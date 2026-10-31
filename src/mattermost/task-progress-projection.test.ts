import { describe, expect, it } from "vitest";
import {
  createMattermostClient, fetchMattermostPost, updateMattermostPost,
} from "./client.js";
import { hydrateMattermostRecoveryPostIdentity, renderMattermostRecoveredTaskTerminal } from "./post-identity.js";
import { restoreMattermostTaskMessage } from "./task-progress-projection.js";

const source = "#### Task progress · In progress\nReview PR\n\n- [x] Read diff\n- [ ] Run tests";
const projected = () => ({
  id: "task", user_id: "bot", channel_id: "channel", root_id: "root",
  type: "custom_openclaw_task", message: "#### Task progress · In progress",
  props: {
    openclaw_mattermost: {version: 1, kind: "task_progress", channelId: "channel",
      threadId: "root", accountId: "default", agentId: "main"},
    openclaw_task_mobile: {version: 1, source_message: source},
    openclaw_task_progress: {version: 1, source_message: source},
  },
});

describe("trusted task projection recovery", () => {
  it("keeps generic reads visible and restores our bot only after route admission", async () => {
    const post = projected();
    let written: {message: string} | undefined;
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065", botToken: "fixture",
      fetchImpl: async (url, init) => {
        if (init?.method === "PUT") {
          written = JSON.parse(String(init.body));
          return Response.json({...post, message: written!.message});
        }
        return Response.json(String(url).includes("/channels/")
          ? {order: ["task"], posts: {task: post}} : post);
      },
    });
    expect((await fetchMattermostPost(client, "task")).message).toBe(post.message);
    const recovered = await hydrateMattermostRecoveryPostIdentity({
      client, botUserId: "bot", channelId: "channel", threadId: "root",
      accountId: "default", agentId: "main", log: () => {},
    });
    expect(recovered?.taskPost.message).toBe(source);
    const terminal = renderMattermostRecoveredTaskTerminal(recovered?.taskPost.message, "completed");
    expect(terminal).toBe(source.replace("In progress", "Incomplete"));
    await updateMattermostPost(client, "task", {message: terminal});
    expect(written?.message).toContain("- [ ] Run tests");
    expect(written?.message).toContain("· Incomplete");
  });

  it("does not restore forged human or foreign-bot text", async () => {
    for (const user_id of ["human", "foreign-bot"]) {
      const post = {...projected(), user_id};
      expect(restoreMattermostTaskMessage(post, "bot")).toBe(post);
      const client = createMattermostClient({
        baseUrl: "http://localhost:8065", botToken: "fixture",
        fetchImpl: async () => Response.json({order: ["task"], posts: {task: post}}),
      });
      expect(await hydrateMattermostRecoveryPostIdentity({
        client, botUserId: "bot", channelId: "channel", threadId: "root",
        accountId: "default", agentId: "main", log: () => {},
      })).toBeUndefined();
    }
  });

  it("rejects stale markers, foreign routes and text edits; preserves terminal headings", () => {
    const post = projected();
    for (const mutate of [
      (p: ReturnType<typeof projected>) => {p.message += "\nUser edit";},
      (p: ReturnType<typeof projected>) => {p.root_id = "foreign";},
      (p: ReturnType<typeof projected>) => {p.props.openclaw_task_mobile.version = 2;},
      (p: ReturnType<typeof projected>) => {p.props.openclaw_task_mobile.source_message += "\nStale";},
    ]) {
      const input = structuredClone(post);
      mutate(input);
      expect(restoreMattermostTaskMessage(input, "bot")).toBe(input);
    }
    for (const status of ["Completed", "Incomplete", "Failed", "Cancelled"]) {
      const input = structuredClone(post);
      input.message = `#### Task progress · ${status}`;
      input.props.openclaw_task_mobile.source_message = source.replace("In progress", status);
      expect(restoreMattermostTaskMessage(input, "bot").message).toBe(source.replace("In progress", status));
    }
  });
});
