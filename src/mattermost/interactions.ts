// Mattermost plugin module implements interactions behavior.
import { createHmac, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { getMattermostRuntime } from "../runtime.js";
import { isWildcardBindHost } from "./callback-host.js";
import { updateMattermostPost, type MattermostClient, type MattermostPost } from "./client.js";
import {
  isRequestBodyLimitError,
  isTrustedProxyAddress,
  readRequestBodyWithLimit,
  resolveClientIp,
  sendHttpRequestRejection,
  type OpenClawConfig,
} from "./runtime-api.js";

const INTERACTION_MAX_BODY_BYTES = 64 * 1024;
const INTERACTION_BODY_TIMEOUT_MS = 10_000;
const SIGNED_CHANNEL_ID_CONTEXT_KEY = "__openclaw_channel_id";

/**
 * Mattermost interactive message callback payload.
 * Sent by Mattermost when a user clicks an action button.
 * See: https://developers.mattermost.com/integrate/plugins/interactive-messages/
 */
export type MattermostInteractionPayload = {
  user_id: string;
  user_name?: string;
  channel_id: string;
  team_id?: string;
  post_id: string;
  trigger_id?: string;
  type?: string;
  data_source?: string;
  context?: Record<string, unknown>;
  selected_option?: unknown;
};

export type MattermostDialogSubmissionPayload = {
  type: "dialog_submission";
  callback_id: string;
  state: string;
  user_id: string;
  channel_id: string;
  team_id?: string;
  submission: Record<string, unknown>;
  cancelled?: boolean;
};

export type MattermostDialogSubmissionResponse = {
  statusCode?: number;
  body?: Record<string, unknown>;
};

export type MattermostInteractionResponse = {
  update?: {
    message: string;
    props?: Record<string, unknown>;
  };
  ephemeral_text?: string;
};

export type MattermostInteractionAuthorizationResult =
  | { ok: true }
  | { ok: false; statusCode?: number; response?: MattermostInteractionResponse };

export type MattermostInteractiveButtonInput = {
  id?: string;
  callback_data?: string;
  text?: string;
  name?: string;
  label?: string;
  style?: "default" | "primary" | "danger";
  context?: Record<string, unknown>;
  type?: "select";
  options?: Array<{ text: string; value: string; context: Record<string, unknown> }>;
};

export type MattermostValidatedInteraction = {
  payload: Omit<MattermostInteractionPayload, "context">;
  userName: string;
  actionId: string;
  actionName: string;
  originalMessage: string;
  context: Record<string, unknown>;
  /** Minimal provider identity needed by replay; post props and callback secrets are not persisted. */
  post: Pick<MattermostPost, "id" | "channel_id" | "root_id" | "message">;
};

export type MattermostInteractionProcessor = (
  interaction: MattermostValidatedInteraction,
) => Promise<void>;

type MattermostInteractionCallback = (opts: {
  payload: MattermostInteractionPayload;
  userName: string;
  actionId: string;
  actionName: string;
  originalMessage: string;
  context: Record<string, unknown>;
  post: MattermostPost;
}) => Promise<MattermostInteractionResponse | null>;

type MattermostInteractionHandlerOptions = {
  client: MattermostClient;
  botUserId: string;
  accountId: string;
  allowedSourceIps?: string[];
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  resolveSessionKey?: (params: {
    channelId: string;
    userId: string;
    post: MattermostPost;
  }) => Promise<string>;
  handleInteraction?: MattermostInteractionCallback;
  /** Handle a short-lived trigger before durable admission (for example, opening a dialog). */
  handleImmediateInteraction?: MattermostInteractionCallback;
  /** Secret-bearing dialog submissions are handled synchronously and are never queued. */
  handleDialogSubmission?: (
    payload: MattermostDialogSubmissionPayload,
  ) => Promise<MattermostDialogSubmissionResponse>;
  authorizeButtonClick?: (opts: {
    payload: MattermostInteractionPayload;
    post: MattermostPost;
  }) => Promise<MattermostInteractionAuthorizationResult>;
  dispatchButtonClick?: (opts: {
    channelId: string;
    userId: string;
    userName: string;
    actionId: string;
    actionName: string;
    selectedValue?: string;
    postId: string;
    post: MattermostPost;
  }) => Promise<void>;
  /** Persist after validation and authorization. HTTP 200 is sent only after this resolves. */
  admitInteraction?: (
    interaction: MattermostValidatedInteraction,
  ) => Promise<void | (() => void)>;
  log?: (message: string) => void;
};

// ── Callback URL registry ──────────────────────────────────────────────

const callbackUrls = new Map<string, string>();

export function setInteractionCallbackUrl(accountId: string, url: string): void {
  callbackUrls.set(accountId, url);
}

type InteractionCallbackConfig = Pick<OpenClawConfig, "gateway" | "channels"> & {
  interactions?: {
    callbackBaseUrl?: string;
  };
};

export function resolveInteractionCallbackPath(accountId: string): string {
  return `/mattermost/interactions/${accountId}`;
}

function normalizeCallbackBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return normalizeOptionalString(value[0]);
  }
  return normalizeOptionalString(value);
}

