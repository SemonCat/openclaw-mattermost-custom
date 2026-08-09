import { describe, expect, it, vi } from "vitest";
import { resolveMattermostAccount } from "./accounts.js";
import { createMattermostClient } from "./client.js";
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
