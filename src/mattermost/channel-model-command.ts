// Mattermost plugin command for channel-scoped default model selection.
import {
  authorizeConfigWrite,
  formatConfigWriteDeniedMessage,
} from "openclaw/plugin-sdk/channel-config-helpers";
import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/core";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveMattermostAccount } from "./accounts.js";
import {
  createMattermostClient,
  fetchMattermostChannel,
  patchMattermostChannelHeader,
} from "./client.js";
import { buildModelsProviderData, type OpenClawConfig } from "./runtime-api.js";

const COMMAND_NAME = "channel_model";
const MATTERMOST_CHANNEL_ID = "mattermost";
export const MATTERMOST_HEADER_MAX_CHARS = 1024;
const MANAGED_HEADER_LINE_PATTERN =
  /^🤖 \*\*Default model:\*\* `[^`\r\n]+`[\t ]*(?:\r?\n|$)/u;
const SESSION_OVERRIDE_NOTE =
  "An active `/model` session override still takes precedence; use `/model default` to clear it.";

export type ChannelModelCommandDependencies = {
  buildModelsProviderData: typeof buildModelsProviderData;
  createMattermostClient: typeof createMattermostClient;
  fetchMattermostChannel: typeof fetchMattermostChannel;
  patchMattermostChannelHeader: typeof patchMattermostChannelHeader;
  resolveMattermostAccount: typeof resolveMattermostAccount;
};

const defaultDependencies: ChannelModelCommandDependencies = {
  buildModelsProviderData,
  createMattermostClient,
  fetchMattermostChannel,
  patchMattermostChannelHeader,
  resolveMattermostAccount,
};

type ParsedModelReference = {
  provider: string;
  model: string;
  ref: string;
};

export function countUnicodeCharacters(value: string): number {
  return Array.from(value).length;
}

export function buildChannelModelHeader(existingHeader: string | null | undefined, model: string) {
  const managedLine = `🤖 **Default model:** \`${model}\``;
  const existing = existingHeader ?? "";
  const remainder = existing.replace(MANAGED_HEADER_LINE_PATTERN, "");
  return remainder ? `${managedLine}\n${remainder}` : managedLine;
}

export function resolveMattermostCommandChannelId(
  ctx: Pick<PluginCommandContext, "channelId" | "sessionKey" | "to">,
): string | undefined {
  if (ctx.to?.startsWith("user:") || ctx.sessionKey?.includes(":mattermost:direct:")) {
    return undefined;
  }
  const channelId = typeof ctx.channelId === "string" ? ctx.channelId.trim() : "";
  if (channelId) {
    return channelId;
  }
  return ctx.to?.startsWith("channel:")
    ? ctx.to.slice("channel:".length).trim() || undefined
    : undefined;
}

export function setMattermostChannelModel(
  cfg: OpenClawConfig,
  channelId: string,
  model: string | undefined,
): void {
  if (model) {
    cfg.channels ??= {};
    cfg.channels.modelByChannel ??= {};
    cfg.channels.modelByChannel[MATTERMOST_CHANNEL_ID] ??= {};
    cfg.channels.modelByChannel[MATTERMOST_CHANNEL_ID][channelId] = model;
    return;
  }

  const mattermostOverrides = cfg.channels?.modelByChannel?.[MATTERMOST_CHANNEL_ID];
  if (!mattermostOverrides || !(channelId in mattermostOverrides)) {
    return;
  }
  delete mattermostOverrides[channelId];
  if (Object.keys(mattermostOverrides).length === 0) {
    delete cfg.channels?.modelByChannel?.[MATTERMOST_CHANNEL_ID];
  }
  if (cfg.channels?.modelByChannel && Object.keys(cfg.channels.modelByChannel).length === 0) {
    delete cfg.channels.modelByChannel;
  }
}