function isAllowedInteractionSource(params: {
  req: IncomingMessage;
  allowedSourceIps?: string[];
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
}): boolean {
  const { allowedSourceIps } = params;
  if (!allowedSourceIps?.length) {
    return true;
  }

  const clientIp = resolveClientIp({
    remoteAddr: params.req.socket?.remoteAddress,
    forwardedFor: headerValue(params.req.headers["x-forwarded-for"]),
    realIp: headerValue(params.req.headers["x-real-ip"]),
    trustedProxies: params.trustedProxies,
    allowRealIpFallback: params.allowRealIpFallback,
  });
  return isTrustedProxyAddress(clientIp, allowedSourceIps);
}

/**
 * Resolve the interaction callback URL for an account.
 * Falls back to computing it from interactions.callbackBaseUrl or gateway host config.
 */
export function computeInteractionCallbackUrl(
  accountId: string,
  cfg?: InteractionCallbackConfig,
): string {
  const path = resolveInteractionCallbackPath(accountId);
  // Prefer merged per-account config when available, but keep the top-level path for
  // callers/tests that still pass the root Mattermost config shape directly.
  const callbackBaseUrl =
    normalizeOptionalString(cfg?.interactions?.callbackBaseUrl) ??
    normalizeOptionalString(cfg?.channels?.mattermost?.interactions?.callbackBaseUrl);
  if (callbackBaseUrl) {
    return `${normalizeCallbackBaseUrl(callbackBaseUrl)}${path}`;
  }
  const port = typeof cfg?.gateway?.port === "number" ? cfg.gateway.port : 18789;
  let host =
    cfg?.gateway?.customBindHost && !isWildcardBindHost(cfg.gateway.customBindHost)
      ? cfg.gateway.customBindHost.trim()
      : "localhost";

  // Bracket IPv6 literals so the URL is valid: http://[::1]:18789/...
  if (host.includes(":") && !(host.startsWith("[") && host.endsWith("]"))) {
    host = `[${host}]`;
  }

  return `http://${host}:${port}${path}`;
}

/**
 * Resolve the interaction callback URL for an account.
 * Prefers the in-memory registered URL (set by the gateway monitor) so callers outside the
 * monitor lifecycle can reuse the runtime-validated callback destination.
 */
export function resolveInteractionCallbackUrl(
  accountId: string,
  cfg?: InteractionCallbackConfig,
): string {
  const cached = callbackUrls.get(accountId);
  if (cached) {
    return cached;
  }
  return computeInteractionCallbackUrl(accountId, cfg);
}

// ── HMAC token management ──────────────────────────────────────────────
// Secret is derived from the bot token so it's stable across CLI and gateway processes.

const interactionSecrets = new Map<string, string>();
let defaultInteractionSecret: string | undefined;

function deriveInteractionSecret(botToken: string): string {
  return createHmac("sha256", "openclaw-mattermost-interactions").update(botToken).digest("hex");
}

export function setInteractionSecret(accountIdOrBotToken: string, botToken?: string): void {
  if (typeof botToken === "string") {
    interactionSecrets.set(accountIdOrBotToken, deriveInteractionSecret(botToken));
    return;
  }
  // Backward-compatible fallback for call sites/tests that only pass botToken.
  defaultInteractionSecret = deriveInteractionSecret(accountIdOrBotToken);
}

function getInteractionSecret(accountId?: string): string {
  const scoped = accountId ? interactionSecrets.get(accountId) : undefined;
  if (scoped) {
    return scoped;
  }
  if (defaultInteractionSecret) {
    return defaultInteractionSecret;
  }
  // Fallback for single-account runtimes that only registered scoped secrets.
  if (interactionSecrets.size === 1) {
    const first = interactionSecrets.values().next().value;
    if (typeof first === "string") {
      return first;
    }
  }
  throw new Error(
    "Interaction secret not initialized — call setInteractionSecret(accountId, botToken) first",
  );
}

