import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadMattermostPostAttachment } from "./file-action.js";
import type { MattermostClient, MattermostPost } from "./client.js";
import type { OpenClawConfig } from "./runtime-api.js";

const CHANNEL_ID = "c".repeat(26);
const POST_ID = "p".repeat(26);
const FILE_ID = "f".repeat(26);
const SENDER_ID = "u".repeat(26);
const BOT_ID = "b".repeat(26);
const tempDirs: string[] = [];

type SetupOptions = {
  groupPolicy?: "allowlist" | "open" | "disabled";
  mediaMaxMb?: number;
  fileSize?: number;
  contentType?: string;
  post?: Partial<MattermostPost>;
  confirmedPost?: Partial<MattermostPost>;
  fileInfo?: Record<string, unknown>;
};

async function setup(options: SetupOptions = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mm-file-action-"));
  tempDirs.push(tempDir);
  const cfg = {
    channels: {
      mattermost: {
        enabled: true,
        botToken: "fixture-token",
        baseUrl: "https://mm.example",
        groupPolicy: options.groupPolicy ?? "open",
        mediaMaxMb: options.mediaMaxMb ?? 64,
      },
    },
  } as unknown as OpenClawConfig;
  const post: MattermostPost = {
    id: POST_ID,
    channel_id: CHANNEL_ID,
    user_id: SENDER_ID,
    file_ids: [FILE_ID],
    ...options.post,
  };
  const confirmedPost: MattermostPost = {
    ...post,
    ...options.confirmedPost,
  };
  const contentType = options.contentType ?? "text/plain";
  const imageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
    "base64",
  );
  const savedBytes =
    contentType === "image/png"
      ? imageBytes
      : Buffer.alloc(options.fileSize ?? 4, 0x61);
  const fileSize = options.fileSize ?? savedBytes.length;
  const request = vi.fn(async (endpoint: string) => {
    if (endpoint === `/channels/${CHANNEL_ID}`) {
      return { id: CHANNEL_ID, type: "O" };
    }
    throw new Error(`Unexpected Mattermost request: ${endpoint}`);
  });
  const client = {
    baseUrl: "https://mm.example",
    apiBaseUrl: "https://mm.example/api/v4",
    token: "fixture-token",
    request,
    fetchImpl: fetch,
  } as unknown as MattermostClient;
  let postReadCount = 0;
  const fetchPost = vi.fn(async () => {
    postReadCount += 1;
    return postReadCount === 1 ? post : confirmedPost;
  });
  const savedPath = path.join(tempDir, FILE_ID);
  const save = vi.fn(async (params: { requestInit?: RequestInit; maxBytes: number }) => {
    params.requestInit?.signal?.throwIfAborted();
    await writeFile(savedPath, savedBytes);
    return {
      path: savedPath,
      contentType,
      fileName: "fixture.txt",
    };
  });
  const fileInfo = {
    id: FILE_ID,
    post_id: POST_ID,
    name: "fixture.txt",
    mime_type: contentType,
    size: fileSize,
    ...options.fileInfo,
  };
  const fetchMe = vi.fn(async () => ({ id: BOT_ID }));
  const fetchUser = vi.fn(async (_client: MattermostClient, id: string) => ({
    id,
    username: "fixture-user",
  }));
  const dependencies = {
    createClient: vi.fn(() => client),
    fetchPost,
    fetchMe,
    fetchUser,
    fetchFileInfo: vi.fn(async () => fileInfo),
    save,
  } as unknown as Parameters<typeof downloadMattermostPostAttachment>[1];
  const run = (
    overrides: Partial<Parameters<typeof downloadMattermostPostAttachment>[0]> = {},
  ) =>
    downloadMattermostPostAttachment(
      {
        cfg,
        accountId: "default",
        requesterAccountId: "default",
        requesterSenderId: SENDER_ID,
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "mattermost",
          currentChannelId: CHANNEL_ID,
        },
        postId: POST_ID,
        fileId: FILE_ID,
        authorizedTarget: `channel:${CHANNEL_ID}`,
        ...overrides,
      },
      dependencies,
    );
  return {
    cfg,
    client,
    dependencies,
    fetchMe,
    fetchPost,
    fetchUser,
    fileInfo,
    request,
    run,
    save,
    savedPath,
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("downloadMattermostPostAttachment", () => {
  it("returns a bounded document result for an attachment on the current post", async () => {
    const fixture = await setup();

    const result = await fixture.run();

    expect(result.details).toMatchObject({
      ok: true,
      fileId: FILE_ID,
      postId: POST_ID,
      path: fixture.savedPath,
      fileName: "fixture.txt",
      contentType: "text/plain",
      media: { mediaUrl: fixture.savedPath, outbound: false },
    });
    expect(fixture.save).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `https://mm.example/api/v4/files/${FILE_ID}`,
        maxBytes: 4,
        requestInit: {
          headers: { Authorization: "Bearer fixture-token" },
          signal: expect.any(AbortSignal),
        },
        ssrfPolicy: {
          hostnameAllowlist: ["mm.example"],
          allowPrivateNetwork: false,
        },
      }),
    );
    expect(fixture.fetchPost).toHaveBeenCalledTimes(2);
  });

  it("returns image content with the verified local path", async () => {
    const fixture = await setup({ contentType: "image/png" });

    const result = await fixture.run();

    expect(result.details).toMatchObject({
      fileId: FILE_ID,
      postId: POST_ID,
      media: {
        mediaUrl: fixture.savedPath,
        outbound: false,
        contentType: "image/png",
      },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "image", mimeType: expect.any(String) }),
      ]),
    );
  });

  it("requires the exact current account and conversation before saving", async () => {
    const fixture = await setup();

    await expect(fixture.run({ requesterAccountId: "work" })).rejects.toThrow(
      "current Mattermost account and conversation",
    );
    expect(fixture.fetchPost).not.toHaveBeenCalled();
    expect(fixture.save).not.toHaveBeenCalled();

    const otherConversation = await setup();
    await expect(
      otherConversation.run({
        toolContext: {
          currentChannelProvider: "mattermost",
          currentChannelId: "o".repeat(26),
        },
      }),
    ).rejects.toThrow("not in the current conversation");
    expect(otherConversation.save).not.toHaveBeenCalled();
  });

  it.each([
    ["a different post", { id: "o".repeat(26) }],
    ["a different channel", { channel_id: "o".repeat(26) }],
    ["a deleted post", { delete_at: 1 }],
    ["a system post", { type: "system_join_channel" }],
    ["a post without the file", { file_ids: [] }],
  ])("rejects %s before downloading", async (_label, postOverride) => {
    const fixture = await setup({ post: postOverride });

    await expect(fixture.run()).rejects.toThrow();

    expect(fixture.save).not.toHaveBeenCalled();
  });

  it("rejects file metadata that assigns the file to another post", async () => {
    const fixture = await setup({ fileInfo: { post_id: "o".repeat(26) } });

    await expect(fixture.run()).rejects.toThrow("ownership or size could not be verified");

    expect(fixture.save).not.toHaveBeenCalled();
  });

  it("keeps posts from senders outside the configured history visible set private", async () => {
    const fixture = await setup({ groupPolicy: "disabled" });

    await expect(fixture.run()).rejects.toThrow("outside the visible conversation history");

    expect(fixture.save).not.toHaveBeenCalled();
  });

  it.each([
    ["configured media limit", { mediaMaxMb: 0.001, fileSize: 2048 }],
    ["20 MiB hard limit", { mediaMaxMb: 64, fileSize: 20 * 1024 * 1024 + 1 }],
  ])("rejects a file above the %s", async (_label, options) => {
    const fixture = await setup(options);

    await expect(fixture.run()).rejects.toThrow("download limit");

    expect(fixture.save).not.toHaveBeenCalled();
  });

  it("stops a caller-cancelled download", async () => {
    const fixture = await setup();
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(fixture.run({ signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fixture.fetchPost).not.toHaveBeenCalled();
    expect(fixture.save).not.toHaveBeenCalled();
  });

  it("removes a saved file if the post no longer owns it after download", async () => {
    const fixture = await setup({ confirmedPost: { file_ids: [] } });

    await expect(fixture.run()).rejects.toThrow("not attached to an available post");

    await expect(stat(fixture.savedPath)).rejects.toThrow();
  });

  it("skips sender history lookup for the bot's own post", async () => {
    const fixture = await setup({ post: { user_id: BOT_ID } });

    await fixture.run();

    expect(fixture.fetchMe).toHaveBeenCalledOnce();
    expect(fixture.fetchUser).not.toHaveBeenCalled();
    expect(fixture.request).not.toHaveBeenCalled();
    expect(fixture.save).toHaveBeenCalledOnce();
  });

  it("propagates cancellation while the attachment body is downloading", async () => {
    const fixture = await setup();
    const controller = new AbortController();
    let saveSignal: AbortSignal | undefined;
    fixture.save.mockImplementationOnce(
      async (params: { requestInit?: RequestInit; maxBytes: number }) => {
        saveSignal = params.requestInit?.signal;
        await new Promise<never>((_resolve, reject) => {
          saveSignal?.addEventListener("abort", () => reject(saveSignal?.reason), {
            once: true,
          });
        });
        return { path: fixture.savedPath, contentType: "text/plain", fileName: "fixture.txt" };
      },
    );
    const result = fixture.run({ signal: controller.signal });
    await vi.waitFor(() => expect(fixture.save).toHaveBeenCalledOnce());

    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(saveSignal?.aborted).toBe(true);
  });

  it("bounds the entire operation and removes a late save even if the saver ignores cancellation", async () => {
    const fixture = await setup();
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    fixture.save.mockImplementationOnce(async () => {
      await blocked;
      await writeFile(fixture.savedPath, "late");
      return { path: fixture.savedPath, contentType: "text/plain", fileName: "late.txt" };
    });
    const pending = fixture.run();
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.waitFor(() => expect(fixture.save).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    release();
    vi.useRealTimers();
    await fixture.save.mock.results[0]!.value;
    await vi.waitFor(async () => {
      expect(fixture.fetchPost).toHaveBeenCalledOnce();
      await expect(stat(fixture.savedPath)).rejects.toThrow();
    });
  });
});
