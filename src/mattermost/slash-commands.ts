import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
// Mattermost plugin module implements slash commands behavior.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isWildcardBindHost } from "./callback-host.js";
import type { MattermostClient } from "./client.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export const MATTERMOST_SLASH_POST_METHOD = "P";
const MATTERMOST_COMMAND_DESCRIPTION_MAX_BYTES = 128;

// Mattermost rejects command descriptions above 128 UTF-8 bytes. Keep portable
// descriptions intact until this API boundary so other channels retain their text.
function truncateMattermostCommandDescription(description: string): string {
  if (Buffer.byteLength(description, "utf8") <= MATTERMOST_COMMAND_DESCRIPTION_MAX_BYTES) {
    return description;
  }
  let bytes = 0;
  let end = 0;
  for (const char of description) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > MATTERMOST_COMMAND_DESCRIPTION_MAX_BYTES) {
      break;
    }
    bytes += charBytes;
    end += char.length;
  }
  return description.slice(0, end);
}

export type MattermostSlashCommandConfig = {
  /** Enable native slash commands. "auto" resolves to false for now (opt-in). */
  native: boolean | "auto";
  /** Also register skill-based commands. */
  nativeSkills: boolean | "auto";
  /** Path for the callback endpoint on the gateway HTTP server. */
  callbackPath: string;
  /**
   * Explicit callback URL override (e.g. behind a reverse proxy).
   * If not set, auto-derived from baseUrl + gateway port + callbackPath.
   */
  callbackUrl?: string;
};

export type MattermostCommandSpec = {
  /** Preferred trigger to register (root name, unless statically reserved by Mattermost). */
  trigger: string;
  /**
   * Deterministic `oc_`-prefixed fallback trigger, tried only when `trigger` collides with a
   * foreign (non-OpenClaw) command on a given team. Defaults to `trigger` (no fallback) when omitted.
   */
  fallbackTrigger?: string;
  description: string;
  autoComplete: boolean;
  autoCompleteHint?: string;
  /** Canonical OpenClaw command name this trigger maps back to (e.g. "status"). */
  originalName?: string;
};

export type MattermostRegisteredCommand = {
  id: string;
  trigger: string;
  teamId: string;
  token: string;
  url: string;
  /** True when this process created the command and should delete it on shutdown. */
  managed: boolean;
};

/**
 * Payload sent by Mattermost when a slash command is invoked.
 * Can arrive as application/x-www-form-urlencoded or application/json.
 */
export type MattermostSlashCommandPayload = {
  token: string;
  team_id: string;
  team_domain?: string;
  channel_id: string;
  channel_name?: string;
  user_id: string;
  user_name?: string;
  command: string; // e.g. "/status"
  text: string; // args after the trigger word
  trigger_id?: string;
  response_url?: string;
  /** Thread root post id when the command was invoked from a thread's reply box. */
  root_id?: string;
};

/**
 * Response format for Mattermost slash command callbacks.
 */
export type MattermostSlashCommandResponse = {
  response_type?: "ephemeral" | "in_channel";
  text: string;
  username?: string;
  icon_url?: string;
  goto_location?: string;
  attachments?: unknown[];
};

// ─── MM API types ────────────────────────────────────────────────────────────

type MattermostCommandCreate = {
  team_id: string;
  trigger: string;
  method: typeof MATTERMOST_SLASH_POST_METHOD | "G";
  url: string;
  description?: string;
  auto_complete: boolean;
  auto_complete_desc?: string;
  auto_complete_hint?: string;
  token?: string;
  creator_id?: string;
};

type MattermostCommandUpdate = {
  id: string;
  team_id: string;
  trigger: string;
  method: typeof MATTERMOST_SLASH_POST_METHOD | "G";
  url: string;
  description?: string;
  auto_complete: boolean;
  auto_complete_desc?: string;
  auto_complete_hint?: string;
};

export type MattermostCommandResponse = {
  id: string;
  token: string;
  team_id: string;
  trigger: string;
  method: string;
  url: string;
  auto_complete: boolean;
  auto_complete_desc?: string;
  auto_complete_hint?: string;
  creator_id?: string;
  create_at?: number;
  update_at?: number;
  delete_at?: number;
};

// ─── Command registration ────────────────────────────────────────────────────

/**
 * List existing custom slash commands for a team.
 */
