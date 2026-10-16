import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMattermostInboundBufferPolicy,
  type MattermostDebounceEntry,
} from "./inbound-buffer.js";

const policy = createMattermostInboundBufferPolicy({
  accountId: "default",
  botUsername: "bot",
  resolveThreadId: (facts) => facts.rootId,
  isControlCommand: (text) => text.startsWith("/"),
});
function entry(id: string, overrides: Partial<MattermostDebounceEntry["post"]> = {}): MattermostDebounceEntry {
  return {
    post: {
      id, channel_id: "channel", root_id: "thread", user_id: "user", message: id, ...overrides,
    },
    payload: { event: "posted", data: { channel_type: "O" } },
    turnAdoptionLifecycle: {
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAdoptionFinalizing: vi.fn(),
      onAbandoned: vi.fn(),
    },
  };
}
function row(candidate: MattermostDebounceEntry) {
  return {
    id: candidate.post.id, channelId: "mattermost", accountId: "default", queueName: "queue",
    receivedAt: 1, updatedAt: 1, attempts: 0,
    payload: {
      version: 1,
      rawEvent: JSON.stringify({
        ...candidate.payload,
        data: { ...candidate.payload.data, post: JSON.stringify(candidate.post) },
      }),
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("Mattermost backlog-aware buffer", () => {
  it("holds for compatible durable input but not already buffered claims", async () => {
    const first = entry("A");
    first.turnAdoptionLifecycle.readLaneBacklog = vi.fn(async () => [row(first), row(entry("B"))]);
    expect(await policy.shouldHoldFlush([first])).toBe(true);
    expect(await policy.shouldHoldFlush([first, entry("B")])).toBe(false);
  });

  it.each([
    { name: "sender", user_id: "other" },
    { name: "channel", channel_id: "other" },
    { name: "thread", root_id: "other" },
    { name: "command", message: "@bot /new" },
    { name: "system", type: "system_join_channel" },
    { name: "attachment", file_ids: ["file"] },
    { name: "empty", message: " " },
  ])("does not wait for another $name event", async ({ name: _name, ...post }) => {
    const first = entry("A");
    first.turnAdoptionLifecycle.readLaneBacklog = async () => [row(entry("B", post))];
    expect(await policy.shouldHoldFlush([first])).toBe(false);
  });

  it("refuses foreign accounts and malformed or unsupported persisted payloads", async () => {
    const first = entry("A");
    const valid = row(entry("B"));
    for (const candidate of [
      { ...valid, accountId: "other" },
      { ...valid, channelId: "other" },
      { ...valid, id: "not-B" },
      { ...valid, payload: { ...valid.payload, version: 2 } },
      { ...valid, payload: { ...valid.payload, rawEvent: "invalid" } },
    ]) {
      first.turnAdoptionLifecycle.readLaneBacklog = async () => [candidate];
      expect(await policy.shouldHoldFlush([first])).toBe(false);
    }
  });

  it("caps merged post count and text length before waiting on more input", async () => {
    const first = entry("A", { message: "a".repeat(50_000) });
    first.turnAdoptionLifecycle.readLaneBacklog = async () => [row(entry("B"))];
    expect(policy.canAppend(entry("B"), [first])).toBe(false);
    expect(await policy.shouldHoldFlush([first])).toBe(false);
    const pending = Array.from({ length: 12 }, (_, index) => entry(String(index)));
    pending.at(-1)!.turnAdoptionLifecycle.readLaneBacklog = async () => [row(entry("B"))];
    expect(await policy.shouldHoldFlush(pending)).toBe(false);
  });

  it.each(["always-backlogged", "stalled-reader", "failed-reader"] as const)(
    "flushes within the SDK deadline with a %s",
    async (mode) => {
      vi.useFakeTimers();
      const first = entry("A");
      first.turnAdoptionLifecycle.readLaneBacklog = vi.fn(() =>
        mode === "stalled-reader" ? new Promise(() => {}) :
          mode === "failed-reader" ? Promise.reject(new Error("unavailable")) :
            Promise.resolve([row(entry("B"))]),
      );
      const flush = vi.fn();
      const debouncer = createInboundDebouncer<MattermostDebounceEntry>({
        ...policy,
        debounceMs: 100,
        onFlush: (entries, createFlush) => createFlush({
          dispatch: async () => { flush(entries.map((item) => item.post.id)); },
        }),
      });
      await debouncer.enqueue(first);
      await vi.advanceTimersByTimeAsync(100);
      expect(flush).toHaveBeenCalledTimes(mode === "failed-reader" ? 1 : 0);
      await vi.advanceTimersByTimeAsync(400);
      await debouncer.drain();
      expect(flush).toHaveBeenCalledExactlyOnceWith(["A"]);
    },
  );

  it("flushes commands after prior text while a backlog reader is stalled", async () => {
    vi.useFakeTimers();
    const first = entry("A");
    first.turnAdoptionLifecycle.readLaneBacklog = () => new Promise(() => {});
    const flush = vi.fn();
    const debouncer = createInboundDebouncer<MattermostDebounceEntry>({
      ...policy, debounceMs: 100,
      onFlush: (entries, createFlush) => createFlush({
        dispatch: async () => { flush(entries.map((item) => item.post.message)); },
      }),
    });
    await debouncer.enqueue(first);
    await vi.advanceTimersByTimeAsync(100);
    await debouncer.enqueue(entry("B", { message: "/new" }));
    await debouncer.drain();
    expect(flush.mock.calls).toEqual([[["A"]], [["/new"]]]);
  });
});
