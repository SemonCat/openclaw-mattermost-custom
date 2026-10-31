// Mattermost plugin module implements explicit historical attachment reads.
import { stat, unlink } from "node:fs/promises";
import {
  resolveChannelMediaMaxBytes,
} from "openclaw/plugin-sdk/account-helpers";
import { imageResultFromFile, jsonResult } from "openclaw/plugin-sdk/channel-actions";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "openclaw/plugin-sdk/account-id";
import { saveRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import { sanitizeUntrustedFileName } from "openclaw/plugin-sdk/security-runtime";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMattermostAccount } from "./accounts.js";
import {
  buildMattermostApiUrl,
  createMattermostClient,
  fetchMattermostChannel,
  fetchMattermostFileInfo,
  fetchMattermostMe,
  fetchMattermostPost,
  fetchMattermostUser,
  type MattermostClient,
  type MattermostFetch,
  type MattermostPost,
} from "./client.js";
import {
  isCurrentMattermostReadTarget,
  type ReadContext,
} from "./read.js";
import {
  resolveMattermostMonitorInboundAccess,
  shouldRetainMattermostSenderHistory,
} from "./monitor-auth.js";
import { isDangerousNameMatchingEnabled } from "./runtime-api.js";
import type { OpenClawConfig } from "./runtime-api.js";

const POST_ID = /^[a-z0-9]{26}$/iu;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10_000;

type MattermostFileActionReadContext = ReadContext & {
  requesterSenderId?: string | null;
};

export type DownloadMattermostPostAttachmentParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  requesterAccountId?: string | null;
  requesterSenderId?: string | null;
  conversationReadOrigin?: ReadContext["conversationReadOrigin"];
  toolContext?: ReadContext["toolContext"];
  postId: string;
  fileId: string;
  authorizedTarget?: string;
  assertCurrent?: () => void;
  signal?: AbortSignal;
  fetchImpl?: MattermostFetch;
};

type DownloadMattermostPostAttachmentDependencies = {
  createClient: typeof createMattermostClient;
  fetchMe: typeof fetchMattermostMe;
  fetchPost: typeof fetchMattermostPost;
  fetchChannel: typeof fetchMattermostChannel;
  fetchUser: typeof fetchMattermostUser;
  fetchFileInfo: typeof fetchMattermostFileInfo;
  save: typeof saveRemoteMedia;
  now: () => number;
};

const defaultDependencies: DownloadMattermostPostAttachmentDependencies = {
  createClient: createMattermostClient,
  fetchMe: fetchMattermostMe,
  fetchPost: fetchMattermostPost,
  fetchChannel: fetchMattermostChannel,
  fetchUser: fetchMattermostUser,
  fetchFileInfo: fetchMattermostFileInfo,
  save: saveRemoteMedia,
  now: Date.now,
};

function resolveChatKind(channelType?: string | null): "direct" | "group" | "channel" {
  switch (channelType?.trim().toUpperCase()) {
    case "D":
      return "direct";
    case "G":
    case "P":
      return "group";
    default:
      return "channel";
  }
}

function assertPostOwnsFile(params: {
  post: MattermostPost;
  postId: string;
  fileId: string;
  channelId: string;
}): void {
  const { post } = params;
  if (
    post.id !== params.postId ||
    post.channel_id !== params.channelId ||
    (typeof post.delete_at === "number" && post.delete_at > 0) ||
    Boolean(post.type?.trim()) ||
    !post.file_ids?.includes(params.fileId)
  ) {
    throw new Error("Mattermost file is not attached to an available post in this conversation.");
  }
}

