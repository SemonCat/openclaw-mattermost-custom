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

  it("does not create a card for visible work sessions when the turn has no plan", async () => {
    const request = vi.fn<MattermostClient["request"]>();
    const onSettled = vi.fn();
    const card = createMattermostTaskProgressCard({
      client: createTestClient(request),
      channelId: "channel-1",
      onSettled,
      log: vi.fn(),
    });

    await card.noteVisibleWorkSessions([
      {
        sessionKey: "agent:main:subagent:one",
        url: "https://control.example.com/sessions/one",
        label: "Investigate",
        status: "running",
      },
    ]);
    await card.finish({ outcome: "completed" });

    expect(request).not.toHaveBeenCalled();
    expect(card.postId()).toBeUndefined();
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("keeps the parent card live and continuously projects child-session progress", async () => {
    const request = vi.fn<MattermostClient["request"]>(async () => ({ id: "card" }) as never);
    const onSettled = vi.fn();
    const card = createMattermostTaskProgressCard({
      client: createTestClient(request),
      channelId: "channel-1",
      onSettled,
      log: vi.fn(),
    });

    await card.updatePlan({
      title: "Investigate regression",
      steps: [{ step: "Delegate focused checks", status: "completed" }],
    });
    await card.noteVisibleWorkSessions([
      {
        sessionKey: "agent:main:subagent:one",
        url: "https://control.example.com/sessions/one",
        label: "Inspect API",
        runId: "child-run-1",
        status: "running",
      },
    ]);
    await card.finish({ outcome: "completed" });

    expect(onSettled).not.toHaveBeenCalled();
    expect(String(readBody(request.mock.calls.at(-1)?.[1]).message)).toContain(
      "Task progress · In progress",
    );
    expect(String(readBody(request.mock.calls.at(-1)?.[1]).message)).toContain(
      "[Inspect API](https://control.example.com/sessions/one) · Running",
    );

    card.noteAgentEvent({
      runId: "child-run-1",
      sessionKey: "agent:main:subagent:one",
      stream: "plan",
      data: {
        steps: [
          { step: "Read upstream implementation", status: "completed" },
          { step: "Reproduce event ordering", status: "in_progress" },
        ],
      },
    });
    await vi.waitFor(() => {
      expect(String(readBody(request.mock.calls.at(-1)?.[1]).message)).toContain(
        "Reproduce event ordering",
      );
    });

    card.noteAgentEvent({
      runId: "child-run-1",
      sessionKey: "agent:main:subagent:one",
      stream: "item",
      data: {
        phase: "update",
        kind: "tool",
        title: "Running focused regression test",
        status: "running",
      },
    });
    await vi.waitFor(() => {
      expect(String(readBody(request.mock.calls.at(-1)?.[1]).message)).toContain(
        "Running focused regression test",
      );
    });

    card.noteAgentEvent({
      runId: "child-run-1",
      sessionKey: "agent:main:subagent:one",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());

    const terminalMessage = String(readBody(request.mock.calls.at(-1)?.[1]).message);
    expect(terminalMessage).toContain("Task progress · Completed");
    expect(terminalMessage).toContain(
      "- [x] [Inspect API](https://control.example.com/sessions/one) · Completed",
    );
    expect(terminalMessage).not.toContain("Running focused regression test");
  });

  it("normalizes child state while bounding rendered work-session links", async () => {
    const request = vi.fn<MattermostClient["request"]>(async () => ({ id: "card" }) as never);
    const onSettled = vi.fn();
    const card = createMattermostTaskProgressCard({
      client: createTestClient(request),
      channelId: "channel-1",
      onSettled,
      log: vi.fn(),
    });
    await card.updatePlan({ steps: [{ step: "Delegate", status: "completed" }] });

    await card.noteVisibleWorkSessions([
      {
        sessionKey: "invalid",
        url: "javascript:alert(1)",
        label: "Invalid",
        status: "running",
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        sessionKey: `child-${index + 1}`,
        url: `https://control.example.com/sessions/${index + 1}`,
        label: index === 0 ? "Check [API]" : `Child ${index + 1}`,
        status:
          index === 1
            ? ("failed" as const)
            : index === 5
              ? ("running" as const)
              : ("done" as const),
      })),
    ]);
    await card.finish({ outcome: "completed" });

    const runningMessage = String(readBody(request.mock.calls.at(-1)?.[1]).message);
    expect(runningMessage).toContain("Task progress · In progress");
    expect(runningMessage).toContain("[Check \\[API\\]](https://control.example.com/sessions/1)");
    expect(runningMessage).toContain("[Child 5](https://control.example.com/sessions/5)");
    expect(runningMessage).toContain("1 additional subtask tracked");
    expect(runningMessage).not.toContain("sessions/6");
    expect(runningMessage).not.toContain("javascript:");
    expect(onSettled).not.toHaveBeenCalled();

    card.noteAgentEvent({
      runId: "child-run-6",
      sessionKey: "child-6",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
    expect(String(readBody(request.mock.calls.at(-1)?.[1]).message)).toContain(
      "Task progress · Failed",
    );
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
    const updateCalls = request.mock.calls.filter(
      ([path]) => path === "/posts/task-card-1/patch",
    );
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

  it("turns an already-created commentary post into a late plan card without losing commentary", async () => {
    let createCount = 0;
    const request = vi.fn<MattermostClient["request"]>(async (path, init) => {
      if (path === "/posts") {
        createCount += 1;
        return {
          id: createCount === 1 ? "first-result-post" : "continuing-result-post",
          message: String(readBody(init).message),
        } as never;
      }
      return {
        id: path.slice("/posts/".length),
        message: String(readBody(init).message),
      } as never;
    });
    const client = createTestClient(request);
    let claimResultPost: (() => Promise<string | undefined>) | undefined;
    const card = createMattermostTaskProgressCard({
      client,
      channelId: "channel-1",
      postProps: buildMattermostPostIdentityProps("task_progress", {
        accountId: "default",
        agentId: "main",
        channelId: "channel-1",
      }),
      claimResultPost: async () => await claimResultPost?.(),
      log: vi.fn(),
    });
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      postProps: buildMattermostPostIdentityProps("turn_result", {
        accountId: "default",
        agentId: "main",
        channelId: "channel-1",
      }),
      throttleMs: 0,
      beforeCreatePost: card.settleBeforeResultPostCreate,
    });
    claimResultPost = stream.handoffPostIdentity;

    stream.update("Commentary before the plan");
    await stream.flush();
    expect(stream.postId()).toBe("first-result-post");

    await expect(
      card.updatePlan({ steps: [{ step: "Inspect", status: "in_progress" }] }),
    ).resolves.toBe(true);
    stream.update("Continuing tool progress");
    await stream.flush();
    await card.finish({ outcome: "completed" });

    expect(card.postId()).toBe("first-result-post");
    expect(stream.postId()).toBe("continuing-result-post");
    const calls = request.mock.calls.map(([path, init]) => ({ path, body: readBody(init) }));
    expect(calls).toEqual([
      expect.objectContaining({
        path: "/posts",
        body: expect.objectContaining({ message: "Commentary before the plan" }),
      }),
      expect.objectContaining({
        path: "/posts",
        body: expect.objectContaining({
          message: "Commentary before the plan",
          props: expect.objectContaining({
            openclaw_mattermost: expect.objectContaining({ kind: "turn_result" }),
          }),
        }),
      }),
      expect.objectContaining({
        path: "/posts/first-result-post/patch",
        body: expect.objectContaining({
          message: expect.stringContaining("Task progress · In progress"),
          props: expect.objectContaining({
            openclaw_mattermost: expect.objectContaining({ kind: "task_progress" }),
          }),
        }),
      }),
      expect.objectContaining({
        path: "/posts/continuing-result-post/patch",
        body: expect.objectContaining({ message: "Continuing tool progress" }),
      }),
      expect.objectContaining({
        path: "/posts/first-result-post/patch",
        body: expect.objectContaining({
          message: expect.stringContaining("Task progress · Incomplete"),
        }),
      }),
    ]);
  });

  it.each([
    { status: "in_progress" as const, label: "In progress" },
    { status: "completed" as const, label: "Completed" },
    { status: "incomplete" as const, label: "Incomplete" },
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

  it("does not publish a card for a generic empty OpenClaw plan event", async () => {
    const request = vi.fn<MattermostClient["request"]>();
    const card = createMattermostTaskProgressCard({
      client: createTestClient(request),
      channelId: "channel-1",
      log: vi.fn(),
    });

    await expect(
      card.updatePlan({
        title: "Plan updated",
        source: "openclaw",
        steps: [],
      }),
    ).resolves.toBe(false);

    expect(request).not.toHaveBeenCalled();
    expect(card.postId()).toBeUndefined();
  });

  it("uses captured native markdown when OpenClaw emits a generic progress explanation", async () => {
    const request = vi.fn<MattermostClient["request"]>(async () => ({ id: "card" }) as never);
    const card = createMattermostTaskProgressCard({
      client: createTestClient(request),
      channelId: "channel-1",
      log: vi.fn(),
    });

    card.noteToolStart({
      toolCallId: "progress-1",
      name: "progress_card",
      phase: "start",
      args: {
        markdown:
          '<progress aria-label="Deploy · 1/2" value="1" max="2"></progress>\n\n**Inspecting the live runtime**',
      },
    });
    await card.updatePlan({
      title: "Plan updated",
      explanation: "Progress updated",
      source: "openclaw",
      steps: [],
    });

    const message = String(readBody(request.mock.calls[0]?.[1]).message);
    expect(message).toContain("**Deploy · 1/2**");
    expect(message).toContain("**Inspecting the live runtime**");
    expect(message).not.toContain("Progress updated");
  });

  it("preserves native markdown when OpenClaw 9.5 also emits a flattened explanation", async () => {
    const request = vi.fn<MattermostClient["request"]>(async () => ({ id: "card" }) as never);
    const card = createMattermostTaskProgressCard({
      client: createTestClient(request),
      channelId: "channel-1",
      log: vi.fn(),
    });
    const markdown = [
      "**Autolearn P5 canary**",
      "",
      "| Gate | Status |",
      "|---|---|",
      "| GBrain query | ✅ 5/5 fresh |",
      "| Waza result | 🔧 Retesting |",
    ].join("\n");

    card.noteToolStart({
      toolCallId: "progress-1",
      name: "progress_card",
      phase: "start",
      args: { markdown },
    });
    await card.updatePlan({
      title: "Plan updated",
      explanation:
        "Autolearn P5 canary Gate Status GBrain query ✅ 5/5 fresh Waza result 🔧 Retesting",
      source: "openclaw",
      steps: [],
    });
    await card.updatePlan({
      title: "Plan updated",
      explanation:
        "Autolearn P5 canary Gate Status GBrain query ✅ 5/5 fresh Waza result 🔧 Retesting",
      source: "openclaw",
      steps: [],
    });

    const message = String(readBody(request.mock.calls[0]?.[1]).message);
    expect(message).toContain(markdown);
    expect(message).not.toContain("Autolearn P5 canary Gate Status");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not replace native progress content with a generic OpenClaw update", async () => {
    const request = vi.fn<MattermostClient["request"]>(async () => ({ id: "card" }) as never);
    const card = createMattermostTaskProgressCard({
      client: createTestClient(request),
      channelId: "channel-1",
      log: vi.fn(),
    });

    card.noteToolStart({
      toolCallId: "progress-1",
      name: "progress_card",
      phase: "start",
      args: { markdown: "**Still running the focused tests**" },
    });
    await card.updatePlan({
      title: "Plan updated",
      explanation: "Progress updated",
      source: "openclaw",
      steps: [],
    });
    await card.updatePlan({
      title: "Plan updated",
      explanation: "Progress updated",
      source: "openclaw",
      steps: [],
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(String(readBody(request.mock.calls[0]?.[1]).message)).toContain(
      "**Still running the focused tests**",
    );
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
      await card.updatePlan({
        steps: [
          {
            step: "Work",
            status: outcome === "completed" && !lifecycle ? "completed" : "in_progress",
          },
        ],
      });
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

  it("marks a successful run incomplete while checklist work remains", async () => {
    const request = vi.fn<MattermostClient["request"]>(async () => ({ id: "card" }) as never);
    const card = createMattermostTaskProgressCard({
      client: createTestClient(request),
      channelId: "channel-1",
      log: vi.fn(),
    });

    card.noteRunStart("run-1");
    await card.updatePlan({
      steps: [
        { step: "Inspect", status: "completed" },
        { step: "Patch", status: "in_progress" },
        { step: "Verify", status: "pending" },
      ],
    });
    card.noteAgentEvent({ runId: "run-1", stream: "lifecycle", data: { phase: "end" } });
    await card.finish({ outcome: "completed" });

    expect(String(readBody(request.mock.calls.at(-1)?.[1]).message)).toContain(
      "Task progress · Incomplete",
    );
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
