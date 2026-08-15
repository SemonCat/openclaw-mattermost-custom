// Mattermost plugin module owns append-once, consume-after-ack final reply metrics receipts.
import { isChannelProgressDraftWorkToolName } from "openclaw/plugin-sdk/channel-outbound";
import type { ReplyPayload } from "./runtime-api.js";

type ToolInterval = { start: number; end: number };
type TokenUsage = { inputTokens?: number; outputTokens?: number };

export type MattermostProgressReceiptState = {
  /** Records a started tool call so it counts toward the pending receipt's tally. */
  noteToolCall: (toolName?: string, toolCallId?: string) => void;
  /**
   * Closes a previously started tool call's timing interval so its wall time
   * is excluded from the approximate tok/s denominator. A no-op when
   * `toolCallId` has no matching open interval (never started, or already closed).
   */
  noteToolCallEnd: (toolCallId?: string) => void;
  /** Records the agent run id backing the current turn, so usage events can be correlated to it. */
  noteRunStart: (runId: string) => void;
  /**
   * Records the latest cumulative token counts reported for `runId`.
   * Ignored when `runId` does not match the current run; invalid fields are
   * ignored independently.
   */
  noteUsage: (runId: string, usage: TokenUsage) => void;
  /** Records cumulative transcript usage when the harness emits incomplete usage events. */
  noteTranscriptUsage: (usage: TokenUsage) => void;
  /** Drops any pending (unsent) receipt and restarts the elapsed-time clock. */
  reset: () => void;
  /**
   * Returns `payload` with the compact receipt appended to its text, computing and
   * caching the receipt line on first call. Later calls before a successful
   * `settleFinalDelivery(true)` reuse the same cached line instead of recomputing
   * it, so a retried final does not report a shifted duration or tool count.
   * Error payloads pass through unchanged: receipts only ride on successful finals.
   */
  prepareFinalPayload: (payload: ReplyPayload) => ReplyPayload;
  /**
   * Reports the outcome of a final delivery attempt. A visible send consumes the
   * pending receipt and suppresses receipts on any later final payloads in the
   * same turn. A failed attempt leaves the cached receipt in place so a retry
   * still carries it. Call `reset()` only when a new turn is admitted.
   */
  settleFinalDelivery: (visibleReplySent: boolean) => void;
  /** True while a receipt has been built but not yet confirmed delivered. */
  hasPendingReceipt: () => boolean;
};

/** Merges overlapping/adjacent wall-clock intervals and returns their total duration in ms. */
function unionDurationMs(intervals: ToolInterval[]): number {
  const positive = intervals.filter((interval) => interval.end > interval.start);
  if (positive.length === 0) {
    return 0;
  }
  const sorted = [...positive].sort((a, b) => a.start - b.start);
  const first = sorted[0];
  if (!first) {
    return 0;
  }
  let total = 0;
  let curStart = first.start;
  let curEnd = first.end;
  for (const interval of sorted.slice(1)) {
    if (interval.start <= curEnd) {
      curEnd = Math.max(curEnd, interval.end);
    } else {
      total += curEnd - curStart;
      curStart = interval.start;
      curEnd = interval.end;
    }
  }
  total += curEnd - curStart;
  return total;
}

