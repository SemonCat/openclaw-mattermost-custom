import { describe, expect, it } from "vitest";
import { MattermostConfigSchema } from "./config-schema-core.js";
import { resolveMattermostGroupContext } from "./group-context.js";
import { buildMattermostEventPlan } from "./mattermost/monitor-event-plan.js";
import type { MattermostMonitorContext } from "./mattermost/monitor-types.js";
import type { OpenClawConfig } from "./runtime-api.js";

const cfg = {
  channels: {
    mattermost: {
      groups: {
        "*": { skills: ["general"], systemPrompt: "Default instructions" },
        engineering: { skills: ["coding"] },
        support: { skills: [], systemPrompt: "Support instructions" },
      },
      accounts: {
        inherited: {},
        work: { groups: { "*": { skills: ["work"], systemPrompt: "Work instructions" }, engineering: { systemPrompt: "Engineering instructions" } } },
      },
    }
  },
} as unknown as OpenClawConfig;
function resolve(channelId: string, accountId = "default", kind: "direct" | "channel" = "channel") {
  return resolveMattermostGroupContext({ cfg, accountId, channelId, kind });
}

describe("configured Mattermost channel context", () => {
  it("inherits each field from the effective account wildcard and preserves empty filters", () => {
    expect(resolve("engineering")).toEqual({ skillFilter: ["coding"], systemPrompt: "Default instructions" });
    expect(resolve("support")).toEqual({ skillFilter: [], systemPrompt: "Support instructions" });
    expect(resolve("engineering", "inherited")).toEqual(resolve("engineering"));
    expect(resolve("engineering", "work")).toEqual({ skillFilter: ["work"], systemPrompt: "Engineering instructions" });
    expect(resolve("support", "work")).toEqual({ skillFilter: ["work"], systemPrompt: "Work instructions" });
    expect(resolve("engineering", "default", "direct")).toEqual({});
    expect(resolveMattermostGroupContext({ cfg: {}, channelId: "engineering", kind: "channel" })).toEqual({ skillFilter: undefined, systemPrompt: undefined });
  });
  it("does not mutate caller skill arrays", () => {
    resolve("engineering").skillFilter!.push("other");
    expect(resolve("engineering").skillFilter).toEqual(["coding"]);
  });
  it("validates fields and keeps excluded policies excluded", () => {
    expect(MattermostConfigSchema.safeParse(cfg.channels!.mattermost).success).toBe(true);
    for (const entry of [{ skills: null }, { skills: "coding" }, { skills: [1] }, { systemPrompt: null }, { systemPrompt: 1 }, { tools: {} }, { toolsBySender: {} }, { enabled: true }, { allowFrom: [] }]) {
      expect(MattermostConfigSchema.safeParse({ groups: { "*": entry } }).success).toBe(false);
    }
  });
  it("puts settings into the common post, interaction and reaction event seams without promoting headers", async () => {
    const monitor = {
      cfg, account: { accountId: "default", config: {} },
      core: {
        channel: {
          routing: { resolveAgentRoute: () => ({ agentId: "main", accountId: "default", sessionKey: "agent:main:mattermost:engineering" }) },
          text: { resolveTextChunkLimit: () => 4000, resolveMarkdownTableMode: () => "off" },
        }
      }, resources: {},
    } as unknown as MattermostMonitorContext;
    for (const dropLabel of ["post", "interaction dispatch", "reaction"]) {
      const plan = await buildMattermostEventPlan(monitor, {
        channelId: "engineering", senderId: "user", postId: "reply", threadRootId: "root", dropLabel,
        channelInfo: { id: "engineering", type: "O", header: "untrusted header", name: "engineering" },
      });
      const context = plan!.finalizeContext({ Body: "hello", GroupSystemPrompt: "untrusted quoted text" });
      expect(context.GroupSystemPrompt).toBe("Default instructions");
      expect(context.SessionKey).toContain(":thread:root");
      expect(plan!.createReplyPlan().replyOptions.skillFilter).toEqual(["coding"]);
    }
    const dm = await buildMattermostEventPlan(monitor, { channelId: "support", senderId: "user", dropLabel: "post", channelInfo: { id: "support", type: "D", header: "support instructions" } });
    expect(dm!.finalizeContext({ Body: "hello" }).GroupSystemPrompt).toBeUndefined();
    expect(dm!.createReplyPlan().replyOptions.skillFilter).toBeUndefined();
  });
});
