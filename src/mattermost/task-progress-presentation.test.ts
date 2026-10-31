import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import { buildMattermostPostIdentityProps } from "./post-identity.js";
import { createMattermostTaskProgressCard } from "./task-progress-card.js";

describe("durable task-card presentation", () => {
  it.each(["completed", "failed", "cancelled"] as const)(
    "publishes matching Markdown and structured data through %s on the same post",
    async (outcome) => {
      const writes: Array<{ path: string; body: Record<string, any> }> = [];
      const client = {
        request: vi.fn(async (path, init) => {
          writes.push({ path, body: JSON.parse(String(init?.body)) });
          return { id: "task-card" };
        }),
      } as unknown as MattermostClient;
      const identity = buildMattermostPostIdentityProps("task_progress", {
        accountId: "default", agentId: "main", channelId: "channel", threadId: "root",
      });
      const card = createMattermostTaskProgressCard({
        client, channelId: "channel", rootId: "root", postProps: identity, log: vi.fn(),
      });
      await card.updatePlan({
        title: "Review PR #2081245",
        steps: [{ step: "Review PR diff", status: "in_progress" }],
      });
      await card.noteVisibleWorkSessions([{
        sessionKey: "private-internal-key", runId: "private-run",
        label: "Build simulator", url: "https://dev.example/session", status: "done",
      }]);
      await card.updatePlan({
        title: "Review PR #2081245",
        steps: [{ step: "Review PR diff", status: "completed" }],
      });
      await card.finish({ outcome });
      expect(writes[0].path).toBe("/posts");
      expect(writes.slice(1).every(({ path }) => path === "/posts/task-card/patch")).toBe(true);
      for (const { body } of writes) {
        expect(body.props.openclaw_mattermost).toEqual(identity.openclaw_mattermost);
        expect(body.props.openclaw_task_progress.source_message).toBe(body.message);
        expect(JSON.stringify(body.props)).not.toContain("private-internal-key");
        expect(JSON.stringify(body.props)).not.toContain("private-run");
      }
      expect(writes.at(-1)?.body.props.openclaw_task_progress).toMatchObject({
        version: 1, status: outcome, title: "Review PR #2081245",
        steps: [{ step: "Review PR diff", status: "completed" }],
        work_sessions: [{ label: "Build simulator", status: "completed" }],
      });
    },
  );

  it("replaces streamed result props when a late plan claims an existing post", async () => {
    const writes: Array<{ path: string; body: Record<string, any> }> = [];
    const client = {
      request: vi.fn(async (path, init) => {
        writes.push({ path, body: JSON.parse(String(init?.body)) });
        return { id: "older-result" };
      }),
    } as unknown as MattermostClient;
    const card = createMattermostTaskProgressCard({
      client, channelId: "channel",
      postProps: buildMattermostPostIdentityProps("task_progress", {
        accountId: "default", agentId: "main", channelId: "channel",
      }),
      claimResultPost: async () => "older-result", log: vi.fn(),
    });
    await card.settleBeforeResultPostCreate();
    await card.updatePlan({ steps: [{ step: "Inspect", status: "in_progress" }] });
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("/posts/older-result/patch");
    expect(writes[0].body.props.openclaw_task_progress.source_message).toBe(writes[0].body.message);
    expect(writes[0].body.props.openclaw_stream).toBeUndefined();
    expect(writes[0].body.props.openclaw_mattermost.kind).toBe("task_progress");
  });
});
