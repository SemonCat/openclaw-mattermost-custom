// Mattermost plugin module implements monitor slash behavior.
import { isLoopbackHost } from "openclaw/plugin-sdk/gateway-runtime";
import type { ResolvedMattermostAccount } from "./accounts.js";
import {
  fetchMattermostUserTeams,
  normalizeMattermostBaseUrl,
  type MattermostClient,
} from "./client.js";
import { buildMattermostNativeCommandSpecs } from "./native-commands.js";
import { parseTcpPort, type OpenClawConfig, type RuntimeEnv } from "./runtime-api.js";
import {
  isSlashCommandsEnabled,
  registerSlashCommands,
  resolveCallbackUrl,
  resolveSlashCommandConfig,
  type MattermostCommandSpec,
  type MattermostRegisteredCommand,
  type MattermostSlashCommandConfig,
} from "./slash-commands.js";
import { activateSlashCommands } from "./slash-state.js";

const MATTERMOST_COMMAND_MUTATION_INTERVAL_MS = 250;

function dedupeSlashCommands(commands: MattermostCommandSpec[]): MattermostCommandSpec[] {
  const seen = new Set<string>();
  return commands.filter((cmd) => {
    const key = cmd.trigger.trim();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildTriggerMap(commands: MattermostCommandSpec[]): Map<string, string> {
  const triggerMap = new Map<string, string>();
  for (const cmd of commands) {
    if (!cmd.originalName) {
      continue;
    }
    triggerMap.set(cmd.trigger, cmd.originalName);
    // A team may have registered the fallback trigger instead of the root one (foreign
    // collision on that team); map both so callback resolution works either way.
    if (cmd.fallbackTrigger) {
      triggerMap.set(cmd.fallbackTrigger, cmd.originalName);
    }
  }
  return triggerMap;
}

function warnOnSuspiciousCallbackUrl(params: {
  runtime: RuntimeEnv;
  baseUrl: string;
  callbackUrl: string;
}) {
  try {
    const mmHost = new URL(normalizeMattermostBaseUrl(params.baseUrl) ?? params.baseUrl).hostname;
    const callbackHost = new URL(params.callbackUrl).hostname;

    if (isLoopbackHost(callbackHost) && !isLoopbackHost(mmHost)) {
      params.runtime.error?.(
        `mattermost: slash commands callbackUrl resolved to ${params.callbackUrl} (loopback) while baseUrl is ${params.baseUrl}. This MAY be unreachable depending on your deployment. If native slash commands don't work, set channels.mattermost.commands.callbackUrl to a URL reachable from the Mattermost server (e.g. your public reverse proxy URL).`,
      );
    }
  } catch {
    // Ignore malformed URLs and let the downstream registration fail naturally.
  }
}

async function registerSlashCommandsAcrossTeams(params: {
  client: MattermostClient;
  teams: Array<{ id: string }>;
  botUserId: string;
  callbackUrl: string;
  commands: MattermostCommandSpec[];
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
}): Promise<{
  registered: MattermostRegisteredCommand[];
  teamRegistrationFailures: number;
}> {
  const registered: MattermostRegisteredCommand[] = [];
  let teamRegistrationFailures = 0;

  for (const team of params.teams) {
    if (params.abortSignal?.aborted) {
      break;
    }
    try {
      const created = await registerSlashCommands({
        client: params.client,
        teamId: team.id,
        creatorUserId: params.botUserId,
        callbackUrl: params.callbackUrl,
        commands: params.commands,
        abortSignal: params.abortSignal,
        mutationIntervalMs: MATTERMOST_COMMAND_MUTATION_INTERVAL_MS,
        log: (msg) => params.runtime.log?.(msg),
      });
      registered.push(...created);
    } catch (err) {
      teamRegistrationFailures += 1;
      params.runtime.error?.(
        `mattermost: failed to register slash commands for team ${team.id}: ${String(err)}`,
      );
    }
  }

  return { registered, teamRegistrationFailures };
}

export async function registerMattermostMonitorSlashCommands(params: {
  client: MattermostClient;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  account: ResolvedMattermostAccount;
  baseUrl: string;
  botUserId: string;
  abortSignal?: AbortSignal;
}) {
  const commandsRaw = params.account.config.commands as
    | Partial<MattermostSlashCommandConfig>
    | undefined;
  const slashConfig = resolveSlashCommandConfig(commandsRaw);
  if (!isSlashCommandsEnabled(slashConfig)) {
    return;
  }

  try {
    const teams = await fetchMattermostUserTeams(params.client, params.botUserId);
    if (params.abortSignal?.aborted) {
      return;
    }
    const envPort = parseTcpPort(process.env.OPENCLAW_GATEWAY_PORT);
    const slashGatewayPort = envPort ?? params.cfg.gateway?.port ?? 18789;
    const slashCallbackUrl = resolveCallbackUrl({
      config: slashConfig,
      gatewayPort: slashGatewayPort,
      gatewayHost: params.cfg.gateway?.customBindHost ?? undefined,
    });

    warnOnSuspiciousCallbackUrl({
      runtime: params.runtime,
      baseUrl: params.baseUrl,
      callbackUrl: slashCallbackUrl,
    });

    const dedupedCommands = dedupeSlashCommands(
      buildMattermostNativeCommandSpecs({
        cfg: params.cfg,
        runtime: params.runtime,
        nativeSkills: slashConfig.nativeSkills === true,
      }),
    );
    const { registered, teamRegistrationFailures } = await registerSlashCommandsAcrossTeams({
      client: params.client,
      teams,
      botUserId: params.botUserId,
      callbackUrl: slashCallbackUrl,
      commands: dedupedCommands,
      runtime: params.runtime,
      abortSignal: params.abortSignal,
    });

    if (params.abortSignal?.aborted) {
      return;
    }
    if (registered.length === 0) {
      params.runtime.error?.(
        "mattermost: native slash commands enabled but no commands could be registered; keeping slash callbacks inactive",
      );
      return;
    }

    if (teamRegistrationFailures > 0) {
      params.runtime.error?.(
        `mattermost: slash command registration completed with ${teamRegistrationFailures} team error(s)`,
      );
    }

    activateSlashCommands({
      account: params.account,
      commandTokens: registered.map((cmd) => cmd.token).filter(Boolean),
      registeredCommands: registered,
      triggerMap: buildTriggerMap(dedupedCommands),
      api: { cfg: params.cfg, runtime: params.runtime },
      log: (msg) => params.runtime.log?.(msg),
    });

    params.runtime.log?.(
      `mattermost: slash commands registered (${registered.length} commands across ${teams.length} teams, callback=${slashCallbackUrl})`,
    );
  } catch (err) {
    if (params.abortSignal?.aborted) {
      return;
    }
    params.runtime.error?.(`mattermost: failed to register slash commands: ${String(err)}`);
  }
}