async function assertVisiblePostSender(params: {
  cfg: OpenClawConfig;
  account: ReturnType<typeof resolveMattermostAccount>;
  client: MattermostClient;
  post: MattermostPost;
  channelId: string;
  assertCurrent: () => void;
  fetchChannel: typeof fetchMattermostChannel;
  fetchMe: typeof fetchMattermostMe;
  fetchUser: typeof fetchMattermostUser;
}): Promise<void> {
  const bot = await params.fetchMe(params.client);
  params.assertCurrent();
  if (params.post.user_id === bot.id) {
    return;
  }
  const senderId = normalizeOptionalString(params.post.user_id);
  if (!senderId) {
    throw new Error("Mattermost file post has no verifiable author.");
  }
  const channel = await params.fetchChannel(params.client, params.channelId);
  params.assertCurrent();
  if (channel.id !== params.channelId || !channel.type) {
    throw new Error("Mattermost file conversation could not be verified.");
  }
  const user = await params.fetchUser(params.client, senderId);
  params.assertCurrent();
  const senderName = isDangerousNameMatchingEnabled(params.account.config)
    ? normalizeOptionalString(user.username) ?? senderId
    : senderId;
  const groupPolicy =
    params.account.config.groupPolicy ??
    params.cfg.channels?.defaults?.groupPolicy ??
    "allowlist";
  const kind = resolveChatKind(channel.type);
  const access = await resolveMattermostMonitorInboundAccess({
    cfg: params.cfg,
    account: params.account,
    senderId,
    senderName,
    channelId: params.channelId,
    kind,
    groupPolicy,
    allowTextCommands: false,
    hasControlCommand: false,
    mayPair: false,
  });
  params.assertCurrent();
  if (
    access.ingress.decision !== "allow" &&
    !shouldRetainMattermostSenderHistory({
      cfg: params.cfg,
      accountId: params.account.accountId,
      kind,
      ingress: access.ingress,
    })
  ) {
    throw new Error("Mattermost file post is outside the visible conversation history.");
  }
}

