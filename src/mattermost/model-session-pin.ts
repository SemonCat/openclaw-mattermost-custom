// Mattermost plugin workaround for explicit selections that equal the OpenClaw global default.
import {
  buildModelAliasIndex,
  resolveAgentDir,
  resolveModelRefFromString,
} from "openclaw/plugin-sdk/agent-runtime";
import type { ModelsProviderData } from "openclaw/plugin-sdk/command-auth-native";
import { applyModelOverrideWithAuthProfileCompatibility } from "openclaw/plugin-sdk/model-session-runtime";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import {
  getSessionEntry,
  patchSessionEntry,
  resolveStorePath,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import type { OpenClawConfig } from "./runtime-api.js";
import { buildModelsProviderData } from "./runtime-api.js";

export type MattermostModelSessionPinDependencies = {
  getSessionEntry: typeof getSessionEntry;
  patchSessionEntry: typeof patchSessionEntry;
};

const defaultDependencies: MattermostModelSessionPinDependencies = {
  getSessionEntry,
  patchSessionEntry,
};

function hasPersistedExplicitModelSelection(
  entry: SessionEntry | undefined,
  requested: { provider: string; model: string },
): boolean {
  return (
    entry?.providerOverride === requested.provider &&
    entry.modelOverride === requested.model &&
    entry.modelOverrideSource === "user" &&
    entry.modelOverrideRouteResolution === "resolved"
  );
}

function parseExplicitModelRef(commandText: string): string | null {
  const match = commandText.trim().match(/^\/model\s+(\S+)(?:\s+.*)?$/iu);
  const rawRef = match?.[1];
  if (!rawRef || /^(?:clear|default|reset)$/iu.test(rawRef)) {
    return null;
  }
  return rawRef;
}

export async function pinMattermostExplicitDefaultModelSelection(
  params: {
    agentId: string;
    cfg: OpenClawConfig;
    commandText: string;
    modelsData?: ModelsProviderData;
    sessionKey: string;
  },
  dependencies: MattermostModelSessionPinDependencies = defaultDependencies,
): Promise<
  { pinned: false } | { pinned: true; modelRef: string }
> {
  const rawRequested = parseExplicitModelRef(params.commandText);
  if (!rawRequested) {
    return { pinned: false };
  }

  const data = params.modelsData ?? (await buildModelsProviderData(params.cfg, params.agentId));
  const resolved = resolveModelRefFromString({
    cfg: params.cfg,
    raw: rawRequested,
    defaultProvider: data.resolvedDefault.provider,
    aliasIndex: buildModelAliasIndex({
      cfg: params.cfg,
      defaultProvider: data.resolvedDefault.provider,
      agentId: params.agentId,
    }),
  });
  const requested = resolved?.ref;
  if (
    !requested ||
    requested.provider !== normalizeProviderId(data.resolvedDefault.provider) ||
    requested.model !== data.resolvedDefault.model
  ) {
    return { pinned: false };
  }

  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
  const readPersistedSelection = () =>
    hasPersistedExplicitModelSelection(
      dependencies.getSessionEntry({
        agentId: params.agentId,
        readConsistency: "latest",
        sessionKey: params.sessionKey,
        storePath,
      }),
      requested,
    );
  let updated: SessionEntry | null | undefined;
  let persistedAfterAmbiguousWrite = false;
  try {
    updated = await dependencies.patchSessionEntry({
      agentId: params.agentId,
      preserveActivity: true,
      replaceEntry: true,
      requireWriteSuccess: true,
      sessionKey: params.sessionKey,
      storePath,
      update: (entry) => {
        applyModelOverrideWithAuthProfileCompatibility({
          cfg: params.cfg,
          agentDir: resolveAgentDir(params.cfg, params.agentId),
          entry,
          currentProvider: entry.providerOverride ?? entry.modelProvider ?? requested.provider,
          selection: {
            ...requested,
            // OpenClaw core derives this from equality with the global default. Mattermost must
            // preserve the user's explicit provider/model intent so channel overrides do not win.
            isDefault: false,
          },
          selectionSource: "user",
          markLiveSwitchPending: true,
        });
        return entry;
      },
    });
  } catch (error) {
    try {
      persistedAfterAmbiguousWrite = readPersistedSelection();
    } catch {
      // Keep the original write error when the verification read is also unavailable.
    }
    if (!persistedAfterAmbiguousWrite) {
      throw error;
    }
  }
  if (!updated && !persistedAfterAmbiguousWrite && !readPersistedSelection()) {
    throw new Error(`Mattermost session not found while pinning model: ${params.sessionKey}`);
  }

  return {
    pinned: true,
    modelRef: `${requested.provider}/${requested.model}`,
  };
}

export function rewriteMattermostPinnedModelReply(text: string, modelRef: string): string {
  const pinnedText = `Model set to ${modelRef} for this session.`;
  const resetPrefix = /^Model reset to default \(.+?\)\.(?=\s|$)/u;
  return resetPrefix.test(text) ? text.replace(resetPrefix, pinnedText) : pinnedText;
}
