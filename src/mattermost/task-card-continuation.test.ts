import { afterEach, describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import { createMattermostTaskProgressCard } from "./task-progress-card.js";
import { createMattermostTaskCardContinuation } from "./task-card-continuation.js";

type Events = MattermostMonitorContext["core"]["events"];
type Update = Parameters<Parameters<Events["onSessionTranscriptUpdate"]>[0]>[0];
const target = { agentId: "main", sessionId: "incarnation-1", sessionKey: "parent" };
const steps = ["Collect sources", "Validate report"];
const drain = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };

const yieldedEnd = { phase: "end", yielded: true, livenessState: "paused", stopReason: "end_turn" };

async function fixture(options: { noPlan?: boolean; missingId?: boolean; yielded?: boolean; allCompleted?: boolean; childRunning?: boolean } = {}) {
  const request = vi.fn<MattermostClient["request"]>(async () => (options.missingId ? { message: "accepted" } : { id: "original-card" }) as never);
  const client: MattermostClient = {
    baseUrl: "https://mattermost.example.com", apiBaseUrl: "https://mattermost.example.com/api/v4",
    token: "test-token", request, fetchImpl: vi.fn(),
  };
  const card = createMattermostTaskProgressCard({ client, channelId: "channel", log: vi.fn() });
  const listeners = new Set<(update: Update) => void>();
  const agentListeners = new Set<Parameters<Events["onAgentEvent"]>[0]>();
  const events = {
    onSessionTranscriptUpdate: (listener: (update: Update) => void) => {
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
    onAgentEvent: (listener: Parameters<Events["onAgentEvent"]>[0]) => {
      agentListeners.add(listener); return () => { agentListeners.delete(listener); };
    },
  } as Events;
  const bridge = createMattermostTaskCardContinuation({ events, log: vi.fn() });
  card.noteRunStart("original-run");
  if (!options.noPlan) await card.updatePlan({ source: "openclaw", steps: steps.map(step => ({ step, status: options.allCompleted ? "completed" : "pending" })) });
  await card.noteVisibleWorkSessions([{ sessionKey: "child-1", status: options.childRunning ? "running" : "done" }]);
  const owner = bridge.register({ ...target, initialRunId: "original-run", card })!;
  let seq = 0;
  const emit = (message: unknown, runId?: string, route = target) => {
    for (const listener of listeners) listener({ target: route, message, messageSeq: ++seq, runId });
  };
  const end = (runId: string, data = { phase: "end" }) => {
    for (const listener of agentListeners) listener({ runId, sessionKey: target.sessionKey, stream: "lifecycle", data });
  };
  const complete = (options: { runId?: string; partial?: boolean; outerError?: boolean;
    innerError?: boolean; wrongCall?: boolean; wrongWrapper?: boolean; terminal?: "stop" | "error" | "aborted";
    yielded?: boolean; lifecycleFirst?: boolean; skipLifecycle?: boolean } = {}) => {
    const runId = options.runId ?? "successor-run";
    emit({ role: "user", provenance: { kind: "inter_session", sourceChannel: "internal",
      sourceTool: "subagent_settle", sourceSessionKey: "child-1" }, content: [] });
    const terminalData = options.yielded ? yieldedEnd : {
      phase: options.terminal === "error" ? "error" : "end", aborted: options.terminal === "aborted",
    };
    if (options.lifecycleFirst) end(runId, terminalData);
    emit({ role: "assistant", __openclaw: { runId }, stopReason: "toolUse",
      content: [{ type: "toolCall", id: "call-1", name: "tool_call", arguments: {
        id: "openclaw:core:progress_card", args: {
          plan: steps.map((step, index) => ({ step, status: options.partial && index === 1 ? "pending" : "completed" })),
        },
      } }] });
    emit({ role: "toolResult", __openclaw: { runId },
      toolName: "tool_call", toolCallId: options.wrongCall ? "foreign-call" : "call-1", isError: options.outerError ?? false,
      content: [{ type: "text", text: JSON.stringify({
        tool: { id: options.wrongWrapper ? "other-tool" : "openclaw:core:progress_card", name: "progress_card", source: "openclaw" },
        result: { isError: options.innerError ?? false, content: [], details: { revision: 2, steps: { completed: 2, total: 2 } } },
      }) }] });
    emit({ role: "assistant", __openclaw: { runId },
      stopReason: options.terminal ?? "stop", content: [{ type: "text", text: "Result delivered separately" }] }, runId);
    if (!options.skipLifecycle && !options.lifecycleFirst) end(runId, terminalData);
  };
  const finish = async () => {
    if (options.yielded) card.noteAgentEvent({ runId: "original-run", stream: "lifecycle", data: yieldedEnd });
    await card.finish({ outcome: "completed" }); owner.finishInitial();
  };
  const assertCompleted = () => {
    expect(request.mock.calls.filter(([path]) => path === "/posts")).toHaveLength(1);
    expect(request.mock.calls.slice(1).every(([path]) => path === "/posts/original-card/patch")).toBe(true);
    const body = JSON.parse(String(request.mock.calls.at(-1)?.[1]?.body));
    expect(body.message).toContain("Task progress · Completed");
    for (const step of steps) expect(body.message).toContain(`- [x] ${step}`);
    expect(body.message).not.toContain("Result delivered separately");
  };
  const message = () => JSON.parse(String(request.mock.calls.at(-1)?.[1]?.body)).message as string;
  return { request, bridge, listeners, agentListeners, emit, complete, end, finish, assertCompleted, message, card };
}

afterEach(() => vi.useRealTimers());

describe("committed native task-card continuation retention", () => {
  it.each([false, true])("preserves repeated yields, native lifecycle before committed rows=%s", async (lifecycleFirst) => {
    const f = await fixture({ yielded: true });
    try {
      await f.finish();
      expect(f.message()).toContain("Task progress · In progress");
      f.complete({ yielded: true, partial: true, lifecycleFirst });
      await drain();
      expect(f.message()).toContain("Task progress · In progress");
      f.complete({ runId: "second-yield", yielded: true, lifecycleFirst });
      await drain();
      expect(f.message()).toContain("Task progress · In progress");
      expect(f.card.canContinue()).toBe(true);
      f.complete({ runId: "final-success", lifecycleFirst });
      await drain();
      f.assertCompleted();
    } finally { f.bridge.stop(); }
  });

  it.each([false, true])("buffers lifecycle before original return=%s", async (beforeReturn) => {
    const f = await fixture({ yielded: true, allCompleted: true });
    try {
      if (beforeReturn) f.complete({ lifecycleFirst: true });
      await f.finish();
      if (!beforeReturn) f.complete({ lifecycleFirst: true });
      await drain();
      f.assertCompleted();
    } finally { f.bridge.stop(); }
  });

  it("does not infer a successful terminal from assistant prose or stop alone", async () => {
    const f = await fixture({ yielded: true });
    try {
      await f.finish();
      f.complete({ skipLifecycle: true });
      await drain();
      expect(f.message()).toContain("Task progress · In progress");
      f.end("unproven-run", { phase: "end" });
      await drain();
      expect(f.message()).toContain("Task progress · In progress");
      f.end("successor-run", { phase: "end" });
      await drain();
      f.assertCompleted();
    } finally { f.bridge.stop(); }
  });

  it("updates the original card after 36 minutes within the absolute 24-hour cap", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    try {
      await f.finish();
      await vi.advanceTimersByTimeAsync(36 * 60 * 1_000);
      f.complete();
      await drain();
      f.assertCompleted();
    } finally { f.bridge.stop(); }
    expect(f.listeners.size).toBe(0);
    expect(f.agentListeners.size).toBe(0);
  });

  it.each([false, true])("ignores 80 original rows before a genuine continuation, successor before return=%s", async (beforeReturn) => {
    const f = await fixture();
    try {
      for (let i = 0; i < 80; i++) f.emit({ role: "toolResult", __openclaw: { runId: "original-run" },
        toolName: "read", toolCallId: `original-${i}`, isError: false, content: [] });
      if (beforeReturn) f.complete();
      await f.finish();
      if (!beforeReturn) f.complete();
      await drain();
      f.assertCompleted();
    } finally { f.bridge.stop(); }
  });

  it("expires after 24 hours and creates no successor card", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    try {
      await f.finish();
      const count = f.request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000 + 1);
      f.complete();
      await drain();
      expect(f.request.mock.calls).toHaveLength(count);
    } finally { f.bridge.stop(); }
  });
});


