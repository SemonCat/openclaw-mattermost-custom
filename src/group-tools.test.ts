import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import { resolveChannelGroupToolsPolicy } from "openclaw/plugin-sdk/channel-policy";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./runtime-api.js";
import { MattermostConfigSchema } from "./config-schema-core.js";
import { MattermostChannelConfigSchema } from "./config-surface.js";
import { mattermostPlugin } from "./channel.js";
import { resolveMattermostGroupContext } from "./group-context.js";

const room = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const sender = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const rootPolicy = { allow: ["read", "write"] };
const senderPolicy = { allow: ["read"] };
const cfg = {
  channels: { mattermost: { groups: {
    "*": { tools: rootPolicy, skills: ["review"] },
    [room]: { toolsBySender: {
      [`id:${sender}`]: senderPolicy,
      "username:renamed": { deny: ["read"] },
      "*": { deny: ["write"] },
    } },
  }, accounts: {
    inherited: {},
    own: { groups: { "*": { tools: { deny: ["read"] } } } },
    empty: { groups: {} },
  } } },
} as OpenClawConfig;

function resolve(overrides: Partial<Parameters<typeof resolveChannelGroupToolsPolicy>[0]> = {}) {
  return resolveChannelGroupToolsPolicy({
    cfg, channel: "mattermost", groupId: room, accountId: "inherited", ...overrides,
  });
}

describe("Mattermost public group tool policy", () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "mattermost-policy-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", directory);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(directory, "missing.json"));
    vi.stubEnv("OPENCLAW_AGENT_DIR", path.join(directory, "agent"));
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("exposes SDK policy fields in the public schema without changing skills", () => {
    const parsed = MattermostConfigSchema.parse(cfg.channels!.mattermost);
    expect(parsed.groups![room]!.toolsBySender![`id:${sender}`]).toEqual(senderPolicy);
    const schema = MattermostChannelConfigSchema.schema as { properties: Record<string, unknown> };
    expect(JSON.stringify(schema.properties.groups)).toContain('"toolsBySender"');
    expect(JSON.stringify(schema.properties.groups)).toContain('"tools"');
    expect(resolveMattermostGroupContext({ cfg, accountId: "inherited", channelId: room, kind: "channel" }).skillFilter).toEqual(["review"]);
    // The host's flat-group fallback owns selection; no competing local resolver.
    expect(mattermostPlugin.groups?.resolveToolPolicy).toBeUndefined();
  });

  it("resolves exact, wildcard, account inheritance and account map replacement", () => {
    expect(resolve({ groupId: "other" })).toEqual(rootPolicy);
    expect(resolve({ senderId: sender })).toEqual(senderPolicy);
    expect(resolve({ accountId: "own", senderId: sender })).toEqual({ deny: ["read"] });
    expect(resolve({ accountId: "empty", senderId: sender })).toBeUndefined();
    expect(resolve({ cfg: { channels: { mattermost: { groups: {
      "*": { tools: rootPolicy }, [room]: { tools: {} },
    } } } } })).toEqual({});
    expect(resolve({ cfg: { channels: { mattermost: { groups: {
      "*": { tools: rootPolicy }, [room]: { tools: { allow: [] } },
    } } } } })).toEqual({ allow: [] });
  });

  it("prioritizes stable sender identity and respects senderPolicyMode", () => {
    expect(resolve({ senderId: sender, senderUsername: "renamed", senderPolicyMode: "always" })).toEqual(senderPolicy);
    expect(resolve({ senderId: sender, senderUsername: "renamed", senderPolicyMode: "never" })).toEqual(rootPolicy);
    expect(resolve({ senderId: "other", senderUsername: "renamed" })).toEqual({ deny: ["read"] });
    expect(resolve({ senderId: "other" })).toEqual({ deny: ["write"] });
    expect(resolve({ cfg: { channels: { mattermost: { groups: {
      [room]: { toolsBySender: {
        [`channel:mattermost:${sender}`]: { deny: ["edit"] },
        [`id:${sender}`]: senderPolicy,
      } },
    } } } }, senderId: sender })).toEqual({ deny: ["edit"] });
  });

  it.each([undefined, {}, { tools: {} }, { tools: { allow: [], deny: [] } }, { toolsBySender: {} }])("accepts omitted and empty policy %j", (group) => {
    expect(MattermostConfigSchema.safeParse({ groups: { [room]: group } }).success).toBe(true);
  });

  it.each([null, { tools: null }, { tools: [] }, { tools: { allow: "read" } },
    { tools: { unsupported: true } }, { toolsBySender: null },
    { toolsBySender: { [`id:${sender}`]: null } }])("rejects invalid policy %j", (group) => {
    expect(MattermostConfigSchema.safeParse({ groups: { [room]: group } }).success).toBe(false);
  });

  it("retains the SDK legacy-key schema while requiring typed keys at resolution", () => {
    const legacy = { groups: { [room]: { toolsBySender: { [sender]: rootPolicy } } } };
    expect(MattermostConfigSchema.safeParse(legacy).success).toBe(true);
    expect(() => resolve({ cfg: { channels: { mattermost: legacy } }, senderId: sender }))
      .toThrow("Untyped toolsBySender keys are retired");
  });

  it("uses the published host tool builder to intersect channel/sender policy with global deny", () => {
    const names = (config: OpenClawConfig, senderId?: string) =>
      createOpenClawCodingTools({
        config, workspaceDir: directory,
        sessionKey: `agent:main:mattermost:channel:${room}`,
        messageProvider: "mattermost", groupId: room, agentAccountId: "inherited", senderId,
        toolConstructionPlan: {
          includeBaseCodingTools: true, includeShellTools: false,
          includeChannelTools: false, includeOpenClawTools: false, includePluginTools: false,
        },
      }).map((tool) => tool.name).sort();
    expect(names(cfg, sender)).toEqual(["read"]);
    expect(names(cfg, "other")).not.toContain("write");
    const exactAllow = { channels: { mattermost: { groups: { [room]: { tools: rootPolicy } } } } };
    expect(names(exactAllow)).toEqual(["read", "write"]);
    expect(names({ ...exactAllow, tools: { deny: ["read"] } })).toEqual(["write"]);
    expect(names({ ...cfg, tools: { deny: ["read"] } }, sender)).toEqual([]);
    expect(names({ channels: { mattermost: { groups: { [room]: { tools: {} } } } } })).toContain("read");
  });
});