export async function listMattermostCommands(
  client: MattermostClient,
  teamId: string,
  init?: Pick<RequestInit, "signal">,
): Promise<MattermostCommandResponse[]> {
  return await client.request<MattermostCommandResponse[]>(
    `/commands?team_id=${encodeURIComponent(teamId)}&custom_only=true`,
    init,
  );
}

/**
 * Get a custom slash command by id.
 */
export async function getMattermostCommand(
  client: MattermostClient,
  commandId: string,
  init?: Pick<RequestInit, "signal">,
): Promise<MattermostCommandResponse> {
  return await client.request<MattermostCommandResponse>(
    `/commands/${encodeURIComponent(commandId)}`,
    init,
  );
}

/**
 * Create a custom slash command on a Mattermost team.
 */
async function createMattermostCommand(
  client: MattermostClient,
  params: MattermostCommandCreate,
  signal?: AbortSignal,
): Promise<MattermostCommandResponse> {
  return await client.request<MattermostCommandResponse>("/commands", {
    method: "POST",
    body: JSON.stringify(params),
    signal,
  });
}

/**
 * Delete a custom slash command.
 */
async function deleteMattermostCommand(
  client: MattermostClient,
  commandId: string,
  signal?: AbortSignal,
): Promise<void> {
  await client.request<Record<string, unknown>>(`/commands/${encodeURIComponent(commandId)}`, {
    method: "DELETE",
    signal,
  });
}

/**
 * Update an existing custom slash command.
 */
async function updateMattermostCommand(
  client: MattermostClient,
  params: MattermostCommandUpdate,
  signal?: AbortSignal,
): Promise<MattermostCommandResponse> {
  return await client.request<MattermostCommandResponse>(
    `/commands/${encodeURIComponent(params.id)}`,
    {
      method: "PUT",
      body: JSON.stringify(params),
      signal,
    },
  );
}

// Mattermost's team command-list endpoint can return an existing command with an empty
// token, while GET /commands/{id} has the authoritative one. Without this lookup, reused
// commands keep an empty startup token and every native callback (e.g. /model) 401s.
async function resolveReusedCommandToken(
  client: MattermostClient,
  existingCmd: MattermostCommandResponse,
  signal?: AbortSignal,
): Promise<string> {
  if (existingCmd.token) {
    return existingCmd.token;
  }
  try {
    const detailed = await getMattermostCommand(client, existingCmd.id, { signal });
    if (!detailed.token) {
      throw new Error("command detail response did not include a token");
    }
    return detailed.token;
  } catch (err) {
    throw new Error(
      `mattermost: failed to fetch authoritative token for reused command /${existingCmd.trigger} (id=${existingCmd.id}): ${String(err)}`,
      { cause: err },
    );
  }
}

/**
 * Reconcile one already-selected trigger against the commands this bot owns for it:
 * reuse as-is, update on callback drift, or create fresh.
 */
