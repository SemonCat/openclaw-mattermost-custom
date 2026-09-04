/**
 * HTTP callback handler for Mattermost slash commands.
 *
 * Receives POST requests from Mattermost when a slash command is invoked,
 * validates the token, and routes the command through the standard inbound pipeline.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  resolveMattermostReplyToMode,
  type ResolvedMattermostAccount,
} from "../mattermost/accounts.js";
import { getMattermostRuntime } from "../runtime.js";
import {
  createMattermostClient,
  fetchMattermostChannel,
  sendMattermostTyping,
  type MattermostChannel,
} from "./client.js";
import {
  renderMattermostModelSummaryView,
  renderMattermostModelsPickerView,
  renderMattermostProviderPickerView,
  resolveMattermostModelPickerCurrentModel,
  resolveMattermostModelPickerEntry,
} from "./model-picker.js";
import {
  pinMattermostExplicitDefaultModelSelection,
  rewriteMattermostPinnedModelReply,
} from "./model-session-pin.js";
import {
  authorizeMattermostCommandInvocation,
  normalizeMattermostAllowList,
} from "./monitor-auth.js";
import { resolveMattermostThreadSessionContext } from "./monitor-context.js";
import {
  createMattermostReplyDeliveryBarrier,
  deliverMattermostReplyPayload,
} from "./reply-delivery.js";
import {
  buildModelsProviderData,
  isRequestBodyLimitError,
  logTypingFailure,
  readRequestBodyWithLimit,
  sendHttpRequestRejection,
  type OpenClawConfig,
  type RuntimeEnv,
} from "./runtime-api.js";
import { sendMessageMattermost } from "./send.js";
import {
  isMattermostSessionAdmissionRaceError,
  withMattermostSessionAdmissionRetry,
} from "./session-admission-retry.js";
import {
  MATTERMOST_SLASH_POST_METHOD,
  getMattermostCommand,
  listMattermostCommands,
  normalizeSlashCommandTrigger,
  parseSlashCommandPayload,
  resolveCommandText,
  type MattermostRegisteredCommand,
  type MattermostCommandResponse,
  type MattermostSlashCommandResponse,
  type MattermostSlashCommandPayload,
} from "./slash-commands.js";

type SlashHttpHandlerParams = {
  account: ResolvedMattermostAccount;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  /** Commands registered or reconciled during monitor startup. */
  registeredCommands: readonly MattermostRegisteredCommand[];
  /** Map from trigger to original command name (for skill commands that start with oc_). */
  triggerMap?: ReadonlyMap<string, string>;
  log?: (msg: string) => void;
  bodyTimeoutMs?: number;
};

const MAX_BODY_BYTES = 64 * 1024;
const BODY_READ_TIMEOUT_MS = 5_000;
const COMMAND_LOOKUP_TIMEOUT_MS = 1_000;
const COMMAND_VALIDATION_FAILURE_CACHE_MS = 5_000;
const COMMAND_VALIDATION_FAILURE_CACHE_MAX_KEYS = 2_000;
const COMMAND_VALIDATION_LOOKUP_BURST = 20;
const COMMAND_VALIDATION_LOOKUP_REFILL_MS = 500;
const COMMAND_VALIDATION_LOOKUP_LIMIT_LOG_MS = 5_000;
const COMMAND_VALIDATION_LOOKUP_RATE_LIMIT_MAX_KEYS = 2_000;
type CommandLookupInflightEntry = {
  accountId: string;
  promise: Promise<CurrentCommandLookupResult>;
};
type CurrentCommandLookupResult =
  | { status: "found"; command: MattermostCommandResponse }
  | { status: "missing" }
  | { status: "unavailable" };
type SlashCommandTokenValidation = "valid" | "invalid" | "unavailable";
type CommandValidationRateLimitEntry = {
  accountId: string;
  tokens: number;
  updatedAt: number;
  lastLimitedLogAt: number;
};
const commandLookupInflight = new Map<string, CommandLookupInflightEntry>();
const commandValidationFailureCache = new Map<string, { accountId: string; expiresAt: number }>();
const commandValidationLookupRateLimit = new Map<string, CommandValidationRateLimitEntry>();
const SECRET_LOG_KEYS = new Set([
  "access_token",
  "authorization",
  "bottoken",
  "client_secret",
  "refresh_token",
  "token",
]);

export function resolveMattermostSlashAcknowledgement(commandText: string): string {
  const match = commandText.trim().match(/^\/channel_model(?:\s+(.+))?$/iu);
  const args = match?.[1]?.trim().toLowerCase();
  if (args && args !== "status" && args !== "help") {
    return "⏳ Channel model update received. Waiting for Gateway runtime activation…";
  }
  return "Processing...";
}

