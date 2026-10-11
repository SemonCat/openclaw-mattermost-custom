// Account-scoped observation of committed automatic continuation; never adopts posts.
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { createMattermostTaskProgressCard, MattermostTaskProgressAgentEvent, MattermostTaskProgressPlan } from "./task-progress-card.js";

type Events = MattermostMonitorContext["core"]["events"];
type TranscriptUpdate = Parameters<Parameters<Events["onSessionTranscriptUpdate"]>[0]>[0];
type Card = ReturnType<typeof createMattermostTaskProgressCard>;
const OWNER_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_OWNERS = 100;
const MAX_PENDING = 32;
const PROGRESS_TOOL_ID = "openclaw:core:progress_card";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function committedRunId(update: TranscriptUpdate): string | undefined {
  const message = record(update.message);
  const metadata = record(message?.__openclaw);
  const details = record(message?.details);
  return typeof metadata?.runId === "string" ? metadata.runId
    : message?.customType === "openclaw.nested-tool.v1" && typeof details?.runId === "string"
      ? details.runId : update.runId;
}

function readPlan(value: unknown): MattermostTaskProgressPlan | undefined {
  const args = record(value);
  if (!Array.isArray(args?.plan) || args.plan.length === 0 || args.plan.length > 50) return;
  const steps: NonNullable<MattermostTaskProgressPlan["steps"]> = [];
  for (const value of args.plan) {
    const step = record(value);
    if (typeof step?.step !== "string" ||
        !["pending", "in_progress", "completed"].includes(String(step.status))) return;
    steps.push({ step: step.step, status: step.status as typeof steps[number]["status"] });
  }
  // Only the original explicit checklist crosses this boundary. No transcript text.
  return { source: "openclaw", steps };
}

function successfulWrappedResult(message: Record<string, unknown>): boolean {
  if (message.isError !== false || !Array.isArray(message.content)) return false;
  for (const value of message.content) {
    const block = record(value);
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    try {
      const payload = record(JSON.parse(block.text));
      const tool = record(payload?.tool);
      const result = record(payload?.result);
      if (tool?.id === PROGRESS_TOOL_ID && tool.name === "progress_card" &&
          tool.source === "openclaw" && result && result.isError !== true) return true;
    } catch { /* A non-JSON tool result cannot prove progress success. */ }
  }
  return false;
}

type Owner = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  card: Card;
  initialRunId: string;
  ready: boolean;
  active: boolean;
  seq: number;
  input?: { sourceSessionKey: string; seq: number };
  runId?: string;
  usedRuns: Set<string>;
  calls: Map<string, MattermostTaskProgressPlan>;
  pending: TranscriptUpdate[];
  bufferingContinuation: boolean;
  terminalRunId?: string;
  lifecycle: Map<string, MattermostTaskProgressAgentEvent>;
  tail: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
};