function parseModelReference(raw: string): ParsedModelReference | undefined {
  const separator = raw.indexOf("/");
  if (separator <= 0 || separator === raw.length - 1) {
    return undefined;
  }
  const provider = raw.slice(0, separator).trim().toLowerCase();
  const model = raw.slice(separator + 1).trim();
  if (!provider || !model || /\s/u.test(provider) || /[\r\n`]/u.test(model)) {
    return undefined;
  }
  return { provider, model, ref: `${provider}/${model}` };
}

export function currentMattermostChannelModelOverride(
  cfg: OpenClawConfig,
  channelId: string,
): string | undefined {
  return cfg.channels?.modelByChannel?.[MATTERMOST_CHANNEL_ID]?.[channelId]?.trim() || undefined;
}

function commandUsage(): string {
  return [
    "Usage:",
    "- `/channel_model` — show this channel's default model",
    "- `/channel_model <provider/model>` — set it",
    "- `/channel_model default` — use the agent default",
  ].join("\n");
}

function formatUnknownModel(params: {
  provider: string;
  model: string;
  providers: string[];
  byProvider: Map<string, Set<string>>;
}): string {
  const providerModels = params.byProvider.get(params.provider);
  if (!providerModels) {
    const providers = params.providers
      .slice(0, 12)
      .map((provider) => `\`${provider}\``)
      .join(", ");
    return `Unknown model provider \`${params.provider}\`. Available providers: ${providers || "none"}.`;
  }
  const models = [...providerModels]
    .toSorted((left, right) => left.localeCompare(right))
    .slice(0, 12)
    .map((model) => `\`${params.provider}/${model}\``)
    .join(", ");
  return `Unknown model \`${params.provider}/${params.model}\`. Available models include: ${models || "none"}.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMattermostChannelModelCommand(
  api: OpenClawPluginApi,
  dependencies: ChannelModelCommandDependencies = defaultDependencies,
): OpenClawPluginCommandDefinition {
  return {
    name: COMMAND_NAME,
    channels: [MATTERMOST_CHANNEL_ID],
    description: "Show or set the default model for this Mattermost channel.",
    acceptsArgs: true,
    requireAuth: true,
    async handler(ctx) {
      const channelId = resolveMattermostCommandChannelId(ctx);
      if (!channelId) {
        return { text: "`/channel_model` only works in Mattermost channels, not direct messages." };
      }

      const cfg = api.runtime.config.current() as OpenClawConfig;
      const data = await dependencies.buildModelsProviderData(cfg, ctx.agentId);
      const agentDefault = `${data.resolvedDefault.provider}/${data.resolvedDefault.model}`;
      const currentOverride = currentMattermostChannelModelOverride(cfg, channelId);
      const args = ctx.args?.trim() ?? "";

      if (!args || args.toLowerCase() === "status") {
        return {
          text: [
            `Channel default model: \`${currentOverride ?? agentDefault}\` (${currentOverride ? "channel override" : "agent default"}).`,
            SESSION_OVERRIDE_NOTE,
          ].join("\n"),
        };
      }
      if (args.toLowerCase() === "help") {
        return { text: commandUsage() };
      }

      const resetToDefault = args.toLowerCase() === "default";
      const parsed = resetToDefault ? undefined : parseModelReference(args);
      if (!resetToDefault && !parsed) {
        return { text: `Expected a full \`provider/model\` reference.\n${commandUsage()}` };
      }
      if (
        parsed &&
        (!data.byProvider.has(parsed.provider) ||
          !data.byProvider.get(parsed.provider)?.has(parsed.model))
      ) {
        return { text: formatUnknownModel({ ...parsed, ...data }) };
      }

      const configWriteAuthorization = authorizeConfigWrite({
        cfg,
        origin: { channelId: MATTERMOST_CHANNEL_ID, accountId: ctx.accountId },
        target: { kind: "channel", scope: { channelId: MATTERMOST_CHANNEL_ID } },
      });
      if (!configWriteAuthorization.allowed) {
        return {
          text: formatConfigWriteDeniedMessage({
            result: configWriteAuthorization,
            fallbackChannelId: MATTERMOST_CHANNEL_ID,
          }),
        };
      }

      const selectedModel = parsed?.ref ?? agentDefault;
      const account = dependencies.resolveMattermostAccount({ cfg, accountId: ctx.accountId });
      if (!account.enabled || !account.baseUrl || !account.botToken) {
        return { text: "Mattermost account credentials are unavailable; no changes were made." };
      }
      const client = dependencies.createMattermostClient({
        baseUrl: account.baseUrl,
        botToken: account.botToken,
        allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
      });

      let channel;
      try {
        channel = await dependencies.fetchMattermostChannel(client, channelId);
      } catch (error) {
        return {
          text: `Could not read the Mattermost channel header; no changes were made: ${errorMessage(error)}`,
        };
      }
      const nextHeader = buildChannelModelHeader(channel.header, selectedModel);
      if (countUnicodeCharacters(nextHeader) > MATTERMOST_HEADER_MAX_CHARS) {
        return {
          text: `The existing channel header is too long to add the model label (Mattermost limit: ${MATTERMOST_HEADER_MAX_CHARS} characters); no changes were made.`,
        };
      }

      const nextOverride = parsed?.ref;
      if (currentOverride !== nextOverride) {
        await api.runtime.config.mutateConfigFile({
          base: "source",
          afterWrite: { mode: "auto" },
          mutate: (draft) => setMattermostChannelModel(draft, channelId, nextOverride),
        });
      }

      let headerWarning: string | undefined;
      if (channel.header !== nextHeader) {
        try {
          await dependencies.patchMattermostChannelHeader(client, channelId, nextHeader);
        } catch (error) {
          headerWarning = `⚠️ The model setting was saved, but the Mattermost header could not be updated: ${errorMessage(error)}`;
        }
      }

      const result = resetToDefault
        ? `✅ Channel model reset to agent default: \`${selectedModel}\`.`
        : `✅ Channel default model set to \`${selectedModel}\`.`;
      return {
        text: [result, headerWarning, SESSION_OVERRIDE_NOTE].filter(Boolean).join("\n"),
      };
    },
  };
}

export function registerMattermostChannelModelCommand(api: OpenClawPluginApi): void {
  api.registerCommand(createMattermostChannelModelCommand(api));
}
