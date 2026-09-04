import type {
  OpenClawPluginApi,
  PluginCommandContext,
} from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import type { MattermostClient, MattermostPost } from "./client.js";
import {
  createMattermostMoveThreadCommand,
  moveMattermostThread,
  type MattermostThreadMoveDependencies,
} from "./thread-move-command.js";

const SOURCE_CHANNEL = "s".repeat(26);
const DESTINATION_CHANNEL = "d".repeat(26);
const ROOT_POST = "a".repeat(26);
const REPLY_POST = "b".repeat(26);
const LATE_REPLY_POST = "c".repeat(26);
const DESTINATION_ROOT = "r".repeat(26);
const DESTINATION_REPLY = "q".repeat(26);
const SOURCE_FILE = "f".repeat(26);
const DESTINATION_FILE = "g".repeat(26);

const client = {
  baseUrl: "https://mattermost.example.com",
  apiBaseUrl: "https://mattermost.example.com/api/v4",
  token: "test-token",
  request: vi.fn(),
  fetchImpl: vi.fn(),
} as unknown as MattermostClient;

function sourcePosts(): MattermostPost[] {
  return [
    {
      id: ROOT_POST,
      channel_id: SOURCE_CHANNEL,
      user_id: "user-root",
      message: "root text",
      file_ids: [SOURCE_FILE],
      create_at: 1,
      update_at: 1,
    },
    {
      id: REPLY_POST,
      channel_id: SOURCE_CHANNEL,
      root_id: ROOT_POST,
      user_id: "user-reply",
      message: "reply text",
      file_ids: [],
      create_at: 2,
      update_at: 2,
    },
  ];
}

function createHarness() {
  const events: string[] = [];
  const created = new Map<string, MattermostPost>();
  let threadReadCount = 0;
  let noticeCount = 0;
  const dependencies = {
    createClient: vi.fn(() => client),
    createPost: vi.fn(async (_client, params) => {
      const marker = params.props?.openclaw_mattermost_move as
        | Record<string, unknown>
        | undefined;
      if (marker) {
        const sourcePostId = String(marker.source_post_id);
        const id = sourcePostId === ROOT_POST ? DESTINATION_ROOT : DESTINATION_REPLY;
        events.push(`create:${sourcePostId}`);
        const post: MattermostPost = {
          id,
          channel_id: params.channelId,
          message: params.message,
          root_id: params.rootId,
          file_ids: params.fileIds ?? [],
          props: params.props,
        };
        created.set(id, post);
        return post;
      }
      noticeCount += 1;
      events.push(`notice:${params.channelId}`);
      return { id: `notice-${noticeCount}`, channel_id: params.channelId };
    }),
    deletePost: vi.fn(async (_client, postId) => {
      events.push(`delete:${postId}`);
    }),
    downloadFile: vi.fn(async () => {
      events.push(`download:${SOURCE_FILE}`);
      return {
        info: { id: SOURCE_FILE, name: "report.txt", mime_type: "text/plain", size: 4 },
        buffer: Buffer.from("file"),
        contentType: "text/plain",
      };
    }),
    fetchChannel: vi.fn(async (_client, channelId) => {
      events.push(`channel:${channelId}`);
      return channelId === SOURCE_CHANNEL
        ? { id: SOURCE_CHANNEL, name: "source", display_name: "Source", type: "O" }
        : {
            id: DESTINATION_CHANNEL,
            name: "destination",
            display_name: "Destination",
            type: "O",
          };
    }),
    fetchChannelByName: vi.fn(),
    fetchMe: vi.fn(),
    fetchPost: vi.fn(async (_client, postId) => {
      events.push(`read:${postId}`);
      const post = created.get(postId);
      if (!post) {
        throw new Error(`unexpected post read ${postId}`);
      }
      return post;
    }),
    fetchThread: vi.fn(async () => {
      threadReadCount += 1;
      events.push(`thread:${threadReadCount}`);
      return { messages: sourcePosts(), hasMore: false };
    }),
    fetchUserTeams: vi.fn(),
    uploadFile: vi.fn(async () => {
      events.push(`upload:${SOURCE_FILE}`);
      return { id: DESTINATION_FILE, name: "report.txt" };
    }),
    operationId: () => "operation-1",
  } satisfies MattermostThreadMoveDependencies;
  return { dependencies, events, created };
}