function canonicalizeInteractionContext(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeInteractionContext(item));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, canonicalizeInteractionContext(entryValue)]);
    return Object.fromEntries(entries);
  }
  return value;
}

export function generateInteractionToken(
  context: Record<string, unknown>,
  accountId?: string,
): string {
  const secret = getInteractionSecret(accountId);
  const payload = JSON.stringify(canonicalizeInteractionContext(context));
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyInteractionToken(
  context: Record<string, unknown>,
  token: string,
  accountId?: string,
): boolean {
  const expected = generateInteractionToken(context, accountId);
  return safeEqualSecret(expected, token);
}

function isMattermostDialogSubmissionPayload(
  value: unknown,
): value is MattermostDialogSubmissionPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  return (
    payload.type === "dialog_submission" &&
    typeof payload.callback_id === "string" &&
    typeof payload.state === "string" &&
    typeof payload.user_id === "string" &&
    typeof payload.channel_id === "string" &&
    Boolean(payload.submission) &&
    typeof payload.submission === "object" &&
    !Array.isArray(payload.submission) &&
    (payload.cancelled === undefined || typeof payload.cancelled === "boolean")
  );
}

// ── Button builder helpers ─────────────────────────────────────────────

type MattermostButton = {
  id: string;
  type: "button" | "select";
  name: string;
  style?: "default" | "primary" | "danger";
  options?: Array<{ text: string; value: string }>;
  integration: {
    url: string;
    context: Record<string, unknown>;
  };
};

type MattermostAttachment = {
  text?: string;
  actions?: MattermostButton[];
  [key: string]: unknown;
};

/**
 * Build Mattermost `props.attachments` with interactive buttons.
 *
 * Each button includes an HMAC token in its integration context so the
 * callback handler can verify the request originated from a legitimate
 * button click (Mattermost's recommended security pattern).
 */
/**
 * Sanitize a button ID so Mattermost's action router can match it.
 * Mattermost uses the action ID in the URL path `/api/v4/posts/{id}/actions/{actionId}`
 * and IDs containing hyphens or underscores break the server-side routing.
 * See: https://github.com/mattermost/mattermost/issues/25747
 */
function sanitizeActionId(id: string): string {
  return id.replace(/[-_]/g, "");
}

export function buildButtonAttachments(params: {
  callbackUrl: string;
  accountId?: string;
  buttons: Array<{
    id: string;
    name: string;
    style?: "default" | "primary" | "danger";
    context?: Record<string, unknown>;
    type?: "select";
    options?: Array<{ text: string; value: string }>;
  }>;
  text?: string;
}): MattermostAttachment[] {
  const actions: MattermostButton[] = params.buttons.map((btn) => {
    const safeId = sanitizeActionId(btn.id);
    const context: Record<string, unknown> = {
      action_id: safeId,
      ...btn.context,
    };
    const token = generateInteractionToken(context, params.accountId);
    return {
      id: safeId,
      type: btn.type ?? "button",
      ...(btn.options ? { options: btn.options.map(({ text, value }) => ({ text, value })) } : {}),
      name: btn.name,
      style: btn.style,
      integration: {
        url: params.callbackUrl,
        context: {
          ...context,
          _token: token,
        },
      },
    };
  });

  return [
    {
      text: params.text ?? "",
      actions,
    },
  ];
}

