import {
  dispatchReplyWithBufferedBlockDispatcher,
} from "openclaw/plugin-sdk/reply-runtime";
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMattermostAccount } from "./accounts.js";
import { sendMattermostTyping, type MattermostClient, type MattermostPost } from "./client.js";
import { buildMattermostEventPlan } from "./monitor-event-plan.js";
import { dispatchMattermostInboundTurn } from "./monitor-turn.js";
import { handleMattermostPreviewStop } from "./preview-stop.js";
import { setInteractionSecret } from "./interactions.js";
import { createMattermostReactionLifecycleStore } from "./monitor-turn-reactions.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { OpenClawConfig } from "./runtime-api.js";

const { normalSend } = vi.hoisted(() => ({
  normalSend: vi.fn(async () => {
    throw new Error("expected final delivery on the existing preview identity");
  }),
}));
vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  sendMessageMattermost: normalSend,
}));

type BufferedParams = Parameters<typeof dispatchReplyWithBufferedBlockDispatcher>[0];
type Dispatch = NonNullable<BufferedParams["dispatchReplyFromConfig"]>;
type Script = (params: Parameters<Dispatch>[0]) => Promise<void>;

afterEach(() => {
  vi.useRealTimers();
  normalSend.mockClear();
});

// Keep the real turn, draft, reply pipeline and SDK dispatcher. Only the host
// agent execution and external Mattermost transports are replaced.
function fixture(mode: "block" | "partial" | "off", transport: "rest" | "companion" = "rest") {
  const cfg: OpenClawConfig = {
    messages: { ackReaction: "" },
    channels: {
      mattermost: {
        enabled: true,
        baseUrl: "https://mattermost.example.invalid",
        botToken: "test-token",
        chatmode: "onmessage",
        groupPolicy: "open",
        streaming: { mode, transport, progress: { toolProgress: false } },
      },
    },
  };
  const calls: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
  const posts = new Map<string, MattermostPost>();
  const client: MattermostClient = {
    baseUrl: "https://mattermost.example.invalid",
    apiBaseUrl: "https://mattermost.example.invalid/api/v4",
    token: "test-token",
    request: async <T>(path: string, init?: RequestInit): Promise<T> => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      calls.push({ path, method: init?.method ?? "GET", body });
      if (path === "/posts") {
        const post = { ...body, id: `post-${posts.size + 1}`, user_id: "bot" } as MattermostPost;
        posts.set(post.id, post);
        return post as T;
      }
      const id = path.split("/")[2]!;
      const post = posts.get(id);
      if (path.endsWith("/patch") && post) {
        Object.assign(post, body);
        return { ...post } as T;
      }
      if (init?.method === "DELETE") posts.delete(id);
      return (post ? { ...post } : {}) as T;
    },
    fetchImpl: vi.fn(async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      calls.push({ path, method: init?.method ?? "GET", body });
      return Response.json(
        path.endsWith("/capabilities")
          ? {
              protocol: 1,
              post_type: "custom_openclaw_stream",
              event: "custom_openclaw-stream_update",
              lease_ms: 15000,
              max_chars: 262144,
            }
          : { accepted: true },
      );
    }) as MattermostClient["fetchImpl"],
  };
  let script: Script = async () => {};
  const sessionKey = "agent:main:mattermost:channel:channel-1";
  const core = {
    capabilities: ["queued-source-lifecycle-v1"],
    config: { current: () => cfg },
    agent: { session: {
      listSessionEntries: () => [],
      getSessionEntry: () => ({ sessionId: "test-session", lifecycleRevision: 1 }),
    } },
    channel: {
      commands: { shouldHandleTextCommands: () => true },
      routing: {
        resolveAgentRoute: () => ({
          accountId: "default",
          agentId: "main",
          sessionKey,
          mainSessionKey: sessionKey,
        }),
      },
      text: {
        resolveChunkMode: () => "length",
        resolveTextChunkLimit: () => 16383,
        resolveMarkdownTableMode: () => "off",
        convertMarkdownTables: (text: string) => text,
        chunkMarkdownTextWithMode: (text: string) => [text],
      },
      inbound: {
        run: async (params: {
          adapter: { resolveTurn: () => ChannelInboundTurnPlan };
        }) => {
          const turn = params.adapter.resolveTurn();
          await turn.afterRecord?.();
          const dispatchResult = await dispatchReplyWithBufferedBlockDispatcher({
            cfg,
            ctx: turn.ctxPayload,
            dispatcherOptions: { ...turn.dispatcherOptions, deliver: turn.delivery.deliver,
              onError: turn.delivery.onError },
            replyOptions: turn.replyOptions,
            dispatchReplyFromConfig: async (options) => {
              await script(options);
              return { queuedFinal: false, counts: options.dispatcher.getQueuedCounts() };
            },
          });
          return { dispatched: true, dispatchResult };
        },
      },
    },
  };
  const monitor = {
    cfg,
    client,
    core,
    account: resolveMattermostAccount({ cfg }),
    botUserId: "bot",
    pairing: { readAllowFromStore: async () => [] },
    groupPolicy: "open",
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    logDebugMessage: vi.fn(),
    logVerboseMessage: vi.fn(),
    resources: {
      resolveChannelInfo: async () => ({
        id: "channel-1",
        type: "O",
        name: "town-square",
      }),
      sendTypingIndicator: async (channelId: string, parentId?: string) =>
        sendMattermostTyping(client, { channelId, parentId }),
    },
  } as unknown as MattermostMonitorContext;
  const run = async (next: Script) => {
    script = next;
    const eventPlan = await buildMattermostEventPlan(monitor, {
      channelId: "channel-1",
      senderId: "user-1",
      postId: "source-post",
      threadRootId: "thread-1",
      dropLabel: "test",
    });
    if (!eventPlan) throw new Error("expected an accepted event plan");
    await dispatchMattermostInboundTurn(monitor, {
      eventPlan,
      post: { id: "source-post", channel_id: "channel-1", user_id: "user-1" },
      rawText: "test",
      ctxPayload: eventPlan.finalizeContext({ Body: "test", RawBody: "test" }),
      channelHistories: new Map(),
      historyKey: null,
      historyLimit: 0,
      pinnedMainDmOwner: null,
      reactionLifecycleStore: createMattermostReactionLifecycleStore(),
      ackGate: {
        canDetectMention: true,
        effectiveWasMentioned: true,
        shouldBypassMention: false,
      },
    });
  };
  const final = async (params: Parameters<Dispatch>[0], text: string) => {
    params.dispatcher.sendFinalReply({ text });
    await params.dispatcher.waitForIdle();
  };
  return { run, final, calls, posts, monitor };
}