async function runMove(
  dependencies: MattermostThreadMoveDependencies,
  rawDestination = `channel:${DESTINATION_CHANNEL}`,
) {
  return await moveMattermostThread({
    client,
    sourceChannelId: SOURCE_CHANNEL,
    sourceRootId: ROOT_POST,
    rawDestination,
    fileMaxBytes: 1024,
    baseUrl: client.baseUrl,
    dependencies,
  });
}

describe("Mattermost verified thread move", () => {
  it("copies and reads back every post before rechecking and deleting the source root", async () => {
    const { dependencies, events } = createHarness();

    await expect(runMove(dependencies)).resolves.toMatchObject({
      status: "moved",
      sourceRootId: ROOT_POST,
      destinationRootId: DESTINATION_ROOT,
      destinationChannelId: DESTINATION_CHANNEL,
      postCount: 2,
      fileCount: 1,
    });

    expect(events).toEqual([
      `channel:${SOURCE_CHANNEL}`,
      `channel:${DESTINATION_CHANNEL}`,
      "thread:1",
      `download:${SOURCE_FILE}`,
      `upload:${SOURCE_FILE}`,
      `create:${ROOT_POST}`,
      `read:${DESTINATION_ROOT}`,
      `create:${REPLY_POST}`,
      `read:${DESTINATION_REPLY}`,
      "thread:2",
      `delete:${ROOT_POST}`,
      `notice:${DESTINATION_CHANNEL}`,
      `notice:${SOURCE_CHANNEL}`,
    ]);
    expect(dependencies.createPost).toHaveBeenNthCalledWith(
      1,
      client,
      expect.objectContaining({
        channelId: DESTINATION_CHANNEL,
        message: "root text",
        fileIds: [DESTINATION_FILE],
        rootId: undefined,
      }),
    );
    expect(dependencies.createPost).toHaveBeenNthCalledWith(
      2,
      client,
      expect.objectContaining({
        channelId: DESTINATION_CHANNEL,
        message: "reply text",
        fileIds: [],
        rootId: DESTINATION_ROOT,
      }),
    );
  });

  it("resolves a #channel destination across the bot's Mattermost teams", async () => {
    const { dependencies } = createHarness();
    dependencies.fetchMe.mockResolvedValue({ id: "bot-user" });
    dependencies.fetchUserTeams.mockResolvedValue([{ id: "team-1", name: "love" }]);
    dependencies.fetchChannelByName.mockResolvedValue({
      id: DESTINATION_CHANNEL,
      name: "destination",
      display_name: "Destination",
      type: "O",
    });

    await expect(runMove(dependencies, "#destination")).resolves.toMatchObject({
      status: "moved",
      destinationChannelId: DESTINATION_CHANNEL,
    });
    expect(dependencies.fetchChannelByName).toHaveBeenCalledWith(
      client,
      "team-1",
      "destination",
    );
  });

  it("keeps the source and removes the incomplete copy when read-back verification fails", async () => {
    const { dependencies, events, created } = createHarness();
    dependencies.fetchPost.mockImplementation(async (_client, postId) => {
      events.push(`read:${postId}`);
      const post = created.get(postId);
      if (!post) {
        throw new Error("missing copied post");
      }
      return { ...post, message: "corrupted" };
    });

    await expect(runMove(dependencies)).rejects.toThrow("failed read-back verification");
    expect(events).toContain(`delete:${DESTINATION_ROOT}`);
    expect(events).not.toContain(`delete:${ROOT_POST}`);
  });

  it("does not delete a source that changes after the copy snapshot", async () => {
    const { dependencies, events } = createHarness();
    dependencies.fetchThread
      .mockResolvedValueOnce({ messages: sourcePosts(), hasMore: false })
      .mockResolvedValueOnce({
        messages: [
          ...sourcePosts(),
          {
            id: LATE_REPLY_POST,
            channel_id: SOURCE_CHANNEL,
            root_id: ROOT_POST,
            message: "late reply",
            create_at: 3,
          },
        ],
        hasMore: false,
      });

    await expect(runMove(dependencies)).rejects.toThrow("Source thread changed");
    expect(events).toContain(`delete:${DESTINATION_ROOT}`);
    expect(events).not.toContain(`delete:${ROOT_POST}`);
  });

  it("rolls back the verified copy when source deletion is known to have failed", async () => {
    const { dependencies, events } = createHarness();
    dependencies.deletePost.mockImplementation(async (_client, postId) => {
      events.push(`delete:${postId}`);
      if (postId === ROOT_POST) {
        throw new Error("delete denied");
      }
    });
    dependencies.fetchPost.mockImplementation(async (_client, postId) => {
      events.push(`read:${postId}`);
      if (postId === ROOT_POST) {
        return sourcePosts()[0] as MattermostPost;
      }
      return (
        postId === DESTINATION_ROOT
          ? {
              id: DESTINATION_ROOT,
              channel_id: DESTINATION_CHANNEL,
              message: "root text",
              file_ids: [DESTINATION_FILE],
              props: {
                openclaw_mattermost_move: {
                  operation_id: "operation-1",
                  source_post_id: ROOT_POST,
                },
              },
            }
          : {
              id: DESTINATION_REPLY,
              channel_id: DESTINATION_CHANNEL,
              root_id: DESTINATION_ROOT,
              message: "reply text",
              file_ids: [],
              props: {
                openclaw_mattermost_move: {
                  operation_id: "operation-1",
                  source_post_id: REPLY_POST,
                },
              },
            }
      ) as MattermostPost;
    });

    await expect(runMove(dependencies)).rejects.toThrow("source could not be deleted");
    expect(events.slice(-3)).toEqual([
      `delete:${ROOT_POST}`,
      `read:${ROOT_POST}`,
      `delete:${DESTINATION_ROOT}`,
    ]);
  });

  it("keeps the verified copy and reports an unknown terminal state when delete read-back fails", async () => {
    const { dependencies, events, created } = createHarness();
    dependencies.deletePost.mockImplementation(async (_client, postId) => {
      events.push(`delete:${postId}`);
      if (postId === ROOT_POST) {
        throw new Error("connection reset");
      }
    });
    dependencies.fetchPost.mockImplementation(async (_client, postId) => {
      events.push(`read:${postId}`);
      if (postId === ROOT_POST) {
        throw new Error("read-back unavailable");
      }
      const post = created.get(postId);
      if (!post) {
        throw new Error("missing copied post");
      }
      return post;
    });

    await expect(runMove(dependencies)).resolves.toMatchObject({
      status: "source-delete-unknown",
      destinationRootId: DESTINATION_ROOT,
    });
    expect(events).not.toContain(`delete:${DESTINATION_ROOT}`);
    expect(events).toContain(`notice:${DESTINATION_CHANNEL}`);
  });

  it("exposes an owner-only command and rejects calls outside a Mattermost thread", async () => {
    const { dependencies } = createHarness();
    const command = createMattermostMoveThreadCommand(
      { logger: { warn: vi.fn() } } as unknown as OpenClawPluginApi,
      dependencies,
    );
    const baseContext = {
      channel: "mattermost",
      commandBody: "/move_thread #destination",
      args: "#destination",
      config: { channels: { mattermost: {} } },
      isAuthorizedSender: true,
      requestConversationBinding: vi.fn(),
      detachConversationBinding: vi.fn(),
      getCurrentConversationBinding: vi.fn(),
    } as unknown as PluginCommandContext;

    await expect(command.handler({ ...baseContext, senderIsOwner: false })).resolves.toMatchObject({
      isError: true,
      text: expect.stringContaining("Only an OpenClaw owner"),
    });
    await expect(command.handler({ ...baseContext, senderIsOwner: true })).resolves.toMatchObject({
      isError: true,
      text: expect.stringContaining("inside the thread"),
    });
    expect(dependencies.createClient).not.toHaveBeenCalled();
  });

  it("suppresses the command reply after a verified move deletes its source thread", async () => {
    const { dependencies } = createHarness();
    const command = createMattermostMoveThreadCommand(
      { logger: { warn: vi.fn() } } as unknown as OpenClawPluginApi,
      dependencies,
    );

    await expect(
      command.handler({
        channel: "mattermost",
        commandBody: "/move_thread #destination",
        args: `channel:${DESTINATION_CHANNEL}`,
        config: {
          channels: {
            mattermost: {
              baseUrl: client.baseUrl,
              botToken: "test-token",
            },
          },
        },
        isAuthorizedSender: true,
        senderIsOwner: true,
        to: `channel:${SOURCE_CHANNEL}`,
        messageThreadId: ROOT_POST,
        requestConversationBinding: vi.fn(),
        detachConversationBinding: vi.fn(),
        getCurrentConversationBinding: vi.fn(),
      } as unknown as PluginCommandContext),
    ).resolves.toEqual({ suppressReply: true });
    expect(dependencies.deletePost).toHaveBeenCalledWith(client, ROOT_POST);
  });
});
