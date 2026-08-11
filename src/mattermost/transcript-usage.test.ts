import { describe, expect, it, vi } from "vitest";
import { createMattermostTranscriptUsageAccumulator } from "./transcript-usage.js";

const target = {
  agentId: "main",
  sessionId: "session-1",
  sessionKey: "mattermost:default:channel:chan-1",
};

describe("createMattermostTranscriptUsageAccumulator", () => {
  it("accumulates assistant output usage for the matching session", () => {
    const onCumulativeOutputTokens = vi.fn();
    const accumulator = createMattermostTranscriptUsageAccumulator({
      sessionKey: target.sessionKey,
      onCumulativeOutputTokens,
    });

    accumulator.onUpdate({
      target,
      messageId: "assistant-1",
      message: { role: "assistant", usage: { output: 40 } },
    });
    accumulator.onUpdate({
      target,
      messageId: "assistant-2",
      message: { role: "assistant", usage: { outputTokens: 60 } },
    });

    expect(onCumulativeOutputTokens).toHaveBeenNthCalledWith(1, 40);
    expect(onCumulativeOutputTokens).toHaveBeenNthCalledWith(2, 100);
  });

  it("ignores other sessions, non-assistant messages, malformed usage, and duplicate updates", () => {
    const onCumulativeOutputTokens = vi.fn();
    const accumulator = createMattermostTranscriptUsageAccumulator({
      sessionKey: target.sessionKey,
      onCumulativeOutputTokens,
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

    expect(onCumulativeOutputTokens).toHaveBeenCalledExactlyOnceWith(40);
  });

  it("resets the turn total without allowing an old transcript event to count twice", () => {
    const onCumulativeOutputTokens = vi.fn();
    const accumulator = createMattermostTranscriptUsageAccumulator({
      sessionKey: target.sessionKey,
      onCumulativeOutputTokens,
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

    expect(onCumulativeOutputTokens).toHaveBeenCalledTimes(2);
    expect(onCumulativeOutputTokens).toHaveBeenLastCalledWith(25);
  });
});
