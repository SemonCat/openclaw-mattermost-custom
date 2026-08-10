// Periodically reconciles the managed model line in every visible Mattermost channel header.
import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  PluginLogger,
} from "openclaw/plugin-sdk/core";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  listMattermostAccountIds,
  resolveMattermostAccount,
} from "./accounts.js";
import {
  createMattermostClient,
  fetchMattermostMe,
  patchMattermostChannelHeader,
  type MattermostChannel,
  type MattermostClient,
} from "./client.js";
import {
  buildChannelModelHeader,
  countUnicodeCharacters,
  currentMattermostChannelModelOverride,
  MATTERMOST_HEADER_MAX_CHARS,
} from "./channel-model-command.js";
import { resolveMattermostTrustedChatKind } from "./monitor-auth.js";
import { buildModelsProviderData, type OpenClawConfig } from "./runtime-api.js";

export const CHANNEL_MODEL_HEADER_STARTUP_DELAY_MS = 5_000;
export const CHANNEL_MODEL_HEADER_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
export const CHANNEL_MODEL_HEADER_PATCH_DELAY_MS = 500;

export type ChannelModelHeaderRefreshStats = {
  accounts: number;
  scanned: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: number;
};

type Delay = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export type ChannelModelHeaderRefresherDependencies = {
  buildModelsProviderData: typeof buildModelsProviderData;
  createMattermostClient: typeof createMattermostClient;
  fetchMattermostMe: typeof fetchMattermostMe;
  listMattermostAccountIds: typeof listMattermostAccountIds;
  patchMattermostChannelHeader: typeof patchMattermostChannelHeader;
  resolveAgentRoute: typeof resolveAgentRoute;
  resolveMattermostAccount: typeof resolveMattermostAccount;
  delay: Delay;
};

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