describe("Mattermost monitor streaming boundaries", () => {
  it.each(["before-result", "after-commentary"] as const)(
    "keeps a late %s plan above the Stop-owning result and finalizes cancellation",
    async (boundary) => {
      vi.useFakeTimers();
      const f = fixture("partial");
      f.monitor.cfg.channels!.mattermost!.allowFrom = ["user-1"];
      setInteractionSecret("default", "test-token");
      await f.run(async (params) => {
        params.replyOptions?.onAgentRunStart?.("run-plan-stop");
        if (boundary === "after-commentary") {
          await params.replyOptions?.onPartialReply?.({ text: "Early commentary" });
          await vi.advanceTimersByTimeAsync(1200);
        }
        await params.replyOptions?.onPlanUpdate?.({
          steps: [{ step: "Inspect", status: "in_progress" }],
        });
        await params.replyOptions?.onPartialReply?.({ text: "Still working" });
        await vi.advanceTimersByTimeAsync(1200);
        expect(f.posts.get("post-1")?.message).toContain("Task progress");
        expect(f.posts.get("post-1")?.props?.openclaw_mattermost).toMatchObject({ kind: "task_progress" });
        const result = f.posts.get("post-2")!;
        expect(result.props?.openclaw_mattermost).toMatchObject({ kind: "turn_result" });
        const attachments = result.props!.attachments as Array<{
          actions: Array<{ integration: { context: Record<string, unknown> } }>;
        }>;
        expect(await handleMattermostPreviewStop(f.monitor, {
          context: attachments[0]!.actions[0]!.integration.context,
          payload: { user_id: "user-1", channel_id: "channel-1", post_id: result.id },
          userName: "user-1",
        })).toEqual({ ephemeral_text: "Stop requested." });
        await f.final(params, "Stopped.");
      });
      expect(f.posts.get("post-1")?.message).toContain("Cancelled");
      expect(f.posts.get("post-2")?.message).toBe("Stopped.");
      expect(f.posts.get("post-2")?.props?.attachments).toEqual([]);
      expect(f.calls.filter((call) => call.path === "/posts")).toHaveLength(2);
      const writes = f.calls.filter((call) => call.method === "PUT");
      expect(writes.some((call) => call.path === "/posts/post-2/patch" && call.body.message === "Stopped.")).toBe(true);
    },
  );

  it.each(["rest", "companion"] as const)(
    "emits a signed Stop for the owned run and removes it after %s delivery",
    async (transport) => {
      vi.useFakeTimers();
      const f = fixture("partial", transport);
      f.monitor.cfg.channels!.mattermost!.allowFrom = ["user-1"];
      setInteractionSecret("default", "test-token");
      await f.run(async (params) => {
        params.replyOptions?.onAgentRunStart?.("run-stop");
        await params.replyOptions?.onPartialReply?.({ text: "Working" });
        await vi.advanceTimersByTimeAsync(1200);
        const post = f.posts.get("post-1")!;
        const attachments = post.props!.attachments as Array<{
          actions: Array<{ integration: { context: Record<string, unknown> } }>;
        }>;
        const result = await handleMattermostPreviewStop(f.monitor, {
          context: attachments[0]!.actions[0]!.integration.context,
          payload: { user_id: "user-1", channel_id: "channel-1", post_id: post.id },
          userName: "user-1",
        });
        expect(result).toEqual({ ephemeral_text: "Stop requested." });
        expect(params.replyOptions?.abortSignal?.aborted).toBe(true);
        await f.final(params, "Stopped.");
      });
      expect(f.posts.get("post-1")!.message).toBe("Stopped.");
      expect(f.posts.get("post-1")!.props!.attachments).toEqual([]);
      expect(f.calls.filter((call) => call.path === "/posts")).toHaveLength(1);
    },
  );
  it.each(["rest", "companion"] as const)(
    "retains pre-tool prose and final post ownership with %s previews",
    async (transport) => {
      vi.useFakeTimers();
      const f = fixture("block", transport);
      await f.run(async (params) => {
        expect(params.replyOptions?.preserveProgressCallbackStartOrder).toBe(true);
        await params.replyOptions?.onAssistantMessageStart?.();
        await params.replyOptions?.onPartialReply?.({ text: "I will check." });
        await vi.advanceTimersByTimeAsync(1200);
        await params.replyOptions?.onToolStart?.({ name: "read", toolCallId: "tool-1" });
        await params.replyOptions?.onAssistantMessageStart?.();
        await params.replyOptions?.onPartialReply?.({ text: "Found the answer." });
        await vi.advanceTimersByTimeAsync(1200);
        await f.final(params, "I will check.\n\nFound the answer.");
      });
      expect([...f.posts.values()].map((post) => post.message)).toEqual([
        "I will check.",
        "Found the answer.",
      ]);
      const creates = f.calls.filter((call) => call.path === "/posts");
      expect(creates).toHaveLength(2);
      expect(creates.every((call) => call.body.root_id === "thread-1")).toBe(true);
      expect(f.calls.filter((call) => call.method === "PUT").at(-1)?.path).toBe(
        "/posts/post-2/patch",
      );
      expect(f.calls.filter((call) => call.method === "DELETE")).toEqual([]);
    },
  );

  it.each(["rest", "companion"] as const)(
    "allows a shorter final without a matching partial to edit the same %s preview",
    async (transport) => {
      vi.useFakeTimers();
      const f = fixture("partial", transport);
      await f.run(async (params) => {
        await params.replyOptions?.onAssistantMessageStart?.();
        await params.replyOptions?.onPartialReply?.({ text: "Correct answer. Old draft tail." });
        await vi.advanceTimersByTimeAsync(1200);
        await f.final(params, "Correct answer.");
      });
      expect(normalSend).not.toHaveBeenCalled();
      expect([...f.posts.values()].map((post) => post.message)).toEqual(["Correct answer."]);
      expect(f.calls.filter((call) => call.path === "/posts")).toHaveLength(1);
      expect(f.calls.filter((call) => call.method === "PUT").at(-1)?.path).toBe(
        "/posts/post-1/patch",
      );
    },
  );

  it.each(["rest", "companion"] as const)(
    "accepts a shorter authoritative snapshot within the same message with %s",
    async (transport) => {
      vi.useFakeTimers();
      const f = fixture("partial", transport);
      await f.run(async (params) => {
        await params.replyOptions?.onAssistantMessageStart?.();
        await params.replyOptions?.onPartialReply?.({ text: "Correct answer. Old draft tail." });
        await vi.advanceTimersByTimeAsync(1200);
        await params.replyOptions?.onPartialReply?.({ text: "Correct answer." });
        await vi.advanceTimersByTimeAsync(1200);
        expect(f.posts.get("post-1")?.message).toBe("Correct answer.");
        await f.final(params, "Correct answer.");
      });
      expect([...f.posts.values()].map((post) => post.message)).toEqual(["Correct answer."]);
      expect(f.calls.filter((call) => call.path === "/posts")).toHaveLength(1);
    },
  );

  it.each(["rest", "companion"] as const)(
    "does not duplicate sealed prose when the cumulative final shortens the current %s block",
    async (transport) => {
      vi.useFakeTimers();
      const f = fixture("block", transport);
      await f.run(async (params) => {
        await params.replyOptions?.onAssistantMessageStart?.();
        await params.replyOptions?.onPartialReply?.({ text: "I will check." });
        await vi.advanceTimersByTimeAsync(1200);
        await params.replyOptions?.onAssistantMessageStart?.();
        await params.replyOptions?.onPartialReply?.({ text: "Correct answer. Old draft tail." });
        await vi.advanceTimersByTimeAsync(1200);
        await f.final(params, "I will check.\n\nCorrect answer.");
      });
      expect(normalSend).not.toHaveBeenCalled();
      expect([...f.posts.values()].map((post) => post.message)).toEqual([
        "I will check.",
        "Correct answer.",
      ]);
      expect(f.calls.filter((call) => call.path === "/posts")).toHaveLength(2);
      expect(f.calls.filter((call) => call.method === "PUT").at(-1)?.path).toBe(
        "/posts/post-2/patch",
      );
    },
  );

  it("stops typing between failed recovery attempts and permits a later successful turn", async () => {
    vi.useFakeTimers();
    const f = fixture("off");
    const typing = () => f.calls.filter((call) => call.path.endsWith("/typing"));
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = typing().length;
      await expect(
        f.run(async (params) => {
          await params.replyOptions?.onReplyStart?.();
          await vi.advanceTimersByTimeAsync(3000);
          expect(typing().length).toBeGreaterThan(before + 1);
          throw new Error("prepared reply dispatch runtime owner was not published for default");
        }),
      ).rejects.toThrow("prepared reply dispatch runtime owner was not published");
      const settled = typing().length;
      await vi.advanceTimersByTimeAsync(9000);
      expect(typing()).toHaveLength(settled);
    }
    const beforeSuccess = typing().length;
    await f.run(async (params) => {
      await params.replyOptions?.onReplyStart?.();
      await vi.advanceTimersByTimeAsync(3000);
      expect(typing().length).toBeGreaterThan(beforeSuccess + 1);
    });
    const settled = typing().length;
    await vi.advanceTimersByTimeAsync(9000);
    expect(typing()).toHaveLength(settled);
    expect(typing().every((call) => call.body.channel_id === "channel-1" &&
      call.body.parent_id === "thread-1")).toBe(true);
    expect(f.posts.size).toBe(0);
  });
});
