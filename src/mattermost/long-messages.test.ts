import { chunkMarkdownTextWithMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it, vi } from "vitest";
import { mattermostPlugin } from "../channel.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { createMattermostClient, createMattermostPost } from "./client.js";
import { createMattermostDraftStream } from "./draft-stream.js";
import { buildMattermostEventPlan } from "./monitor-event-plan.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import { registerMattermostQuestionDelivery } from "./question-finalization.js";
import { deliverMattermostReplyPayload } from "./reply-delivery.js";

async function createFixture(version: string, suffix: string, configuredLimit?: number) {
  const baseUrl = `https://long-post-${suffix}.example.test`;
  const cfg = {
    channels: {
      mattermost: {
        baseUrl,
        botToken: "test-token",
        ...(configuredLimit === undefined ? {} : { textChunkLimit: configuredLimit }),
      },
    },
  } as OpenClawConfig;
  const posts: Array<{ id: string; message: string }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: unknown = { id: "bot", username: "bot" };
    if (url.endsWith("/posts") || url.endsWith("/patch")) {
      const sent = JSON.parse(String(init?.body));
      body = { ...sent, id: sent.id ?? `post-${posts.length + 1}` };
      posts.push(body as { id: string; message: string });
    }
    return Response.json(body, { headers: { "X-Version-ID": version } });
  });
  const client = createMattermostClient({ baseUrl, botToken: "test-token", fetchImpl });
  // Normal startup authentication hydrates server capabilities before delivery planning.
  await client.request("/users/me");
  const account = { accountId: "default", baseUrl, config: {}, textChunkLimit: configuredLimit };
  const monitor = {
    cfg, client, account, resources: {},
    core: {
      channel: {
        routing: { resolveAgentRoute: () => ({ agentId: "main", accountId: "default", sessionKey: "main" }) },
        text: { resolveTextChunkLimit, resolveMarkdownTableMode: () => "off" },
      },
    },
  } as unknown as MattermostMonitorContext;
  const plan = await buildMattermostEventPlan(monitor, {
    channelId: "channel-1", senderId: "user-1", dropLabel: "post",
    channelInfo: { id: "channel-1", type: "O" },
  });
  const inboundLimit = plan!.createReplyPlan().textLimit;
  const outboundLimit = mattermostPlugin.outbound!.resolveEffectiveTextChunkLimit!({ cfg, accountId: "default" })!;
  return { cfg, client, posts, inboundLimit, outboundLimit, fetchImpl };
}

