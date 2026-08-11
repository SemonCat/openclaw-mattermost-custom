// Mattermost plugin module owns append-once, consume-after-ack final reply metrics receipts.
import { createChannelProgressReceiptTracker } from "openclaw/plugin-sdk/channel-outbound";
import type { ReplyPayload } from "./runtime-api.js";

type ToolInterval = { start: number; end: number };

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
   * Records the latest cumulative output token count reported for `runId`.
   * Ignored when `runId` does not match the current run or `outputTokens` is
   * not a finite, non-negative number.
   */
  noteUsage: (runId: string, outputTokens: number) => void;
  /** Records cumulative transcript output usage when the harness emits no usage event. */
  noteTranscriptUsage: (outputTokens: number) => void;
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
  const tracker = createChannelProgressReceiptTracker(params);
  let pendingLine: string | undefined;
  let delivered = false;

  let turnStartedAt = now();
  let currentRunId: string | undefined;
  let latestOutputTokens: number | undefined;
  let transcriptOutputTokens: number | undefined;
  const openToolIntervals = new Map<string, number>();
  const closedToolIntervals: ToolInterval[] = [];

  const resetTpsState = () => {
    turnStartedAt = now();
    currentRunId = undefined;
    latestOutputTokens = undefined;
    transcriptOutputTokens = undefined;
    openToolIntervals.clear();
    closedToolIntervals.length = 0;
  };

  // Approximate: numerator is the last cumulative usage snapshot observed for
  // this run, denominator is turn wall time minus tool wall time (union of
  // completed/in-flight intervals, clipped to the turn). Not strict provider
  // generation tok/s.
  const computeApproxTps = (): number | undefined => {
    const outputTokens = latestOutputTokens ?? transcriptOutputTokens;
    if (outputTokens === undefined || !(outputTokens > 0)) {
      return undefined;
    }
    const nowMs = now();
    const turnElapsedMs = nowMs - turnStartedAt;
    if (!(turnElapsedMs > 0)) {
      return undefined;
    }
    const intervals: ToolInterval[] = [...closedToolIntervals];
    for (const start of openToolIntervals.values()) {
      intervals.push({ start, end: nowMs });
    }
    const clipped = intervals.map((interval) => ({
      start: Math.max(interval.start, turnStartedAt),
      end: Math.min(interval.end, nowMs),
    }));
    const toolBusyMs = unionDurationMs(clipped);
    const denomMs = turnElapsedMs - toolBusyMs;
    if (!(denomMs > 0)) {
      return undefined;
    }
    const tps = outputTokens / (denomMs / 1000);
    return Number.isFinite(tps) && tps > 0 ? tps : undefined;
  };

  const buildLine = (): string => {
    const base = tracker.buildSummaryLine();
    const tps = computeApproxTps();
    return tps === undefined ? base : `${base} · ⚡≈${tps.toFixed(1)} tok/s`;
  };

  return {
    noteToolCall(toolName, toolCallId) {
      tracker.noteToolCall(toolName);
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
      latestOutputTokens = undefined;
      transcriptOutputTokens = undefined;
    },
    noteUsage(runId, outputTokens) {
      if (!runId || runId !== currentRunId) {
        return;
      }
      if (!Number.isFinite(outputTokens) || outputTokens < 0) {
        return;
      }
      latestOutputTokens = outputTokens;
    },
    noteTranscriptUsage(outputTokens) {
      if (!Number.isFinite(outputTokens) || outputTokens < 0) {
        return;
      }
      transcriptOutputTokens = outputTokens;
    },
    reset() {
      pendingLine = undefined;
      delivered = false;
      tracker.reset();
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
