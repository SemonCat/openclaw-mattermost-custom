// Mattermost fallback for harnesses that persist usage without emitting agent usage events.

export type MattermostSessionTranscriptUpdate = {
  target: { agentId: string; sessionId: string; sessionKey: string };
  sessionKey?: string;
  message?: unknown;
  messageId?: string;
  messageSeq?: number;
};

export type MattermostTranscriptUsageAccumulator = {
  onUpdate: (update: MattermostSessionTranscriptUpdate) => void;
  reset: () => void;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveAssistantOutputTokens(message: unknown): number | undefined {
  const record = asRecord(message);
  if (record?.role !== "assistant") {
    return undefined;
  }
  const usage = asRecord(record.usage);
  const value = usage?.output ?? usage?.outputTokens ?? usage?.output_tokens;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function resolveUpdateIdentity(update: MattermostSessionTranscriptUpdate): string | undefined {
  const messageId = update.messageId?.trim();
  if (messageId) {
    return `id:${messageId}`;
  }
  return Number.isSafeInteger(update.messageSeq) && (update.messageSeq ?? 0) > 0
    ? `seq:${update.messageSeq}`
    : undefined;
}

/**
 * Accumulates per-assistant-message transcript usage for one session. The
 * lifetime-wide dedupe set survives queued-followup resets so a replayed old
 * transcript event cannot inflate the new turn's numerator.
 */
export function createMattermostTranscriptUsageAccumulator(params: {
  sessionKey: string;
  onCumulativeOutputTokens: (outputTokens: number) => void;
}): MattermostTranscriptUsageAccumulator {
  const seenUpdates = new Set<string>();
  let cumulativeOutputTokens = 0;

  return {
    onUpdate(update) {
      const updateSessionKey = update.target?.sessionKey ?? update.sessionKey;
      if (updateSessionKey !== params.sessionKey) {
        return;
      }
      const identity = resolveUpdateIdentity(update);
      const outputTokens = resolveAssistantOutputTokens(update.message);
      if (!identity || outputTokens === undefined || seenUpdates.has(identity)) {
        return;
      }
      seenUpdates.add(identity);
      cumulativeOutputTokens += outputTokens;
      params.onCumulativeOutputTokens(cumulativeOutputTokens);
    },
    reset() {
      cumulativeOutputTokens = 0;
    },
  };
}