/**
 * Read the full request body as a string.
 */
function readBody(
  req: IncomingMessage,
  maxBytes: number,
  timeoutMs = BODY_READ_TIMEOUT_MS,
): Promise<string> {
  return readRequestBodyWithLimit(req, {
    maxBytes,
    timeoutMs,
    // Defer destruction so the rejection below reaches Mattermost before the close.
    destroyOnLimit: false,
  });
}

function sendJsonResponse(
  res: ServerResponse,
  status: number,
  body: MattermostSlashCommandResponse,
) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function findRegisteredCommandForPayload(params: {
  registeredCommands: readonly MattermostRegisteredCommand[];
  payload: MattermostSlashCommandPayload;
}): MattermostRegisteredCommand | undefined {
  const trigger = normalizeSlashCommandTrigger(params.payload.command);
  return params.registeredCommands.find(
    (cmd) => cmd.teamId === params.payload.team_id && cmd.trigger === trigger,
  );
}

function isDeletedMattermostCommand(command: { delete_at?: number }): boolean {
  return typeof command.delete_at === "number" && command.delete_at > 0;
}

function sanitizeCommandLookupError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const sanitized = raw
    .replace(/[\r\n\t]/gu, " ")
    .replace(/https?:\/\/[^\s)\]}]+/giu, (urlText) => {
      try {
        const url = new URL(urlText);
        if (url.username || url.password) {
          url.username = "redacted";
          url.password = "redacted";
        }
        for (const key of url.searchParams.keys()) {
          if (SECRET_LOG_KEYS.has(key.toLowerCase())) {
            url.searchParams.set(key, "redacted");
          }
        }
        return url.toString();
      } catch {
        return urlText;
      }
    })
    .replace(/(^|[^\w-])(Bearer|Token)\s+[A-Za-z0-9._~+/=-]+/giu, "$1$2 [redacted]")
    .replace(
      /\b(token|authorization|access_token|refresh_token|client_secret|botToken)\b(\s*["']?\s*(?:=|:)\s*["']?)[^"',\s;}]+/giu,
      "$1$2[redacted]",
    );
  return truncateUtf16Safe(sanitized, 300);
}

function sanitizeMattermostLogValue(value: string): string {
  return truncateUtf16Safe(value.replace(/[\r\n\t]/gu, " "), 200);
}

async function withCommandLookupTimeout<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COMMAND_LOOKUP_TIMEOUT_MS);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function commandLookupKey(
  client: ReturnType<typeof createMattermostClient>,
  registered: MattermostRegisteredCommand,
  accountId: string,
): string {
  return `${client.apiBaseUrl}:${accountId}:${registered.teamId}:${registered.id}`;
}

export function clearMattermostSlashCommandValidationCacheForAccount(accountId: string): void {
  for (const [key, entry] of commandValidationFailureCache) {
    if (entry.accountId === accountId) {
      commandValidationFailureCache.delete(key);
    }
  }
  for (const [key, entry] of commandLookupInflight) {
    if (entry.accountId === accountId) {
      commandLookupInflight.delete(key);
    }
  }
  for (const [key, entry] of commandValidationLookupRateLimit) {
    if (entry.accountId === accountId) {
      commandValidationLookupRateLimit.delete(key);
    }
  }
}

function sweepCommandValidationFailureCache(now = Date.now()): void {
  const validNow = asDateTimestampMs(now);
  if (validNow === undefined) {
    commandValidationFailureCache.clear();
    return;
  }
  for (const [key, entry] of commandValidationFailureCache) {
    const expiresAt = asDateTimestampMs(entry.expiresAt);
    if (expiresAt === undefined || expiresAt <= validNow) {
      commandValidationFailureCache.delete(key);
    }
  }
  while (commandValidationFailureCache.size > COMMAND_VALIDATION_FAILURE_CACHE_MAX_KEYS) {
    const oldestKey = commandValidationFailureCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    commandValidationFailureCache.delete(oldestKey);
  }
}

function hasCachedCommandValidationFailure(key: string, now = Date.now()): boolean {
  sweepCommandValidationFailureCache(now);
  const validNow = asDateTimestampMs(now);
  if (validNow === undefined) {
    return false;
  }
  const cached = commandValidationFailureCache.get(key);
  if (!cached) {
    return false;
  }
  const expiresAt = asDateTimestampMs(cached.expiresAt);
  if (expiresAt !== undefined && expiresAt > validNow) {
    return true;
  }
  commandValidationFailureCache.delete(key);
  return false;
}