const defaultDependencies: ChannelModelHeaderRefresherDependencies = {
  buildModelsProviderData,
  createMattermostClient,
  fetchMattermostMe,
  listMattermostAccountIds,
  patchMattermostChannelHeader,
  resolveAgentRoute,
  resolveMattermostAccount,
  delay,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function listVisibleMattermostChannels(
  client: MattermostClient,
  botUserId: string,
): Promise<MattermostChannel[]> {
  return await client.request<MattermostChannel[]>(
    `/users/${encodeURIComponent(botUserId)}/channels?per_page=200`,
  );
}

function createEmptyStats(): ChannelModelHeaderRefreshStats {
  return { accounts: 0, scanned: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0 };
}

export async function refreshMattermostChannelModelHeaders(params: {
  api: Pick<OpenClawPluginApi, "runtime">;
  logger: PluginLogger;
  signal?: AbortSignal;
  dependencies?: ChannelModelHeaderRefresherDependencies;
}): Promise<ChannelModelHeaderRefreshStats> {
  const dependencies = params.dependencies ?? defaultDependencies;
  const cfg = params.api.runtime.config.current() as OpenClawConfig;
  const stats = createEmptyStats();
  const seenChannelIds = new Set<string>();
  const agentDefaultModels = new Map<string, string>();

  const resolveAgentDefaultModel = async (agentId: string): Promise<string> => {
    const cached = agentDefaultModels.get(agentId);
    if (cached) {
      return cached;
    }
    const data = await dependencies.buildModelsProviderData(cfg, agentId);
    const model = `${data.resolvedDefault.provider}/${data.resolvedDefault.model}`;
    agentDefaultModels.set(agentId, model);
    return model;
  };

  for (const accountId of dependencies.listMattermostAccountIds(cfg)) {
    if (params.signal?.aborted) {
      break;
    }

    let account;
    try {
      account = dependencies.resolveMattermostAccount({ cfg, accountId });
    } catch (error) {
      stats.errors += 1;
      params.logger.warn?.(
        `mattermost channel model header refresh: cannot resolve account ${accountId}: ${errorMessage(error)}`,
      );
      continue;
    }
    if (!account.enabled || !account.baseUrl || !account.botToken) {
      stats.skipped += 1;
      continue;
    }

    const client = dependencies.createMattermostClient({
      baseUrl: account.baseUrl,
      botToken: account.botToken,
      allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
    });

    let channels: MattermostChannel[];
    try {
      const me = await dependencies.fetchMattermostMe(client);
      channels = await listVisibleMattermostChannels(client, me.id);
      stats.accounts += 1;
    } catch (error) {
      stats.errors += 1;
      params.logger.warn?.(
        `mattermost channel model header refresh: cannot list channels for account ${accountId}: ${errorMessage(error)}`,
      );
      continue;
    }

    for (const channel of channels) {
      if (params.signal?.aborted) {
        break;
      }
      if (
        !channel.id ||
        (channel.type !== "O" && channel.type !== "P") ||
        seenChannelIds.has(channel.id)
      ) {
        continue;
      }
      seenChannelIds.add(channel.id);
      stats.scanned += 1;

      try {
        const kind = resolveMattermostTrustedChatKind({ channelType: channel.type });
        const route = dependencies.resolveAgentRoute({
          cfg,
          channel: "mattermost",
          accountId: account.accountId,
          teamId: channel.team_id ?? undefined,
          peer: { kind, id: channel.id },
        });
        const agentDefault = await resolveAgentDefaultModel(route.agentId);
        const selectedModel =
          currentMattermostChannelModelOverride(cfg, channel.id) ?? agentDefault;
        const nextHeader = buildChannelModelHeader(channel.header, selectedModel);

        if (countUnicodeCharacters(nextHeader) > MATTERMOST_HEADER_MAX_CHARS) {
          stats.skipped += 1;
          params.logger.warn?.(
            `mattermost channel model header refresh: channel ${channel.id} exceeds the ${MATTERMOST_HEADER_MAX_CHARS}-character header limit`,
          );
          continue;
        }
        if ((channel.header ?? "") === nextHeader) {
          stats.unchanged += 1;
          continue;
        }

        try {
          await dependencies.patchMattermostChannelHeader(client, channel.id, nextHeader);
          stats.updated += 1;
        } finally {
          // Deliberately serialize and rate-limit writes so a default-model change does not
          // turn startup or the hourly reconciliation into a burst against Mattermost.
          await dependencies.delay(CHANNEL_MODEL_HEADER_PATCH_DELAY_MS, params.signal);
        }
      } catch (error) {
        stats.errors += 1;
        params.logger.warn?.(
          `mattermost channel model header refresh: channel ${channel.id} failed: ${errorMessage(error)}`,
        );
      }
    }
  }

  return stats;
}

export function createMattermostChannelModelHeaderRefresherService(
  api: OpenClawPluginApi,
  dependencies: ChannelModelHeaderRefresherDependencies = defaultDependencies,
): OpenClawPluginService {
  let controller: AbortController | undefined;
  let task: Promise<void> | undefined;

  return {
    id: "mattermost-channel-model-header-refresher",
    start(ctx) {
      if (task) {
        return;
      }
      controller = new AbortController();
      const signal = controller.signal;
      task = (async () => {
        await dependencies.delay(CHANNEL_MODEL_HEADER_STARTUP_DELAY_MS, signal);
        while (!signal.aborted) {
          const stats = await refreshMattermostChannelModelHeaders({
            api,
            logger: ctx.logger,
            signal,
            dependencies,
          });
          ctx.logger.info?.(
            `mattermost channel model header refresh: accounts=${stats.accounts} scanned=${stats.scanned} updated=${stats.updated} unchanged=${stats.unchanged} skipped=${stats.skipped} errors=${stats.errors}`,
          );
          await dependencies.delay(CHANNEL_MODEL_HEADER_REFRESH_INTERVAL_MS, signal);
        }
      })()
        .catch((error: unknown) => {
          ctx.logger.error?.(
            `mattermost channel model header refresher stopped unexpectedly: ${errorMessage(error)}`,
          );
        })
        .finally(() => {
          task = undefined;
        });
    },
    async stop() {
      controller?.abort();
      await task;
      controller = undefined;
    },
  };
}

export function registerMattermostChannelModelHeaderRefresher(api: OpenClawPluginApi): void {
  api.registerService(createMattermostChannelModelHeaderRefresherService(api));
}
