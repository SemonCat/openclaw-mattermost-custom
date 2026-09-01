import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import { createMattermostDraftStream } from "./draft-stream.js";
import {
  createMattermostTaskProgressCard,
  renderMattermostTaskProgressCard,
} from "./task-progress-card.js";
import { buildMattermostPostIdentityProps } from "./post-identity.js";

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
    await card.settleBeforeResultPost();
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
      postProps: buildMattermostPostIdentityProps("task_progress", {
        accountId: "default",
        agentId: "main",
        channelId: "channel-1",
        threadId: "thread-root-1",
      }),
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
      props: {
        openclaw_mattermost: {
          version: 1,
          kind: "task_progress",
          accountId: "default",
          agentId: "main",
          channelId: "channel-1",
          threadId: "thread-root-1",
        },
      },
    });
    expect(updateCalls).toHaveLength(2);
    expect(String(readBody(updateCalls[0]?.[1]).message)).toContain("- [ ] **Test**");
    expect(String(readBody(updateCalls[1]?.[1]).message)).toContain("- [ ] **Ship**");
    expect(String(readBody(updateCalls[1]?.[1]).message)).not.toContain("- [ ] **Test**");
    expect(card.postId()).toBe("task-card-1");
  });

  it("creates the card before a concurrently-started result preview", async () => {
    const releaseCardCreate = deferred<void>();
    const request = vi.fn<MattermostClient["request"]>(async (path, init) => {
      if (path !== "/posts") {
        return { id: "updated" } as never;
      }
      const body = readBody(init);
      if (String(body.message).startsWith("#### Task progress")) {
        await releaseCardCreate.promise;
        return { id: "task-card" } as never;
      }
      return { id: "result-post" } as never;
    });
    const client = createTestClient(request);
    const card = createMattermostTaskProgressCard({
      client,
      channelId: "channel-1",
      log: vi.fn(),
    });
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      throttleMs: 0,
      beforeCreatePost: card.settleBeforeResultPostCreate,
    });

    const planUpdate = card.updatePlan({
      steps: [{ step: "Inspect", status: "in_progress" }],
    });
    stream.update("Running a tool");
    const resultFlush = stream.flush();

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(
      String(readBody(request.mock.calls[0]?.[1]).message).startsWith(
        "#### Task progress · In progress",
      ),
    ).toBe(true);
    releaseCardCreate.resolve();
    await Promise.all([planUpdate, resultFlush]);

    const creates = request.mock.calls.filter(([path]) => path === "/posts");
    const createdMessages = creates.map(([, init]) => String(readBody(init).message));
    expect(createdMessages[0]?.startsWith("#### Task progress · In progress")).toBe(true);
    expect(createdMessages[1]).toBe("Running a tool");
    expect(card.postId()).toBe("task-card");
    expect(stream.postId()).toBe("result-post");
  });

  it("creates a late plan card before a result whose delivery started first", async () => {
    const request = vi.fn<MattermostClient["request"]>(async (path, init) => {
      if (path !== "/posts") {
        return { id: "updated" } as never;
      }
      const message = String(readBody(init).message);
      return {
        id: message.startsWith("#### Task progress") ? "task-card" : "result-post",
      } as never;
    });
    const client = createTestClient(request);
    const card = createMattermostTaskProgressCard({
      client,
      channelId: "channel-1",
      log: vi.fn(),
    });
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      throttleMs: 0,
      beforeCreatePost: card.settleBeforeResultPostCreate,
    });

    // Core can enter result delivery before its ordered plan callback starts. This is
    // not yet a Mattermost result identity, so the later callback must still own the
    // first create and the actual preview create must wait behind it.
    expect(card.settleBeforeResultPost()).toBeUndefined();
    const planUpdate = card.updatePlan({
      steps: [{ step: "Inspect", status: "in_progress" }],
    });
    stream.update("Running a tool");
    const resultFlush = stream.flush();

    await expect(planUpdate).resolves.toBe(true);
    await resultFlush;

    const createdMessages = request.mock.calls
      .filter(([path]) => path === "/posts")
      .map(([, init]) => String(readBody(init).message));
    expect(createdMessages[0]?.startsWith("#### Task progress · In progress")).toBe(true);
    expect(createdMessages[1]).toBe("Running a tool");
    expect(card.postId()).toBe("task-card");
    expect(stream.postId()).toBe("result-post");
  });

  it.each([
    { status: "in_progress" as const, label: "In progress" },
    { status: "completed" as const, label: "Completed" },
    { status: "failed" as const, label: "Failed" },
    { status: "cancelled" as const, label: "Cancelled" },
  ])("renders a compact $status card", ({ status, label }) => {
    const rendered = renderMattermostTaskProgressCard({
      status,
      title: "Deploy",
      explanation: "Plan updated",
      steps: [
        { step: "Inspect", status: "completed" },
        { step: "Patch", status: "in_progress" },
        { step: "Test", status: "pending" },
      ],
    });

    expect(rendered).toBe(
      [
        `#### Task progress · ${label}`,
        "Deploy",
        "",
        "- [x] Inspect",
        "- [ ] **Patch**",
        "- [ ] Test",
      ].join("\n"),
    );
    expect(rendered).not.toContain("Status:");
    expect(rendered).not.toContain("Plan updated");
    expect(rendered).not.toMatch(/[✅❌⛔🔄]/u);
  });

  it("omits the redundant Plan updated explanation from published plans", async () => {
    const request = vi.fn<MattermostClient["request"]>(async () => ({ id: "card" }) as never);
    const card = createMattermostTaskProgressCard({
      client: createTestClient(request),
      channelId: "channel-1",
      log: vi.fn(),
    });

    await card.updatePlan({
      explanation: "Plan updated.",
      steps: [{ step: "Work", status: "in_progress" }],
    });

    expect(String(readBody(request.mock.calls[0]?.[1]).message)).not.toContain("Plan updated");
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

    await expect(renderTerminal("completed")).resolves.toContain("Task progress · Completed");
    await expect(renderTerminal("failed", { phase: "error" })).resolves.toContain(
      "Task progress · Failed",
    );
    await expect(
      renderTerminal("failed", { phase: "error", aborted: true }),
    ).resolves.toContain("Task progress · Cancelled");
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
    await card.settleBeforeResultPost();
    await expect(card.finish({ outcome: "completed" })).resolves.toBeUndefined();
    await expect(
      card.updatePlan({ steps: [{ step: "Still working", status: "in_progress" }] }),
    ).resolves.toBe(false);

    expect(request).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("task progress card create failed");
  });
});