function cacheCommandValidationFailure(key: string, accountId: string): void {
  const now = Date.now();
  sweepCommandValidationFailureCache(now);
  const expiresAt = resolveExpiresAtMsFromDurationMs(COMMAND_VALIDATION_FAILURE_CACHE_MS, {
    nowMs: now,
  });
  if (expiresAt === undefined) {
    commandValidationFailureCache.delete(key);
    return;
  }
  commandValidationFailureCache.set(key, {
    accountId,
    expiresAt,
  });
}

function sweepCommandValidationLookupRateLimit(now = Date.now()): void {
  const validNow = asDateTimestampMs(now);
  if (validNow === undefined) {
    commandValidationLookupRateLimit.clear();
    return;
  }
  const staleAfterMs = COMMAND_VALIDATION_LOOKUP_REFILL_MS * COMMAND_VALIDATION_LOOKUP_BURST * 2;
  for (const [key, entry] of commandValidationLookupRateLimit) {
    const updatedAt = asDateTimestampMs(entry.updatedAt);
    if (updatedAt === undefined || validNow - updatedAt > staleAfterMs) {
      commandValidationLookupRateLimit.delete(key);
    }
  }
  while (commandValidationLookupRateLimit.size > COMMAND_VALIDATION_LOOKUP_RATE_LIMIT_MAX_KEYS) {
    const oldestKey = commandValidationLookupRateLimit.keys().next().value;
    if (!oldestKey) {
      break;
    }
    commandValidationLookupRateLimit.delete(oldestKey);
  }
}

function reserveCommandValidationLookup(params: {
  key: string;
  accountId: string;
  now?: number;
}): { allowed: true } | { allowed: false; shouldLog: boolean } {
  const rawNow = params.now ?? Date.now();
  const now = asDateTimestampMs(rawNow);
  if (now === undefined) {
    commandValidationLookupRateLimit.clear();
    return { allowed: true };
  }
  sweepCommandValidationLookupRateLimit(now);
  const existing = commandValidationLookupRateLimit.get(params.key);
  if (!existing) {
    commandValidationLookupRateLimit.set(params.key, {
      accountId: params.accountId,
      tokens: COMMAND_VALIDATION_LOOKUP_BURST - 1,
      updatedAt: now,
      lastLimitedLogAt: 0,
    });
    return { allowed: true };
  }

  const refill = Math.floor((now - existing.updatedAt) / COMMAND_VALIDATION_LOOKUP_REFILL_MS);
  if (refill > 0) {
    existing.tokens = Math.min(COMMAND_VALIDATION_LOOKUP_BURST, existing.tokens + refill);
    existing.updatedAt += refill * COMMAND_VALIDATION_LOOKUP_REFILL_MS;
  }
  if (existing.tokens <= 0) {
    const shouldLog = now - existing.lastLimitedLogAt >= COMMAND_VALIDATION_LOOKUP_LIMIT_LOG_MS;
    if (shouldLog) {
      existing.lastLimitedLogAt = now;
    }
    return { allowed: false, shouldLog };
  }
  existing.tokens -= 1;
  return { allowed: true };
}

async function fetchCurrentMattermostCommandUncached(params: {
  client: ReturnType<typeof createMattermostClient>;
  registered: MattermostRegisteredCommand;
  log?: (msg: string) => void;
}): Promise<CurrentCommandLookupResult> {
  let commandLookupResult: MattermostCommandResponse | null = null;
  let commandLookupError: unknown;
  let commandLookupFallbackDetail: string | undefined;
  try {
    commandLookupResult = await withCommandLookupTimeout((signal) =>
      getMattermostCommand(params.client, params.registered.id, { signal }),
    );
    if (!isDeletedMattermostCommand(commandLookupResult)) {
      return { status: "found", command: commandLookupResult };
    }
    commandLookupFallbackDetail = `command lookup by id returned deleted command ${sanitizeMattermostLogValue(commandLookupResult.id)}`;
  } catch (err) {
    commandLookupError = err;
    // Older Mattermost servers may not expose GET /commands/{id}; fall back to
    // the team command list, which registration already requires.
  }

  try {
    const currentCommands = await withCommandLookupTimeout((signal) =>
      listMattermostCommands(params.client, params.registered.teamId, { signal }),
    );
    if (commandLookupError) {
      params.log?.(
        `mattermost: slash command lookup by id failed for /${sanitizeMattermostLogValue(params.registered.trigger)}; using team list fallback: ${sanitizeCommandLookupError(commandLookupError)}`,
      );
    } else if (commandLookupFallbackDetail) {
      params.log?.(
        `mattermost: slash ${commandLookupFallbackDetail} for /${sanitizeMattermostLogValue(params.registered.trigger)}; using team list fallback`,
      );
    }
    const current = currentCommands.find((cmd) => cmd.id === params.registered.id);
    if (current) {
      return { status: "found", command: current };
    }
    if (commandLookupResult) {
      return { status: "found", command: commandLookupResult };
    }
    return { status: "missing" };
  } catch (err) {
    const primaryDetail = commandLookupError
      ? `; command lookup: ${sanitizeCommandLookupError(commandLookupError)}`
      : commandLookupFallbackDetail
        ? `; command lookup: ${commandLookupFallbackDetail}`
        : "";
    params.log?.(
      `mattermost: slash command registration check failed for /${sanitizeMattermostLogValue(params.registered.trigger)}: ${sanitizeCommandLookupError(err)}${primaryDetail}`,
    );
    if (commandLookupResult) {
      return { status: "found", command: commandLookupResult };
    }
    return { status: "unavailable" };
  }
}

