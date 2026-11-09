import { describe, expect, it, vi } from "vitest";
import { deliverMattermostReplyPayload } from "./reply-delivery.js";
import { mattermostWorkDetailsProps } from "./work-details.js";
import { restoreMattermostTaskMessage } from "./task-progress-projection.js";
import { createMattermostDraftStream } from "./draft-stream.js";
import type { MattermostClient } from "./client.js";

describe("work details presentation", () => {
  it("falls back to the complete final when a same-text sealed-prefix promotion is rejected", async () => {
    const posts = new Map<string, Record<string, unknown>>();
    let rejectPromotion = false;
    const client = {
      baseUrl: "https://work-details.example", token: "fixture",
      request: async (path: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (path === "/posts") {
          const post = {id: `post-${posts.size + 1}`, ...body};
          posts.set(post.id, post);
          return post;
        }
        const post = posts.get(path.split("/")[2]!);
        if (init?.method === "PUT") {
          if (rejectPromotion) throw new Error("unaccepted same-text promotion");
          Object.assign(post!, body);
        }
        return {...post};
      },
    } as unknown as MattermostClient;
    const stream = createMattermostDraftStream({
      client, channelId: "channel", workDetails: true,
      postProps: {openclaw_mattermost: {version: 1, kind: "turn_result", channelId: "channel"}},
    });
    stream.updateAssistantText("First block");
    await stream.flush();
    await stream.forceNewMessage();
    stream.updateAssistantText("Second block");
    await stream.flush();
    const final = "First block\n\nSecond block";
    expect(stream.resolveFinalText(final).kind).toBe("remaining");
    rejectPromotion = true;
    await expect(stream.promoteFinalParts(final)).resolves.toBeUndefined();
    expect(stream.resolveFinalText(final)).toMatchObject({kind: "full", text: final});
    expect(posts.get("post-1")?.props).toHaveProperty("openclaw_work_details");
    await stream.stop();
  });
  it("leaves large Unicode Markdown intact rather than emitting over-budget native details", () => {
    const source = "界".repeat(5000);
    expect(mattermostWorkDetailsProps(source)).toMatchObject({source_message: source});
    expect(mattermostWorkDetailsProps(source + "界")).toBeUndefined();
  });

  it("restores projected work text only for our bot in the admitted route", () => {
    const details = {version: 1, source_message: "Already publishable commentary"};
    const post = {
      id: "preview", user_id: "bot", type: "custom_openclaw_stream",
      channel_id: "channel", root_id: "thread", message: "Work details",
      props: {
        openclaw_mattermost: {version: 1, kind: "turn_result", channelId: "channel", threadId: "thread"},
        openclaw_work_details: details, openclaw_work_projection: details,
      },
    };
    expect(restoreMattermostTaskMessage(post, "bot").message).toBe(details.source_message);
    for (const changed of [
      {...post, user_id: "human"}, {...post, root_id: "other"}, {...post, message: "Edited answer"},
      {...post, props: {...post.props, openclaw_work_projection: {...details, source_message: "Stale"}}},
    ]) {
      expect(restoreMattermostTaskMessage(changed, "bot")).toBe(changed);
    }
  });

  it.each([
    {payload: {text: "Public commentary", isCommentary: true}, work: false, collapsed: true},
    {payload: {text: "Enabled tool summary"}, work: true, collapsed: true},
    {payload: {text: "Final answer"}, work: false, collapsed: false},
    {payload: {text: "Hidden reasoning", isReasoning: true}, work: true, collapsed: false, skipped: true},
  ])("classifies existing public delivery: $payload.text", async ({payload, work, collapsed, skipped}) => {
    const send = vi.fn(async (_target, text) => ({
      messageId: "post", channelId: "channel", content: text,
    }));
    const result = await deliverMattermostReplyPayload({
      core: {channel: {text: {
        convertMarkdownTables: (text: string) => text,
        resolveChunkMode: () => "length",
        chunkMarkdownTextWithMode: (text: string) => [text],
      }}} as never,
      cfg: {}, payload, workDetails: work, channelId: "channel", accountId: "default",
      agentId: "main", replyToId: "thread", textLimit: 16383, tableMode: "off",
      sendMessage: send as never,
    });
    if (skipped) {
      expect(send).not.toHaveBeenCalled();
      expect(result.outcome).toBe("reasoning_skipped");
      return;
    }
    const options = (send.mock.calls[0] as unknown as [string, string, {workDetails?: boolean; props?: unknown}])[2];
    expect(options.workDetails === true).toBe(collapsed);
    if (collapsed) {
      expect(options.props).toMatchObject({openclaw_mattermost: {
        kind: "turn_result", channelId: "channel", threadId: "thread",
      }});
    }
    expect(result.visibleReplySent).toBe(true);
    expect(result.content).toBe(payload.text);
  });
});
