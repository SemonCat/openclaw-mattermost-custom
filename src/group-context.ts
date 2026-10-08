import { buildChannelGroupsScopeTree } from "openclaw/plugin-sdk/channel-policy";
import type { MattermostAccountConfig } from "./types.js";
import type { OpenClawConfig } from "./runtime-api.js";

/** Same effective account groups and exact/wildcard rules as requireMention. */
export function resolveMattermostGroupContext(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  channelId: string;
  kind: "direct" | "group" | "channel";
}): { systemPrompt?: string; skillFilter?: string[] } {
  if (params.kind === "direct") return {};
  const tree = buildChannelGroupsScopeTree(params.cfg, "mattermost", params.accountId);
  type Group = NonNullable<NonNullable<MattermostAccountConfig["groups"]>[string]>;
  const exact = tree.scopes[params.channelId] as Group | undefined;
  const wildcard = tree.defaults as Group | undefined;
  const skills = exact?.skills ?? wildcard?.skills;
  return {
    systemPrompt: exact?.systemPrompt ?? wildcard?.systemPrompt,
    // Never pass the caller's mutable config array into reply dispatch.
    skillFilter: skills === undefined ? undefined : [...skills],
  };
}