async function fetchCurrentMattermostCommand(params: {
  accountId: string;
  client: ReturnType<typeof createMattermostClient>;
  registered: MattermostRegisteredCommand;
  log?: (msg: string) => void;
}): Promise<CurrentCommandLookupResult> {
  const key = commandLookupKey(params.client, params.registered, params.accountId);
  const existing = commandLookupInflight.get(key);
  if (existing) {
    return await existing.promise;
  }

  const lookup = fetchCurrentMattermostCommandUncached(params).finally(() => {
    commandLookupInflight.delete(key);
  });
  commandLookupInflight.set(key, { accountId: params.accountId, promise: lookup });
  return await lookup;
}

async function validateMattermostSlashCommandToken(params: {
  accountId: string;
  client: ReturnType<typeof createMattermostClient>;
  registeredCommand: MattermostRegisteredCommand;
  payload: MattermostSlashCommandPayload;
  log?: (msg: string) => void;
}): Promise<SlashCommandTokenValidation> {
  const lookupKey = commandLookupKey(params.client, params.registeredCommand, params.accountId);
  if (hasCachedCommandValidationFailure(lookupKey)) {
    return "invalid";
  }
  if (!commandLookupInflight.has(lookupKey)) {
    const reservation = reserveCommandValidationLookup({
      key: lookupKey,
      accountId: params.accountId,
    });
    if (!reservation.allowed) {
      if (reservation.shouldLog) {
        params.log?.(
          `mattermost: slash command validation lookup rate-limited for /${sanitizeMattermostLogValue(params.registeredCommand.trigger)}`,
        );
      }
      return "unavailable";
    }
  }
  const lookup = await fetchCurrentMattermostCommand({
    accountId: params.accountId,
    client: params.client,
    registered: params.registeredCommand,
    log: params.log,
  });
  if (lookup.status === "unavailable") {
    return "unavailable";
  }
  if (lookup.status === "missing" || isDeletedMattermostCommand(lookup.command)) {
    cacheCommandValidationFailure(lookupKey, params.accountId);
    return "invalid";
  }
  const current = lookup.command;
  if (
    current.id !== params.registeredCommand.id ||
    current.team_id !== params.registeredCommand.teamId ||
    current.trigger !== params.registeredCommand.trigger ||
    current.method !== MATTERMOST_SLASH_POST_METHOD ||
    current.url !== params.registeredCommand.url
  ) {
    cacheCommandValidationFailure(lookupKey, params.accountId);
    return "invalid";
  }
  if (!current.token || !safeEqualSecret(params.payload.token, current.token)) {
    return "invalid";
  }
  commandValidationFailureCache.delete(lookupKey);
  return "valid";
}

type SlashInvocationAuth = {
  ok: boolean;
  denyResponse?: MattermostSlashCommandResponse;
  commandAuthorized: boolean;
  channelInfo: MattermostChannel | null;
  kind: "direct" | "group" | "channel";
  chatType: "direct" | "group" | "channel";
  channelName: string;
  channelDisplay: string;
  roomLabel: string;
};