export function createMattermostTaskCardContinuation(params: {
  events: Events;
  log: (message: string) => void;
}) {
  const owners = new Map<string, Owner>();
  let stopped = false;
  const retire = (owner: Owner) => {
    owner.active = false;
    clearTimeout(owner.timer);
    owner.pending.length = 0;
    owner.calls.clear();
    owner.lifecycle.clear();
    if (owners.get(owner.sessionKey) === owner) owners.delete(owner.sessionKey);
  };
  const queue = (owner: Owner, operation: () => Promise<void>) => {
    owner.tail = owner.tail.then(async () => {
      if (owner.active) await operation();
    }).catch((error: unknown) => {
      params.log(`mattermost task continuation failed: ${String(error)}`);
      retire(owner);
    });
  };
  const finishCommitted = (owner: Owner) => {
    const runId = owner.runId;
    const event = runId ? owner.lifecycle.get(runId) : undefined;
    if (!runId || owner.terminalRunId !== runId || !event) return;
    owner.terminalRunId = undefined;
    owner.lifecycle.delete(runId);
    queue(owner, async () => {
      // A committed assistant stop alone cannot distinguish yield from task completion.
      owner.card.noteAgentEvent(event);
      await owner.card.finish({ outcome: event.data.phase === "error" ? "failed" : "completed" });
      if (owner.runId === runId) owner.input = undefined;
      if (!owner.card.canContinue()) retire(owner);
    });
  };
  const failedLifecycle = (event: MattermostTaskProgressAgentEvent) =>
    event.data.phase === "error" || event.data.aborted === true ||
    event.data.status === "cancelled" || event.data.status === "timed_out" ||
    event.data.timeoutPhase != null || event.data.error != null;
  const finishFailure = (owner: Owner, event: MattermostTaskProgressAgentEvent) => {
    queue(owner, async () => {
      owner.card.noteAgentEvent(event);
      await owner.card.finish({ outcome: "failed" });
      retire(owner);
    });
  };
  const consume = (owner: Owner, update: TranscriptUpdate) => {
    const message = record(update.message);
    if (!message) return;
    // A missing sequence cannot establish that a row follows the correlated input.
    if (typeof update.messageSeq !== "number") {
      if (message.role === "user") retire(owner);
      return;
    }
    if (update.messageSeq <= owner.seq) return;
    owner.seq = update.messageSeq;
    if (message.role === "user") {
      const provenance = record(message.provenance);
      if (provenance?.kind !== "inter_session" || provenance.sourceChannel !== "internal" ||
          provenance.sourceTool !== "subagent_settle" ||
          typeof provenance.sourceSessionKey !== "string" ||
          !owner.card.hasWorkSession(provenance.sourceSessionKey)) {
        retire(owner);
        return;
      }
      owner.input = { sourceSessionKey: provenance.sourceSessionKey, seq: update.messageSeq };
      owner.runId = undefined;
      owner.terminalRunId = undefined;
      owner.calls.clear();
      return;
    }
    if (!owner.input || update.messageSeq <= owner.input.seq ||
        !["assistant", "toolResult", "custom"].includes(String(message.role))) return;
    const details = record(message.details);
    const rowRunId = committedRunId(update);
    if (!rowRunId || rowRunId === owner.initialRunId) return;
    if (!owner.runId) {
      if (owner.usedRuns.has(rowRunId)) return;
      if (owner.usedRuns.size >= MAX_PENDING) { retire(owner); return; }
      owner.runId = rowRunId;
      owner.usedRuns.add(rowRunId);
      queue(owner, async () => {
        if (!await owner.card.beginContinuation(rowRunId, () => owner.active)) retire(owner);
      });
      const receipt = owner.lifecycle.get(rowRunId);
      if (receipt && failedLifecycle(receipt)) {
        finishFailure(owner, receipt);
        return;
      }
    }
    if (rowRunId !== owner.runId) return;
    const apply = (plan: MattermostTaskProgressPlan | undefined) => {
      if (plan) queue(owner, async () => { await owner.card.updateContinuationPlan(rowRunId, plan, () => owner.active); });
    };
    if (message.role === "custom" && message.customType === "openclaw.nested-tool.v1" &&
        details?.toolName === "progress_card" && details.isError === false &&
        record(details.result) && record(details.result)?.isError !== true) {
      apply(readPlan(details.input));
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const value of message.content) {
        const block = record(value);
        if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
        const args = record(block.arguments);
        const plan = block.name === "tool_call" && args?.id === PROGRESS_TOOL_ID
          ? readPlan(args.args) : undefined;
        if (plan && owner.calls.size < MAX_PENDING) owner.calls.set(block.id, plan);
      }
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const plan = owner.calls.get(message.toolCallId);
      owner.calls.delete(message.toolCallId);
      if (message.toolName === "tool_call" && successfulWrappedResult(message)) apply(plan);
    }
    // Public top-level runId is emitted only for a committed terminal assistant.
    if (message.role === "assistant" && update.runId === rowRunId) {
      const cancelled = message.stopReason === "aborted";
      const failed = message.stopReason === "error";
      if (failed || cancelled) {
        owner.lifecycle.set(rowRunId, { runId: rowRunId, stream: "lifecycle",
          data: { phase: failed ? "error" : "end", aborted: cancelled } });
      }
      owner.terminalRunId = rowRunId;
      finishCommitted(owner);
    }
  };
  const unsubscribeTranscript = params.events.onSessionTranscriptUpdate((update) => {
    const owner = owners.get(update.target.sessionKey);
    if (!owner) return;
    if (update.target.agentId !== owner.agentId || update.target.sessionId !== owner.sessionId) {
      retire(owner);
      return;
    }
    if (!owner.ready) {
      // User input retires immediately, even while original provider writes are pending.
      const message = record(update.message);
      if (message?.role === "user") {
        const provenance = record(message.provenance);
        if (provenance?.kind !== "inter_session" || provenance.sourceTool !== "subagent_settle" ||
            provenance.sourceChannel !== "internal" ||
            typeof provenance.sourceSessionKey !== "string" ||
            !owner.card.hasWorkSession(provenance.sourceSessionKey)) { retire(owner); return; }
        owner.bufferingContinuation = true;
      } else {
        // Normal tool-heavy initial runs do not consume the continuation buffer.
        // Only committed successor rows after a proven child input may enter it.
        const runId = committedRunId(update);
        if (!owner.bufferingContinuation || !runId || runId === owner.initialRunId) return;
      }
      if (owner.pending.length >= MAX_PENDING) { retire(owner); return; }
      owner.pending.push(update);
      return;
    }
    consume(owner, update);
  });
  const unsubscribeAgent = params.events.onAgentEvent((event) => {
    // Lifecycle events can finalize only a run already proven by committed rows.
    for (const owner of owners.values()) {
      if (owner.ready && event.sessionKey && owner.card.hasWorkSession(event.sessionKey)) {
        owner.card.noteAgentEvent(event);
      }
      if (event.sessionKey !== owner.sessionKey || event.stream !== "lifecycle" ||
          !event.runId || event.runId === owner.initialRunId ||
          (event.data.phase !== "end" && event.data.phase !== "error")) continue;
      // A native end may precede its first transcript broadcast. Receipts alone
      // grant no authority: exact-session input and committed run rows still gate writes.
      if (!owner.input && !owner.bufferingContinuation) continue;
      if (owner.usedRuns.has(event.runId) && event.runId !== owner.runId) continue;
      if (!owner.lifecycle.has(event.runId) && owner.lifecycle.size >= MAX_PENDING) {
        retire(owner);
        continue;
      }
      owner.lifecycle.set(event.runId, event);
      if (!owner.ready || event.runId !== owner.runId || !owner.input) continue;
      if (!failedLifecycle(event)) {
        finishCommitted(owner);
        continue;
      }
      finishFailure(owner, event);
    }
  });
  return {
    retireSession: (sessionKey: string) => {
      const owner = owners.get(sessionKey);
      if (owner) retire(owner);
    },
    register: (input: { agentId: string; sessionId: string; sessionKey: string;
      initialRunId: string; card: Card }) => {
      const previous = owners.get(input.sessionKey);
      if (previous) retire(previous);
      if (stopped) return undefined;
      if (owners.size >= MAX_OWNERS) retire(owners.values().next().value!);
      const owner: Owner = { ...input, ready: false, active: true, seq: -1,
        usedRuns: new Set([input.initialRunId]), calls: new Map(), pending: [], bufferingContinuation: false,
        lifecycle: new Map(),
        tail: Promise.resolve(), timer: setTimeout(() => retire(owner), OWNER_TTL_MS) };
      owner.timer.unref?.();
      owners.set(input.sessionKey, owner);
      return {
        finishInitial: () => {
          if (!owner.active) return;
          if (!owner.card.canContinue()) { retire(owner); return; }
          owner.ready = true;
          const pending = owner.pending.splice(0);
          for (const update of pending) {
            if (owner.active) consume(owner, update);
          }
        },
      };
    },
    stop: () => {
      stopped = true;
      for (const owner of owners.values()) retire(owner);
      unsubscribeTranscript();
      unsubscribeAgent();
    },
  };
}
