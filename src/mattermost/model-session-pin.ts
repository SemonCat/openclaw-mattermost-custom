// Mattermost plugin workaround for explicit selections that equal the OpenClaw global default.
import {
  buildModelAliasIndex,
  resolveAgentDir,
  resolveModelRefFromString,
} from "openclaw/plugin-sdk/agent-runtime";
import type { ModelsProviderData } from "openclaw/plugin-sdk/command-auth-native";
import { applyModelOverrideWithAuthProfileCompatibility } from "openclaw/plugin-sdk/model-session-runtime";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { patchSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import type { OpenClawConfig } from "./runtime-api.js";
import { buildModelsProviderData } from "./runtime-api.js";

function parseExplicitModelRef(commandText: string): string | null {
  const match = commandText.trim().match(/^\/model\s+(\S+)(?:\s+.*)?$/iu);
  const rawRef = match?.[1];
  if (!rawRef || /^(?:clear|default|reset)$/iu.test(rawRef)) {
    return null;
  }
  return rawRef;
}

export async function pinMattermostExplicitDefaultModelSelection(params: {
  agentId: string;
  cfg: OpenClawConfig;
  commandText: string;
  modelsData?: ModelsProviderData;
  sessionKey: string;
}): Promise<{ pinned: false } | { pinned: true; modelRef: string }> {
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
  const updated = await patchSessionEntry({
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
  if (!updated) {
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