export function buildButtonProps(params: {
  callbackUrl: string;
  accountId?: string;
  channelId: string;
  buttons: Array<unknown>;
  text?: string;
  format?: "legacy" | "blocks";
}): Record<string, unknown> | undefined {
  const rawButtons = params.buttons.flatMap((item) =>
    Array.isArray(item) ? item : [item],
  ) as MattermostInteractiveButtonInput[];

  const buttons = rawButtons
    .map((btn) => ({
      id: normalizeStringifiedOptionalString(btn.id ?? btn.callback_data) ?? "",
      name: normalizeStringifiedOptionalString(btn.text ?? btn.name ?? btn.label) ?? "",
      style: btn.style ?? "default",
      type: btn.type,
      options: btn.options,
      context: (
        typeof btn.context === "object" && btn.context !== null
          ? {
              ...btn.context,
              [SIGNED_CHANNEL_ID_CONTEXT_KEY]: params.channelId,
            }
          : { [SIGNED_CHANNEL_ID_CONTEXT_KEY]: params.channelId }) as Record<string, unknown>,
    }))
    .filter((btn) => btn.id && btn.name);

  if (buttons.length === 0) {
    return undefined;
  }

  for (const button of buttons) {
    if (button.type !== "select") continue;
    const choices = button.options;
    if (!Array.isArray(choices) || choices.length < 1 || choices.length > 25 ||
      choices.some(choice => typeof choice.value !== "string" || !choice.value || choice.value.length > 200 || /[\x00-\x1f\x7f]/.test(choice.value) ||
        typeof choice.text !== "string" || !choice.text || choice.text.length > 100) ||
      new Set(choices.map(choice => choice.value)).size !== choices.length) {
      throw new Error("Mattermost select requires 1–25 distinct bounded choices.");
    }
    button.context = {
      [SIGNED_CHANNEL_ID_CONTEXT_KEY]: params.channelId,
      oc_select: true,
      select_nonce: randomUUID(),
      select_expires: Date.now() + 24 * 60 * 60 * 1000,
      // Only necessary SDK choice data; never arbitrary callback context.
      select_choices: choices.map(choice => ({
        text: choice.text, value: choice.value,
        ...choice.context?.oc_question === true ? {
          question_id: choice.context.question_id, option_index: choice.context.option_index,
        } : {},
      })),
    };
  }

  if (params.format === "blocks") {
    const mmBlocksActions: Record<string, unknown> = {};
    const controls = buttons.map((button) => {
      const actionId = sanitizeActionId(button.id);
      const context = { action_id: actionId, ...button.context };
      mmBlocksActions[actionId] = {
        type: "external",
        url: params.callbackUrl,
        context: {
          ...context,
          _token: generateInteractionToken(context, params.accountId),
        },
      };
      return {
        ...(button.type === "select" ? {
          type: "static_select", placeholder: button.name,
          options: button.options!.map(choice => ({ text: choice.text, value: choice.value })),
        } : { type: "button", text: button.name, style: button.style }),
        action_id: actionId,
      };
    });
    return {
      mm_blocks: [
        ...(params.text ? [{ type: "text", text: params.text }] : []),
        {
          type: "container",
          flow: "horizontal",
          gap: "small",
          content: controls,
        },
      ],
      mm_blocks_actions: mmBlocksActions,
    };
  }

  return {
    attachments: buildButtonAttachments({
      callbackUrl: params.callbackUrl,
      accountId: params.accountId,
      buttons,
      text: params.text,
    }),
  };
}

// ── Request body reader ────────────────────────────────────────────────

function readInteractionBody(req: IncomingMessage): Promise<string> {
  return readRequestBodyWithLimit(req, {
    maxBytes: INTERACTION_MAX_BODY_BYTES,
    timeoutMs: INTERACTION_BODY_TIMEOUT_MS,
    // Defer destruction so the rejection below reaches Mattermost before the close.
    destroyOnLimit: false,
  });
}

function findMattermostBlockActionName(blocks: unknown, actionId: string): string | null {
  const block = findMattermostBlockControl(blocks, actionId);
  const label = block?.text ?? block?.placeholder;
  return typeof label === "string" && label.trim() ? label.trim() : null;
}

function findMattermostBlockControl(blocks: unknown, actionId: string): Record<string, unknown> | null {
  if (!Array.isArray(blocks)) {
    return null;
  }
  const pending = [...blocks];
  let inspected = 0;
  while (pending.length > 0 && inspected < 100) {
    const raw = pending.shift();
    inspected += 1;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const block = raw as Record<string, unknown>;
    if (block.action_id === actionId) return block;
    for (const key of ["content", "header", "columns", "items"] as const) {
      if (Array.isArray(block[key])) {
        pending.push(...block[key]);
      }
    }
  }
  return null;
}

function readSelectControl(post: MattermostPost, actionId: string): {
  options: unknown; context: Record<string, unknown>;
} | null {
  const attachments = post.props?.attachments;
  if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      const action = attachment?.actions?.find((item: { id?: string }) => item?.id === actionId);
      if (action?.type === "select" && action.integration?.context) {
        return { options: action.options, context: action.integration.context };
      }
    }
  }
  const block = findMattermostBlockControl(post.props?.mm_blocks, actionId);
  const actions = post.props?.mm_blocks_actions as Record<string, { context?: Record<string, unknown> }> | undefined;
  const context = actions?.[actionId]?.context;
  return block?.type === "static_select" && context ? { options: block.options, context } : null;
}

