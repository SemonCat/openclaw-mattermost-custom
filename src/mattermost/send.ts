import { createHash, createHmac } from "node:crypto";
import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/account-helpers";
import type { ChannelOutboundContext } from "openclaw/plugin-sdk/channel-contract";
import {
  createAcceptedChannelDeliveryResult,
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
// Mattermost plugin module implements send behavior.
import {
  createMessageReceiptFromOutboundResults,
  listMessageReceiptPlatformIds,
  type ChannelMessageUnknownSendContext,
  type ChannelMessageUnknownSendReconciliationResult,
  type MessageReceipt,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { chunkMarkdownTextWithMode, resolveChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { convertMarkdownTables, FormatCapabilityProfile } from "openclaw/plugin-sdk/text-chunking";
import { getMattermostRuntime } from "../runtime.js";
import { resolveMattermostAccount } from "./accounts.js";
import { createMattermostPostWithButtonFallback } from "./button-delivery.js";
import {
  assertMattermostAttachmentCount,
  MATTERMOST_GROUPED_MEDIA_MAX_BYTES,
} from "./attachment-limits.js";
import {
  detectMattermostBlocksSupport,
  resolveMattermostButtonFormat,
} from "./capabilities.js";
import {
  createMattermostClient,
  createMattermostDirectChannelWithRetry,
  fetchMattermostChannelByName,
  fetchMattermostChannelPostsSince,
  fetchMattermostMe,
  fetchMattermostUserByUsername,
  fetchMattermostUserTeams,
  normalizeMattermostBaseUrl,
  parseMattermostApiStatus,
  uploadMattermostFile,
  type CreateDmChannelRetryOptions,
  type MattermostClient,
  type MattermostPost,
  type MattermostUser,
} from "./client.js";
import {
  buildButtonProps,
  resolveInteractionCallbackUrl,
  setInteractionSecret,
} from "./interactions.js";
import { loadOutboundMediaFromUrl, type OpenClawConfig } from "./runtime-api.js";
import {
  parseMattermostTarget,
  resolveMattermostOpaqueTarget,
  type MattermostTarget,
} from "./target-resolution.js";
import { registerMattermostQuestionDelivery } from "./question-finalization.js";
import { MATTERMOST_V12_TEXT_LIMIT, resolveMattermostTextLimit } from "./text-limits.js";
import { createMattermostQuestionRpc } from "./question-rpc.js";
import { buildMattermostQuestionFormButtons, readMattermostQuestion } from "./question-dialog.js";
import { renderQuestionElements } from "./form-schema.js";

type MattermostSendOpts = Pick<
  ChannelOutboundContext,
  "assertDirectAdapterHandoff" | "onPlatformSendDispatch" | "signal" | "silent"
> & {
  cfg: OpenClawConfig;
  botToken?: string;
  baseUrl?: string;
  accountId?: string;
  mediaUrl?: string;
  mediaUrls?: readonly string[];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  workspaceDir?: string;
  /** Fail the send if media cannot be loaded/uploaded instead of posting text-only. */
  requireMediaUpload?: boolean;
  replyToId?: string;
  props?: Record<string, unknown>;
  buttons?: Array<unknown>;
  /** Gateway question bound to this prompt; used only to retire its visible controls. */
  questionId?: string;
  attachmentText?: string;
  /** Retry options for DM channel creation */
  dmRetryOptions?: CreateDmChannelRetryOptions;
  /** Observe the bounded cache-miss DM channel resolution lifecycle. */
  onDmChannelResolution?: (resolution: PromiseLike<unknown>) => void;
  /** Report the provider-finalized send before later fallible bookkeeping. */
  onDeliveryResult?: (result: MattermostSendResult) => Promise<void> | void;
  /** Opaque host-owned durable intent id used only to derive provider-side markers. */
  deliveryQueueId?: string;
  /** Stable platform-send position within one durable text payload. */
  deliveryPartIndex?: number;
  /** Exact number of platform sends expected for one durable text payload. */
  deliveryPartCount?: number;
};

export type MattermostSendResult = {
  messageId: string;
  channelId: string;
  receipt: MessageReceipt;
  content: string;
};

const MATTERMOST_BOT_USER_CACHE_MAX_ENTRIES = 64;
const MATTERMOST_TARGET_CACHE_MAX_ENTRIES = 1024;
const MATTERMOST_DELIVERY_MARKER_PROP = "openclaw_delivery";
const MATTERMOST_RECONCILE_LOOKBACK_MS = 5 * 60_000;
const MATTERMOST_FORMAT_PROFILE = FormatCapabilityProfile.define({
  mechanism: "markdown",
  chunk: { limit: MATTERMOST_V12_TEXT_LIMIT, unit: "chars" },
});

function renderMattermostMarkdown(
  markdown: string,
  tableMode: Parameters<typeof convertMarkdownTables>[1],
): string {
  // Native tables stay byte-identical; only an explicit operator fallback uses conversion.
  return tableMode === "off" && MATTERMOST_FORMAT_PROFILE.constructs.table === "native"
    ? markdown
    : convertMarkdownTables(markdown, tableMode);
}

const botUserCache = new Map<string, MattermostUser>();
const userByNameCache = new Map<string, MattermostUser>();
const channelByNameCache = new Map<string, string>();
const dmChannelCache = new Map<string, string>();

function cacheOutboundEntry<K, V>(cache: Map<K, V>, key: K, value: V, maxEntries: number): void {
  // Cache reads stay insertion ordered; only a newly resolved value refreshes
  // recency before the oldest retained entry is pruned.
  cache.delete(key);
  cache.set(key, value);
  pruneMapToMaxSize(cache, maxEntries);
}

const getCore = () => getMattermostRuntime();

function createMattermostSendReceipt(params: {
  messageId: string;
  channelId: string;
  kind: MessageReceiptPartKind;
  replyToId?: string;
}): MessageReceipt {
  return createMessageReceiptFromOutboundResults({
    kind: params.kind,
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
    results: [
      {
        channel: "mattermost",
        messageId: params.messageId,
        channelId: params.channelId,
      },
    ],
  });
}

type MattermostDeliveryMarker = {
  id: string;
  part_index: number;
  part_count: number;
  signature: string;
};

function createMattermostDeliveryId(queueId?: string): string | undefined {
  const normalized = normalizeOptionalString(queueId);
  return normalized
    ? createHash("sha256").update(normalized).digest("base64url")
    : undefined;
}

function createMattermostDeliverySignature(params: {
  queueId: string;
  channelId: string;
  rootId?: string;
  partIndex: number;
  partCount: number;
}): string {
  return createHmac("sha256", params.queueId)
    .update(
      JSON.stringify([
        "openclaw.mattermost.delivery.v1",
        params.channelId,
        params.rootId ?? "",
        params.partIndex,
        params.partCount,
      ]),
    )
    .digest("base64url");
}

function resolveMattermostDeliveryPart(params: {
  deliveryPartIndex?: number;
  deliveryPartCount?: number;
}): { partIndex: number; partCount: number } {
  const partIndex = params.deliveryPartIndex ?? 0;
  const partCount = params.deliveryPartCount ?? 1;
  if (
    !Number.isSafeInteger(partIndex) ||
    partIndex < 0 ||
    !Number.isSafeInteger(partCount) ||
    partCount < 1 ||
    partIndex >= partCount
  ) {
    throw new Error("Mattermost durable delivery part metadata is invalid");
  }
  return { partIndex, partCount };
}

function withMattermostDeliveryMarker(
  props: Record<string, unknown> | undefined,
  params: {
    queueId?: string;
    channelId: string;
    rootId?: string;
    deliveryPartIndex?: number;
    deliveryPartCount?: number;
  },
): Record<string, unknown> | undefined {
  const queueId = normalizeOptionalString(params.queueId);
  const deliveryId = createMattermostDeliveryId(queueId);
  if (!queueId || !deliveryId) {
    return props;
  }
  const { partIndex, partCount } = resolveMattermostDeliveryPart(params);
  const marker: MattermostDeliveryMarker = {
    id: deliveryId,
    part_index: partIndex,
    part_count: partCount,
    signature: createMattermostDeliverySignature({
      queueId,
      channelId: params.channelId,
      rootId: params.rootId,
      partIndex,
      partCount,
    }),
  };
  return { ...props, [MATTERMOST_DELIVERY_MARKER_PROP]: marker };
}

function readMattermostDeliveryMarker(post: MattermostPost): MattermostDeliveryMarker | null {
  const raw = post.props?.[MATTERMOST_DELIVERY_MARKER_PROP];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const marker = raw as Record<string, unknown>;
  if (
    typeof marker.id !== "string" ||
    typeof marker.signature !== "string" ||
    typeof marker.part_index !== "number" ||
    typeof marker.part_count !== "number" ||
    !Number.isSafeInteger(marker.part_index) ||
    !Number.isSafeInteger(marker.part_count)
  ) {
    return null;
  }
  return {
    id: marker.id,
    signature: marker.signature,
    part_index: marker.part_index,
    part_count: marker.part_count,
  };
}

function resolveMattermostReceiptKind(params: {
  fileIds?: readonly string[];
  buttons?: readonly unknown[];
  props?: Record<string, unknown>;
}): MessageReceiptPartKind {
  if (params.fileIds?.length) {
    return "media";
  }
  if (params.buttons?.length || params.props) {
    return "card";
  }
  return "text";
}

function recordMattermostOutboundActivity(accountId: string): void {
  try {
    getCore().channel.activity.record({
      channel: "mattermost",
      accountId,
      direction: "outbound",
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Mattermost runtime not initialized") {
      throw error;
    }
  }
}

function cacheKey(baseUrl: string, token: string): string {
  return `${baseUrl}::${token}`;
}

function normalizeMessage(text: string, mediaUrl?: string): string {
  const trimmed = normalizeOptionalString(text) ?? "";
  const media = normalizeOptionalString(mediaUrl);
  return [trimmed, media].filter(Boolean).join("\n");
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
async function resolveBotUser(client: MattermostClient): Promise<MattermostUser> {
  const key = cacheKey(client.baseUrl, client.token);
  const cached = botUserCache.get(key);
  if (cached) {
    return cached;
  }
  const user = await fetchMattermostMe(client);
  cacheOutboundEntry(botUserCache, key, user, MATTERMOST_BOT_USER_CACHE_MAX_ENTRIES);
  return user;
}

async function resolveUserIdByUsername(params: {
  client: MattermostClient;
  username: string;
}): Promise<string> {
  const { client, username } = params;
  const key = `${cacheKey(client.baseUrl, client.token)}::${normalizeLowercaseStringOrEmpty(username)}`;
  const cached = userByNameCache.get(key);
  if (cached?.id) {
    return cached.id;
  }
  const user = await fetchMattermostUserByUsername(client, username);
  cacheOutboundEntry(userByNameCache, key, user, MATTERMOST_TARGET_CACHE_MAX_ENTRIES);
  return user.id;
}

async function resolveChannelIdByName(params: {
  client: MattermostClient;
  name: string;
}): Promise<string> {
  const { client, name } = params;
  const key = `${cacheKey(client.baseUrl, client.token)}::channel::${normalizeLowercaseStringOrEmpty(name)}`;
  const cached = channelByNameCache.get(key);
  if (cached) {
    return cached;
  }
  const me = await fetchMattermostMe(client);
  const teams = await fetchMattermostUserTeams(client, me.id);
  for (const team of teams) {
    try {
      const channel = await fetchMattermostChannelByName(client, team.id, name);
      if (channel?.id) {
        cacheOutboundEntry(
          channelByNameCache,
          key,
          channel.id,
          MATTERMOST_TARGET_CACHE_MAX_ENTRIES,
        );
        return channel.id;
      }
    } catch (error) {
      if (parseMattermostApiStatus(error) !== 404) {
        throw error;
      }
    }
  }
  throw new Error(`Mattermost channel "#${name}" not found in any team the bot belongs to`);
}

type ResolveTargetChannelIdParams = {
  target: MattermostTarget;
  client: MattermostClient;
  dmRetryOptions?: CreateDmChannelRetryOptions;
  onDmChannelResolution?: (resolution: PromiseLike<unknown>) => void;
  logger?: { debug?: (msg: string) => void; warn?: (msg: string) => void };
};

function mergeDmRetryOptions(
  base?: CreateDmChannelRetryOptions,
  override?: CreateDmChannelRetryOptions,
): CreateDmChannelRetryOptions | undefined {
  const merged: CreateDmChannelRetryOptions = {
    maxRetries: override?.maxRetries ?? base?.maxRetries,
    initialDelayMs: override?.initialDelayMs ?? base?.initialDelayMs,
    maxDelayMs: override?.maxDelayMs ?? base?.maxDelayMs,
    timeoutMs: override?.timeoutMs ?? base?.timeoutMs,
    onRetry: override?.onRetry,
  };

  if (
    merged.maxRetries === undefined &&
    merged.initialDelayMs === undefined &&
    merged.maxDelayMs === undefined &&
    merged.timeoutMs === undefined &&
    merged.onRetry === undefined
  ) {
    return undefined;
  }

  return merged;
}

async function resolveTargetChannelId(params: ResolveTargetChannelIdParams): Promise<string> {
  if (params.target.kind === "channel") {
    return params.target.id;
  }
  if (params.target.kind === "channel-name") {
    return await resolveChannelIdByName({
      client: params.client,
      name: params.target.name,
    });
  }
  const userId = params.target.id
    ? params.target.id
    : await resolveUserIdByUsername({
        client: params.client,
        username: params.target.username ?? "",
      });
  const dmKey = `${cacheKey(params.client.baseUrl, params.client.token)}::dm::${userId}`;
  const cachedDm = dmChannelCache.get(dmKey);
  if (cachedDm) {
    return cachedDm;
  }
  const botUser = await resolveBotUser(params.client);

  const resolution = createMattermostDirectChannelWithRetry(params.client, [botUser.id, userId], {
    ...params.dmRetryOptions,
    onRetry: (attempt, delayMs, error) => {
      // Call user's onRetry if provided
      params.dmRetryOptions?.onRetry?.(attempt, delayMs, error);
      // Log if verbose mode is enabled
      if (params.logger) {
        params.logger.warn?.(
          `DM channel creation retry ${attempt} after ${delayMs}ms: ${error.message}`,
        );
      }
    },
  });
  params.onDmChannelResolution?.(resolution);
  const channel = await resolution;
  cacheOutboundEntry(dmChannelCache, dmKey, channel.id, MATTERMOST_TARGET_CACHE_MAX_ENTRIES);
  return channel.id;
}

type MattermostSendContext = {
  cfg: OpenClawConfig;
  accountId: string;
  client: MattermostClient;
  questionFinalizationClient?: MattermostClient;
  channelId: string;
  mediaMaxBytes?: number;
};

async function resolveMattermostSendContext(
  to: string,
  opts: MattermostSendOpts,
): Promise<MattermostSendContext> {
  const core = getCore();
  const logger = core.logging.getChildLogger({ module: "mattermost" });
  if (!opts?.cfg) {
    throw new Error(
      "Mattermost send requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.",
    );
  }
  const cfg = requireRuntimeConfig(opts.cfg, "Mattermost send");
  const account = resolveMattermostAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = normalizeOptionalString(opts.botToken) ?? normalizeOptionalString(account.botToken);
  if (!token) {
    throw new Error(
      `Mattermost bot token missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.botToken or MATTERMOST_BOT_TOKEN for default).`,
    );
  }
  const baseUrl = normalizeMattermostBaseUrl(opts.baseUrl ?? account.baseUrl);
  if (!baseUrl) {
    throw new Error(
      `Mattermost baseUrl missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.baseUrl or MATTERMOST_URL for default).`,
    );
  }

  // Keep lookup, DM creation, and delivery on the same account transport policy.
  const transport = {
    baseUrl,
    botToken: token,
    allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
  };
  const client = createMattermostClient({
    ...transport,
    assertRequestCurrent: opts.signal || opts.assertDirectAdapterHandoff
      ? () => {
          opts.signal?.throwIfAborted();
          opts.assertDirectAdapterHandoff?.();
        }
      : undefined,
  });
  // Build retry options from account config, allowing opts to override
  const accountRetryConfig: CreateDmChannelRetryOptions | undefined = account.config.dmChannelRetry
    ? {
        maxRetries: account.config.dmChannelRetry.maxRetries,
        initialDelayMs: account.config.dmChannelRetry.initialDelayMs,
        maxDelayMs: account.config.dmChannelRetry.maxDelayMs,
        timeoutMs: account.config.dmChannelRetry.timeoutMs,
      }
    : undefined;
  const dmRetryOptions = mergeDmRetryOptions(accountRetryConfig, opts.dmRetryOptions);

  let channelId: string;
  try {
    const trimmedTo = normalizeOptionalString(to) ?? "";
    const opaqueTarget = await resolveMattermostOpaqueTarget({
      input: trimmedTo,
      client,
    });
    channelId = await resolveTargetChannelId({
      target: parseMattermostTarget(opaqueTarget?.to ?? trimmedTo),
      client,
      dmRetryOptions,
      onDmChannelResolution: opts.onDmChannelResolution,
      logger: core.logging.shouldLogVerbose() ? logger : undefined,
    });
  } catch (error) {
    // Target preparation cannot have posted a message. Recheck outside its
    // retry history before returning the failure to delivery settlement.
    client.assertRequestCurrent?.();
    throw error;
  }

  return {
    cfg,
    accountId: account.accountId,
    client,
    // Question retirement outlives this send. Keep account/network policy and
    // normal ambient authority checks, without retaining its operation fence.
    ...(opts.questionId
      ? { questionFinalizationClient: createMattermostClient(transport) }
      : {}),
    channelId,
    mediaMaxBytes: resolveChannelMediaMaxBytes({
      cfg,
      accountId: account.accountId,
      resolveChannelLimitMb: () => account.config.mediaMaxMb,
    }),
  };
}

export async function sendMessageMattermost(
  to: string,
  text: string,
  opts: MattermostSendOpts,
): Promise<MattermostSendResult> {
  const core = getCore();
  const logger = core.logging.getChildLogger({ module: "mattermost" });
  const mediaUrls = (opts.mediaUrls?.length ? opts.mediaUrls : [opts.mediaUrl ?? ""])
    .map((url) => url.trim()).filter(Boolean);
  assertMattermostAttachmentCount(mediaUrls);
  opts.signal?.throwIfAborted();
  const { cfg, accountId, client, questionFinalizationClient, channelId, mediaMaxBytes } =
    await resolveMattermostSendContext(to, opts);
  client.assertRequestCurrent?.();
  let props = opts.props;
  let buttons = opts.buttons;
  if (!props && !buttons?.length && opts.questionId &&
    resolveMattermostTextLimit({ baseUrl: client.baseUrl }) === MATTERMOST_V12_TEXT_LIMIT) {
    try {
      const question = await readMattermostQuestion(createMattermostQuestionRpc(() => cfg), opts.questionId);
      if (question.status === "pending" &&
        (question.questions.length > 1 || question.questions.some((q) => q.multiSelect))) {
        renderQuestionElements(question.questions);
        buttons = [buildMattermostQuestionFormButtons(question.id)];
      }
    } catch {
      // Preserve the host's text/Web UI fallback when native form preparation is unavailable.
      logger.warn("mattermost question form: native prompt preparation unavailable");
    }
  }
  let legacyButtonFallbackProps: Record<string, unknown> | undefined;
  if (!props && Array.isArray(buttons) && buttons.length > 0) {
    setInteractionSecret(accountId, client.token);
    const interactions = resolveMattermostAccount({ cfg, accountId }).config?.interactions;
    const detectedBlocksSupport =
      interactions?.blocks === undefined
        ? await detectMattermostBlocksSupport(client)
        : undefined;
    const buttonFormat = resolveMattermostButtonFormat(
      interactions?.blocks,
      detectedBlocksSupport,
    );
    const useBlocks = buttonFormat === "blocks";
    const callbackUrl = resolveInteractionCallbackUrl(accountId, {
      gateway: cfg.gateway,
      interactions,
    });
    const buttonParams = {
      callbackUrl,
      accountId,
      channelId,
      buttons,
      text: opts.attachmentText,
    };
    props = buildButtonProps({
      ...buttonParams,
      format: useBlocks ? "blocks" : "legacy",
    });
    if (useBlocks) {
      legacyButtonFallbackProps = buildButtonProps({ ...buttonParams, format: "legacy" });
    }
  }
  let message = normalizeOptionalString(text) ?? "";
  let fileIds: string[] | undefined;
  let uploadError: Error | undefined;
  const grouped = mediaUrls.length > 1;
  // Bound the complete group as well as each SDK media read. Single-file sends
  // retain their existing SDK default/explicit limit and URL fallback.
  let remainingBytes = grouped
    ? Math.min(mediaMaxBytes ?? MATTERMOST_GROUPED_MEDIA_MAX_BYTES, MATTERMOST_GROUPED_MEDIA_MAX_BYTES)
    : mediaMaxBytes;
  for (const mediaUrl of mediaUrls) {
    try {
      client.assertRequestCurrent?.();
      if (remainingBytes !== undefined && remainingBytes <= 0) {
        throw new Error("Mattermost attachment aggregate byte limit exceeded");
      }
      const media = await loadOutboundMediaFromUrl(mediaUrl, {
        maxBytes: remainingBytes,
        mediaLocalRoots: opts.mediaLocalRoots,
        mediaReadFile: opts.mediaReadFile,
        workspaceDir: opts.workspaceDir,
      });
      client.assertRequestCurrent?.();
      if (remainingBytes !== undefined && media.buffer.length > remainingBytes) {
        throw new Error("Mattermost attachment aggregate byte limit exceeded");
      }
      const fileInfo = await uploadMattermostFile(client, {
        channelId,
        buffer: media.buffer,
        fileName: media.fileName ?? `upload${extensionForMime(media.contentType) ?? ""}`,
        contentType: media.contentType ?? undefined,
        signal: opts.signal,
      });
      client.assertRequestCurrent?.();
      (fileIds ??= []).push(fileInfo.id);
      if (remainingBytes !== undefined) remainingBytes -= media.buffer.length;
    } catch (err) {
      client.assertRequestCurrent?.();
      uploadError = err instanceof Error ? err : new Error(String(err));
      if (grouped || opts.requireMediaUpload || mediaMaxBytes !== undefined) {
        throw new Error(`Mattermost media upload failed: ${uploadError.message}`, {
          cause: err,
        });
      }
      if (core.logging.shouldLogVerbose()) {
        logger.debug?.(
          `mattermost send: media upload failed, falling back to URL text: ${String(err)}`,
        );
      }
      message = normalizeMessage(message, isHttpUrl(mediaUrl) ? mediaUrl : "");
    }
  }

  if (message) {
    const tableMode = resolveMarkdownTableMode({
      cfg,
      channel: "mattermost",
      accountId,
    });
    message = renderMattermostMarkdown(message, tableMode);
  }

  if (!message && (!fileIds || fileIds.length === 0)) {
    if (uploadError) {
      throw new Error(`Mattermost media upload failed: ${uploadError.message}`, {
        cause: uploadError,
      });
    }
    throw new Error("Mattermost message is empty");
  }

  const chunks = grouped && message
    ? chunkMarkdownTextWithMode(
        message,
        resolveMattermostTextLimit({
          baseUrl: client.baseUrl,
          textChunkLimit: resolveMattermostAccount({ cfg, accountId }).textChunkLimit,
        }),
        resolveChunkMode(cfg, "mattermost", accountId),
      )
    : [message];
  const results: MattermostSendResult[] = [];
  // A host-counted multi-payload batch cannot safely be renumbered locally.
  // Media reconciliation is unsupported; omit markers for that nested fanout
  // rather than sign a false total. A single intent can describe all its parts.
  const canMark = chunks.length === 1 ||
    ((opts.deliveryPartIndex ?? 0) === 0 && (opts.deliveryPartCount ?? 1) === 1);
  const delivery = () => createAcceptedChannelDeliveryResult({
    results: results.map((result) => ({ receipt: result.receipt })),
    kind: "media",
    ...(opts.replyToId ? { replyToId: opts.replyToId } : {}),
    content: results.map((result) => result.content).filter(Boolean).join("\n"),
  });
  try {
    for (const [index, chunk] of chunks.entries()) {
      client.assertRequestCurrent?.();
      try {
        await opts.onPlatformSendDispatch?.();
      } catch (error) {
        client.assertRequestCurrent?.();
        throw error;
      }
      const marker = {
        queueId: canMark ? opts.deliveryQueueId : undefined,
        channelId,
        rootId: opts.replyToId,
        deliveryPartIndex: chunks.length > 1 ? index : opts.deliveryPartIndex,
        deliveryPartCount: chunks.length > 1 ? chunks.length : opts.deliveryPartCount,
      };
      const partProps = withMattermostDeliveryMarker(index === 0 ? props : undefined, marker);
      const created = await createMattermostPostWithButtonFallback({
        client,
        post: {
          channelId,
          message: chunk,
          rootId: opts.replyToId,
          fileIds: index === 0 ? fileIds : undefined,
          props: partProps,
          silent: opts.silent,
        },
        legacyProps: index === 0 && legacyButtonFallbackProps
          ? withMattermostDeliveryMarker(legacyButtonFallbackProps, marker)
          : undefined,
        warn: (warning) => logger.warn?.(warning),
      });
      const post = created.post;
      const receipt = createMattermostSendReceipt({
        messageId: post.id,
        channelId,
        kind: resolveMattermostReceiptKind({
          fileIds: index === 0 ? fileIds : undefined,
          buttons: index === 0 ? opts.buttons : undefined,
          props: index === 0 ? props : undefined,
        }),
        replyToId: opts.replyToId,
      });
      const result: MattermostSendResult = {
        messageId: post.id,
        channelId,
        receipt,
        content: post.message ?? chunk,
      };
      results.push(result);
      try {
        registerMattermostQuestionDelivery({
          accountId,
          client: questionFinalizationClient ?? client,
          post: post.props == null && created.props ? { ...post, props: created.props } : post,
          questionId: index === 0 ? opts.questionId : undefined,
        });
      } catch {
        // Provider acceptance must survive fallible terminal-control bookkeeping.
        logger.warn?.("mattermost send: question finalization registration failed");
      }
      await opts.onDeliveryResult?.(result);
      recordMattermostOutboundActivity(accountId);
    }
  } catch (error: unknown) {
    const partial = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
    if (!results.length) throw error;
    throw createChannelPartialDeliveryError(error, createAcceptedChannelDeliveryResult({
      results: results.map((result) => ({ receipt: result.receipt })),
      deliveryResults: partial ? [partial] : [],
      kind: grouped ? "media" : resolveMattermostReceiptKind({ fileIds, buttons: opts.buttons, props }),
      ...(opts.replyToId ? { replyToId: opts.replyToId } : {}),
      content: [...results.map((result) => result.content), partial?.content].filter(Boolean).join("\n"),
    }));
  }
  if (results.length === 1) return results[0]!;
  const accepted = delivery();
  return { ...results[0]!, receipt: accepted.receipt!, content: accepted.content ?? "" };
}

function resolveMattermostUnknownSendRootId(
  ctx: ChannelMessageUnknownSendContext,
): string | undefined {
  if (Object.hasOwn(ctx, "effectiveReplyToId")) {
    return normalizeOptionalString(ctx.effectiveReplyToId);
  }
  const payloadReplyToId = ctx.payloads[0]?.replyToId;
  if (payloadReplyToId != null) {
    return normalizeOptionalString(payloadReplyToId);
  }
  if (ctx.replyToMode === "off") {
    return undefined;
  }
  return normalizeOptionalString(ctx.replyToId) ?? normalizeOptionalString(ctx.threadId);
}

function createMattermostReconciledReceipt(params: {
  posts: MattermostPost[];
  channelId: string;
  rootId?: string;
}): MessageReceipt {
  return createMessageReceiptFromOutboundResults({
    kind: "text",
    ...(params.rootId ? { replyToId: params.rootId } : {}),
    results: params.posts.map((post) => ({
      channel: "mattermost",
      messageId: post.id,
      channelId: params.channelId,
    })),
  });
}

export async function reconcileMattermostUnknownSend(
  ctx: ChannelMessageUnknownSendContext,
): Promise<ChannelMessageUnknownSendReconciliationResult> {
  const queueId = normalizeOptionalString(ctx.queueId);
  const deliveryId = createMattermostDeliveryId(queueId);
  if (!queueId || !deliveryId) {
    return {
      status: "unresolved",
      error: "Mattermost unknown-send reconciliation requires a durable delivery id",
      retryable: false,
    };
  }
  const { accountId, client, channelId } = await resolveMattermostSendContext(ctx.to, {
    cfg: ctx.cfg,
    accountId: ctx.accountId ?? undefined,
  });
  const botUser = await resolveBotUser(client);
  const rootId = resolveMattermostUnknownSendRootId(ctx);
  const searchStartedAt = ctx.platformSendStartedAt ?? ctx.enqueuedAt;
  const since = Math.max(1, Math.floor(searchStartedAt - MATTERMOST_RECONCILE_LOOKBACK_MS));
  const posts = await fetchMattermostChannelPostsSince(client, channelId, since);
  const matchesByIndex = new Map<number, MattermostPost>();
  let expectedPartCount: number | undefined;
  let duplicatePart = false;

  for (const post of posts) {
    if (
      normalizeOptionalString(post.channel_id) !== channelId ||
      normalizeOptionalString(post.user_id) !== botUser.id ||
      normalizeOptionalString(post.root_id) !== rootId
    ) {
      continue;
    }
    const marker = readMattermostDeliveryMarker(post);
    if (
      !marker ||
      marker.id !== deliveryId ||
      marker.part_index < 0 ||
      marker.part_count < 1 ||
      marker.part_index >= marker.part_count
    ) {
      continue;
    }
    const expectedSignature = createMattermostDeliverySignature({
      queueId,
      channelId,
      rootId,
      partIndex: marker.part_index,
      partCount: marker.part_count,
    });
    if (marker.signature !== expectedSignature) {
      continue;
    }
    if (expectedPartCount !== undefined && expectedPartCount !== marker.part_count) {
      return {
        status: "unresolved",
        error: "Mattermost durable delivery markers disagree on part count",
        retryable: false,
      };
    }
    expectedPartCount = marker.part_count;
    if (matchesByIndex.has(marker.part_index)) {
      duplicatePart = true;
      continue;
    }
    matchesByIndex.set(marker.part_index, post);
  }

  if (duplicatePart) {
    return {
      status: "unresolved",
      error: "Mattermost durable delivery contains duplicate provider parts",
      retryable: false,
    };
  }
  if (expectedPartCount !== undefined && matchesByIndex.size === expectedPartCount) {
    const orderedPosts: MattermostPost[] = [];
    for (let partIndex = 0; partIndex < expectedPartCount; partIndex += 1) {
      const post = matchesByIndex.get(partIndex);
      if (!post) {
        return {
          status: "unresolved",
          error: "Mattermost durable delivery marker set is incomplete",
          retryable: ctx.retryCount < 2,
        };
      }
      orderedPosts.push(post);
    }
    const receipt = createMattermostReconciledReceipt({
      posts: orderedPosts,
      channelId,
      rootId,
    });
    return {
      status: "sent",
      receipt,
      messageId: receipt.primaryPlatformMessageId,
    };
  }

  return {
    status: "unresolved",
    error:
      matchesByIndex.size > 0
        ? "Mattermost durable delivery marker set is incomplete"
        : `Mattermost contains no exact durable delivery marker for account "${accountId}"`,
    retryable: ctx.retryCount < 2,
  };
}
