import { describe, expect, it, vi } from "vitest";
import { createMattermostTranscriptUsageAccumulator } from "./transcript-usage.js";

const target = {
  agentId: "main",
  sessionId: "session-1",
  sessionKey: "mattermost:default:channel:chan-1",
};

describe("createMattermostTranscriptUsageAccumulator", () => {
  it("accumulates assistant input and output usage for the matching session", () => {
    const onCumulativeUsage = vi.fn();
    const accumulator = createMattermostTranscriptUsageAccumulator({
      sessionKey: target.sessionKey,
      onCumulativeUsage,
    });

    accumulator.onUpdate({
      target,
      messageId: "assistant-1",
      message: { role: "assistant", usage: { input: 15_000, output: 40 } },
    });
    accumulator.onUpdate({
      target,
      messageId: "assistant-2",
      message: { role: "assistant", usage: { inputTokens: 500, outputTokens: 60 } },
    });

    expect(onCumulativeUsage).toHaveBeenNthCalledWith(1, {
      inputTokens: 15_000,
      outputTokens: 40,
    });
    expect(onCumulativeUsage).toHaveBeenNthCalledWith(2, {
      inputTokens: 15_500,
      outputTokens: 100,
    });
  });

  it("ignores other sessions, non-assistant messages, malformed usage, and duplicate updates", () => {
    const onCumulativeUsage = vi.fn();
    const accumulator = createMattermostTranscriptUsageAccumulator({
      sessionKey: target.sessionKey,
      onCumulativeUsage,
    });
    const valid = {
      target,
      messageId: "assistant-1",
      message: { role: "assistant", usage: { output: 40 } },
    };

    accumulator.onUpdate({ ...valid, target: { ...target, sessionKey: "other" } });
    accumulator.onUpdate({ ...valid, message: { role: "user", usage: { output: 40 } } });
    accumulator.onUpdate({ ...valid, message: { role: "assistant", usage: { output: -1 } } });
    accumulator.onUpdate(valid);
    accumulator.onUpdate(valid);

    expect(onCumulativeUsage).toHaveBeenCalledExactlyOnceWith({ outputTokens: 40 });
  });

  it("resets the turn total without allowing an old transcript event to count twice", () => {
    const onCumulativeUsage = vi.fn();
    const accumulator = createMattermostTranscriptUsageAccumulator({
      sessionKey: target.sessionKey,
      onCumulativeUsage,
    });
    const first = {
      target,
      messageId: "assistant-1",
      message: { role: "assistant", usage: { output: 40 } },
    };

    accumulator.onUpdate(first);
    accumulator.reset();
    accumulator.onUpdate(first);
    accumulator.onUpdate({
      target,
      messageSeq: 2,
      message: { role: "assistant", usage: { output_tokens: 25 } },
    });

    expect(onCumulativeUsage).toHaveBeenCalledTimes(2);
    expect(onCumulativeUsage).toHaveBeenLastCalledWith({ outputTokens: 25 });
  });
});
