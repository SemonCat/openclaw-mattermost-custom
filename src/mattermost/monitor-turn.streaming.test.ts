import {
  dispatchReplyWithBufferedBlockDispatcher,
  type ReplyDispatchRuntimeInfo,
} from "openclaw/plugin-sdk/reply-runtime";
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMattermostAccount } from "./accounts.js";
import { sendMattermostTyping, type MattermostClient, type MattermostPost } from "./client.js";
import { buildMattermostEventPlan } from "./monitor-event-plan.js";
import { dispatchMattermostInboundTurn } from "./monitor-turn.js";
import { setInteractionSecret } from "./interactions.js";
import { createMattermostReactionLifecycleStore } from "./monitor-turn-reactions.js";
import { createMattermostTaskCardContinuation } from "./task-card-continuation.js";
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
function fixture(
  mode: "block" | "partial" | "progress" | "off",
  transport: "rest" | "companion" = "rest",
  channelType: "O" | "D" = "O",
) {
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
  let nextPostId = 0;
  const client: MattermostClient = {
    baseUrl: "https://mattermost.example.invalid",
    apiBaseUrl: "https://mattermost.example.invalid/api/v4",
    token: "test-token",
    request: async <T>(path: string, init?: RequestInit): Promise<T> => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      calls.push({ path, method: init?.method ?? "GET", body });
      if (path.split("?")[0] === "/posts") {
        const post = { ...body, id: `post-${++nextPostId}`, user_id: "bot" } as MattermostPost;
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
  let progressOffer: ReplyDispatchRuntimeInfo["adoptProgressDraft"];
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
            // The host attaches its capability at delivery. Private payload
            // metadata is not a published SDK API; supply that host boundary here.
            dispatcherOptions: { ...turn.dispatcherOptions,
              deliver: (payload, info) => turn.delivery.deliver(payload,
                progressOffer ? { ...info, adoptProgressDraft: progressOffer } : info),
              onError: turn.delivery.onError },
            replyOptions: turn.replyOptions,
            dispatchReplyFromConfig: async (options) => {
              await script(options);
              return {
                queuedFinal: false,
                counts: options.dispatcher.getQueuedCounts(),
                [Symbol.for("openclaw.agentRunTerminalOutcome")]: "completed",
              };
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
        type: channelType,
        name: "town-square",
      }),
      sendTypingIndicator: async (channelId: string, parentId?: string) =>
        sendMattermostTyping(client, { channelId, parentId }),
    },
  } as unknown as MattermostMonitorContext;
  const run = async (
    next: Script,
    turnAdoptionLifecycle?: Parameters<typeof dispatchMattermostInboundTurn>[1]["turnAdoptionLifecycle"],
  ) => {
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
      turnAdoptionLifecycle,
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
  return { run, final, calls, posts, monitor,
    offerProgressDraft: (offer: NonNullable<typeof progressOffer>) => { progressOffer = offer; } };
}