/** Validate the mutable choice against the currently signed, bot-authored post control. */
function resolveSelectChoice(params: {
  post: MattermostPost; payload: MattermostInteractionPayload; actionId: string;
  accountId: string; botUserId: string; selected: unknown; nonce?: unknown;
}) {
  const { post, payload, actionId, selected } = params;
  if (post.id !== payload.post_id || post.channel_id !== payload.channel_id || post.user_id !== params.botUserId ||
    post.delete_at || !payload.user_id?.trim() || typeof selected !== "string" || !selected || selected.length > 200 || /[\x00-\x1f\x7f]/.test(selected)) return null;
  const control = readSelectControl(post, actionId);
  if (!control) return null;
  const { _token, ...staticContext } = control.context;
  if (staticContext.oc_select !== true || staticContext.action_id !== actionId ||
    staticContext[SIGNED_CHANNEL_ID_CONTEXT_KEY] !== payload.channel_id ||
    typeof staticContext.select_nonce !== "string" || (params.nonce !== undefined && params.nonce !== staticContext.select_nonce) ||
    typeof staticContext.select_expires !== "number" || !Number.isSafeInteger(staticContext.select_expires) || staticContext.select_expires <= Date.now() ||
    typeof _token !== "string" || !verifyInteractionToken(staticContext, _token, params.accountId)) return null;
  const choices = staticContext.select_choices;
  if (!Array.isArray(choices) || choices.length < 1 || choices.length > 25 || !Array.isArray(control.options) || choices.length !== control.options.length) return null;
  if (choices.some((choice, index) => !choice || typeof choice.value !== "string" || typeof choice.text !== "string" ||
    choice.value !== (control.options as Array<{ value?: unknown }>)[index]?.value ||
    choice.text !== (control.options as Array<{ text?: unknown }>)[index]?.text)) return null;
  const choice = choices.find(item => item.value === selected);
  if (!choice) return null;
  const isQuestion = typeof choice.question_id === "string" && Number.isInteger(choice.option_index) && choice.option_index >= 0;
  return {
    staticContext, token: _token, actionName: choice.text as string,
    context: {
      action_id: actionId, oc_select: true, select_nonce: staticContext.select_nonce,
      selected_option: selected,
      ...(isQuestion ? { oc_question: true, question_id: choice.question_id, option_index: choice.option_index } : { callback_data: selected }),
    } as Record<string, unknown>,
  };
}

async function deliverInteractionResponse(params: {
  client: MattermostClient;
  interaction: MattermostValidatedInteraction;
  response: MattermostInteractionResponse;
}): Promise<void> {
  if (params.response.update) {
    await updateMattermostPost(params.client, params.interaction.payload.post_id, {
      message: params.response.update.message,
      props: params.response.update.props,
    });
  }
  if (params.response.ephemeral_text) {
    await params.client.request("/posts/ephemeral", {
      method: "POST",
      body: JSON.stringify({
        user_id: params.interaction.payload.user_id,
        post: {
          channel_id: params.interaction.payload.channel_id,
          message: params.response.ephemeral_text,
          ...(params.interaction.post.root_id
            ? { root_id: params.interaction.post.root_id }
            : {}),
        },
      }),
    });
  }
}

