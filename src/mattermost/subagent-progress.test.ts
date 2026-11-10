import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import { buildMattermostPostIdentityProps, findMattermostRecoveryPostIdentity } from "./post-identity.js";
import { restoreMattermostTaskMessage } from "./task-progress-projection.js";
import { createMattermostTaskProgressCard } from "./task-progress-card.js";

const scope = { accountId: "default", agentId: "main", channelId: "channel", threadId: "root" };
function fixture() {
  const writes: Array<{ path: string; body: Record<string, any> }> = [];
  const client = { request: vi.fn(async (path, init) => {
    writes.push({ path, body: JSON.parse(String(init?.body)) });
    return { id: "card" };
  }) } as unknown as MattermostClient;
  const card = createMattermostTaskProgressCard({
    client, channelId: "channel", rootId: "root",
    postProps: buildMattermostPostIdentityProps("task_progress", scope), log: vi.fn(),
  });
  return { card, writes };
}

describe("child-only durable progress", () => {
  it("upgrades one silent child identity on a real late plan, without a second create", async () => {
    const { card, writes } = fixture();
    await card.noteVisibleWorkSessions([{ sessionKey: "private-key", status: "queued", label: "Review" }]);
    expect(writes[0].path).toBe("/posts?silent=true");
    expect(writes[0].body.props.openclaw_mattermost.kind).toBe("subagent_progress");
    expect(writes[0].body.props.openclaw_task_progress.steps).toEqual([]);
    await card.settleBeforeResultPostCreate();
    await card.updatePlan({ steps: [{ step: "Review findings", status: "in_progress" }] });
    expect(writes).toHaveLength(2);
    expect(writes[1].path).toBe("/posts/card/patch");
    expect(writes[1].body.props.openclaw_mattermost.kind).toBe("task_progress");
    expect(writes[1].body.message).toContain("Review");
    expect(JSON.stringify(writes)).not.toContain("private-key");
  });

  it("publishes hidden-child counts when the visible Markdown is identical", async () => {
    const { card, writes } = fixture();
    await card.noteVisibleWorkSessions(Array.from({ length: 6 }, (_, i) => ({
      sessionKey: `private-${i}`, label: `Worker ${i + 1}`, status: "running" as const,
    })));
    const initial = writes.at(-1)!.body;
    await card.noteVisibleWorkSessions([{ sessionKey: "private-5", status: "done" }]);
    const next = writes.at(-1)!.body;
    expect(writes).toHaveLength(2);
    expect(next.message).toBe(initial.message);
    expect(next.props.openclaw_task_progress.hidden_work_sessions).toBe(1);
    expect(next.props.openclaw_task_progress.work_session_counts).toEqual({
      queued: 0, running: 5, completed: 1, failed: 0, cancelled: 0,
    });
    expect(JSON.stringify(next)).not.toContain("private-5");
  });

  it("does not revive a terminal child from stale metadata, items, or earlier runs", async () => {
    const { card, writes } = fixture();
    await card.noteVisibleWorkSessions([{ sessionKey: "child", sessionId: "child-session",
      runId: "run-1", publicRead: true, label: "Review", status: "running" }]);
    card.noteAgentEvent({ sessionKey: "child", sessionId: "child-session", runId: "run-1", seq: 3, ts: 100,
      stream: "lifecycle", data: { phase: "end" } });
    await card.noteVisibleWorkSessions([{ sessionKey: "child", runId: "stale", status: "running" }]);
    card.noteAgentEvent({ sessionKey: "child", runId: "run-1", seq: 4,
      stream: "item", data: { kind: "tool", progressText: "Stale", status: "running" } });
    expect(writes.at(-1)!.body.props.openclaw_task_progress.work_sessions[0].status).toBe("completed");
    card.noteAgentEvent({ sessionKey: "child", sessionId: "foreign", runId: "run-2", ts: 200,
      stream: "lifecycle", data: { phase: "start" } });
    card.noteAgentEvent({ sessionKey: "child", sessionId: "child-session", runId: "run-2", ts: 200, seq: 1,
      stream: "lifecycle", data: { phase: "start" } });
    await vi.waitFor(() => expect(writes.at(-1)!.body.props.openclaw_task_progress.work_sessions[0].status).toBe("running"));
    card.noteAgentEvent({ sessionKey: "child", runId: "run-1", seq: 5, ts: 201,
      stream: "lifecycle", data: { phase: "end" } });
    await card.noteVisibleWorkSessions([{ sessionKey: "child", status: "running" }]);
    expect(writes.at(-1)!.body.props.openclaw_task_progress.work_sessions[0].status).toBe("running");
    expect(card.ownsChildActivity("run-1")).toBe(true);
    expect(card.ownsChildActivity("run-2")).toBe(true);
    expect(card.ownsChildActivity("unknown-task")).toBe(false);
    expect(card.ownsChildActivity("Review")).toBe(false);
  });

  it("does not publish private/suppressed child details, and yields can continue without a plan", async () => {
    const { card, writes } = fixture();
    card.noteRunStart("parent");
    await card.noteVisibleWorkSessions([{ sessionKey: "child", label: "Review", status: "running" }]);
    card.noteAgentEvent({ sessionKey: "child", runId: "child-run", stream: "tool",
      data: { name: "exec", meta: "private command", progressText: "private detail" } });
    card.noteAgentEvent({ runId: "parent", stream: "lifecycle",
      data: { phase: "end", yielded: true, livenessState: "paused", stopReason: "end_turn" } });
    await card.finish({ outcome: "completed" });
    expect(JSON.stringify(writes)).not.toContain("private detail");
    expect(card.canContinue()).toBe(true);
    expect(await card.beginContinuation("successor", () => true)).toBe(true);
    await card.updateContinuationPlan("successor", { source: "openclaw",
      steps: [{ step: "Report", status: "completed" }] }, () => true);
    expect(writes.at(-1)!.body.props.openclaw_mattermost.kind).toBe("task_progress");
    card.noteAgentEvent({ sessionKey: "child", runId: "child-run", stream: "lifecycle", data: { phase: "end" } });
    card.noteAgentEvent({ runId: "successor", stream: "lifecycle", data: { phase: "end" } });
    await card.finish({ outcome: "completed" });
    expect(writes.at(-1)!.body.message).toContain("· Completed");
  });

  it("keeps reasoning, assistant prose and suppressed items out of a publicly readable child row", async () => {
    const { card, writes } = fixture();
    await card.noteVisibleWorkSessions([{ sessionKey: "child", label: "Review",
      status: "running", publicRead: true }]);
    for (const data of [
      { kind: "reasoning", progressText: "Private reasoning" },
      { kind: "assistant", summary: "Child transcript prose" },
      { kind: "tool", progressText: "Hidden tool detail", hideFromChannelProgress: true },
      { kind: "tool", progressText: "Suppressed tool detail", suppressDurableProgress: true },
    ]) card.noteAgentEvent({ sessionKey: "child", runId: "child-run", stream: "item", data });
    await card.noteVisibleWorkSessions([{ sessionKey: "child", status: "running" }]);
    expect(writes).toHaveLength(1);
    card.noteAgentEvent({ sessionKey: "child", runId: "child-run", stream: "item",
      data: { kind: "tool", progressText: "Checking public API" } });
    await vi.waitFor(() => expect(writes.at(-1)!.body.message).toContain("Checking public API"));
    expect(JSON.stringify(writes)).not.toMatch(/Private reasoning|Child transcript prose|Hidden tool detail|Suppressed tool detail/);
    card.suppressChildToolProgress();
    await card.noteVisibleWorkSessions([{ sessionKey: "child", status: "running" }]);
    expect(writes.at(-1)!.body.message).not.toContain("Checking public API");
  });

  it("recovers only exact bot/route/source child projections and rejects foreign markers", () => {
    const source = "#### Task progress · In progress\n\n##### Subagents\n- [ ] Review · Queued";
    const post = {
      id: "card", user_id: "bot", channel_id: "channel", root_id: "root", create_at: 1,
      type: "custom_openclaw_task", message: "#### Task progress · In progress",
      props: { ...buildMattermostPostIdentityProps("subagent_progress", scope),
        openclaw_task_mobile: { version: 1, source_message: source },
        openclaw_task_progress: { version: 1, source_message: source } },
    };
    expect(restoreMattermostTaskMessage(post, "bot").message).toBe(source);
    const malformed = { ...post, props: { ...post.props,
      openclaw_mattermost: { ...post.props.openclaw_mattermost, kind: ["subagent_progress"] } } };
    expect(restoreMattermostTaskMessage(malformed, "bot").message).toBe(post.message);
    const lookup = (candidate: typeof post) => findMattermostRecoveryPostIdentity({
      ...scope, botUserId: "bot", posts: [candidate],
    });
    expect(lookup(post)?.taskPost.message).toBe(source);
    for (const candidate of [
      { ...post, user_id: "human" }, { ...post, root_id: "foreign" },
      { ...post, props: { ...post.props,
        openclaw_mattermost: { version: 1, kind: "forged", ...scope } } },
    ]) expect(lookup(candidate)).toBeUndefined();
  });
});
