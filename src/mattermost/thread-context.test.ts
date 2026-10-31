import { describe, expect, it, vi } from "vitest";
import { resolveMattermostAccount } from "./accounts.js";
import { createMattermostClient, fetchMattermostPost } from "./client.js";
import { hydrateMattermostPermalinks } from "./permalink-hydration.js";
import { createMattermostTestConfig, requestUrl } from "./reactions.test-helpers.js";
import {
  collectMattermostPermalinkReferences,
  fetchMattermostThreadContext,
  parseMattermostPermalinkReference,
  resolveMattermostThreadTarget,
} from "./thread-context.js";

const ROOT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const LINK_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const REPLY_ID = "cccccccccccccccccccccccccc";
const FILE_ID = "dddddddddddddddddddddddddd";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function createThreadFetch(params: { channelId: string; channelType: string }) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = requestUrl(input);
    if (url.endsWith(`/api/v4/posts/${LINK_ID}`)) {
      return jsonResponse({
        id: LINK_ID,
        root_id: ROOT_ID,
        channel_id: params.channelId,
        user_id: "user-2",
        message: "linked reply",
        create_at: 2_000,
        file_ids: [FILE_ID],
      });
    }
    if (url.endsWith(`/api/v4/channels/${params.channelId}`)) {
      return jsonResponse({
        id: params.channelId,
        type: params.channelType,
        name: "target",
        display_name: "Target",
      });
    }
    if (url.includes(`/api/v4/posts/${ROOT_ID}/thread?perPage=`)) {
      return jsonResponse({
        order: [ROOT_ID, LINK_ID, REPLY_ID],
        posts: {
          [ROOT_ID]: {
            id: ROOT_ID,
            channel_id: params.channelId,
            user_id: "user-1",
            message: "root text",
            create_at: 1_000,
          },
          [LINK_ID]: {
            id: LINK_ID,
            root_id: ROOT_ID,
            channel_id: params.channelId,
            user_id: "user-2",
            message: "linked reply",
            create_at: 2_000,
            file_ids: [FILE_ID],
          },
          [REPLY_ID]: {
            id: REPLY_ID,
            root_id: ROOT_ID,
            channel_id: params.channelId,
            user_id: "user-1",
            message: "later reply",
            create_at: 3_000,
          },
        },
      });
    }
    if (url.endsWith("/api/v4/users/ids")) {
      expect(init?.method).toBe("POST");
      return jsonResponse([
        { id: "user-1", username: "alice", first_name: "Alice" },
        { id: "user-2", username: "bob", nickname: "Bobby" },
      ]);
    }
    if (url.endsWith(`/api/v4/files/${FILE_ID}/info`)) {
      return jsonResponse({
        id: FILE_ID,
        name: "report.pdf",
        mime_type: "application/pdf",
        size: 1234,
      });
    }
    throw new Error(`Unexpected Mattermost request: ${url}`);
  });
}

describe("Mattermost permalink parsing", () => {
  it("accepts only same-instance permalinks and deduplicates preview metadata", () => {
    const baseUrl = "https://chat.example.com";
    expect(
      parseMattermostPermalinkReference({
        value: `https://chat.example.com/team/pl/${LINK_ID}`,
        baseUrl,
      }),
    ).toBe(LINK_ID);
    expect(
      parseMattermostPermalinkReference({
        value: `https://evil.example.com/team/pl/${LINK_ID}`,
        baseUrl,
      }),
    ).toBeUndefined();
    expect(
      collectMattermostPermalinkReferences({
        text: `see https://chat.example.com/team/pl/${LINK_ID}.`,
        props: { previewed_post: LINK_ID },
        baseUrl,
      }),
    ).toEqual([LINK_ID]);
  });

  it("accepts explicitly allowed public origins without trusting lookalike hosts", () => {
    const baseUrl = "http://192.168.31.177:8065";
    const allowedOrigins = ["https://mattermost.example.com"];

    expect(
      parseMattermostPermalinkReference({
        value: `https://mattermost.example.com/team/pl/${LINK_ID}`,
        baseUrl,
        allowedOrigins,
      }),
    ).toBe(LINK_ID);
    expect(
      parseMattermostPermalinkReference({
        value: `https://mattermost.example.com.evil.test/team/pl/${LINK_ID}`,
        baseUrl,
        allowedOrigins,
      }),
    ).toBeUndefined();
  });
});

