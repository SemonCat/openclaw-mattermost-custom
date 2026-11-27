// Account-scoped observation of committed automatic continuation; never adopts posts.
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { createMattermostTaskProgressCard, MattermostTaskProgressAgentEvent, MattermostTaskProgressPlan } from "./task-progress-card.js";
import { isMattermostTaskProgressYieldedWaiting } from "./task-progress-card.js";

type Events = MattermostMonitorContext["core"]["events"];
type TranscriptUpdate = Parameters<Parameters<Events["onSessionTranscriptUpdate"]>[0]>[0];
type Card = ReturnType<typeof createMattermostTaskProgressCard>;
type ExecOutcome = "completed" | "failed" | "cancelled" | "skipped";
type ExecReceipt = Promise<ExecOutcome>;
type ExecContinuationEvents = {
  getPendingExecContinuations?: (
    target: { agentId: string; sessionId: string; sessionKey: string; runId: string },
  ) => readonly ExecReceipt[];
};
type ExecContinuation = {
  origins: Set<string>;
  observed: Set<ExecReceipt>;
  pending: Set<ExecReceipt>;
  outcome: ExecOutcome;
};
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
  if (!args) return;
  if (args.plan !== undefined && (!Array.isArray(args.plan) || args.plan.length > 50)) return;
  const steps: NonNullable<MattermostTaskProgressPlan["steps"]> = [];
  for (const value of (args.plan ?? []) as unknown[]) {
    const step = record(value);
    if (typeof step?.step !== "string" ||
        !["pending", "in_progress", "completed"].includes(String(step.status))) return;
    steps.push({ step: step.step, status: step.status as typeof steps[number]["status"] });
  }
  const explanation = typeof args.explanation === "string" ? args.explanation : undefined;
  const markdown = typeof args.markdown === "string" ? args.markdown : undefined;
  if (!steps.length && !explanation?.trim() && !markdown?.trim()) return;
  // Only arguments of a successful native progress tool cross this boundary.
  return { source: "openclaw", steps, explanation, markdown };
}

function savedRevision(result: Record<string, unknown> | undefined): boolean {
  const revision = record(result?.details)?.revision;
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0;
}

// Automatic inputs preserve observation only. A later native save authorizes projection.
function isAutomaticInput(message: Record<string, unknown>): boolean {
  const provenance = record(message.provenance);
  return provenance?.kind === "inter_session" && provenance.sourceTool === "sessions_send" &&
    typeof provenance.sourceSessionKey === "string" && Boolean(provenance.sourceSessionKey.trim()) ||
    provenance?.kind === "internal_system" &&
    (provenance.sourceTool === undefined || provenance.sourceTool === "exec");
}