async function reconcileMattermostCommandTrigger(params: {
  client: MattermostClient;
  teamId: string;
  callbackUrl: string;
  trigger: string;
  description: string;
  spec: MattermostCommandSpec;
  ownedCommands: MattermostCommandResponse[];
  abortSignal?: AbortSignal;
  beforeMutation: () => Promise<void>;
  log?: (msg: string) => void;
}): Promise<MattermostRegisteredCommand | undefined> {
  const {
    client,
    teamId,
    callbackUrl,
    trigger,
    description,
    spec,
    ownedCommands,
    abortSignal,
    beforeMutation,
    log,
  } = params;
  if (ownedCommands.length > 1) {
    log?.(
      `mattermost: multiple owned commands found for /${trigger}; using the first and leaving extras untouched`,
    );
  }
  const existingCmd = ownedCommands[0];
  const existingNeedsUpdate = existingCmd
    ? existingCmd.url !== callbackUrl || existingCmd.method !== MATTERMOST_SLASH_POST_METHOD
    : false;

  // Already registered with the correct callback URL and method.
  if (existingCmd && !existingNeedsUpdate) {
    log?.(`mattermost: command /${trigger} already registered (id=${existingCmd.id})`);
    return {
      id: existingCmd.id,
      trigger,
      teamId,
      token: await resolveReusedCommandToken(client, existingCmd, abortSignal),
      url: callbackUrl,
      managed: false,
    };
  }

  // Exists but has drifted critical callback fields: attempt to reconcile by
  // updating (useful during callback URL migrations or method drift).
  if (existingCmd && existingNeedsUpdate) {
    log?.(
      `mattermost: command /${trigger} exists with different callback settings; updating (id=${existingCmd.id})`,
    );
    try {
      await beforeMutation();
      const updated = await updateMattermostCommand(
        client,
        {
          id: existingCmd.id,
          team_id: teamId,
          trigger,
          method: MATTERMOST_SLASH_POST_METHOD,
          url: callbackUrl,
          description,
          auto_complete: spec.autoComplete,
          auto_complete_desc: description,
          auto_complete_hint: spec.autoCompleteHint,
        },
        abortSignal,
      );
      return {
        id: updated.id,
        trigger,
        teamId,
        token: await resolveReusedCommandToken(client, updated, abortSignal),
        url: callbackUrl,
        managed: false,
      };
    } catch (err) {
      log?.(
        `mattermost: failed to update command /${trigger} (id=${existingCmd.id}): ${String(err)}`,
      );
      // An update failure can be transient or rate-limited. Abort the pass so
      // stale cleanup cannot delete a still-valid command after partial reconcile.
      throw err;
    }
  }

  try {
    await beforeMutation();
    const created = await createMattermostCommand(
      client,
      {
        team_id: teamId,
        trigger,
        method: MATTERMOST_SLASH_POST_METHOD,
        url: callbackUrl,
        description,
        auto_complete: spec.autoComplete,
        auto_complete_desc: description,
        auto_complete_hint: spec.autoCompleteHint,
      },
      abortSignal,
    );
    log?.(`mattermost: registered command /${trigger} (id=${created.id})`);
    return {
      id: created.id,
      trigger,
      teamId,
      token: created.token,
      url: callbackUrl,
      managed: true,
    };
  } catch (err) {
    log?.(`mattermost: failed to register command /${trigger}: ${String(err)}`);
    return undefined;
  }
}

/**
 * Register all OpenClaw slash commands for a given team.
 *
 * Tries each spec's preferred `trigger` (its root command name) first; if that trigger is
 * owned by a non-OpenClaw integration, retries the deterministic `fallbackTrigger` instead of
 * giving up, so the command stays reachable even when its root name is taken on this one team.
 * Never mutates a foreign-owned command either way.
 *
 * Afterward, deletes any command this bot still owns on the team whose trigger is not part of
 * the current desired set (e.g. a legacy `oc_`-prefixed registration superseded by a root
 * trigger that no longer collides), so renamed/removed commands do not linger indefinitely.
 */