export function createMattermostProgressReceipt(params?: {
  now?: () => number;
}): MattermostProgressReceiptState {
  const now = params?.now ?? Date.now;
  let pendingLine: string | undefined;
  let delivered = false;

  let turnStartedAt = now();
  let toolCalls = 0;
  let currentRunId: string | undefined;
  let latestInputTokens: number | undefined;
  let latestOutputTokens: number | undefined;
  let transcriptInputTokens: number | undefined;
  let transcriptOutputTokens: number | undefined;
  const openToolIntervals = new Map<string, number>();
  const closedToolIntervals: ToolInterval[] = [];

  const resetTpsState = () => {
    turnStartedAt = now();
    toolCalls = 0;
    currentRunId = undefined;
    latestInputTokens = undefined;
    latestOutputTokens = undefined;
    transcriptInputTokens = undefined;
    transcriptOutputTokens = undefined;
    openToolIntervals.clear();
    closedToolIntervals.length = 0;
  };

  const computeTiming = () => {
    const nowMs = now();
    const turnElapsedMs = Math.max(0, nowMs - turnStartedAt);
    const intervals: ToolInterval[] = [...closedToolIntervals];
    for (const start of openToolIntervals.values()) {
      intervals.push({ start, end: nowMs });
    }
    const clipped = intervals.map((interval) => ({
      start: Math.max(interval.start, turnStartedAt),
      end: Math.min(interval.end, nowMs),
    }));
    const toolBusyMs = Math.min(turnElapsedMs, unionDurationMs(clipped));
    return { turnElapsedMs, toolBusyMs, modelBusyMs: turnElapsedMs - toolBusyMs };
  };

  const formatTokenCount = (value: number | undefined): string => {
    if (value === undefined) {
      return "?";
    }
    if (value >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
    }
    if (value >= 1_000) {
      return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
    }
    return String(Math.round(value));
  };

  const recordUsage = (
    usage: TokenUsage,
    setInput: (value: number) => void,
    setOutput: (value: number) => void,
  ) => {
    if (
      typeof usage.inputTokens === "number" &&
      Number.isFinite(usage.inputTokens) &&
      usage.inputTokens >= 0
    ) {
      setInput(usage.inputTokens);
    }
    if (
      typeof usage.outputTokens === "number" &&
      Number.isFinite(usage.outputTokens) &&
      usage.outputTokens >= 0
    ) {
      setOutput(usage.outputTokens);
    }
  };

  const buildLine = (): string => {
    const inputTokens = latestInputTokens ?? transcriptInputTokens;
    const outputTokens = latestOutputTokens ?? transcriptOutputTokens;
    const { turnElapsedMs, toolBusyMs, modelBusyMs } = computeTiming();
    const toolLabel = `🛠️ ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`;
    const usageLine = [
      `⬆️ ${formatTokenCount(inputTokens)} in`,
      `⬇️ ${formatTokenCount(outputTokens)} out`,
      toolLabel,
    ].join(" · ");
    const timingParts = [
      `⏱️ ${Math.max(1, Math.round(turnElapsedMs / 1_000))}s`,
      `🧠 ${(modelBusyMs / 1_000).toFixed(1)}s`,
      `🔧 ${(toolBusyMs / 1_000).toFixed(1)}s`,
    ];
    // Approximate: output tokens divided by turn wall time minus the union of
    // tool intervals. This is not strict provider generation tok/s.
    if (outputTokens !== undefined && outputTokens > 0 && modelBusyMs > 0) {
      const tps = outputTokens / (modelBusyMs / 1_000);
      if (Number.isFinite(tps) && tps > 0) {
        timingParts.push(`⚡ ≈${tps.toFixed(1)} tok/s`);
      }
    }
    return `${usageLine}\n${timingParts.join(" · ")}`;
  };

  return {
    noteToolCall(toolName, toolCallId) {
      if (isChannelProgressDraftWorkToolName(toolName)) {
        toolCalls += 1;
      }
      if (toolCallId) {
        openToolIntervals.set(toolCallId, now());
      }
    },
    noteToolCallEnd(toolCallId) {
      if (!toolCallId) {
        return;
      }
      const start = openToolIntervals.get(toolCallId);
      if (start === undefined) {
        return;
      }
      openToolIntervals.delete(toolCallId);
      closedToolIntervals.push({ start, end: now() });
    },
    noteRunStart(runId) {
      if (!runId || runId === currentRunId) {
        return;
      }
      currentRunId = runId;
      // A new run id means a new agent run: any usage tally collected under
      // the previous run id no longer describes this one.
      latestInputTokens = undefined;
      latestOutputTokens = undefined;
      transcriptInputTokens = undefined;
      transcriptOutputTokens = undefined;
    },
    noteUsage(runId, usage) {
      if (!runId || runId !== currentRunId) {
        return;
      }
      recordUsage(
        usage,
        (value) => (latestInputTokens = value),
        (value) => (latestOutputTokens = value),
      );
    },
    noteTranscriptUsage(usage) {
      recordUsage(
        usage,
        (value) => (transcriptInputTokens = value),
        (value) => (transcriptOutputTokens = value),
      );
    },
    reset() {
      pendingLine = undefined;
      delivered = false;
      resetTpsState();
    },
    prepareFinalPayload(payload) {
      if (payload.isError || delivered) {
        return payload;
      }
      if (pendingLine === undefined) {
        pendingLine = buildLine();
      }
      const text = payload.text;
      return {
        ...payload,
        text: text?.trim() ? `${text.trimEnd()}\n${pendingLine}` : pendingLine,
      };
    },
    settleFinalDelivery(visibleReplySent) {
      if (!visibleReplySent) {
        return;
      }
      pendingLine = undefined;
      delivered = true;
    },
    hasPendingReceipt() {
      return pendingLine !== undefined;
    },
  };
}