async function authorizeSlashInvocation(params: {
  account: ResolvedMattermostAccount;
  cfg: OpenClawConfig;
  client: ReturnType<typeof createMattermostClient>;
  commandText: string;
  channelId: string;
  senderId: string;
  senderName: string;
  log?: (msg: string) => void;
}): Promise<SlashInvocationAuth> {
  const { account, cfg, client, commandText, channelId, senderId, senderName, log } = params;
  const core = getMattermostRuntime();

  // Resolve channel info so we can enforce DM vs group/channel policies.
  let channelInfo: MattermostChannel | null = null;
  try {
    channelInfo = await fetchMattermostChannel(client, channelId);
  } catch (err) {
    log?.(
      `mattermost: slash channel lookup failed for ${sanitizeMattermostLogValue(channelId)}: ${sanitizeCommandLookupError(err)}`,
    );
  }

  if (!channelInfo) {
    return {
      ok: false,
      denyResponse: {
        response_type: "ephemeral",
        text: "Temporary error: unable to determine channel type. Please try again.",
      },
      commandAuthorized: false,
      channelInfo: null,
      kind: "channel",
      chatType: "channel",
      channelName: "",
      channelDisplay: "",
      roomLabel: `#${channelId}`,
    };
  }

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg,
    surface: "mattermost",
  });
  const hasControlCommand = core.channel.text.hasControlCommand(commandText, cfg);
  const storeAllowFrom = normalizeMattermostAllowList(
    await core.channel.pairing
      .readAllowFromStore({
        channel: "mattermost",
        accountId: account.accountId,
      })
      .catch(() => []),
  );
  const decision = await authorizeMattermostCommandInvocation({
    account,
    cfg,
    senderId,
    senderName,
    channelId,
    channelInfo,
    storeAllowFrom,
    allowTextCommands,
    hasControlCommand,
  });

  if (!decision.ok) {
    if (decision.denyReason === "dm-pairing") {
      const { code } = await core.channel.pairing.upsertPairingRequest({
        channel: "mattermost",
        accountId: account.accountId,
        id: senderId,
        meta: { name: senderName },
      });
      return {
        ...decision,
        denyResponse: {
          response_type: "ephemeral",
          text: core.channel.pairing.buildPairingReply({
            channel: "mattermost",
            idLine: `Your Mattermost user id: ${senderId}`,
            code,
          }),
        },
      };
    }

    const denyText =
      decision.denyReason === "unknown-channel"
        ? "Temporary error: unable to determine channel type. Please try again."
        : decision.denyReason === "dm-disabled"
          ? "This bot is not accepting direct messages."
          : decision.denyReason === "channels-disabled"
            ? "Slash commands are disabled in channels."
            : decision.denyReason === "channel-no-allowlist"
              ? "Slash commands are not configured for this channel (no allowlist)."
              : "Unauthorized.";
    return {
      ...decision,
      denyResponse: {
        response_type: "ephemeral",
        text: denyText,
      },
    };
  }

  return {
    ...decision,
    denyResponse: undefined,
  };
}

/**
 * Create the HTTP request handler for Mattermost slash command callbacks.
 *
 * This handler is registered as a plugin HTTP route and receives POSTs
 * from the Mattermost server when a user invokes a registered slash command.
 */