describe("projected task thread context", () => {
  const source = "#### Task progress · In progress\nReview PR\n\n- [x] Read diff\n- [ ] Run tests\nSubtask checkpoint";
  function fixture(options: {failMe?: boolean; projected?: boolean; source?: string} = {}) {
    const cfg = createMattermostTestConfig("projected-thread");
    const account = resolveMattermostAccount({cfg});
    const channel_id = "CURRENT";
    const projection = (id: string, user_id: string, canonical: string) => ({
      id, user_id, channel_id, root_id: ROOT_ID, type: "custom_openclaw_task",
      message: "#### Task progress · In progress", create_at: 2_000,
      props: {
        openclaw_mattermost: {version: 1, kind: "task_progress", channelId: channel_id, threadId: ROOT_ID},
        openclaw_task_progress: {version: 1, source_message: canonical},
        openclaw_task_mobile: {version: 1, source_message: canonical},
      },
    });
    const posts = {
      [ROOT_ID]: {id: ROOT_ID, user_id: "human", channel_id, message: "Root text", create_at: 1_000},
      [LINK_ID]: projection(LINK_ID, "our-bot", options.source ?? source),
      [REPLY_ID]: projection(REPLY_ID, "human", source + "\nHidden human forgery"),
      [FILE_ID]: projection(FILE_ID, "foreign-bot", source + "\nHidden foreign bot forgery"),
    };
    if (options.projected === false) {
      for (const post of [posts[LINK_ID], posts[REPLY_ID], posts[FILE_ID]]) {
        delete (post.props as Record<string, unknown>).openclaw_task_mobile;
      }
    }
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/users/me")) {
        if (options.failMe) throw new Error("Self lookup unavailable");
        return jsonResponse({id: "our-bot"});
      }
      if (url.endsWith(`/posts/${LINK_ID}`)) return jsonResponse(posts[LINK_ID]);
      if (url.endsWith(`/channels/${channel_id}`)) return jsonResponse({id: channel_id, type: "O"});
      if (url.includes(`/posts/${ROOT_ID}/thread?`)) {
        return jsonResponse({order: Object.keys(posts), posts});
      }
      if (url.endsWith("/users/ids")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = createMattermostClient({baseUrl: account.baseUrl!, botToken: account.botToken!, fetchImpl});
    const selfLookups = () => fetchImpl.mock.calls.filter(([input]) => requestUrl(input).endsWith("/users/me")).length;
    return {cfg, account, client, selfLookups};
  }

  it("restores only the authenticated author's full plan/subtasks in thread and permalink text", async () => {
    const {cfg, account, client, selfLookups} = fixture();
    expect((await fetchMattermostPost(client, LINK_ID)).message).toBe("#### Task progress · In progress");
    const target = await resolveMattermostThreadTarget({client, postId: LINK_ID});
    const context = await fetchMattermostThreadContext({client, target});
    expect(context.posts.find((post) => post.id === LINK_ID)?.message).toBe(source);
    expect(context.posts.filter((post) => post.author.id !== "our-bot").map((post) => post.message).join("\n"))
      .not.toMatch(/Hidden human|Hidden foreign|Subtask checkpoint/);
    expect(selfLookups()).toBe(1);
    const hydrated = await hydrateMattermostPermalinks({
      cfg, account, client, currentChannelId: "CURRENT", text: `${account.baseUrl}/pl/${LINK_ID}`,
    });
    expect(hydrated).toContain("- [ ] Run tests\nSubtask checkpoint");
    expect(hydrated).not.toMatch(/Hidden human|Hidden foreign/);
    expect(selfLookups()).toBe(2);
  });

  it("keeps visible text on self lookup failure and skips the lookup for ordinary posts", async () => {
    for (const options of [{failMe: true}, {projected: false}]) {
      const {client, selfLookups} = fixture(options);
      const target = await resolveMattermostThreadTarget({client, postId: LINK_ID});
      const context = await fetchMattermostThreadContext({client, target});
      expect(context.posts.find((post) => post.id === LINK_ID)?.message).toBe("#### Task progress · In progress");
      expect(context.posts.map((post) => post.message).join("\n")).not.toContain("Subtask checkpoint");
      expect(selfLookups()).toBe(options.failMe ? 1 : 0);
    }
  });

  it("applies the existing character budget after canonical restoration", async () => {
    const {client} = fixture({source: source + "x".repeat(51_000)});
    const target = await resolveMattermostThreadTarget({client, postId: LINK_ID});
    const context = await fetchMattermostThreadContext({client, target});
    expect(context.posts.find((post) => post.id === LINK_ID)?.messageTruncated).toBe(true);
    expect(context.posts.reduce((count, post) => count + post.message.length, 0)).toBe(50_000);
    expect(context.truncated).toBe(true);
  });
});

