import { describe, expect, it, vi } from "vitest";
import type { MattermostClient, MattermostPost } from "./client.js";
import {
  buildMattermostPostIdentityProps,
  findMattermostRecoveryPostIdentity,
  hydrateMattermostRecoveryPostIdentity,
  renderMattermostRecoveredTaskTerminal,
} from "./post-identity.js";

const SCOPE = {
  accountId: "default",
  agentId: "main",
  channelId: "channel-1",
  threadId: "thread-root",
};

function post(params: Partial<MattermostPost> & Pick<MattermostPost, "id">): MattermostPost {
  return {
    channel_id: "channel-1",
    root_id: "thread-root",
    user_id: "bot-user",
    create_at: 1,
    message: "",
    ...params,
  };
}

describe("Mattermost durable post identity", () => {
  it("prefers tagged in-progress task and result posts for the exact session", () => {
    const taskProps = buildMattermostPostIdentityProps("task_progress", SCOPE);
    const resultProps = buildMattermostPostIdentityProps("turn_result", SCOPE);
    const identity = findMattermostRecoveryPostIdentity({
      botUserId: "bot-user",
      channelId: "channel-1",
      threadId: "thread-root",
      accountId: "default",
      agentId: "main",
      posts: [
        post({
          id: "completed-card",
          create_at: 10,
          message: "#### Task progress · Completed\n\n- [x] Old",
          props: taskProps,
        }),
        post({
          id: "active-card",
          create_at: 20,
          message: "#### Task progress · In progress\n\n- [ ] **Work**",
          props: taskProps,
        }),
        post({
          id: "other-session-result",
          create_at: 25,
          message: "Wrong",
          props: buildMattermostPostIdentityProps("turn_result", {
            ...SCOPE,
            agentId: "other",
          }),
        }),
        post({
          id: "active-result",
          create_at: 30,
          message: "Running tool",
          props: resultProps,
        }),
      ],
    });

    expect(identity).toEqual({
      taskPost: expect.objectContaining({ id: "active-card" }),
      resultPost: expect.objectContaining({ id: "active-result" }),
      source: "metadata",
    });
  });

  it("uses a bounded legacy renderer fallback only inside the exact route", () => {
    const identity = findMattermostRecoveryPostIdentity({
      botUserId: "bot-user",
      channelId: "channel-1",
      threadId: "thread-root",
      accountId: "default",
      agentId: "main",
      posts: [
        post({
          id: "legacy-card",
          create_at: 10,
          message:
            "### Task progress\n**Status:** 🔄 In progress\n\n**Plan updated**\n\n✅ Inspect\n▸ Patch",
        }),
        post({ id: "legacy-result", create_at: 20, message: "Executing patch" }),
        post({
          id: "wrong-thread",
          root_id: "another-root",
          create_at: 30,
          message: "Executing elsewhere",
        }),
      ],
    });

    expect(identity).toEqual({
      taskPost: expect.objectContaining({ id: "legacy-card" }),
      resultPost: expect.objectContaining({ id: "legacy-result" }),
      source: "legacy",
    });
  });

  it("contains Mattermost lookup failures and emits one diagnostic", async () => {
    const log = vi.fn();
    const client = {
      request: vi.fn(async () => {
        throw new Error("Mattermost unavailable");
      }),
    } as unknown as MattermostClient;

    await expect(
      hydrateMattermostRecoveryPostIdentity({
        client,
        botUserId: "bot-user",
        channelId: "channel-1",
        threadId: "thread-root",
        accountId: "default",
        agentId: "main",
        log,
      }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).toContain("identity hydration failed");
  });

  it.each([
    { status: "completed" as const, label: "Completed" },
    { status: "failed" as const, label: "Failed" },
    { status: "cancelled" as const, label: "Cancelled" },
  ])("converts compact and legacy cards to truthful $status state", ({ status, label }) => {
    const compact = renderMattermostRecoveredTaskTerminal(
      "#### Task progress · In progress\nDeploy\n\n- [x] Inspect\n- [ ] **Test**",
      status,
    );
    const legacy = renderMattermostRecoveredTaskTerminal(
      "### Task progress\n**Status:** 🔄 In progress\n\n**Plan updated**\n\n✅ Inspect\n▸ Test",
      status,
    );

    expect(compact).toContain(`#### Task progress · ${label}`);
    expect(compact).toContain("- [ ] **Test**");
    expect(legacy).toContain(`#### Task progress · ${label}`);
    expect(legacy).not.toContain("Status:");
    expect(legacy).not.toContain("Plan updated");
  });
});