export function createSlashCommandHttpHandler(params: SlashHttpHandlerParams) {
  const { account, runtime, registeredCommands, triggerMap, log, bodyTimeoutMs } = params;

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    bufferedBody?: string,
  ): Promise<void> => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return;
    }

    let body: string;
    try {
      body = bufferedBody ?? (await readBody(req, MAX_BODY_BYTES, bodyTimeoutMs));
    } catch (error) {
      if (isRequestBodyLimitError(error, "REQUEST_BODY_TIMEOUT")) {
        await sendHttpRequestRejection(req, res, 408, "Request body timeout");
        return;
      }
      await sendHttpRequestRejection(req, res, 413, "Payload Too Large");
      return;
    }

    const contentType = req.headers["content-type"] ?? "";
    const payload = parseSlashCommandPayload(body, contentType);
    if (!payload) {
      sendJsonResponse(res, 400, {
        response_type: "ephemeral",
        text: "Invalid slash command payload.",
      });
      return;
    }

    const registeredCommand = findRegisteredCommandForPayload({ registeredCommands, payload });

    // Fail closed when the payload does not map to a command registered for
    // this exact team and trigger. Token validation below remains scoped to
    // that resolved command rather than accepting any token in the account.
    if (registeredCommands.length === 0 || !registeredCommand) {
      sendJsonResponse(res, 401, {
        response_type: "ephemeral",
        text: "Unauthorized: invalid command token.",
      });
      return;
    }

    // Validate every callback against the current Mattermost command record.
    // The startup token is only a reconciliation snapshot and may have been
    // revoked or rotated after this handler was created.
    const client = createMattermostClient({
      baseUrl: account.baseUrl ?? "",
      botToken: account.botToken ?? "",
      allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
    });
    const validation = await validateMattermostSlashCommandToken({
      accountId: account.accountId,
      client,
      registeredCommand,
      payload,
      log,
    });
    if (validation === "unavailable") {
      sendJsonResponse(res, 503, {
        response_type: "ephemeral",
        text: "Temporary error validating the command token. Please try again.",
      });
      return;
    }
    if (validation === "invalid") {
      sendJsonResponse(res, 401, {
        response_type: "ephemeral",
        text: "Unauthorized: invalid command token.",
      });
      return;
    }

    // The monitor can outlive a config hot reload. Pin each invocation to the
    // current runtime snapshot so authorization, catalog reads, and delivery
    // do not use the monitor's superseded startup config.
    const currentCfg = getMattermostRuntime().config.current() as OpenClawConfig;

    // Extract command info
    const trigger = normalizeSlashCommandTrigger(payload.command);
    const commandText = resolveCommandText(trigger, payload.text, triggerMap);
    const channelId = payload.channel_id;
    const senderId = payload.user_id;
    const senderName = payload.user_name ?? senderId;

    const auth = await authorizeSlashInvocation({
      account,
      cfg: currentCfg,
      client,
      commandText,
      channelId,
      senderId,
      senderName,
      log,
    });

    if (!auth.ok) {
      sendJsonResponse(
        res,
        200,
        auth.denyResponse ?? { response_type: "ephemeral", text: "Unauthorized." },
      );
      return;
    }

    log?.(
      `mattermost: slash command /${sanitizeMattermostLogValue(trigger)} from ${sanitizeMattermostLogValue(senderName)} in ${sanitizeMattermostLogValue(channelId)}`,
    );

    // Acknowledge immediately — we'll send the actual reply asynchronously
    sendJsonResponse(res, 200, {
      response_type: "ephemeral",
      text: resolveMattermostSlashAcknowledgement(commandText),
    });

    // Now handle the command asynchronously (post reply as a message)
    try {
      await handleSlashCommandAsync({
        account,
        cfg: currentCfg,
        runtime,
        client,
        commandText,
        channelId,
        senderId,
        senderName,
        teamId: payload.team_id,
        triggerId: payload.trigger_id,
        rootId: payload.root_id,
        kind: auth.kind,
        chatType: auth.chatType,
        channelName: auth.channelName,
        channelDisplay: auth.channelDisplay,
        roomLabel: auth.roomLabel,
        commandAuthorized: auth.commandAuthorized,
        log,
      });
    } catch (err) {
      log?.(`mattermost: slash command handler error: ${sanitizeCommandLookupError(err)}`);
      try {
        const to = `channel:${channelId}`;
        // Preserve the invocation's root_id so this last-resort fallback still lands in the
        // thread the user invoked from, matching handleSlashCommandAsync's own error delivery.
        await sendMessageMattermost(to, "Sorry, something went wrong processing that command.", {
          cfg: currentCfg,
          accountId: account.accountId,
          replyToId: payload.root_id,
        });
      } catch {
        // best-effort error reply
      }
    }
  };
}