export async function registerSlashCommands(params: {
  client: MattermostClient;
  teamId: string;
  creatorUserId: string;
  callbackUrl: string;
  commands: MattermostCommandSpec[];
  abortSignal?: AbortSignal;
  mutationIntervalMs?: number;
  log?: (msg: string) => void;
}): Promise<MattermostRegisteredCommand[]> {
  const { client, teamId, creatorUserId, callbackUrl, commands, abortSignal, log } = params;
  const normalizedCreatorUserId = creatorUserId.trim();
  if (!normalizedCreatorUserId) {
    throw new Error("creatorUserId is required for slash command reconciliation");
  }

  // Fetch existing commands to avoid duplicates
  let existing: MattermostCommandResponse[];
  try {
    existing = await listMattermostCommands(client, teamId, { signal: abortSignal });
  } catch (err) {
    log?.(`mattermost: failed to list existing commands: ${String(err)}`);
    // Fail closed: if we can't list existing commands, we should not attempt to
    // create/update anything because we may create duplicates and end up with an
    // empty/partial token set (causing callbacks to be rejected until restart).
    throw err;
  }

  const existingByTrigger = new Map<string, MattermostCommandResponse[]>();
  for (const cmd of existing) {
    const list = existingByTrigger.get(cmd.trigger) ?? [];
    list.push(cmd);
    existingByTrigger.set(cmd.trigger, list);
  }

  const registered: MattermostRegisteredCommand[] = [];
  const desiredTriggers = new Set<string>();
  const mutationIntervalMs = Math.max(0, params.mutationIntervalMs ?? 0);
  let lastMutationAt = 0;
  const beforeMutation = async () => {
    const waitMs = Math.max(0, lastMutationAt + mutationIntervalMs - Date.now());
    if (waitMs > 0) {
      await sleepWithAbort(waitMs, abortSignal);
    }
    lastMutationAt = Date.now();
  };

  for (const spec of commands) {
    if (abortSignal?.aborted) {
      throw abortSignal.reason ?? new Error("Mattermost slash command reconciliation aborted");
    }
    const description = truncateMattermostCommandDescription(spec.description);
    const fallbackTrigger = spec.fallbackTrigger ?? spec.trigger;
    const candidateTriggers =
      fallbackTrigger === spec.trigger ? [spec.trigger] : [spec.trigger, fallbackTrigger];

    let reconciled: MattermostRegisteredCommand | undefined;
    let sawForeignCandidate = false;
    for (const candidateTrigger of candidateTriggers) {
      const existingForTrigger = existingByTrigger.get(candidateTrigger) ?? [];
      const ownedCommands = existingForTrigger.filter(
        (cmd) => cmd.creator_id?.trim() === normalizedCreatorUserId,
      );
      const foreignCommands = existingForTrigger.filter(
        (cmd) => cmd.creator_id?.trim() !== normalizedCreatorUserId,
      );
      if (ownedCommands.length === 0 && foreignCommands.length > 0) {
        sawForeignCandidate = true;
        continue;
      }
      reconciled = await reconcileMattermostCommandTrigger({
        client,
        teamId,
        callbackUrl,
        trigger: candidateTrigger,
        description,
        spec,
        ownedCommands,
        abortSignal,
        beforeMutation,
        log,
      });
      break;
    }

    if (!reconciled) {
      if (sawForeignCandidate) {
        const triedTriggers = candidateTriggers.map((trigger) => `/${trigger}`).join(" then ");
        log?.(
          `mattermost: trigger ${triedTriggers} already used by non-OpenClaw command(s); skipping to avoid mutating external integrations`,
        );
      }
      continue;
    }
    desiredTriggers.add(reconciled.trigger);
    registered.push(reconciled);
  }

  // Migration cleanup: an empty desired set almost always means the caller failed to build
  // its command list rather than truly wanting zero commands, so skip cleanup rather than risk
  // deleting every owned command on the team.
  if (commands.length > 0) {
    const ownedTriggersHandled = new Set<string>();
    for (const cmd of existing) {
      if (cmd.creator_id?.trim() !== normalizedCreatorUserId) {
        continue;
      }
      if (desiredTriggers.has(cmd.trigger) || ownedTriggersHandled.has(cmd.trigger)) {
        continue;
      }
      ownedTriggersHandled.add(cmd.trigger);
      try {
        await beforeMutation();
        await deleteMattermostCommand(client, cmd.id, abortSignal);
        log?.(
          `mattermost: removed stale command /${cmd.trigger} (id=${cmd.id}); no longer part of the desired command set`,
        );
      } catch (err) {
        log?.(
          `mattermost: failed to remove stale command /${cmd.trigger} (id=${cmd.id}): ${String(err)}`,
        );
      }
    }
  }

  return registered;
}

// ─── Callback parsing ────────────────────────────────────────────────────────

/**
 * Parse a Mattermost slash command callback payload from a URL-encoded or JSON body.
 */