describe("Mattermost long-message delivery", () => {
  it("keeps a 262144-character v12 reply in one inbound, outbound and streaming post", async () => {
    const fixture = await createFixture("12.0.0.38519854955.hash.false", "v12");
    expect(fixture.inboundLimit).toBe(262_144);
    expect(fixture.outboundLimit).toBe(262_144);
    const text = "文".repeat(262_144);
    expect(mattermostPlugin.outbound!.chunker!(text, fixture.outboundLimit)).toEqual([text]);
    const stream = createMattermostDraftStream({
      client: fixture.client, channelId: "channel-1", maxChars: fixture.inboundLimit,
      chunkText: (value) => chunkMarkdownTextWithMode(value, fixture.inboundLimit, "length"),
    });
    stream.updateAssistantText(text);
    await stream.flush();
    await stream.forceNewMessage();
    expect(fixture.posts).toHaveLength(1);
    expect(fixture.posts[0].id).toBe("post-1");
    expect(fixture.posts[0].message === text).toBe(true);
    const parts = stream.resolveFinalText(text).publishedParts;
    expect(parts).toHaveLength(1);
    expect(parts[0].messageId).toBe("post-1");
    expect(parts[0].content === text).toBe(true);
    await stream.stop();
  });

  it("splits only beyond the v12 bound without dropping text or breaking surrogate pairs", async () => {
    const fixture = await createFixture("12.0.0", "overflow");
    const text = `${"a".repeat(262_143)}\u{1F600}tail`;
    const chunks = mattermostPlugin.outbound!.chunker!(text, fixture.outboundLimit);
    expect(chunks).toHaveLength(2);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 262_144 && chunk.isWellFormed())).toBe(true);
    const stream = createMattermostDraftStream({
      client: fixture.client, channelId: "channel-1", maxChars: fixture.inboundLimit,
    });
    stream.updateAssistantText(text);
    await stream.flush();
    await stream.forceNewMessage();
    expect(fixture.posts.every((post) => post.message.length <= 262_144 && post.message.isWellFormed())).toBe(true);
    const state = stream.resolveFinalText(text);
    expect(state.publishedParts.map((part) => part.content).join("") === text).toBe(true);
    await stream.stop();
  });

  it("delivers a full-size final reply through the normal reply adapter as one post", async () => {
    const fixture = await createFixture("12.0.0", "final");
    const text = "文".repeat(262_144);
    const result = await deliverMattermostReplyPayload({
      cfg: fixture.cfg,
      core: {
        channel: {
          text: {
            convertMarkdownTables: (value: string) => value,
            resolveChunkMode: () => "length",
            chunkMarkdownTextWithMode,
          },
        },
      } as unknown as Parameters<typeof deliverMattermostReplyPayload>[0]["core"],
      channelId: "channel-1",
      accountId: "default",
      textLimit: fixture.inboundLimit,
      tableMode: "off",
      payload: { text },
      sendMessage: async (_target, content) => {
        const post = await createMattermostPost(fixture.client, {
          channel_id: "channel-1",
          message: content,
        });
        return {
          messageId: post.id,
          channelId: "channel-1",
          content,
          receipt: createMessageReceiptFromOutboundResults({
            results: [{ channel: "mattermost", messageId: post.id, channelId: "channel-1" }],
            kind: "text",
          }),
        };
      },
    });
    expect(result.outcome).toBe("text");
    expect(result.visibleReplySent).toBe(true);
    expect(result.content === text).toBe(true);
    expect(fixture.posts).toHaveLength(1);
    expect(fixture.posts[0].message === text).toBe(true);
  });

  it.each([
    ["11.11.1", undefined, 16_383],
    ["12.0.0", 4000, 4000],
    ["12.0.0", 999_999, 262_144],
  ] as const)("aligns inbound and outbound limits for %s with override %s", async (version, configured, expected) => {
    const fixture = await createFixture(version, `override-${version}-${configured}`, configured);
    expect(fixture.inboundLimit).toBe(expected);
    expect(fixture.outboundLimit).toBe(expected);
  });

  it("honors per-account overrides and inherits the channel limit for other accounts", async () => {
    const fixture = await createFixture("12.0.0", "accounts", 20_000);
    fixture.cfg.channels!.mattermost!.accounts = {
      personal: { textChunkLimit: 8000 },
      inherited: {},
    };
    const resolveLimit = mattermostPlugin.outbound!.resolveEffectiveTextChunkLimit!;
    expect(resolveLimit({ cfg: fixture.cfg, accountId: "personal" })).toBe(8000);
    expect(resolveLimit({ cfg: fixture.cfg, accountId: "inherited" })).toBe(20_000);
    const hints = mattermostPlugin.agentPrompt!.messageToolHints!({
      cfg: fixture.cfg,
      accountId: "personal",
    });
    expect(hints.join("\n")).toContain("8000");
  });

  it("keeps a long question prompt when removing controls and adding terminal status", async () => {
    const fixture = await createFixture("12.0.0", "question");
    const register = vi.fn();
    const text = "q".repeat(30_000);
    registerMattermostQuestionDelivery({
      accountId: "default", client: fixture.client,
      post: { id: "question-post", message: text, channel_id: "channel-1" },
      questionId: "ask_0123456789abcdef0123456789abcdef",
      registerChannelDelivery: register,
    });
    await register.mock.calls[0][0].finalize("Answered");
    expect(fixture.posts).toEqual([{ id: "question-post", message: `${text}\n\nAnswered`, props: {} }]);
  });

  it("bounds terminal question edits without breaking an emoji at the new limit", async () => {
    const fixture = await createFixture("12.0.0", "question-boundary");
    const register = vi.fn();
    const text = `${"q".repeat(262_133)}\u{1F600}${"q".repeat(9)}`;
    registerMattermostQuestionDelivery({
      accountId: "default", client: fixture.client,
      post: { id: "question-post", message: text, channel_id: "channel-1" },
      questionId: "ask_0123456789abcdef0123456789abcdef",
      registerChannelDelivery: register,
    });
    await register.mock.calls[0][0].finalize("Answered");
    expect(fixture.posts).toHaveLength(1);
    const message = fixture.posts[0].message;
    expect(message.length).toBeLessThanOrEqual(262_144);
    expect(message.isWellFormed()).toBe(true);
    expect(message.endsWith("\n\nAnswered")).toBe(true);
    expect(message.startsWith("q".repeat(262_132))).toBe(true);
  });

  it("gives the model the active text bound and only the implemented interactive controls", async () => {
    const fixture = await createFixture("12.0.0", "hints");
    const hints = mattermostPlugin.agentPrompt!.messageToolHints!({ cfg: fixture.cfg, accountId: "default" });
    expect(hints.join("\n")).toContain("262144");
    expect(hints.join("\n")).toContain("single-select");
    expect(hints.join("\n")).toContain("ask_user");
    expect(hints.join("\n")).toContain("secret-entry");
    expect(hints.join("\n")).toContain("mattermost_form");
    expect(hints.join("\n")).toContain("multiSelect");
  });
});