async function handleSlashCommandAsync(params: {
  account: ResolvedMattermostAccount;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  client: ReturnType<typeof createMattermostClient>;
  commandText: string;
  channelId: string;
  senderId: string;
  senderName: string;
  teamId: string;
  kind: "direct" | "group" | "channel";
  chatType: "direct" | "group" | "channel";
  channelName: string;
  channelDisplay: string;
  roomLabel: string;
  commandAuthorized: boolean;
  triggerId?: string;
  rootId?: string;
  log?: (msg: string) => void;
}) {
  const {
    account,
    cfg,
    runtime,
    client,
    commandText,
    channelId,
    senderId,
    senderName,
    teamId,
    kind,
    chatType,
    channelName: _channelName,
    channelDisplay,
    roomLabel,
    commandAuthorized,
    triggerId,
    rootId,
    log,
  } = params;
  const core = getMattermostRuntime();

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "mattermost",
    accountId: account.accountId,
    teamId,
    peer: {
      kind,
      id: kind === "direct" ? senderId : channelId,
    },
  });

  // Native slash callbacks carry `root_id` only when invoked from a thread's reply box (no
  // post id of their own to start a new thread with otherwise), so this mirrors the WS post
  // path's thread-session resolution using only that field: /stop and replies then target the
  // exact thread session instead of always falling back to the flat channel/DM-level session.
  const thread = resolveMattermostThreadSessionContext({
    baseSessionKey: route.sessionKey,
    kind,
    postId: undefined,
    replyToMode: resolveMattermostReplyToMode(account, kind),
    threadRootId: rootId,
  });

  const fromLabel =
    kind === "direct"
      ? `Mattermost DM from ${senderName}`
      : `Mattermost message in ${roomLabel} from ${senderName}`;

  const to = kind === "direct" ? `user:${senderId}` : `channel:${channelId}`;
  const pickerEntry = resolveMattermostModelPickerEntry(commandText);
  if (pickerEntry) {
    const data = await buildModelsProviderData(cfg, route.agentId);
    if (data.providers.length === 0) {
      await sendMessageMattermost(`channel:${channelId}`, "No models available.", {
        cfg,
        accountId: account.accountId,
        replyToId: thread.effectiveReplyToId,
      });
      return;
    }

    const currentModel = resolveMattermostModelPickerCurrentModel({
      cfg,
      route: {
        agentId: route.agentId,
        sessionKey: thread.sessionKey,
      },
      data,
    });
    const view =
      pickerEntry.kind === "summary"
        ? renderMattermostModelSummaryView({
            ownerUserId: senderId,
            currentModel,
          })
        : pickerEntry.kind === "providers"
          ? renderMattermostProviderPickerView({
              ownerUserId: senderId,
              data,
              currentModel,
            })
          : renderMattermostModelsPickerView({
              ownerUserId: senderId,
              data,
              provider: pickerEntry.provider,
              page: 1,
              currentModel,
            });

    await sendMessageMattermost(`channel:${channelId}`, view.text, {
      cfg,
      accountId: account.accountId,
      buttons: view.buttons,
      replyToId: thread.effectiveReplyToId,
    });
    runtime.log?.(`delivered model picker to ${to}`);
    return;
  }

  // The core session-admission race this retries only surfaces as a rejection right at
  // dispatch's admission check (before any delivery), typically caused by a concurrent config
  // hot reload changing the session record mid-flight. Re-resolving cfg/route/thread/ctxPayload
  // fresh on every attempt — instead of replaying the first attempt's snapshot — means a retry
  // targets current routing rather than a session shape config has already superseded.
  // MessageSid/Timestamp are captured once below so both attempts stay the same invocation.
  const invocationSid = triggerId ?? `slash-${Date.now()}`;
  const invocationTimestamp = Date.now();

  const resolveDispatchAttempt = () => {
    const attemptCfg = getMattermostRuntime().config.current() as OpenClawConfig;
    const attemptRoute = core.channel.routing.resolveAgentRoute({
      cfg: attemptCfg,
      channel: "mattermost",
      accountId: account.accountId,
      teamId,
      peer: {
        kind,
        id: kind === "direct" ? senderId : channelId,
      },
    });
    const attemptThread = resolveMattermostThreadSessionContext({
      baseSessionKey: attemptRoute.sessionKey,
      kind,
      postId: undefined,
      replyToMode: resolveMattermostReplyToMode(account, kind),
      threadRootId: rootId,
    });
    // Build inbound context — the command text is the body
    const attemptCtxPayload = finalizeInboundContext({
      Body: commandText,
      BodyForAgent: commandText,
      RawBody: commandText,
      CommandBody: commandText,
      From:
        kind === "direct"
          ? `mattermost:${senderId}`
          : kind === "group"
            ? `mattermost:group:${channelId}`
            : `mattermost:channel:${channelId}`,
      To: to,
      SessionKey: attemptThread.sessionKey,
      ParentSessionKey: attemptThread.parentSessionKey,
      AccountId: attemptRoute.accountId,
      ChatType: chatType,
      ConversationRouteContextObserved: true,
      ConversationRoutePeerId: kind === "direct" ? senderId : channelId,
      ConversationLabel: fromLabel,
      GroupSpace: teamId,
      GroupSubject: kind !== "direct" ? channelDisplay || roomLabel : undefined,
      SenderName: senderName,
      SenderId: senderId,
      Provider: "mattermost" as const,
      Surface: "mattermost" as const,
      MessageSid: invocationSid,
      Timestamp: invocationTimestamp,
      WasMentioned: true,
      CommandAuthorized: commandAuthorized,
      InboundAccessAuthorized: true,
      CommandSource: "native" as const,
      OriginatingChannel: "mattermost" as const,
      OriginatingTo: to,
      ReplyToId: attemptThread.effectiveReplyToId,
      MessageThreadId: attemptThread.effectiveReplyToId,
    });
    return {
      cfg: attemptCfg,
      route: attemptRoute,
      thread: attemptThread,
      ctxPayload: attemptCtxPayload,
    };
  };

  // Set as soon as typing starts or a reply is delivered, proving this attempt passed
  // admission and started user-visible work. A session-admission retry below must never
  // re-run past that point.
  let hasStartedWork = false;
  let lastAttempt: ReturnType<typeof resolveDispatchAttempt> | undefined;

  try {
    await withMattermostSessionAdmissionRetry({
      hasStartedWork: () => hasStartedWork,
      run: () => {
        const attempt = resolveDispatchAttempt();
        let modelPinResult: ReturnType<typeof pinMattermostExplicitDefaultModelSelection> | undefined;
        lastAttempt = attempt;
        const textLimit = core.channel.text.resolveTextChunkLimit(
          attempt.cfg,
          "mattermost",
          account.accountId,
          { fallbackLimit: account.textChunkLimit ?? 4000 },
        );
        const tableMode = core.channel.text.resolveMarkdownTableMode({
          cfg: attempt.cfg,
          channel: "mattermost",
          accountId: account.accountId,
        });
        const humanDelay = resolveHumanDelayConfig(attempt.cfg, attempt.route.agentId);
        const deliveryBarrier = createMattermostReplyDeliveryBarrier({
          isDirect: kind === "direct",
          dmRetryOptions: account.config.dmChannelRetry,
        });
        return core.channel.inbound.dispatch({
          cfg: attempt.cfg,
          channel: "mattermost",
          accountId: account.accountId,
          route: {
            agentId: attempt.route.agentId,
            dmScope: attempt.route.dmScope,
            sessionKey: attempt.route.sessionKey,
          },
          ctxPayload: attempt.ctxPayload,
          delivery: {
            observeMessageSent: true,
            deliver: async (payload) => {
              hasStartedWork = true;
              let deliveredPayload = payload;
              try {
                modelPinResult ??= pinMattermostExplicitDefaultModelSelection({
                  agentId: attempt.route.agentId,
                  cfg: attempt.cfg,
                  commandText,
                  sessionKey: attempt.thread.sessionKey,
                });
                const pin = await modelPinResult;
                if (pin.pinned) {
                  deliveredPayload = {
                    ...payload,
                    text: rewriteMattermostPinnedModelReply(payload.text ?? "", pin.modelRef),
                  };
                }
              } catch (error) {
                runtime.error?.(
                  `mattermost explicit model pin failed: ${sanitizeCommandLookupError(error)}`,
                );
                deliveredPayload = {
                  ...payload,
                  text: "Model change could not be saved for this Mattermost session. Please retry.",
                  isError: true,
                };
              }
              const result = await deliverMattermostReplyPayload({
                core,
                cfg: attempt.cfg,
                payload: deliveredPayload,
                channelId,
                accountId: account.accountId,
                agentId: attempt.route.agentId,
                replyToId: attempt.thread.effectiveReplyToId,
                textLimit,
                tableMode,
                sendMessage: sendMessageMattermost,
                onDmChannelResolution: deliveryBarrier.trackDmChannelResolution,
              });
              if (result.visibleReplySent) {
                runtime.log?.(`delivered slash reply to ${to}`);
              }
              return result;
            },
            onError: (err, info) => {
              runtime.error?.(
                `mattermost slash ${info.kind} reply failed: ${sanitizeCommandLookupError(err)}`,
              );
            },
          },
          replyPipeline: {
            typing: {
              start: () => {
                hasStartedWork = true;
                return sendMattermostTyping(client, {
                  channelId,
                  parentId: attempt.thread.effectiveReplyToId,
                });
              },
              onStartError: (err) => {
                logTypingFailure({
                  log: (message) => log?.(message),
                  channel: "mattermost",
                  target: channelId,
                  error: err,
                });
              },
            },
          },
          dispatcherOptions: {
            resolveFollowupAdmissionBarrierTimeoutPolicy: deliveryBarrier.resolveTimeoutPolicy,
            onDeliverySettled: deliveryBarrier.markDeliverySettled,
            humanDelay,
          },
          replyOptions: {
            disableBlockStreaming:
              typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
          },
        });
      },
    });
  } catch (error) {
    // Only take over error delivery for the specific race pattern, and only while nothing
    // has been delivered yet (hasStartedWork false) — any other error, or this same race
    // after work started, falls through to the HTTP handler's generic fallback below.
    // Because hasStartedWork is false in this branch, replying here can never duplicate a
    // successful dispatch.
    if (!hasStartedWork && isMattermostSessionAdmissionRaceError(error)) {
      log?.(
        `mattermost: slash command session-admission race did not clear after retry; sending actionable reply: ${sanitizeCommandLookupError(error)}`,
      );
      try {
        await sendMessageMattermost(
          `channel:${channelId}`,
          "Still finishing a previous action in this conversation. Please wait a few seconds and run the command again.",
          {
            cfg: lastAttempt?.cfg ?? cfg,
            accountId: account.accountId,
            replyToId: lastAttempt?.thread.effectiveReplyToId,
          },
        );
        return;
      } catch {
        // Fall through to the HTTP handler's generic best-effort fallback.
      }
    }
    throw error;
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