export function parseSlashCommandPayload(
  body: string,
  contentType?: string,
): MattermostSlashCommandPayload | null {
  if (!body) {
    return null;
  }

  try {
    if (contentType?.includes("application/json")) {
      const parsed = JSON.parse(body) as Record<string, unknown>;

      // Validate required fields (same checks as the form-encoded branch)
      const token = typeof parsed.token === "string" ? parsed.token : "";
      const teamId = typeof parsed.team_id === "string" ? parsed.team_id : "";
      const channelId = typeof parsed.channel_id === "string" ? parsed.channel_id : "";
      const userId = typeof parsed.user_id === "string" ? parsed.user_id : "";
      const command = typeof parsed.command === "string" ? parsed.command : "";

      if (!token || !teamId || !channelId || !userId || !command) {
        return null;
      }

      return {
        token,
        team_id: teamId,
        team_domain: typeof parsed.team_domain === "string" ? parsed.team_domain : undefined,
        channel_id: channelId,
        channel_name: typeof parsed.channel_name === "string" ? parsed.channel_name : undefined,
        user_id: userId,
        user_name: typeof parsed.user_name === "string" ? parsed.user_name : undefined,
        command,
        text: typeof parsed.text === "string" ? parsed.text : "",
        trigger_id: typeof parsed.trigger_id === "string" ? parsed.trigger_id : undefined,
        response_url: typeof parsed.response_url === "string" ? parsed.response_url : undefined,
        root_id: typeof parsed.root_id === "string" ? parsed.root_id : undefined,
      };
    }

    // Default: application/x-www-form-urlencoded
    const params = new URLSearchParams(body);
    const token = params.get("token");
    const teamId = params.get("team_id");
    const channelId = params.get("channel_id");
    const userId = params.get("user_id");
    const command = params.get("command");

    if (!token || !teamId || !channelId || !userId || !command) {
      return null;
    }

    return {
      token,
      team_id: teamId,
      team_domain: params.get("team_domain") ?? undefined,
      channel_id: channelId,
      channel_name: params.get("channel_name") ?? undefined,
      user_id: userId,
      user_name: params.get("user_name") ?? undefined,
      command,
      text: params.get("text") ?? "",
      trigger_id: params.get("trigger_id") ?? undefined,
      response_url: params.get("response_url") ?? undefined,
      root_id: params.get("root_id") ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Map the trigger word back to the original OpenClaw command name.
 * e.g. "oc_status" -> "/status", "oc_model" -> "/model"
 */
export function resolveCommandText(
  trigger: string,
  text: string,
  triggerMap?: ReadonlyMap<string, string>,
): string {
  // Use the trigger map if available for accurate name resolution
  const commandName =
    triggerMap?.get(trigger) ?? (trigger.startsWith("oc_") ? trigger.slice(3) : trigger);
  const args = text.trim();
  return args ? `/${commandName} ${args}` : `/${commandName}`;
}

export function normalizeSlashCommandTrigger(command: string): string {
  return command.replace(/^\//, "").trim();
}

// ─── Config resolution ───────────────────────────────────────────────────────

// Keep the default outside the Gateway's protected `/api/**` namespace. Mattermost
// authenticates callbacks with the per-command token, and the route handler validates
// that token against both startup state and the current Mattermost command record.
// Replacement channel plugins cannot rely on the bundled plugin's pre-plugin Gateway
// auth-bypass artifact being selected, so an `/api/**` default can be rejected before
// this handler gets a chance to authenticate it.
const DEFAULT_CALLBACK_PATH = "/mattermost/command";

/**
 * Ensure the callback path starts with a leading `/` to prevent
 * malformed URLs like `http://host:portapi/...`.
 */
function normalizeCallbackPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return DEFAULT_CALLBACK_PATH;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function resolveSlashCommandConfig(
  raw?: Partial<MattermostSlashCommandConfig>,
): MattermostSlashCommandConfig {
  return {
    native: raw?.native ?? "auto",
    nativeSkills: raw?.nativeSkills ?? "auto",
    callbackPath: normalizeCallbackPath(raw?.callbackPath ?? DEFAULT_CALLBACK_PATH),
    callbackUrl: normalizeOptionalString(raw?.callbackUrl),
  };
}

export function isSlashCommandsEnabled(config: MattermostSlashCommandConfig): boolean {
  if (config.native === true) {
    return true;
  }
  if (config.native === false) {
    return false;
  }
  // "auto" defaults to false for mattermost (opt-in)
  return false;
}

/**
 * Build the callback URL that Mattermost will POST to when a command is invoked.
 */
export function resolveCallbackUrl(params: {
  config: MattermostSlashCommandConfig;
  gatewayPort: number;
  gatewayHost?: string;
}): string {
  if (params.config.callbackUrl) {
    return params.config.callbackUrl;
  }

  let host =
    params.gatewayHost && !isWildcardBindHost(params.gatewayHost)
      ? params.gatewayHost
      : "localhost";
  const path = normalizeCallbackPath(params.config.callbackPath);

  // Bracket IPv6 literals so the URL is valid: http://[::1]:3015/...
  if (host.includes(":") && !(host.startsWith("[") && host.endsWith("]"))) {
    host = `[${host}]`;
  }

  return `http://${host}:${params.gatewayPort}${path}`;
}