describe("Mattermost monitor streaming boundaries", () => {
  it.each((["rest", "companion"] as const).flatMap(transport =>
    (["partial", "block", "progress"] as const).map(mode => ({ transport, mode }))))(
    "keeps $transport $mode previews and task cards free of standalone Stop controls",
    async ({ transport, mode }) => {
      vi.useFakeTimers();
      const f = fixture(mode, transport);
      f.monitor.account.config.streaming!.progress!.toolProgress = true;
      setInteractionSecret("default", "test-token");
      if (mode === "progress") {
        normalSend.mockImplementationOnce(async () => ({
          messageId: "final-post", channelId: "channel-1",
        }) as never);
      }
      const expectNoStop = () => {
        expect(f.posts.size).toBeGreaterThan(0);
        for (const post of f.posts.values()) {
          expect(post.props).not.toHaveProperty("openclaw_preview_stop");
          expect(JSON.stringify(post.props)).not.toContain("openclawstop");
        }
        expect(JSON.stringify(f.calls)).not.toContain("openclaw_preview_stop");
        expect(JSON.stringify(f.calls)).not.toContain("openclawstop");
      };
      await f.run(async (params) => {
        params.replyOptions?.onAgentRunStart?.("run-without-stop");
        await params.replyOptions?.onPlanUpdate?.({
          steps: [{ step: "Inspect", status: "in_progress" }],
        });
        await params.replyOptions?.onItemEvent?.({
          itemId: "read-1", kind: "tool", name: "read", phase: "start", status: "running",
        });
        await params.replyOptions?.onPartialReply?.({ text: "Working" });
        await vi.advanceTimersByTimeAsync(1200);
        expect([...f.posts.values()].some(post =>
          (post.props?.openclaw_mattermost as { kind?: string })?.kind === "turn_result",
        )).toBe(true);
        expectNoStop();
        await params.replyOptions?.onPlanUpdate?.({
          steps: [{ step: "Inspect", status: "completed" }],
        });
        await f.final(params, "All done.");
      });
      expectNoStop();
      expect(f.posts.get("post-1")?.message).toContain("Task progress · Completed");
      if (mode === "progress") {
        expect(normalSend).toHaveBeenCalledOnce();
        expect(normalSend.mock.calls[0]).toContain("All done.");
      } else {
        expect([...f.posts.values()].some(post => post.message === "All done.")).toBe(true);
      }
    },
  );

  it.each((["rest", "companion"] as const).flatMap(transport =>
    (["before", "after"] as const).map(retirement => ({ transport, retirement }))))(
    "completes the original card when a native terminal-only settle retires its $transport progress draft $retirement lifecycle publication",
    async ({ transport, retirement }) => {
      const f = fixture("progress", transport);
      f.monitor.account.config.replyToMode = "first";
      f.monitor.account.config.streaming!.progress!.toolProgress = true;
      setInteractionSecret("default", "test-token");
      type Events = MattermostMonitorContext["core"]["events"];
      const transcripts = new Set<Parameters<Events["onSessionTranscriptUpdate"]>[0]>();
      const agents = new Set<Parameters<Events["onAgentEvent"]>[0]>();
      const events = {
        onSessionTranscriptUpdate: (listener: Parameters<Events["onSessionTranscriptUpdate"]>[0]) => {
          transcripts.add(listener); return () => { transcripts.delete(listener); };
        },
        onAgentEvent: (listener: Parameters<Events["onAgentEvent"]>[0]) => {
          agents.add(listener); return () => { agents.delete(listener); };
        },
      } as Events;
      f.monitor.core.events = events;
      const bridge = createMattermostTaskCardContinuation({ events, log: vi.fn() });
      f.monitor.taskCardContinuation = bridge;
      const parent = "agent:main:mattermost:channel:channel-1:thread:thread-1";
      const child = "agent:main:subagent:known-child";
      const successor = "announce:requester-settle:main:parent:cohort:yield-1";
      let retained: Parameters<NonNullable<ReplyDispatchRuntimeInfo["adoptProgressDraft"]>>[0] | undefined;
      f.offerProgressDraft(draft => { retained = draft; return true; });
      f.monitor.core.agent.session.listSessionEntries = () => [{
        sessionKey: child, entry: { spawnedBy: parent, createdAt: Date.now(), status: "done" },
      }] as never;
      const lifecycle = (runId: string, data: Record<string, unknown>) => {
        for (const listener of agents) listener({ runId, sessionKey: parent, stream: "lifecycle", data });
      };
      const emit = (messageSeq: number, message: unknown, runId?: string) => {
        for (const listener of transcripts) listener({
          target: { agentId: "main", sessionId: "test-session", sessionKey: parent },
          messageSeq, message, runId,
        });
      };
      try {
        await f.run(async (params) => {
          params.replyOptions?.onAgentRunStart?.("initial-run");
          await params.replyOptions?.onPlanUpdate?.({
            source: "openclaw", steps: [{ step: "Verify candidate", status: "completed" }],
          });
          await params.replyOptions?.onItemEvent?.({
            itemId: "work", kind: "tool", name: "exec", phase: "start", status: "running",
          });
          lifecycle("initial-run", {
            phase: "end", yielded: true, livenessState: "paused", stopReason: "end_turn",
          });
          await f.final(params, "Waiting for child settlement");
        });
        expect(retained).toBeDefined();
        expect(f.posts.get("post-1")?.message).toContain("Task progress · In progress");
        emit(860, { role: "user", display: false, provenance: {
          kind: "inter_session", sourceSessionKey: child,
          sourceChannel: "internal", sourceTool: "subagent_settle",
        }, content: [] });
        emit(861, { role: "assistant", __openclaw: { runId: successor },
          stopReason: "stop", content: [{ type: "text", text: "Final delivered separately" }] }, successor);
        if (retirement === "before") retained!.retire();
        lifecycle(successor, { phase: "end", stopReason: "stop", executionSettled: true });
        if (retirement === "after") retained!.retire();
        await vi.waitFor(() => expect(f.posts.get("post-1")?.message).toContain("Task progress · Completed"));
        expect(f.posts.get("post-1")?.message).toContain("- [x] Verify candidate");
        expect(f.posts.get("post-1")?.message).not.toContain("Final delivered separately");
        expect(f.posts.get("post-1")?.props?.openclaw_mattermost).toMatchObject({ kind: "task_progress" });
        const writes = f.calls.filter(call => call.path === "/posts/post-1/patch").length;
        emit(862, { role: "user", provenance: { kind: "internal_system", sourceTool: "exec" }, content: [] });
        emit(863, { role: "assistant", __openclaw: { runId: "internal-exec" },
          stopReason: "stop", content: [{ type: "text", text: "NO_REPLY" }] }, "internal-exec");
        lifecycle("internal-exec", { phase: "end", stopReason: "stop" });
        for (let i = 0; i < 60; i++) await Promise.resolve();
        expect(f.calls.filter(call => call.path === "/posts/post-1/patch")).toHaveLength(writes);
      } finally { retained?.retire(); bridge.stop(); }
    },
  );

  it.each(["rest", "companion"] as const)(
    "retires transient execution progress while preserving the card and final with %s transport",
    async (transport) => {
      vi.useFakeTimers();
      const f = fixture("block", transport);
      f.monitor.account.config.streaming!.progress!.toolProgress = true;
      setInteractionSecret("default", "test-token");
      await f.run(async (params) => {
        params.replyOptions?.onAgentRunStart?.("retained-run");
        await params.replyOptions?.onPlanUpdate?.({
          steps: [{ step: "Inspect", status: "in_progress" }],
        });
        await params.replyOptions?.onItemEvent?.({
          itemId: "read-1", kind: "tool", name: "read", phase: "start", status: "running",
        });
        await vi.advanceTimersByTimeAsync(1200);
        const preview = f.posts.get("post-2")!;
        expect(preview.message).toContain("Read");
        expect(preview.props).not.toHaveProperty("openclaw_preview_stop");
        await params.replyOptions?.onAssistantMessageStart?.();
        await params.replyOptions?.onPartialReply?.({ text: "All done." });
        await vi.advanceTimersByTimeAsync(1200);
        await params.replyOptions?.onPlanUpdate?.({
          steps: [{ step: "Inspect", status: "completed" }],
        });
        await f.final(params, "All done.");
      });
      expect(f.posts.get("post-1")?.message).toContain("Task progress · Completed");
      expect(f.posts.has("post-2")).toBe(false);
      expect(f.posts.get("post-3")?.message).toBe("All done.");
      expect(f.posts.get("post-3")?.props?.openclaw_mattermost).toMatchObject({ kind: "turn_result" });
      expect(f.posts.get("post-3")?.props).not.toHaveProperty("attachments");
      expect(f.posts.get("post-3")?.props).not.toHaveProperty("openclaw_preview_stop");
      const settled = f.calls.length;
      await vi.advanceTimersByTimeAsync(2400);
      expect(f.calls).toHaveLength(settled);
      expect(f.calls.filter((call) => call.method === "DELETE")).toEqual([
        expect.objectContaining({ path: "/posts/post-2" }),
      ]);
    },
  );

  it.each(["rest", "companion"] as const)(
    "retires a completed %s execution preview without control cleanup requests",
    async (transport) => {
      vi.useFakeTimers();
      const f = fixture("progress", transport);
      f.monitor.account.config.streaming!.progress!.toolProgress = true;
      normalSend.mockImplementationOnce(async () => ({
        messageId: "final-post", channelId: "channel-1",
      }) as never);
      await f.run(async (params) => {
        params.replyOptions?.onAgentRunStart?.("completed-run");
        await params.replyOptions?.onPlanUpdate?.({
          steps: [{ step: "Inspect", status: "in_progress" }],
        });
        await params.replyOptions?.onItemEvent?.({
          itemId: "read-1", kind: "tool", name: "read", phase: "start", status: "running",
        });
        await vi.advanceTimersByTimeAsync(1200);
        expect(f.posts.get("post-2")?.props).not.toHaveProperty("attachments");
        await params.replyOptions?.onPlanUpdate?.({
          steps: [{ step: "Inspect", status: "completed" }],
        });
        await f.final(params, "All done.");
      });
      expect(f.posts.get("post-1")?.message).toContain("Task progress · Completed");
      expect(f.posts.has("post-2")).toBe(false);
      expect(normalSend).toHaveBeenCalledOnce();
      expect(f.calls.filter(call => call.path === "/posts/post-2" && call.method === "DELETE")).toHaveLength(1);
      expect(f.calls.some(call => call.path === "/posts/post-2" && call.method === "GET")).toBe(false);
      expect(f.calls.some(call => call.path === "/posts/post-2/patch" && call.body.props !== undefined)).toBe(false);
    },
  );

  it.each([
    { child: "hidden", timing: "before", outcome: "completed" },
    { child: "hidden", timing: "split", outcome: "completed" },
    { child: "hidden", timing: "after", outcome: "completed" },
    { child: "known", timing: "before", outcome: "completed" },
    { child: "hidden", timing: "before", outcome: "partial" },
    { child: "hidden", timing: "before", outcome: "error" },
    { child: "hidden", timing: "before", outcome: "aborted" },
    { child: "foreign", timing: "before", outcome: "fenced" },
    { child: "hidden", timing: "before", outcome: "human" },
    { child: "hidden", timing: "before", outcome: "no-plan" },
  ].flatMap(scenario => [
    { ...scenario, preview: "partial" as const },
    { ...scenario, preview: "progress" as const },
  ]))("projects $child-child settlement around original cleanup ($timing, $outcome, $preview)", async ({ child, timing, outcome, preview }) => {
    const f = fixture(preview, preview === "progress" ? "companion" : "rest");
    if (preview === "progress") setInteractionSecret("default", "test-token");
    f.monitor.account.config.replyToMode = "first";
    f.monitor.account.config.streaming!.progress!.toolProgress = preview === "progress";
    type Draft = Parameters<NonNullable<ReplyDispatchRuntimeInfo["adoptProgressDraft"]>>[0];
    let retained: Draft | undefined;
    const adopt = vi.fn((draft: Draft) => { retained = draft; return true; });
    if (preview === "progress") f.offerProgressDraft(adopt);
    type Events = MattermostMonitorContext["core"]["events"];
    const transcriptListeners = new Set<Parameters<Events["onSessionTranscriptUpdate"]>[0]>();
    const agentListeners = new Set<Parameters<Events["onAgentEvent"]>[0]>();
    const events = {
      onSessionTranscriptUpdate: (listener: Parameters<Events["onSessionTranscriptUpdate"]>[0]) => {
        transcriptListeners.add(listener);
        return () => { transcriptListeners.delete(listener); };
      },
      onAgentEvent: (listener: Parameters<Events["onAgentEvent"]>[0]) => {
        agentListeners.add(listener);
        return () => { agentListeners.delete(listener); };
      },
    } as Events;
    f.monitor.core.events = events;
    const bridge = createMattermostTaskCardContinuation({ events, log: vi.fn() });
    f.monitor.taskCardContinuation = bridge;
    const parent = "agent:main:mattermost:channel:channel-1:thread:thread-1";
    f.monitor.core.agent.session.listSessionEntries = () => [{
      sessionKey: "hidden-child",
      entry: { spawnedBy: parent, createdAt: Date.now(), status: "done", lastRunId: "child-run" },
    }] as never;
    let seq = 262;
    const emit = (message: unknown, runId?: string) => {
      for (const listener of transcriptListeners) listener({
        target: { agentId: "main", sessionId: "test-session", sessionKey: parent },
        messageSeq: ++seq, message, runId,
      });
    };
    const lifecycle = (runId: string, data: Record<string, unknown>) => {
      for (const listener of agentListeners) listener({ runId, sessionKey: parent, stream: "lifecycle", data });
    };
    const plan = ["Inspect", "Implement", "Verify"];
    const input = () => emit({ role: "user", provenance: {
      kind: "inter_session", sourceChannel: "internal", sourceTool: "subagent_settle",
      sourceSessionKey: child === "foreign" ? "foreign-child" : "hidden-child",
    }, content: [] });
    const complete = () => {
      emit({ role: "custom", customType: "openclaw.nested-tool.v1",
        display: true, excludeFromContext: true, content: "", timestamp: Date.now(),
        details: { runId: "successor-run", scopeId: "scope", afterEntryId: null, startOrder: 0,
          toolCallId: "progress-call", toolName: "progress_card", isError: false,
          startedAt: Date.now(), timestamp: Date.now(),
          input: { plan: plan.map((step, i) => ({
            step, status: outcome === "partial" && i === 2 ? "pending" : "completed",
          })) },
          result: { content: [], details: { revision: 4, steps: { completed: 3, total: 3 } } } } });
      emit({ role: "toolResult", __openclaw: { runId: "successor-run" },
        toolName: "dispatch_action", isError: false, content: [] });
      emit({ role: "assistant", __openclaw: { runId: "successor-run" },
        stopReason: outcome === "error" || outcome === "aborted" ? outcome : "stop",
        content: [{ type: "text", text: "Delivered separately" }] }, "successor-run");
      lifecycle("successor-run", { phase: outcome === "error" ? "error" : "end",
        aborted: outcome === "aborted" });
    };
    try {
      await f.run(async (params) => {
        params.replyOptions?.onAgentRunStart?.("initial-run");
        if (outcome !== "no-plan") await params.replyOptions?.onPlanUpdate?.({
          source: "openclaw",
          steps: plan.map((step, i) => ({ step, status: i < 2 ? "completed" : "in_progress" })),
        });
        if (child === "known") params.replyOptions?.onVisibleWorkSessions?.([{ sessionKey: "hidden-child" }]);
        lifecycle("initial-run", { phase: "end", yielded: true, livenessState: "paused", stopReason: "end_turn" });
        if (outcome !== "no-plan") {
          expect(f.posts.get("post-1")?.message).toContain("Task progress · In progress");
          expect(f.posts.get("post-1")?.message).toContain("- [ ] **Verify**");
        }
        // A hidden child has no onVisibleWorkSessions callback. Core commits
        // its native settle input before the original inbound owner returns.
        if (timing !== "after") input();
        if (outcome === "human") emit({ role: "user", content: [{ type: "text", text: "Correction" }] });
        if (timing === "before") complete();
        if (outcome !== "no-plan") {
          // Candidate rows cannot edit until original cleanup proves the child.
          expect(f.posts.get("post-1")?.message).toContain("- [ ] **Verify**");
        }
        if (preview === "progress" && outcome !== "no-plan") {
          await params.replyOptions?.onItemEvent?.({
            itemId: "initial-tool", kind: "tool", name: "read", phase: "start", status: "running",
          });
          await f.final(params, "Waiting for delegated work");
          expect(adopt).toHaveBeenCalledOnce();
          expect(f.calls.some(call => call.path.endsWith("/capabilities"))).toBe(true);
          expect(f.posts.get("post-2")?.type).toBe("custom_openclaw_stream");
          expect(f.posts.get("post-2")?.root_id).toBe("thread-1");
          expect(f.calls.some(call => call.path.endsWith("/close") && call.body.post_id === "post-2")).toBe(true);
        }
      });
      if (timing !== "before") {
        expect(f.posts.get("post-1")?.message).toContain("Task progress · In progress");
        if (preview === "progress") {
          retained!.push({ itemId: "successor-tool", kind: "tool", name: "exec", phase: "start", status: "running" });
          await vi.waitFor(() => expect(f.posts.get("post-2")?.message).toContain("Exec"), { timeout: 2000 });
          expect(f.posts.get("post-1")?.message).not.toContain("Exec");
        }
        if (timing === "after") input();
        complete();
      }
      // Let queued continuation writes settle before asserting negative fences.
      for (let i = 0; i < 100; i++) await Promise.resolve();
      const status = outcome === "error" ? "Failed" : outcome === "aborted" ? "Cancelled"
        : outcome === "partial" ? "Incomplete" : ["fenced", "human"].includes(outcome) ? "In progress" : "Completed";
      if (outcome === "no-plan") expect(f.posts.size).toBe(0);
      else {
        await vi.waitFor(() => expect(f.posts.get("post-1")?.message).toContain(`Task progress · ${status}`));
        if (outcome === "completed") {
          for (const step of plan) expect(f.posts.get("post-1")?.message).toContain(`- [x] ${step}`);
        }
        if (["fenced", "human"].includes(outcome)) {
          expect(f.posts.get("post-1")?.message).toContain("- [ ] **Verify**");
        }
      }
      expect(f.calls.filter(call => call.path.split("?")[0] === "/posts"))
        .toHaveLength(outcome === "no-plan" ? 0 : preview === "progress" ? 2 : 1);
      expect(f.calls.filter(call => call.path.endsWith("/patch"))
        .every(call => call.path === "/posts/post-1/patch" ||
          preview === "progress" && call.path === "/posts/post-2/patch")).toBe(true);
    } finally {
      retained?.retire();
      bridge.stop();
    }
  });

  it.each(["before-result", "after-commentary"] as const)(
    "keeps DM task progress and the successor result in the inbound thread (%s plan)",
    async (boundary) => {
      vi.useFakeTimers();
      const f = fixture("partial", "rest", "D");
      f.monitor.account.config.replyToMode = "first";
      await f.run(async (params) => {
        await params.replyOptions?.onPartialReply?.({ text: "Early commentary" });
        if (boundary === "after-commentary") {
          await vi.advanceTimersByTimeAsync(1200);
          expect(f.posts.get("post-1")?.message).toBe("Early commentary");
        } else {
          expect(f.posts.size).toBe(0);
        }
        await params.replyOptions?.onPlanUpdate?.({
          steps: [{ step: "Inspect", status: "in_progress" }],
        });
        await params.replyOptions?.onToolStart?.({ name: "read", toolCallId: "tool-1" });
        await params.replyOptions?.onPartialReply?.({ text: "Found the answer." });
        await vi.advanceTimersByTimeAsync(1200);
        expect(f.posts.get("post-1")?.props?.openclaw_mattermost).toMatchObject({
          kind: "task_progress",
        });
        expect(f.posts.get("post-2")?.props?.openclaw_mattermost).toMatchObject({
          kind: "turn_result",
        });
        await params.replyOptions?.onPlanUpdate?.({
          steps: [{ step: "Inspect", status: "completed" }],
        });
        await f.final(params, "Found the answer.");
      });
      const creates = f.calls.filter((call) => call.path.split("?")[0] === "/posts");
      expect(creates).toHaveLength(2);
      expect(creates.map((call) => call.body.root_id)).toEqual(["thread-1", "thread-1"]);
      if (boundary === "after-commentary") {
        expect(creates[1]?.body.message).toBe("Early commentary");
      }
      expect(f.posts.get("post-1")?.message).toContain("Task progress · Completed");
      expect(f.posts.get("post-2")?.message).toBe("Found the answer.");
      const answerWrites = f.calls.filter(
        (call) => call.method === "PUT" && call.body.message === "Found the answer.",
      );
      expect(answerWrites.length).toBeGreaterThan(0);
      expect(answerWrites.every((call) => call.path === "/posts/post-2/patch")).toBe(true);
      expect(normalSend).not.toHaveBeenCalled();
    },
  );

  it.each(["before-result", "after-commentary"] as const)(
    "keeps a late %s plan above the result and finalizes host cancellation",
    async (boundary) => {
      vi.useFakeTimers();
      const f = fixture("partial");
      type AgentListener = Parameters<MattermostMonitorContext["core"]["events"]["onAgentEvent"]>[0];
      let onAgentEvent: AgentListener | undefined;
      f.monitor.core.events = {
        onAgentEvent: (listener: AgentListener) => {
          onAgentEvent = listener;
          return () => { onAgentEvent = undefined; };
        },
      } as never;
      await f.run(async (params) => {
        params.replyOptions?.onAgentRunStart?.("run-plan-cancel");
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
        expect(result.props).not.toHaveProperty("attachments");
        onAgentEvent?.({
          runId: "run-plan-cancel", stream: "lifecycle", data: { phase: "end", aborted: true },
        });
        await f.final(params, "Stopped.");
      });
      expect(f.posts.get("post-1")?.message).toContain("Cancelled");
      expect(f.posts.get("post-1")?.message).toContain("Task cancelled; reason unavailable.");
      expect(f.posts.get("post-2")?.message).toBe("Stopped.");
      expect(f.posts.get("post-2")?.props).not.toHaveProperty("attachments");
      expect(f.calls.filter((call) => call.path.split("?")[0] === "/posts")).toHaveLength(2);
      const writes = f.calls.filter((call) => call.method === "PUT");
      expect(writes.some((call) => call.path === "/posts/post-2/patch" && call.body.message === "Stopped.")).toBe(true);
    },
  );

  it.each(["rest", "companion"] as const)(
    "preserves ingress cancellation without adding controls to a planless %s reply",
    async (transport) => {
      vi.useFakeTimers();
      const f = fixture("partial", transport);
      const controller = new AbortController();
      const lifecycle = {
        abortSignal: controller.signal,
        onAdopted: vi.fn(), onDeferred: vi.fn(),
        onAdoptionFinalizing: vi.fn(), onAbandoned: vi.fn(),
      };
      await f.run(async (params) => {
        params.replyOptions?.onAgentRunStart?.("planless-run");
        await params.replyOptions?.onPartialReply?.({ text: "Working" });
        await vi.advanceTimersByTimeAsync(1200);
        const post = f.posts.get("post-1")!;
        expect(post.props).not.toHaveProperty("attachments");
        expect(post.props).not.toHaveProperty("openclaw_preview_stop");
        const adoption = params.replyOptions?.turnAdoptionLifecycle;
        expect(adoption?.abortSignal).toBe(controller.signal);
        await adoption?.onAbandoned?.();
        expect(lifecycle.onAbandoned).toHaveBeenCalledOnce();
        expect(adoption?.onSettled).toEqual(expect.any(Function));
        controller.abort();
        expect(adoption?.abortSignal?.aborted).toBe(true);
        await f.final(params, "Stopped.");
      }, lifecycle);
      expect(f.posts.get("post-1")!.message).toBe("Stopped.");
      expect(f.posts.get("post-1")!.props).not.toHaveProperty("attachments");
      expect(f.calls.filter(call => call.path.split("?")[0] === "/posts")).toHaveLength(1);
    },
  );
  it.each((["rest", "companion"] as const).flatMap(transport =>
    (["silent", "error", "status"] as const).map(terminal => ({ transport, terminal }))))(
    "removes tool progress after a $terminal terminal turn with $transport previews",
    async ({ transport, terminal }) => {
      vi.useFakeTimers();
      const f = fixture("progress", transport);
      f.monitor.account.config.streaming!.progress!.toolProgress = true;
      if (terminal === "status") {
        normalSend.mockImplementationOnce(async () => ({
          messageId: "final-post", channelId: "channel-1",
        }) as never);
      }
      const turn = f.run(async (params) => {
        await params.replyOptions?.onItemEvent?.({
          itemId: "tool-1", kind: "tool", name: "read", phase: "start", status: "running",
        });
        await vi.advanceTimersByTimeAsync(1200);
        expect(f.posts.size).toBe(1);
        if (terminal === "error") throw new Error("execution failed");
        if (terminal === "status") {
          params.dispatcher.sendFinalReply({ text: "Session resolved.", isStatusNotice: true });
          await params.dispatcher.waitForIdle();
        }
      });
      if (terminal === "error") await expect(turn).rejects.toThrow("execution failed");
      else await turn;
      expect(f.posts.size).toBe(0);
      expect(f.calls.filter((call) => call.method === "DELETE")).toEqual([
        expect.objectContaining({ path: "/posts/post-1" }),
      ]);
      if (terminal === "status") expect(normalSend).toHaveBeenCalledOnce();
    },
  );
  it.each(["rest", "companion"] as const)(
    "removes transient tool progress while retaining prose with %s block previews",
    async (transport) => {
      vi.useFakeTimers();
      const f = fixture("block", transport);
      f.monitor.account.config.streaming!.progress!.toolProgress = true;
      await f.run(async (params) => {
        await params.replyOptions?.onAssistantMessageStart?.();
        await params.replyOptions?.onPartialReply?.({ text: "I will check." });
        await vi.advanceTimersByTimeAsync(1200);
        await params.replyOptions?.onItemEvent?.({
          itemId: "tool-1", kind: "tool", name: "read", phase: "start", status: "running",
        });
        await vi.advanceTimersByTimeAsync(1200);
        expect(f.posts.size).toBe(2);
        await params.replyOptions?.onAssistantMessageStart?.();
        await params.replyOptions?.onPartialReply?.({ text: "Found the answer." });
        await vi.advanceTimersByTimeAsync(1200);
        await f.final(params, "I will check.\n\nFound the answer.");
      });
      expect([...f.posts.values()].map((post) => post.message)).toEqual([
        "I will check.",
        "Found the answer.",
      ]);
      expect(f.calls.filter((call) => call.method === "DELETE")).toEqual([
        expect.objectContaining({ path: "/posts/post-2" }),
      ]);
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
      const creates = f.calls.filter((call) => call.path.split("?")[0] === "/posts");
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
      expect(f.calls.filter((call) => call.path.split("?")[0] === "/posts")).toHaveLength(1);
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
      expect(f.calls.filter((call) => call.path.split("?")[0] === "/posts")).toHaveLength(1);
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
      expect(f.calls.filter((call) => call.path.split("?")[0] === "/posts")).toHaveLength(2);
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
