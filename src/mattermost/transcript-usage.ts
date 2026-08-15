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

export type MattermostCumulativeTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveTokenCount(usage: Record<string, unknown>, keys: string[]): number | undefined {
  const value = keys.map((key) => usage[key]).find((candidate) => candidate !== undefined);
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function resolveAssistantUsage(message: unknown): MattermostCumulativeTokenUsage | undefined {
  const record = asRecord(message);
  if (record?.role !== "assistant") {
    return undefined;
  }
  const usage = asRecord(record.usage);
  if (!usage) {
    return undefined;
  }
  const inputTokens = resolveTokenCount(usage, ["input", "inputTokens", "input_tokens"]);
  const outputTokens = resolveTokenCount(usage, ["output", "outputTokens", "output_tokens"]);
  return inputTokens === undefined && outputTokens === undefined
    ? undefined
    : { inputTokens, outputTokens };
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
  onCumulativeUsage: (usage: MattermostCumulativeTokenUsage) => void;
}): MattermostTranscriptUsageAccumulator {
  const seenUpdates = new Set<string>();
  let cumulativeInputTokens = 0;
  let cumulativeOutputTokens = 0;

  return {
    onUpdate(update) {
      const updateSessionKey = update.target?.sessionKey ?? update.sessionKey;
      if (updateSessionKey !== params.sessionKey) {
        return;
      }
      const identity = resolveUpdateIdentity(update);
      const usage = resolveAssistantUsage(update.message);
      if (!identity || !usage || seenUpdates.has(identity)) {
        return;
      }
      seenUpdates.add(identity);
      cumulativeInputTokens += usage.inputTokens ?? 0;
      cumulativeOutputTokens += usage.outputTokens ?? 0;
      params.onCumulativeUsage({
        ...(usage.inputTokens === undefined ? {} : { inputTokens: cumulativeInputTokens }),
        ...(usage.outputTokens === undefined ? {} : { outputTokens: cumulativeOutputTokens }),
      });
    },
    reset() {
      cumulativeInputTokens = 0;
      cumulativeOutputTokens = 0;
    },
  };
}