function successfulWrappedResult(message: Record<string, unknown>, requireSave = false): boolean {
  if (message.isError !== false || !Array.isArray(message.content)) return false;
  for (const value of message.content) {
    const block = record(value);
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    try {
      const payload = record(JSON.parse(block.text));
      const tool = record(payload?.tool);
      const result = record(payload?.result);
      if (tool?.id === PROGRESS_TOOL_ID && tool.name === "progress_card" &&
          tool.source === "openclaw" && result && result.isError !== true &&
          (!requireSave || savedRevision(result))) return true;
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
  input?: { sourceSessionKey?: string; seq: number; requireSave?: boolean; candidateRunId?: string; exec?: boolean };
  exec?: ExecContinuation;
  execClosed?: boolean;
  nativeProjection: boolean;
  runId?: string;
  usedRuns: Set<string>;
  calls: Map<string, MattermostTaskProgressPlan>;
  pending: TranscriptUpdate[];
  bufferingContinuation: boolean;
  terminalRunId?: string;
  yieldedRunId?: string;
  lifecycle: Map<string, MattermostTaskProgressAgentEvent>;
  tail: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  adoptedDraft?: { retire: () => void };
  generation: number;
  finishingGeneration?: number;
  releasing?: boolean;
};

export function createMattermostTaskCardContinuation(params: {
  events: Events & ExecContinuationEvents;
  log: (message: string) => void;
}) {
  const owners = new Map<string, Owner>();
  type Draft = { retire: () => void };
  const drafts = new Map<Draft, { agentId: string; sessionId: string; sessionKey: string;
    timer: ReturnType<typeof setTimeout> }>();
  const releaseDraft = (draft: Draft, drainTerminal = false) => {
    const entry = drafts.get(draft);
    if (entry) clearTimeout(entry.timer);
    drafts.delete(draft);
    for (const owner of owners.values()) {
      if (owner.adoptedDraft !== draft) continue;
      if (owner.exec) {
        owner.adoptedDraft = undefined;
        continue;
      }
      if (drainTerminal && (owner.finishingGeneration === owner.generation ||
          owner.runId && owner.terminalRunId === owner.runId)) {
        // Draft custody and native lifecycle publication are independent. A
        // committed terminal keeps only its missing receipt, never a new run.
        owner.releasing = true;
        if (owner.finishingGeneration === owner.generation) {
          void owner.tail.then(() => retire(owner));
        }
      } else retire(owner);
    }
  };
  const retireDraft = (draft: Draft) => {
    releaseDraft(draft);
    draft.retire();
  };
  let stopped = false;
  const retire = (owner: Owner) => {
    owner.active = false;
    clearTimeout(owner.timer);
    owner.pending.length = 0;
    owner.calls.clear();
    owner.lifecycle.clear();
    owner.exec = undefined;
    if (owners.get(owner.sessionKey) === owner) owners.delete(owner.sessionKey);
  };
  const hasHostCustody = (owner: Owner) => {
    const target = owner.adoptedDraft && drafts.get(owner.adoptedDraft);
    return target && target.sessionKey === owner.sessionKey &&
      target.sessionId === owner.sessionId && target.agentId === owner.agentId;
  };
  const resetInput = (owner: Owner, preserveLifecycle = false) => {
    owner.generation += 1;
    owner.input = undefined;
    owner.runId = undefined;
    owner.terminalRunId = undefined;
    owner.yieldedRunId = undefined;
    owner.finishingGeneration = undefined;
    owner.calls.clear();
    if (!preserveLifecycle) owner.lifecycle.clear();
    owner.pending.length = 0;
    owner.bufferingContinuation = false;
    if (owner.ready) owner.card.suspendContinuation();
  };
  const fenceInput = (owner: Owner) => {
    owner.nativeProjection = false;
    const hadExec = Boolean(owner.exec);
    owner.exec = undefined;
    if (hadExec) owner.execClosed = true;
    if (!hasHostCustody(owner)) { retire(owner); return; }
    resetInput(owner);
    if (!owner.ready || hadExec) owner.card.suspendContinuation(hadExec);
  };
  const queue = (owner: Owner, operation: (isCurrent: () => boolean) => Promise<void>) => {
    const generation = owner.generation;
    const isCurrent = () => owner.active && owner.generation === generation;
    owner.tail = owner.tail.then(async () => {
      if (isCurrent()) await operation(isCurrent);
    }).catch((error: unknown) => {
      params.log(`mattermost task continuation failed: ${String(error)}`);
      retire(owner);
    });
  };
  const finishExec = (owner: Owner, exec: ExecContinuation) => {
    if (!owner.ready || exec.pending.size > 0) return;
    owner.tail = owner.tail.then(async () => {
      const isCurrent = () => owner.active && owner.exec === exec;
      if (!isCurrent() || exec.pending.size > 0) return;
      await owner.card.finish({
        outcome: exec.outcome === "skipped" ? undefined : exec.outcome,
        execContinuationPending: false,
        isCurrent,
      });
      if (!isCurrent()) return;
      owner.exec = undefined;
      owner.execClosed = true;
      if (!owner.card.canContinue()) retire(owner);
    }).catch((error: unknown) => {
      params.log(`mattermost task continuation failed: ${String(error)}`);
      retire(owner);
    });
  };
  const observeExec = (owner: Owner, runId: string) => {
    if (!owner.active || !owner.nativeProjection || owner.execClosed || !params.events.getPendingExecContinuations) return;
    try {
      const { agentId, sessionId, sessionKey } = owner;
      const receipts = params.events.getPendingExecContinuations({ agentId, sessionId, sessionKey, runId });
      if (!receipts.length) return;
      const exec = owner.exec ??= { origins: new Set(), observed: new Set(), pending: new Set(), outcome: "skipped" };
      exec.origins.add(runId);
      const settle = (receipt: ExecReceipt, outcome: ExecOutcome) => {
        if (!owner.active || owner.exec !== exec) return;
        exec.pending.delete(receipt);
        if (outcome === "cancelled" || exec.outcome !== "cancelled" &&
            (outcome === "failed" || exec.outcome === "skipped")) exec.outcome = outcome;
        finishExec(owner, exec);
      };
      for (const receipt of receipts) {
        if (exec.observed.has(receipt)) continue;
        exec.observed.add(receipt);
        exec.pending.add(receipt);
        void receipt.then(outcome => settle(receipt, outcome), () => settle(receipt, "failed"));
      }
    } catch (error: unknown) {
      params.log(`mattermost exec continuation unavailable: ${String(error)}`);
    }
  };
  const isExecInput = (owner: Owner, message: Record<string, unknown>): boolean => {
    const provenance = record(message.provenance);
    return Boolean(provenance?.kind === "internal_system" && provenance.sourceTool === "exec" &&
      typeof provenance.runId === "string" && owner.exec?.origins.has(provenance.runId));
  };
  const finishCommitted = (owner: Owner) => {
    const runId = owner.runId;
    const event = runId ? owner.lifecycle.get(runId) : undefined;
    if (!runId || !event || (owner.terminalRunId !== runId &&
        !(owner.yieldedRunId === runId && isMattermostTaskProgressYieldedWaiting(event.data)))) return;
    owner.terminalRunId = undefined;
    owner.lifecycle.delete(runId);
    const exec = owner.input?.exec === true;
    if (exec) observeExec(owner, runId);
    owner.finishingGeneration = owner.generation;
    queue(owner, async (isCurrent) => {
      // A clean yield may commit only its tool result. The matching native
      // lifecycle must prove a successful pause before that run can hand off.
      owner.card.noteAgentEvent(event);
      if (!exec || !failedLifecycle(event)) {
        await owner.card.finish({ outcome: event.data.phase === "error" ? "failed" : "completed", isCurrent });
      }
      if (!isCurrent()) return;
      owner.finishingGeneration = undefined;
      if (owner.runId === runId) {
        owner.input = undefined;
        owner.terminalRunId = undefined;
      }
      if (owner.releasing || !owner.card.canContinue()) retire(owner);
    });
  };
  const failedLifecycle = (event: MattermostTaskProgressAgentEvent) =>
    event.data.phase === "error" || event.data.aborted === true ||
    event.data.status === "cancelled" || event.data.status === "timed_out" ||
    event.data.status === "timeout" || event.data.stopReason === "timeout" ||
    event.data.timeoutPhase != null || event.data.error != null;
  const finishFailure = (owner: Owner, event: MattermostTaskProgressAgentEvent) => {
    if (owner.input?.exec) {
      queue(owner, async () => { owner.card.noteAgentEvent(event); });
      return;
    }
    owner.finishingGeneration = owner.generation;
    queue(owner, async (isCurrent) => {
      owner.card.noteAgentEvent(event);
      await owner.card.finish({ outcome: "failed", isCurrent });
      if (isCurrent()) retire(owner);
    });
  };
  const consume = (owner: Owner, update: TranscriptUpdate) => {
    const message = record(update.message);
    if (!message) return;
    // A missing sequence cannot establish that a row follows the correlated input.
    if (typeof update.messageSeq !== "number") {
      if (message.role === "user") fenceInput(owner);
      return;
    }
    if (update.messageSeq <= owner.seq) return;
    owner.seq = update.messageSeq;
    if (message.role === "user") {
      if (owner.nativeProjection && isAutomaticInput(message)) {
        // A native receipt may precede buffered committed rows. It grants no
        // writes until this input's successor proves a successful native save.
        const exec = isExecInput(owner, message);
        const closedExecInput = owner.execClosed && record(message.provenance)?.sourceTool === "exec";
        resetInput(owner, !owner.exec || exec);
        if (exec || (!owner.exec && !closedExecInput)) {
          owner.input = { seq: update.messageSeq, requireSave: true, exec };
        }
        return;
      }
      const provenance = record(message.provenance);
      if (provenance?.kind !== "inter_session" || provenance.sourceChannel !== "internal" ||
          provenance.sourceTool !== "subagent_settle" ||
          typeof provenance.sourceSessionKey !== "string" ||
          !owner.card.hasWorkSession(provenance.sourceSessionKey)) {
        fenceInput(owner);
        return;
      }
      owner.input = { sourceSessionKey: provenance.sourceSessionKey, seq: update.messageSeq };
      owner.runId = undefined;
      owner.terminalRunId = undefined;
      owner.yieldedRunId = undefined;
      owner.calls.clear();
      return;
    }
    if (!owner.input || update.messageSeq <= owner.input.seq ||
        !["assistant", "toolResult", "custom"].includes(String(message.role))) return;
    const details = record(message.details);
    const rowRunId = committedRunId(update);
    if (!rowRunId || rowRunId === owner.initialRunId) return;
    if (owner.runId && rowRunId !== owner.runId ||
        owner.usedRuns.has(rowRunId) && rowRunId !== owner.runId) return;
    if (owner.input.requireSave) {
      owner.input.candidateRunId ??= rowRunId;
      if (rowRunId !== owner.input.candidateRunId) return;
    }
    let plan: MattermostTaskProgressPlan | undefined;
    if (message.role === "custom" && message.customType === "openclaw.nested-tool.v1" &&
        details?.toolName === "progress_card" && details.isError === false &&
        record(details.result) && record(details.result)?.isError !== true &&
        (!owner.input.requireSave || savedRevision(record(details.result)))) {
      plan = readPlan(details.input);
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const value of message.content) {
        const block = record(value);
        if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
        const args = record(block.arguments);
        const pendingPlan = (block.name === "tool_call" || block.name === "dispatch_action") &&
          args?.id === PROGRESS_TOOL_ID ? readPlan(args.args) : undefined;
        if (pendingPlan && owner.calls.size < MAX_PENDING) owner.calls.set(block.id, pendingPlan);
      }
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const pendingPlan = owner.calls.get(message.toolCallId);
      owner.calls.delete(message.toolCallId);
      if ((message.toolName === "tool_call" || message.toolName === "dispatch_action") &&
          successfulWrappedResult(message, owner.input.requireSave)) plan = pendingPlan;
    }
    if (!owner.runId) {
      if (owner.input.requireSave && !plan && !owner.input.exec) return;
      if (owner.usedRuns.has(rowRunId)) return;
      if (owner.usedRuns.size >= MAX_PENDING) { retire(owner); return; }
      owner.runId = rowRunId;
      owner.usedRuns.add(rowRunId);
      queue(owner, async (isCurrent) => {
        if (!await owner.card.beginContinuation(rowRunId, isCurrent) && isCurrent()) retire(owner);
      });
      const receipt = owner.lifecycle.get(rowRunId);
      if (receipt && owner.input.exec && !failedLifecycle(receipt)) observeExec(owner, rowRunId);
      if (receipt && failedLifecycle(receipt)) {
        finishFailure(owner, receipt);
        return;
      }
    }
    if (rowRunId !== owner.runId) return;
    const savedPlan = plan;
    if (savedPlan) queue(owner, async (isCurrent) => { await owner.card.updateContinuationPlan(rowRunId, savedPlan, isCurrent); });
    if (message.role === "toolResult" && message.toolName === "sessions_yield" &&
        message.isError === false && details?.status === "yielded") {
      owner.yieldedRunId = rowRunId;
      finishCommitted(owner);
    }
    // Public top-level runId is emitted only for a committed terminal assistant.
    if (message.role === "assistant" && update.runId === rowRunId) {
      const cancelled = message.stopReason === "aborted";
      const failed = message.stopReason === "error";
      // sessions_yield publishes an empty aborted assistant before stripping it.
      // Its same-run successful tool result makes this row ambiguous: only the
      // native lifecycle can prove a clean pause or a genuine cancellation.
      if (cancelled && owner.yieldedRunId === rowRunId && message.errorMessage == null &&
          Array.isArray(message.content) && message.content.every((value) => {
            const block = record(value);
            return block?.type === "text" && block.text === "";
          })) {
        // Keep the committed terminal correlated if host draft custody ends
        // before the native receipt; draining must not manufacture a cancel.
        owner.terminalRunId = rowRunId;
        finishCommitted(owner);
        return;
      }
      const receipt = owner.lifecycle.get(rowRunId);
      if ((failed || cancelled) && (!receipt || !failedLifecycle(receipt))) {
        owner.lifecycle.set(rowRunId, { runId: rowRunId, stream: "lifecycle",
          data: { phase: failed ? "error" : "end", aborted: cancelled } });
      }
      owner.terminalRunId = rowRunId;
      finishCommitted(owner);
    }
  };
  const unsubscribeTranscript = params.events.onSessionTranscriptUpdate((update) => {
    // The host owns adopted task debt across steers. Only incarnation replacement
    // (or account stop/expiry) revokes transport custody here, never human prose.
    for (const [draft, target] of drafts) {
      if (update.target.sessionKey === target.sessionKey &&
          (update.target.agentId !== target.agentId || update.target.sessionId !== target.sessionId)) {
        retireDraft(draft);
      }
    }
    const owner = owners.get(update.target.sessionKey);
    if (!owner) return;
    if (update.target.agentId !== owner.agentId || update.target.sessionId !== owner.sessionId) {
      retire(owner);
      return;
    }
    if (owner.releasing) {
      const message = record(update.message);
      const provenance = record(message?.provenance);
      if (message?.role === "user" && (provenance?.kind !== "inter_session" ||
          provenance.sourceChannel !== "internal" || provenance.sourceTool !== "subagent_settle" ||
          typeof provenance.sourceSessionKey !== "string" ||
          !owner.card.hasWorkSession(provenance.sourceSessionKey))) retire(owner);
      return;
    }
    if (!owner.ready) {
      // User input retires immediately, even while original provider writes are pending.
      const message = record(update.message);
      if (message?.role === "user") {
        const provenance = record(message.provenance);
        if (owner.nativeProjection && isAutomaticInput(message)) {
          // The original callback remains the writer until finishInitial. Runtime
          // notices must not erase retention or consume its tool-heavy transcript.
          if (provenance?.kind === "internal_system" && !owner.bufferingContinuation) {
            if (provenance.sourceTool === "exec" && provenance.runId === owner.initialRunId) {
              observeExec(owner, owner.initialRunId);
            }
            if (!isExecInput(owner, message)) return;
          }
        } else if (provenance?.kind !== "inter_session" || provenance.sourceTool !== "subagent_settle" ||
            provenance.sourceChannel !== "internal" ||
            typeof provenance.sourceSessionKey !== "string") { fenceInput(owner); return; }
        // Hidden children are discovered by finishPresentation before finishInitial.
        // Retain native candidates now; consume revalidates child ownership once
        // discovery completes, before any continuation can edit the card.
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
      const sameParent = event.sessionKey === owner.sessionKey &&
        (!event.sessionId || event.sessionId === owner.sessionId) &&
        (!event.agentId || event.agentId === owner.agentId);
      if (owner.releasing) {
        if (owner.runId && owner.terminalRunId === owner.runId && event.runId === owner.runId &&
            sameParent && event.stream === "lifecycle" &&
            (event.data.phase === "end" || event.data.phase === "error")) {
          owner.lifecycle.set(event.runId, event);
          finishCommitted(owner);
        }
        continue;
      }
      if (owner.ready && event.sessionKey && owner.card.hasWorkSession(event.sessionKey)) {
        owner.card.noteAgentEvent(event);
      }
      if (!owner.ready && sameParent && event.runId === owner.initialRunId &&
          event.stream === "lifecycle" && event.data.phase === "end") {
        observeExec(owner, owner.initialRunId);
      }
      if (!sameParent || event.stream !== "lifecycle" ||
          !event.runId || event.runId === owner.initialRunId ||
          (event.data.phase !== "end" && event.data.phase !== "error")) continue;
      // A native end may precede its first transcript broadcast. Receipts alone
      // grant no authority: exact-session input and committed run rows still gate writes.
      const yieldedFailure = event.runId === owner.runId &&
        owner.yieldedRunId === event.runId && failedLifecycle(event);
      if (!owner.input && !owner.bufferingContinuation && !yieldedFailure) continue;
      if (owner.usedRuns.has(event.runId) && event.runId !== owner.runId) continue;
      if (!owner.lifecycle.has(event.runId) && owner.lifecycle.size >= MAX_PENDING) {
        retire(owner);
        continue;
      }
      owner.lifecycle.set(event.runId, event);
      if (!owner.ready || event.runId !== owner.runId || !owner.input && !yieldedFailure) continue;
      if (!failedLifecycle(event)) {
        if (owner.input?.exec) observeExec(owner, event.runId);
        finishCommitted(owner);
        continue;
      }
      finishFailure(owner, event);
    }
  });
  return {
    retireSession: (sessionKey: string) => {
      const owner = owners.get(sessionKey);
      if (owner) fenceInput(owner);
    },
    register: (input: { agentId: string; sessionId: string; sessionKey: string;
      initialRunId: string; card: Card; adoptedDraft?: Draft }) => {
      const previous = owners.get(input.sessionKey);
      if (previous) retire(previous);
      if (stopped) return undefined;
      if (owners.size >= MAX_OWNERS) retire(owners.values().next().value!);
      const owner: Owner = { ...input, ready: false, active: true, seq: -1, generation: 0, nativeProjection: true,
        usedRuns: new Set([input.initialRunId]), calls: new Map(), pending: [], bufferingContinuation: false,
        lifecycle: new Map(),
        tail: Promise.resolve(), timer: setTimeout(() => retire(owner), OWNER_TTL_MS) };
      owner.timer.unref?.();
      owners.set(input.sessionKey, owner);
      return {
        prepareInitialFinish: () => {
          observeExec(owner, owner.initialRunId);
          return owner.exec ? true : undefined;
        },
        adoptDraft: (draft: Draft): boolean => {
          const target = drafts.get(draft);
          if (!owner.active || !target || target.agentId !== owner.agentId ||
              target.sessionId !== owner.sessionId || target.sessionKey !== owner.sessionKey) return false;
          // Attaching host custody must not discard a native continuation
          // already observed while the original presentation was still active.
          owner.adoptedDraft = draft;
          return true;
        },
        finishInitial: () => {
          if (!owner.active) return;
          if (!owner.card.canContinue()) { retire(owner); return; }
          owner.ready = true;
          const pending = owner.pending.splice(0);
          for (const update of pending) {
            if (owner.active) consume(owner, update);
          }
          if (owner.exec) finishExec(owner, owner.exec);
        },
      };
    },
    retainProgressDraft: (input: { agentId: string; sessionId: string; sessionKey: string; draft: Draft }) => {
      if (stopped) { input.draft.retire(); return () => {}; }
      if (drafts.size >= MAX_OWNERS) retireDraft(drafts.keys().next().value!);
      const timer = setTimeout(() => retireDraft(input.draft), OWNER_TTL_MS);
      timer.unref?.();
      drafts.set(input.draft, { ...input, timer });
      return () => releaseDraft(input.draft, true);
    },
    stop: () => {
      stopped = true;
      for (const owner of owners.values()) retire(owner);
      for (const draft of drafts.keys()) retireDraft(draft);
      unsubscribeTranscript();
      unsubscribeAgent();
    },
  };
}