describe("continuation ownership and terminal fences", () => {
  it.each(["foreign-child", "foreign-session", "foreign-agent", "replaced-incarnation", "web-ui-user", "new-inbound", "stop"])(
    "prevents edits after %s", async (cause) => {
      const f = await fixture();
      try {
        await f.finish();
        const count = f.request.mock.calls.length;
        if (cause === "foreign-child") f.emit({ role: "user", provenance: {
          kind: "inter_session", sourceChannel: "internal", sourceTool: "subagent_settle", sourceSessionKey: "unrelated-child",
        } });
        if (cause === "foreign-session") {
          for (const listener of f.listeners) listener({ target: { ...target, sessionKey: "other-account-parent" },
            messageSeq: 1, message: { role: "user" } });
          expect(f.request.mock.calls).toHaveLength(count);
          // A foreign session is ignored; ordinary input in the exact session retires.
          f.emit({ role: "user", content: [] });
        }
        if (cause === "foreign-agent") f.emit({ role: "user" }, undefined, { ...target, agentId: "foreign" });
        if (cause === "replaced-incarnation") f.emit({ role: "user" }, undefined, { ...target, sessionId: "reset-session" });
        if (cause === "web-ui-user") f.emit({ role: "user", content: [{ type: "text", text: "New independent work" }] });
        if (cause === "new-inbound") f.bridge.retireSession(target.sessionKey);
        if (cause === "stop") f.bridge.stop();
        f.complete();
        await drain();
        expect(f.request.mock.calls).toHaveLength(count);
      } finally { f.bridge.stop(); }
    },
  );

  it.each(["outer-error", "inner-error", "wrong-call", "wrong-wrapper"])("requires matching wrapped tool success: %s", async (cause) => {
    const f = await fixture();
    try {
      await f.finish();
      f.complete({ outerError: cause === "outer-error", innerError: cause === "inner-error",
        wrongCall: cause === "wrong-call", wrongWrapper: cause === "wrong-wrapper" });
      await drain();
      expect(f.message()).toContain("Task progress · Incomplete");
      for (const step of steps) expect(f.message()).not.toContain(`- [x] ${step}`);
    } finally { f.bridge.stop(); }
  });

  it("keeps a partial successful parent incomplete, and rejects stale earlier run updates", async () => {
    const f = await fixture();
    try {
      await f.finish();
      f.complete({ partial: true });
      await drain();
      expect(f.message()).toContain("Task progress · Incomplete");
      expect(f.message()).toContain(`- [x] ${steps[0]}`);
      expect(f.message()).toContain(`- [ ] ${steps[1]}`);
      const count = f.request.mock.calls.length;
      f.complete({ runId: "original-run" });
      await drain();
      expect(f.request.mock.calls).toHaveLength(count);
      f.complete({ runId: "successor-run" }); // Already used run cannot claim a new input.
      await drain();
      expect(f.request.mock.calls).toHaveLength(count);
      f.complete({ runId: "next-successor" });
      await drain();
      f.assertCompleted();
    } finally { f.bridge.stop(); }
  });

  it.each(["error", "aborted"] as const)("preserves terminal %s even with an explicit completed plan", async (terminal) => {
    const f = await fixture();
    try {
      await f.finish();
      f.complete({ terminal });
      await drain();
      expect(f.message()).toContain(`Task progress · ${terminal === "error" ? "Failed" : "Cancelled"}`);
      const count = f.request.mock.calls.length;
      f.complete({ runId: "later-run" });
      await drain();
      expect(f.request.mock.calls).toHaveLength(count);
    } finally { f.bridge.stop(); }
  });

  it.each(["planless", "accepted-without-id"])("does not create or adopt a card for %s", async (cause) => {
    const f = await fixture({ noPlan: cause === "planless", missingId: cause === "accepted-without-id" });
    try {
      await f.finish();
      const count = f.request.mock.calls.length;
      f.complete();
      await drain();
      expect(f.request.mock.calls).toHaveLength(count);
      expect(f.card.postId()).toBeUndefined();
      expect(f.request.mock.calls.filter(([path]) => path === "/posts")).toHaveLength(cause === "planless" ? 0 : 1);
    } finally { f.bridge.stop(); }
  });

  it("fences queued continuation writes on immediate new input", async () => {
    const f = await fixture();
    try {
      await f.finish();
      const count = f.request.mock.calls.length;
      f.complete();
      f.emit({ role: "user", content: [] });
      await drain();
      expect(f.request.mock.calls).toHaveLength(count);
    } finally { f.bridge.stop(); }
  });

  it.each([false, true])("preserves the unprovenanced human correction fence, before initial finish=%s", async (beforeFinish) => {
    const f = await fixture({ yielded: true });
    try {
      if (!beforeFinish) await f.finish();
      f.emit({ role: "user", provenance: null, content: [{ type: "text", text: "Correct output folder" }] });
      // Later original-run tools do not prove this user row's adoption authority.
      f.emit({ role: "assistant", __openclaw: { runId: "original-run" }, content: [] });
      if (beforeFinish) await f.finish();
      const count = f.request.mock.calls.length;
      f.complete();
      await drain();
      expect(f.request.mock.calls).toHaveLength(count);
      expect(f.message()).toContain("Task progress · In progress");
    } finally { f.bridge.stop(); }
  });

  it("correlates a failure received before successor rows without waiting for a final assistant", async () => {
    const f = await fixture({ yielded: true });
    try {
      await f.finish();
      f.emit({ role: "user", provenance: { kind: "inter_session", sourceChannel: "internal",
        sourceTool: "subagent_settle", sourceSessionKey: "child-1" } });
      f.end("successor-run", { phase: "error" });
      await drain();
      expect(f.message()).toContain("Task progress · In progress");
      f.emit({ role: "assistant", __openclaw: { runId: "successor-run" }, stopReason: "toolUse", content: [] });
      await drain();
      expect(f.message()).toContain("Task progress · Failed");
      const count = f.request.mock.calls.length;
      f.complete({ runId: "later-run" });
      await drain();
      expect(f.request.mock.calls).toHaveLength(count);
    } finally { f.bridge.stop(); }
  });
});
