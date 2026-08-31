import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import { createMattermostTaskProgressCard } from "./task-progress-card.js";

function createTestClient(
  request: MattermostClient["request"],
): MattermostClient {
  return {
    baseUrl: "https://mattermost.example.com",
    apiBaseUrl: "https://mattermost.example.com/api/v4",
    token: "test-token",
    request,
    fetchImpl: vi.fn(),
  };
}

function readBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("Mattermost durable task progress card", () => {
  it("stays lazy for turns without a plan", async () => {
    const request = vi.fn<MattermostClient["request"]>();
    const card = createMattermostTaskProgressCard({
      client: createTestClient(request),
      channelId: "channel-1",
      log: vi.fn(),
    });

    card.noteRunStart("run-1");
    await card.finish({ outcome: "completed" });

    expect(request).not.toHaveBeenCalled();
    expect(card.postId()).toBeUndefined();
  });

  it("creates once and serializes rapid, duplicate, and slow updates onto one post", async () => {
    const firstUpdate = deferred<{ id: string }>();
    let updateCount = 0;
    const request = vi.fn<MattermostClient["request"]>(async (path, init) => {
      if (path === "/posts") {
        return { id: "task-card-1" } as never;
      }
      updateCount += 1;
      if (updateCount === 1) {
        return (await firstUpdate.promise) as never;
      }
      return { id: "task-card-1" } as never;
    });
    const card = createMattermostTaskProgressCard({
      client: createTestClient(request),
      channelId: "channel-1",
      rootId: "thread-root-1",
      log: vi.fn(),
    });

    await card.updatePlan({
      title: "Deploy",
      steps: [
        { step: "Inspect", status: "completed" },
        { step: "Patch", status: "in_progress" },
      ],
    });
    const slowUpdate = card.updatePlan({
      title: "Deploy",
      steps: [
        { step: "Inspect", status: "completed" },
        { step: "Patch", status: "completed" },
        { step: "Test", status: "in_progress" },
      ],
    });
    await vi.waitFor(() => expect(updateCount).toBe(1));
    const newestUpdate = card.updatePlan({
      title: "Deploy",
      steps: [
        { step: "Inspect", status: "completed" },
        { step: "Patch", status: "completed" },
        { step: "Test", status: "completed" },
        { step: "Ship", status: "in_progress" },
      ],
    });
    const duplicateUpdate = card.updatePlan({
      title: "Deploy",
      steps: [
        { step: "Inspect", status: "completed" },
        { step: "Patch", status: "completed" },
        { step: "Test", status: "completed" },
        { step: "Ship", status: "in_progress" },
      ],
    });
    firstUpdate.resolve({ id: "task-card-1" });
    await Promise.all([slowUpdate, newestUpdate, duplicateUpdate]);

    const createCalls = request.mock.calls.filter(([path]) => path === "/posts");
    const updateCalls = request.mock.calls.filter(([path]) => path === "/posts/task-card-1");
    expect(createCalls).toHaveLength(1);
    expect(readBody(createCalls[0]?.[1])).toMatchObject({
      channel_id: "channel-1",
      root_id: "thread-root-1",
    });
    expect(updateCalls).toHaveLength(2);
    expect(String(readBody(updateCalls[0]?.[1]).message)).toContain("▸ Test");
    expect(String(readBody(updateCalls[1]?.[1]).message)).toContain("▸ Ship");
    expect(String(readBody(updateCalls[1]?.[1]).message)).not.toContain("▸ Test");
    expect(card.postId()).toBe("task-card-1");
  });

  it.each([
    { channelId: "channel-root", rootId: undefined },
    { channelId: "channel-thread", rootId: "root-post" },
    { channelId: "direct-channel", rootId: undefined },
  ])("creates in the resolved Mattermost destination %#", async ({ channelId, rootId }) => {
    const request = vi.fn<MattermostClient["request"]>(async () => ({ id: "card" }) as never);
    const card = createMattermostTaskProgressCard({
      client: createTestClient(request),
      channelId,
      rootId,
      log: vi.fn(),
    });

    await card.updatePlan({ steps: [{ step: "Work", status: "in_progress" }] });

    const body = readBody(request.mock.calls[0]?.[1]);
    expect(body.channel_id).toBe(channelId);
    expect(body.root_id).toBe(rootId);
  });

  it("keeps the card and truthfully renders success, failure, and cancellation", async () => {
    const renderTerminal = async (
      outcome: "completed" | "failed",
      lifecycle?: { phase: "end" | "error"; aborted?: boolean },
    ) => {
      const request = vi.fn<MattermostClient["request"]>(async (path) =>
        ({ id: path === "/posts" ? "card" : "card" }) as never,
      );
      const card = createMattermostTaskProgressCard({
        client: createTestClient(request),
        channelId: "channel-1",
        log: vi.fn(),
      });
      card.noteRunStart("run-1");
      await card.updatePlan({ steps: [{ step: "Work", status: "in_progress" }] });
      if (lifecycle) {
        card.noteAgentEvent({ runId: "run-1", stream: "lifecycle", data: lifecycle });
      }
      await card.finish({ outcome });
      return String(readBody(request.mock.calls.at(-1)?.[1]).message);
    };

    await expect(renderTerminal("completed")).resolves.toContain("✅ Completed");
    await expect(renderTerminal("failed", { phase: "error" })).resolves.toContain("❌ Failed");
    await expect(
      renderTerminal("failed", { phase: "error", aborted: true }),
    ).resolves.toContain("⛔ Cancelled");
  });

  it("contains create/update failures with bounded retry and diagnostics", async () => {
    const log = vi.fn();
    const request = vi.fn<MattermostClient["request"]>(async () => {
      throw new Error("Mattermost unavailable");
    });
    const card = createMattermostTaskProgressCard({
      client: createTestClient(request),
      channelId: "channel-1",
      log,
    });

    await expect(
      card.updatePlan({ steps: [{ step: "Work", status: "in_progress" }] }),
    ).resolves.toBe(false);
    await expect(card.finish({ outcome: "completed" })).resolves.toBeUndefined();
    await expect(
      card.updatePlan({ steps: [{ step: "Still working", status: "in_progress" }] }),
    ).resolves.toBe(false);

    expect(request).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]?.[0]).toContain("task progress card create failed");
  });
});