export async function downloadMattermostPostAttachment(
  params: DownloadMattermostPostAttachmentParams,
  dependencies: Partial<DownloadMattermostPostAttachmentDependencies> = {},
) {
  const deps = { ...defaultDependencies, ...dependencies };
  const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
  const account = resolveMattermostAccount({ cfg: params.cfg, accountId });
  const baseUrl = normalizeOptionalString(account.baseUrl);
  const botToken = normalizeOptionalString(account.botToken);
  if (!account.enabled || !baseUrl || !botToken) {
    throw new Error("Mattermost account credentials are unavailable.");
  }
  const postId = normalizeOptionalString(params.postId);
  const fileId = normalizeOptionalString(params.fileId);
  if (!postId || !POST_ID.test(postId) || !fileId || !POST_ID.test(fileId)) {
    throw new Error("Mattermost download-file requires valid postId and fileId values.");
  }
  if (!normalizeOptionalString(params.requesterSenderId)) {
    throw new Error("Mattermost download-file requires a trusted current sender.");
  }

  const context: MattermostFileActionReadContext = {
    conversationReadOrigin: params.conversationReadOrigin,
    requesterAccountId: params.requesterAccountId,
    requesterSenderId: params.requesterSenderId,
    toolContext: params.toolContext,
  };
  const requesterAccountId = normalizeAccountId(context.requesterAccountId ?? "");
  if (
    requesterAccountId !== normalizeAccountId(account.accountId) ||
    normalizeOptionalString(context.toolContext?.currentChannelProvider)?.toLowerCase() !==
      "mattermost"
  ) {
    throw new Error("Mattermost file downloads require the current Mattermost account and conversation.");
  }

  const controller = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([controller.signal, params.signal])
    : controller.signal;
  const startedAt = deps.now();
  const deadline = startedAt + DOWNLOAD_TIMEOUT_MS;
  const remainingMs = () => Math.max(1, deadline - deps.now());
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (deps.now() >= deadline) {
      throw new DOMException("Mattermost attachment download exceeded its 10 second deadline.", "TimeoutError");
    }
    params.assertCurrent?.();
  };
  const timeoutError = new DOMException(
    "Mattermost attachment download exceeded its 10 second deadline.",
    "TimeoutError",
  );
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const operation = async () => {
    const originalClient = deps.createClient({
      baseUrl,
      botToken,
      fetchImpl: params.fetchImpl,
      allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
    });
    const client: MattermostClient = {
      ...originalClient,
      request: (path, init) => {
        assertCurrent();
        return originalClient.request(path, {
          ...init,
          signal,
          timeoutMs: remainingMs(),
        });
      },
    };
    assertCurrent();
    const post = await deps.fetchPost(client, postId);
    assertCurrent();
    const channelId = normalizeOptionalString(post.channel_id);
    if (!channelId) {
      throw new Error("Mattermost file post has no conversation binding.");
    }
    if (
      !isCurrentMattermostReadTarget({
        accountId: account.accountId,
        channelId,
        context,
      })
    ) {
      throw new Error("Mattermost file post is not in the current conversation.");
    }
    if (params.authorizedTarget) {
      const target = normalizeOptionalString(params.authorizedTarget);
      if (target !== `channel:${channelId}`) {
        throw new Error("Mattermost file target must match the current conversation.");
      }
    }
    assertPostOwnsFile({ post, postId, fileId, channelId });
    await assertVisiblePostSender({
      cfg: params.cfg,
      account,
      client,
      post,
      channelId,
      assertCurrent,
      fetchChannel: deps.fetchChannel,
      fetchMe: deps.fetchMe,
      fetchUser: deps.fetchUser,
    });
    const file = await deps.fetchFileInfo(client, fileId);
    assertCurrent();
    if (
      file.id !== fileId ||
      file.post_id !== postId ||
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    ) {
      throw new Error("Mattermost file ownership or size could not be verified.");
    }
    const mediaLimit = Math.min(
      MAX_DOWNLOAD_BYTES,
      resolveChannelMediaMaxBytes({
        cfg: params.cfg,
        accountId: account.accountId,
        resolveChannelLimitMb: () => account.config.mediaMaxMb,
      }) ?? MAX_DOWNLOAD_BYTES,
    );
    if (file.size > mediaLimit) {
      throw new Error(`Mattermost attachment exceeds the ${mediaLimit}-byte download limit.`);
    }

    const downloadUrl = buildMattermostApiUrl(baseUrl, `/files/${encodeURIComponent(fileId)}`);
    let unclaimedSavedPath: string | undefined;
    try {
      const saved = await deps.save({
        url: downloadUrl,
        requestInit: {
          headers: { Authorization: `Bearer ${client.token}` },
          signal,
        },
        filePathHint: fileId,
        originalFilename: sanitizeUntrustedFileName(file.name ?? "", fileId),
        maxBytes: Math.max(1, Math.min(file.size, mediaLimit)),
        timeoutMs: remainingMs(),
        responseHeaderTimeoutMs: remainingMs(),
        readIdleTimeoutMs: remainingMs(),
        ssrfPolicy: {
          hostnameAllowlist: [new URL(baseUrl).hostname],
          allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
        },
        assertCurrent,
      });
      unclaimedSavedPath = saved.path;
      assertCurrent();
      if (!saved.path) {
        throw new Error("Mattermost attachment could not be saved for analysis.");
      }
      const savedSize = (await stat(saved.path)).size;
      assertCurrent();
      if (savedSize > mediaLimit || savedSize > file.size) {
        throw new Error("Mattermost attachment exceeded its verified size.");
      }

      const confirmedPost = await deps.fetchPost(client, postId);
      assertCurrent();
      assertPostOwnsFile({ post: confirmedPost, postId, fileId, channelId });
      const contentType = normalizeOptionalString(saved.contentType ?? file.mime_type);
      const fileName = sanitizeUntrustedFileName(saved.fileName ?? file.name ?? fileId, fileId);
      const result = contentType?.toLowerCase().startsWith("image/")
        ? await imageResultFromFile({
            label: "mattermost-file",
            path: saved.path,
            extraText: `Mattermost attachment ${fileName} from post ${postId}.`,
            details: {
              fileId,
              postId,
              media: {
                mediaUrl: saved.path,
                outbound: false,
                ...(contentType ? { contentType } : {}),
              },
            },
          })
        : jsonResult({
            ok: true,
            fileId,
            postId,
            path: saved.path,
            fileName,
            ...(contentType ? { contentType } : {}),
            media: {
              mediaUrl: saved.path,
              outbound: false,
              ...(contentType ? { contentType } : {}),
            },
          });
      assertCurrent();
      unclaimedSavedPath = undefined;
      return result;
    } finally {
      if (unclaimedSavedPath) {
        await unlink(unclaimedSavedPath).catch(() => {});
      }
    }
  };

  try {
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    const timeout = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => {
        controller.abort(timeoutError);
        reject(timeoutError);
      }, DOWNLOAD_TIMEOUT_MS);
    });
    return await Promise.race([operation(), aborted, timeout]);
  } finally {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
    }
    controller.abort();
  }
}