/** Process a previously validated callback. Safe to invoke from the durable interaction drain. */
export function createMattermostInteractionProcessor(
  params: MattermostInteractionHandlerOptions,
): MattermostInteractionProcessor {
  const { accountId, client, log } = params;
  const core = getMattermostRuntime();
  return async (interaction) => {
    if (interaction.context.oc_select === true) {
      const currentPost = await client.request<MattermostPost>(`/posts/${encodeURIComponent(interaction.payload.post_id)}`);
      const choice = resolveSelectChoice({
        post: currentPost, payload: interaction.payload, actionId: interaction.actionId,
        accountId, botUserId: params.botUserId, selected: interaction.context.selected_option, nonce: interaction.context.select_nonce
      });
      if (!choice) return; // stale or replaced controls cannot start a replayed turn
      interaction = { ...interaction, actionName: choice.actionName, context: choice.context };
    }
    const payload: MattermostInteractionPayload = {
      ...interaction.payload,
      context: interaction.context,
    };
    const post = interaction.post as MattermostPost;
    if (params.authorizeButtonClick) {
      const authorization = await params.authorizeButtonClick({ payload, post });
      if (!authorization.ok) {
        await deliverInteractionResponse({
          client,
          interaction,
          response:
            authorization.response ?? {
              ephemeral_text: "You are not allowed to use this action here.",
            },
        });
        return;
      }
    }

    if (params.handleInteraction) {
      const response = await params.handleInteraction({
        payload,
        userName: interaction.userName,
        actionId: interaction.actionId,
        actionName: interaction.actionName,
        originalMessage: interaction.originalMessage,
        context: interaction.context,
        post,
      });
      if (response !== null) {
        await deliverInteractionResponse({ client, interaction, response });
        return;
      }
    }

    try {
      const eventLabel =
        `Mattermost button click: action="${interaction.actionId}" ` +
        `by ${interaction.userName} in channel ${payload.channel_id}`;
      const sessionKey = params.resolveSessionKey
        ? await params.resolveSessionKey({
            channelId: payload.channel_id,
            userId: payload.user_id,
            post,
          })
        : `agent:main:mattermost:${accountId}:${payload.channel_id}`;
      core.system.enqueueSystemEvent(eventLabel, {
        sessionKey,
        contextKey: `mattermost:interaction:${payload.post_id}:${interaction.actionId}${interaction.context.oc_select === true ? `:choice:${encodeURIComponent(String(interaction.context.selected_option))}` : ""}`,
      });
    } catch (error) {
      log?.(`mattermost interaction: system event dispatch failed: ${String(error)}`);
    }

    try {
      if (interaction.context.oc_select !== true) {
      await updateMattermostPost(client, payload.post_id, {
        message: interaction.originalMessage,
        props: {
          attachments: [
            {
              text: `✓ **${interaction.actionName}** selected by @${interaction.userName}`,
            },
          ],
        },
      });
      }
    } catch (error) {
      log?.(`mattermost interaction: failed to update post ${payload.post_id}: ${String(error)}`);
    }

    if (params.dispatchButtonClick) {
      try {
        await params.dispatchButtonClick({
          channelId: payload.channel_id,
          userId: payload.user_id,
          userName: interaction.userName,
          actionId: interaction.actionId,
          actionName: interaction.actionName,
          ...(typeof interaction.context.selected_option === "string" ? { selectedValue: interaction.context.selected_option } : {}),
          postId: payload.post_id,
          post,
        });
      } catch (error) {
        // Preserve the released callback contract: agent dispatch failure is logged,
        // not retried after provider-visible completion side effects have run.
        log?.(`mattermost interaction: dispatchButtonClick failed: ${String(error)}`);
      }
    }
  };
}

// ── HTTP handler ───────────────────────────────────────────────────────