describe("Mattermost thread context", () => {
  it("returns bounded posts with authors, attachment metadata, and untrusted marking", async () => {
    const baseUrl = "https://chat.example.com";
    const fetchImpl = createThreadFetch({ channelId: "CURRENT", channelType: "P" });
    const client = createMattermostClient({ baseUrl, botToken: "token", fetchImpl });
    const target = await resolveMattermostThreadTarget({ client, postId: LINK_ID });

    const result = await fetchMattermostThreadContext({ client, target, limit: 50 });

    expect(result).toMatchObject({
      untrusted: true,
      requestedPostId: LINK_ID,
      rootPostId: ROOT_ID,
      channel: { id: "CURRENT", type: "P" },
      posts: [
        { id: ROOT_ID, author: { username: "alice" }, message: "root text" },
        {
          id: LINK_ID,
          author: { username: "bob", displayName: "Bobby" },
          attachments: [{ id: FILE_ID, name: "report.pdf", mimeType: "application/pdf" }],
        },
        { id: REPLY_ID, author: { username: "alice" }, message: "later reply" },
      ],
    });
  });

  it("hydrates the current private channel but denies a different private channel before thread fetch", async () => {
    const cfg = createMattermostTestConfig("thread-hydration");
    const account = resolveMattermostAccount({ cfg });
    const baseUrl = account.baseUrl!;

    const currentFetch = createThreadFetch({ channelId: "CURRENT", channelType: "P" });
    const currentClient = createMattermostClient({
      baseUrl,
      botToken: account.botToken!,
      fetchImpl: currentFetch,
    });
    await expect(
      hydrateMattermostPermalinks({
        cfg,
        account,
        client: currentClient,
        currentChannelId: "CURRENT",
        text: `${baseUrl}/team/pl/${LINK_ID}`,
      }),
    ).resolves.toContain("[Begin untrusted Mattermost thread context]");

    const privateFetch = createThreadFetch({ channelId: "PRIVATE", channelType: "P" });
    const privateClient = createMattermostClient({
      baseUrl,
      botToken: account.botToken!,
      fetchImpl: privateFetch,
    });
    await expect(
      hydrateMattermostPermalinks({
        cfg,
        account,
        client: privateClient,
        currentChannelId: "CURRENT",
        text: `${baseUrl}/team/pl/${LINK_ID}`,
      }),
    ).resolves.toBe("");
    expect(privateFetch.mock.calls.some(([input]) => requestUrl(input).includes("/thread?"))).toBe(
      false,
    );
  });

  it("hydrates a configured public cross-channel target", async () => {
    const cfg = createMattermostTestConfig("thread-public");
    cfg.channels!.mattermost!.groupPolicy = "allowlist";
    cfg.channels!.mattermost!.groups = { PUBLIC: { requireMention: false } };
    const account = resolveMattermostAccount({ cfg });
    const baseUrl = account.baseUrl!;
    const fetchImpl = createThreadFetch({ channelId: "PUBLIC", channelType: "O" });
    const client = createMattermostClient({
      baseUrl,
      botToken: account.botToken!,
      fetchImpl,
    });

    await expect(
      hydrateMattermostPermalinks({
        cfg,
        account,
        client,
        currentChannelId: "CURRENT",
        text: `${baseUrl}/team/pl/${LINK_ID}`,
      }),
    ).resolves.toContain("Channel: Target (PUBLIC)");
  });
});
