import { afterEach, describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import { retainMattermostProgressDraft } from "./monitor-progress-continuation.js";

const drain = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };

function fixture(requestOverride?: MattermostClient["request"]) {
  const request = vi.fn<MattermostClient["request"]>(requestOverride ?? (async (_path, init) =>
    ({ id: "retained-preview", message: JSON.parse(String(init?.body ?? "{}")).message }) as never));
  const client: MattermostClient = { baseUrl: "https://mattermost.example.com",
    apiBaseUrl: "https://mattermost.example.com/api/v4", token: "test-token", request, fetchImpl: vi.fn() };
  const abort = new AbortController();
  const assertCurrent = vi.fn();
  const draft = retainMattermostProgressDraft({
    client, channelId: "channel", rootId: "thread", postId: "retained-preview", text: "Working",
    snapshot: { lines: [] }, entry: { streaming: { mode: "progress", progress: { toolProgress: true } } },
    seed: "test", maxChars: 300, abortSignal: abort.signal, assertCurrent, log: vi.fn(),
  });
  return { draft, abort, request, assertCurrent };
}

afterEach(() => vi.useRealTimers());

describe("host-owned Mattermost continuation draft", () => {
  it("renders the host's minimal operation and status on one bounded post, then retires once", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.draft.push({ itemId: "requester:tool", kind: "tool", name: "exec", phase: "update", status: "running" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.request.mock.calls.at(-1)?.[0]).toBe("/posts/retained-preview/patch");
    expect(String(f.request.mock.calls.at(-1)?.[1]?.body)).toContain("Exec: running");
    for (let i = 0; i < 50; i++) f.draft.push({
      itemId: `child-${i}`, kind: "subagent", title: "Delegated work ".repeat(15), status: "running",
    });
    await vi.advanceTimersByTimeAsync(1500);
    for (const [path, init] of f.request.mock.calls) {
      expect(path).toBe("/posts/retained-preview/patch");
      expect(JSON.parse(String(init?.body)).message.length).toBeLessThanOrEqual(300);
    }
    f.draft.retire();
    f.draft.retire();
    await drain();
    expect(f.request.mock.calls.filter(([, init]) => init?.method === "DELETE")).toEqual([
      ["/posts/retained-preview", { method: "DELETE", discardResponse: true }],
    ]);
    const count = f.request.mock.calls.length;
    f.draft.push({ itemId: "late", kind: "tool", name: "read", status: "running" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.request.mock.calls).toHaveLength(count);
  });

  it("releases a rejected adoption without deleting or editing the original final identity", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.draft.push({ itemId: "requester:tool", kind: "tool", name: "exec", status: "running" });
    f.draft.release();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.request).not.toHaveBeenCalled();
    f.draft.retire();
    await drain();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("aborts an in-flight retained update before deleting only its old preview", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture(async (_path, init) => {
      if (init?.method === "PUT") { signal = init.signal!; await pending; }
      return { id: "retained-preview" } as never;
    });
    f.draft.push({ itemId: "requester:tool", kind: "tool", name: "exec", status: "running" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(signal).toBeDefined();
    f.abort.abort();
    await drain();
    expect(signal!.aborted).toBe(true);
    expect(f.request.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    release();
    await drain();
    expect(f.request.mock.calls.map(([path, init]) => [path, init?.method])).toEqual([
      ["/posts/retained-preview/patch", "PUT"], ["/posts/retained-preview", "DELETE"],
    ]);
  });
});