export function createMattermostInteractionHandler(
  params: MattermostInteractionHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { client, accountId, log } = params;
  const core = getMattermostRuntime();

  function parseInteractionPayload(raw: string): unknown {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error("Mattermost interaction body was malformed JSON");
    }
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    // Only accept POST
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }

    if (
      !isAllowedInteractionSource({
        req,
        allowedSourceIps: params.allowedSourceIps,
        trustedProxies: params.trustedProxies,
        allowRealIpFallback: params.allowRealIpFallback,
      })
    ) {
      log?.(
        `mattermost interaction: rejected callback source remote=${req.socket?.remoteAddress ?? "?"}`,
      );
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Forbidden origin" }));
      return;
    }

    let parsedPayload: unknown;
    try {
      const raw = await readInteractionBody(req);
      parsedPayload = parseInteractionPayload(raw);
    } catch (err) {
      log?.(`mattermost interaction: failed to parse body: ${String(err)}`);
      if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) {
        await sendHttpRequestRejection(
          req,
          res,
          413,
          JSON.stringify({ error: "Payload too large" }),
          "application/json",
        );
        return;
      }
      if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) {
        await sendHttpRequestRejection(
          req,
          res,
          408,
          JSON.stringify({ error: "Request body timeout" }),
          "application/json",
        );
        return;
      }
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid request body" }));
      return;
    }

    if (
      parsedPayload &&
      typeof parsedPayload === "object" &&
      !Array.isArray(parsedPayload) &&
      (parsedPayload as Record<string, unknown>).type === "dialog_submission"
    ) {
      if (!isMattermostDialogSubmissionPayload(parsedPayload) || !params.handleDialogSubmission) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid dialog submission" }));
        return;
      }
      try {
        const response = await params.handleDialogSubmission(parsedPayload);
        res.statusCode = response.statusCode ?? 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(response.body ?? {}));
      } catch {
        // Never stringify a secret-bearing exception or request payload into logs.
        log?.("mattermost interaction: secret dialog submission failed");
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Credential submission failed" }));
      }
      return;
    }

    if (!parsedPayload || typeof parsedPayload !== "object" || Array.isArray(parsedPayload)) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid interaction payload" }));
      return;
    }
    const payload = parsedPayload as MattermostInteractionPayload;

    const context = payload.context;
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Missing context" }));
      return;
    }

    // Verify HMAC token
    const token = context["_token"];
    if (typeof token !== "string") {
      log?.("mattermost interaction: missing _token in context");
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Missing token" }));
      return;
    }

    // Strip _token before verification (it wasn't in the original context)
    let { _token, ...contextWithoutToken } = context;
    const hasSelection = context.selected_option !== undefined || payload.selected_option !== undefined;
    if (!hasSelection && !verifyInteractionToken(contextWithoutToken, token, accountId)) {
      log?.("mattermost interaction: invalid _token");
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid token" }));
      return;
    }

    const actionId = context.action_id;
    if (typeof actionId !== "string") {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Missing action_id in context" }));
      return;
    }

    const signedChannelId =
      typeof contextWithoutToken[SIGNED_CHANNEL_ID_CONTEXT_KEY] === "string"
        ? contextWithoutToken[SIGNED_CHANNEL_ID_CONTEXT_KEY].trim()
        : "";
    if (signedChannelId && signedChannelId !== payload.channel_id) {
      log?.(
        `mattermost interaction: signed channel mismatch payload=${payload.channel_id} signed=${signedChannelId}`,
      );
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Channel mismatch" }));
      return;
    }

    const userName = payload.user_name ?? payload.user_id;
    let originalMessage;
    let originalPost: MattermostPost | null;
    let clickedButtonName: string | null = null;
    try {
      originalPost = await client.request<MattermostPost>(`/posts/${payload.post_id}`);
      const postChannelId = originalPost.channel_id?.trim();
      if (!postChannelId || postChannelId !== payload.channel_id) {
        log?.(
          `mattermost interaction: post channel mismatch payload=${payload.channel_id} post=${postChannelId ?? "<missing>"}`,
        );
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Post/channel mismatch" }));
        return;
      }
      originalMessage = originalPost.message ?? "";

      if (hasSelection || context.oc_select === true) {
        const selected = context.selected_option ?? payload.selected_option;
        const choice = resolveSelectChoice({ post: originalPost, payload, actionId, accountId, botUserId: params.botUserId, selected });
        const { selected_option: _selected, ...submittedStatic } = contextWithoutToken;
        if (!choice || (context.selected_option !== undefined && payload.selected_option !== undefined && context.selected_option !== payload.selected_option) ||
          !safeEqualSecret(token, choice.token) ||
          JSON.stringify(canonicalizeInteractionContext(submittedStatic)) !== JSON.stringify(canonicalizeInteractionContext(choice.staticContext)) ||
          !verifyInteractionToken(submittedStatic, token, accountId)) {
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Invalid select choice or control" }));
          return;
        }
        // Persist only authenticated choice identity, never the token or all offered options.
        contextWithoutToken = choice.context;
        payload.context = choice.context;
        clickedButtonName = choice.actionName;
      }

      // Ensure the callback can only target an action that exists on the original post.
      const postAttachments = Array.isArray(originalPost?.props?.attachments)
        ? (originalPost.props.attachments as Array<{
            actions?: Array<{ id?: string; name?: string }>;
          }>)
        : [];
      for (const att of postAttachments) {
        const match = att.actions?.find((a) => a.id === actionId);
        if (match?.name) {
          clickedButtonName ??= match.name;
          break;
        }
      }
      clickedButtonName ??= findMattermostBlockActionName(
        originalPost?.props?.mm_blocks,
        actionId,
      );
      if (clickedButtonName === null) {
        log?.(`mattermost interaction: action ${actionId} not found in post ${payload.post_id}`);
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Unknown action" }));
        return;
      }
    } catch (err) {
      log?.(`mattermost interaction: failed to validate post ${payload.post_id}: ${String(err)}`);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Failed to validate interaction" }));
      return;
    }

    if (!originalPost) {
      log?.(`mattermost interaction: missing fetched post ${payload.post_id}`);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Failed to load interaction post" }));
      return;
    }

    log?.(
      `mattermost interaction: action=${actionId} user=${payload.user_name ?? payload.user_id} ` +
        `post=${payload.post_id} channel=${payload.channel_id}`,
    );

    if (params.authorizeButtonClick) {
      try {
        const authorization = await params.authorizeButtonClick({
          payload,
          post: originalPost,
        });
        if (!authorization.ok) {
          res.statusCode = authorization.statusCode ?? 200;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify(
              authorization.response ?? {
                ephemeral_text: "You are not allowed to use this action here.",
              },
            ),
          );
          return;
        }
      } catch (err) {
        log?.(`mattermost interaction: authorization failed: ${String(err)}`);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Interaction authorization failed" }));
        return;
      }
    }

    if (params.handleImmediateInteraction) {
      try {
        const response = await params.handleImmediateInteraction({
          payload,
          userName,
          actionId,
          actionName: clickedButtonName,
          originalMessage,
          context: contextWithoutToken,
          post: originalPost,
        });
        if (response !== null) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(response));
          return;
        }
      } catch (err) {
        log?.(`mattermost interaction: immediate handler failed: ${String(err)}`);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Interaction handler failed" }));
        return;
      }
    }

    if (params.admitInteraction) {
      const payloadWithoutContext = {
        user_id: payload.user_id, user_name: payload.user_name, channel_id: payload.channel_id,
        post_id: payload.post_id, team_id: payload.team_id,
        ...(contextWithoutToken.oc_select === true ? {} : { trigger_id: payload.trigger_id }),
      };
      const interaction: MattermostValidatedInteraction = {
        payload: payloadWithoutContext,
        userName,
        actionId,
        actionName: clickedButtonName,
        originalMessage,
        context: contextWithoutToken,
        post: {
          id: originalPost.id,
          channel_id: originalPost.channel_id,
          root_id: originalPost.root_id,
          message: originalPost.message,
        },
      };
      let releaseAfterAck: void | (() => void);
      try {
        releaseAfterAck = await params.admitInteraction(interaction);
      } catch (error) {
        log?.(`mattermost interaction: durable admission failed: ${String(error)}`);
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Interaction admission failed" }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      try {
        res.end("{}");
      } finally {
        releaseAfterAck?.();
      }
      return;
    }

    if (params.handleInteraction) {
      try {
        const response = await params.handleInteraction({
          payload,
          userName,
          actionId,
          actionName: clickedButtonName,
          originalMessage,
          context: contextWithoutToken,
          post: originalPost,
        });
        if (response !== null) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(response));
          return;
        }
      } catch (err) {
        log?.(`mattermost interaction: custom handler failed: ${String(err)}`);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Interaction handler failed" }));
        return;
      }
    }

    // Dispatch as system event so the agent can handle it.
    // Wrapped in try/catch — the post update below must still run even if
    // system event dispatch fails (e.g. missing sessionKey or channel lookup).
    try {
      const eventLabel =
        `Mattermost button click: action="${actionId}" ` +
        `by ${payload.user_name ?? payload.user_id} ` +
        `in channel ${payload.channel_id}`;

      const sessionKey = params.resolveSessionKey
        ? await params.resolveSessionKey({
            channelId: payload.channel_id,
            userId: payload.user_id,
            post: originalPost,
          })
        : `agent:main:mattermost:${accountId}:${payload.channel_id}`;

      core.system.enqueueSystemEvent(eventLabel, {
        sessionKey,
        contextKey: `mattermost:interaction:${payload.post_id}:${actionId}${contextWithoutToken.oc_select === true ? `:choice:${encodeURIComponent(String(contextWithoutToken.selected_option))}` : ""}`,
      });
    } catch (err) {
      log?.(`mattermost interaction: system event dispatch failed: ${String(err)}`);
    }

    // Update the post via API to replace buttons with a completion indicator.
    try {
      if (contextWithoutToken.oc_select !== true) {
      await updateMattermostPost(client, payload.post_id, {
        message: originalMessage,
        props: {
          attachments: [
            {
              text: `✓ **${clickedButtonName}** selected by @${userName}`,
            },
          ],
        },
      });
      }
    } catch (err) {
      log?.(`mattermost interaction: failed to update post ${payload.post_id}: ${String(err)}`);
    }

    // Respond with empty JSON — the post update is handled above
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end("{}");

    // Dispatch a synthetic inbound message so the agent responds to the button click.
    if (params.dispatchButtonClick) {
      try {
        await params.dispatchButtonClick({
          channelId: payload.channel_id,
          userId: payload.user_id,
          userName,
          actionId,
          actionName: clickedButtonName,
          ...(typeof contextWithoutToken.selected_option === "string" ? { selectedValue: contextWithoutToken.selected_option } : {}),
          postId: payload.post_id,
          post: originalPost,
        });
      } catch (err) {
        log?.(`mattermost interaction: dispatchButtonClick failed: ${String(err)}`);
      }
    }
  };
}
