import { describe, expect, it, vi } from "vitest";
import {
  createMattermostRestartRecoveryProgressBridge,
  parseMattermostRestartRecoverySessionKey,
  type MattermostRestartRecoveryEvent,
  type MattermostRestartRecoveryRunUi,
} from "./restart-recovery-progress.js";

function createHarness() {
  let listener: ((event: MattermostRestartRecoveryEvent) => void) | undefined;
  const runs = new Map<
    string,
    MattermostRestartRecoveryRunUi & {
      event: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    }
  >();
  const createRunUi = vi.fn((params: { runId: string }) => {
    const run = { event: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    runs.set(params.runId, run);
    return run;
  });
  const unsubscribe = vi.fn();
  const bridge = createMattermostRestartRecoveryProgressBridge({
    subscribe: (next) => {
      listener = next;
      return unsubscribe;
    },
    createRunUi,
    log: vi.fn(),
  });
  const emit = (event: MattermostRestartRecoveryEvent) => listener?.(event);
  return { bridge, createRunUi, emit, runs, unsubscribe };
}

describe("Mattermost restart recovery progress", () => {
  it("parses only canonical Mattermost channel and group routes", () => {
    expect(
      parseMattermostRestartRecoverySessionKey(
        "agent:main:mattermost:channel:chan-1:thread:root-1",
      ),
    ).toEqual({ kind: "channel", channelId: "chan-1", threadId: "root-1" });
    expect(
      parseMattermostRestartRecoverySessionKey("agent:support:mattermost:group:group-1"),
    ).toEqual({ kind: "group", channelId: "group-1", threadId: undefined });
    expect(
      parseMattermostRestartRecoverySessionKey(
        "agent:main:other:channel:chan-1:thread:root-1",
      ),
    ).toBeNull();
    expect(
      parseMattermostRestartRecoverySessionKey(
        "agent:main:mattermost:direct:user-1:thread:root-1",
      ),
    ).toBeNull();
  });

  it("ignores ordinary agent runs", () => {
    const harness = createHarness();
    harness.emit({
      runId: "normal-run",
      sessionKey: "agent:main:mattermost:channel:chan-1:thread:root-1",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    harness.emit({
      runId: "normal-run",
      stream: "tool",
      data: { phase: "start", name: "read", toolCallId: "tool-1" },
    });
    expect(harness.createRunUi).not.toHaveBeenCalled();
  });

  it("reattaches tool progress to the original thread and stops at terminal", async () => {
    const harness = createHarness();
    harness.emit({
      runId: "recovery-run",
      sessionKey: "agent:main:mattermost:channel:chan-1:thread:root-1",
      mainSessionRestartRecovery: true,
      stream: "lifecycle",
      data: { phase: "start" },
    });
    harness.emit({
      runId: "recovery-run",
      mainSessionRestartRecovery: true,
      stream: "tool",
      data: { phase: "start", name: "read", toolCallId: "tool-1" },
    });
    harness.emit({
      runId: "recovery-run",
      mainSessionRestartRecovery: true,
      stream: "item",
      data: { phase: "update", kind: "tool", itemId: "tool-1", progressText: "50%" },
    });
    harness.emit({
      runId: "recovery-run",
      sessionKey: "agent:main:mattermost:channel:chan-1:thread:root-1",
      mainSessionRestartRecovery: true,
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await vi.waitFor(() => expect(harness.runs.get("recovery-run")?.stop).toHaveBeenCalledOnce());

    expect(harness.createRunUi).toHaveBeenCalledWith({
      runId: "recovery-run",
      route: { kind: "channel", channelId: "chan-1", threadId: "root-1" },
    });
    expect(harness.runs.get("recovery-run")?.event).toHaveBeenCalledTimes(2);
  });

  it("deduplicates starts and ignores late events after terminal", async () => {
    const harness = createHarness();
    const start: MattermostRestartRecoveryEvent = {
      runId: "recovery-run",
      sessionKey: "agent:main:mattermost:group:chan-1:thread:root-1",
      mainSessionRestartRecovery: true,
      stream: "lifecycle",
      data: { phase: "start" },
    };
    harness.emit(start);
    harness.emit(start);
    harness.emit({ ...start, data: { phase: "error" } });
    harness.emit({
      runId: "recovery-run",
      mainSessionRestartRecovery: true,
      stream: "tool",
      data: { phase: "start", name: "exec", toolCallId: "late" },
    });
    await vi.waitFor(() => expect(harness.runs.get("recovery-run")?.stop).toHaveBeenCalledOnce());
    expect(harness.createRunUi).toHaveBeenCalledOnce();
    expect(harness.runs.get("recovery-run")?.event).not.toHaveBeenCalled();
  });

  it("tears down active recovery UIs when the monitor stops", async () => {
    const harness = createHarness();
    for (const runId of ["one", "two"]) {
      harness.emit({
        runId,
        sessionKey: `agent:main:mattermost:channel:${runId}:thread:root-${runId}`,
        mainSessionRestartRecovery: true,
        stream: "lifecycle",
        data: { phase: "start" },
      });
    }
    await harness.bridge.stop();
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
    expect(harness.runs.get("one")?.stop).toHaveBeenCalledOnce();
    expect(harness.runs.get("two")?.stop).toHaveBeenCalledOnce();
  });

  it("waits for terminal cleanup that was already retired when the monitor stops", async () => {
    const harness = createHarness();
    harness.emit({
      runId: "retiring",
      sessionKey: "agent:main:mattermost:channel:chan-1:thread:root-1",
      mainSessionRestartRecovery: true,
      stream: "lifecycle",
      data: { phase: "start" },
    });
    let releaseCleanup: (() => void) | undefined;
    harness.runs.get("retiring")?.stop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        }),
    );
    harness.emit({
      runId: "retiring",
      mainSessionRestartRecovery: true,
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await vi.waitFor(() => expect(harness.runs.get("retiring")?.stop).toHaveBeenCalledOnce());

    let bridgeStopped = false;
    const stopping = harness.bridge.stop().then(() => {
      bridgeStopped = true;
    });
    await Promise.resolve();
    expect(bridgeStopped).toBe(false);
    releaseCleanup?.();
    await stopping;
    expect(bridgeStopped).toBe(true);
  });
});
