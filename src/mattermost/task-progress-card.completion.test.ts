import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import { createMattermostTaskProgressCard } from "./task-progress-card.js";

describe("task-card explicit parent completion across continuation", () => {
  it.each([false, true])("retains a yielded parent when child completes before yield=%s", async (childFirst) => {
    const request = vi.fn<MattermostClient["request"]>(async (_path, init) => ({
      id: JSON.parse(String(init?.body)).props?.kind === "turn_result" ? "result-post" : "original-card",
    }) as never);
    const client: MattermostClient = {
      baseUrl: "https://mattermost.example.com", apiBaseUrl: "https://mattermost.example.com/api/v4",
      token: "test-token", request, fetchImpl: vi.fn(),
    };
    const card = createMattermostTaskProgressCard({ client, channelId: "channel", log: vi.fn() });
    card.noteRunStart("parent-run");
    await card.updatePlan({ steps: [{ step: "Actual video work", status: "pending" }] });
    await card.noteVisibleWorkSessions([{ sessionKey: "child", runId: "child-run", status: childFirst ? "done" : "running" }]);
    await card.settleBeforeResultPostCreate();
    await client.request("/posts", { method: "POST", body: JSON.stringify({ message: "Continuing", props: { kind: "turn_result" } }) });
    card.noteAgentEvent({ runId: "parent-run", stream: "lifecycle",
      data: { phase: "end", yielded: true, livenessState: "paused", stopReason: "end_turn" } });
    await card.finish({ outcome: "completed" });
    if (!childFirst) {
      card.noteAgentEvent({ runId: "child-run", sessionKey: "child", stream: "lifecycle", data: { phase: "end" } });
      await card.noteVisibleWorkSessions([{ sessionKey: "child", status: "done" }]);
    }
    const cardCalls = request.mock.calls.filter(([_path, init]) => JSON.parse(String(init?.body)).message.startsWith("#### Task progress"));
    expect(JSON.parse(String(cardCalls.at(-1)?.[1]?.body)).message).toContain("Task progress · In progress");
    expect(card.canContinue()).toBe(true);
    expect(card.postId()).toBe("original-card");
    const resultIndex = request.mock.calls.findIndex(([_path, init]) => JSON.parse(String(init?.body)).props?.kind === "turn_result");
    expect(resultIndex).toBeGreaterThan(0);
    expect(request.mock.calls.slice(resultIndex + 1).every(([path]) => path === "/posts/original-card/patch")).toBe(true);
    expect(await card.beginContinuation("next-parent", () => true)).toBe(true);
    await card.updateContinuationPlan("next-parent", { steps: [{ step: "Actual video work", status: "completed" }] }, () => true);
    card.noteAgentEvent({ runId: "next-parent", stream: "lifecycle", data: { phase: "end" } });
    await card.finish({ outcome: "completed" });
    expect(JSON.parse(String(request.mock.calls.at(-1)?.[1]?.body)).message).toContain("Task progress · Completed");
    expect(request.mock.calls.filter(([path]) => path === "/posts")).toHaveLength(2);
    expect(request.mock.calls.slice(resultIndex + 1).every(([path]) => path === "/posts/original-card/patch")).toBe(true);
  });

  it("does not turn an all-completed checklist into task completion on yield", async () => {
    const request = vi.fn<MattermostClient["request"]>(async () => ({ id: "card" }) as never);
    const client = { baseUrl: "https://example.com", apiBaseUrl: "https://example.com/api/v4",
      token: "test", request, fetchImpl: vi.fn() } satisfies MattermostClient;
    const card = createMattermostTaskProgressCard({ client, channelId: "channel", log: vi.fn() });
    card.noteRunStart("parent");
    await card.updatePlan({ steps: [{ step: "Video work", status: "completed" }] });
    card.noteAgentEvent({ runId: "parent", stream: "lifecycle",
      data: { phase: "end", yielded: true, livenessState: "paused", stopReason: "end_turn" } });
    await card.finish({ outcome: "completed" });
    expect(JSON.parse(String(request.mock.calls.at(-1)?.[1]?.body)).message).toContain("Task progress · In progress");
    expect(card.canContinue()).toBe(true);
  });

  it.each([
    { phase: "error", expected: "Failed" },
    { aborted: true, expected: "Cancelled" },
    { status: "cancelled", expected: "Cancelled" },
    { status: "timed_out", expected: "Failed" },
    { timeoutPhase: "delivery", expected: "Failed" },
    { error: "provider failed", expected: "Failed" },
    { deliveryFailed: true, expected: "Failed" },
    { outcome: "failed" as const, expected: "Failed" },
  ])("preserves $expected over yield: %j", async ({ expected, deliveryFailed, outcome, ...data }) => {
    const request = vi.fn<MattermostClient["request"]>(async () => ({ id: "card" }) as never);
    const client = { baseUrl: "https://example.com", apiBaseUrl: "https://example.com/api/v4",
      token: "test", request, fetchImpl: vi.fn() } satisfies MattermostClient;
    const card = createMattermostTaskProgressCard({ client, channelId: "channel", log: vi.fn() });
    card.noteRunStart("parent");
    await card.updatePlan({ steps: [{ step: "Work", status: "completed" }] });
    await card.noteVisibleWorkSessions([{ sessionKey: "child", status: "running" }]);
    card.noteAgentEvent({ runId: "parent", stream: "lifecycle",
      data: { phase: "end", yielded: true, livenessState: "paused", stopReason: "end_turn", ...data } });
    await card.finish({ outcome: outcome ?? "completed", deliveryFailed });
    expect(JSON.parse(String(request.mock.calls.at(-1)?.[1]?.body)).message).toContain(`Task progress · ${expected}`);
    expect(card.canContinue()).toBe(false);
  });

  it("keeps a yielded child active until its real terminal", async () => {
    const request = vi.fn<MattermostClient["request"]>(async () => ({ id: "card" }) as never);
    const client = { baseUrl: "https://example.com", apiBaseUrl: "https://example.com/api/v4",
      token: "test", request, fetchImpl: vi.fn() } satisfies MattermostClient;
    const card = createMattermostTaskProgressCard({ client, channelId: "channel", log: vi.fn() });
    card.noteRunStart("parent");
    await card.updatePlan({ steps: [{ step: "Work", status: "completed" }] });
    await card.noteVisibleWorkSessions([{ sessionKey: "child", runId: "child-run", status: "running" }]);
    card.noteAgentEvent({ sessionKey: "child", runId: "child-run", stream: "lifecycle",
      data: { phase: "end", yielded: true, livenessState: "paused", stopReason: "end_turn" } });
    await card.finish({ outcome: "completed" });
    let message = JSON.parse(String(request.mock.calls.at(-1)?.[1]?.body)).message;
    expect(message).toContain("Task progress · In progress");
    expect(message).toContain("Subtask 1 · Running");
    card.noteAgentEvent({ sessionKey: "child", runId: "child-run", stream: "lifecycle", data: { phase: "end" } });
    await card.noteVisibleWorkSessions([{ sessionKey: "child", status: "done" }]);
    message = JSON.parse(String(request.mock.calls.at(-1)?.[1]?.body)).message;
    expect(message).toContain("Task progress · Completed");
    expect(message).toContain("Subtask 1 · Completed");
  });

  it.each([
    { yielded: false }, { livenessState: "running" }, { stopReason: "stop" },
  ])("requires strict waiting fields: %j", async (override) => {
    const request = vi.fn<MattermostClient["request"]>(async () => ({ id: "card" }) as never);
    const client = { baseUrl: "https://example.com", apiBaseUrl: "https://example.com/api/v4",
      token: "test", request, fetchImpl: vi.fn() } satisfies MattermostClient;
    const card = createMattermostTaskProgressCard({ client, channelId: "channel", log: vi.fn() });
    card.noteRunStart("parent");
    await card.updatePlan({ steps: [{ step: "Work", status: "pending" }] });
    card.noteAgentEvent({ runId: "parent", stream: "lifecycle",
      data: { phase: "end", yielded: true, livenessState: "paused", stopReason: "end_turn", ...override } });
    await card.finish({ outcome: "completed" });
    expect(JSON.parse(String(request.mock.calls.at(-1)?.[1]?.body)).message).toContain("Task progress · Incomplete");
  });

  it.each([false, true])(
    "applies explicit completion to the original card with earlier per-run finish=%s",
    async (finishInitialRun) => {
      const request = vi.fn<MattermostClient["request"]>(async () => ({ id: "original-card" }) as never);
      const client: MattermostClient = {
        baseUrl: "https://mattermost.example.com",
        apiBaseUrl: "https://mattermost.example.com/api/v4",
        token: "test-token",
        request,
        fetchImpl: vi.fn(),
      };
      const card = createMattermostTaskProgressCard({
        client, channelId: "channel-1", log: vi.fn(),
      });
      const step = "Update and validate the original HTML report";
      card.noteRunStart("initial-run");
      await card.updatePlan({ source: "openclaw", steps: [{ step, status: "in_progress" }] });
      // The earlier run yielded successfully. This is not parent-task completion.
      if (finishInitialRun) await card.finish({ outcome: "completed" });

      const plan = { source: "openclaw", steps: [{ step, status: "completed" as const }] };
      if (finishInitialRun) {
        // A plain later callback is still rejected. The monitor must prove ownership.
        expect(await card.updatePlan(plan)).toBe(false);
        expect(await card.beginContinuation("continuation-run", () => true)).toBe(true);
        expect(await card.updateContinuationPlan("continuation-run", plan, () => true)).toBe(true);
      } else {
        card.noteRunStart("continuation-run");
        await card.updatePlan(plan);
      }
      card.noteAgentEvent({ runId: "continuation-run", stream: "lifecycle", data: { phase: "end" } });
      await card.finish({ outcome: "completed" });

      expect(card.postId()).toBe("original-card");
      const paths = request.mock.calls.map(([path]) => path);
      expect(paths.filter((path) => path === "/posts")).toHaveLength(1);
      expect(paths.slice(1).every((path) => path === "/posts/original-card/patch")).toBe(true);
      const terminal = JSON.parse(String(request.mock.calls.at(-1)?.[1]?.body));
      // Completion comes from an explicit later parent plan, with no children.
      // A heading-only change cannot satisfy the checklist assertion.
      expect(terminal.message).toContain(`- [x] ${step}`);
      expect(terminal.message).toContain("Task progress · Completed");
    },
  );
});
