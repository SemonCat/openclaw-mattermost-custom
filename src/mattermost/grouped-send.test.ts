import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { listMessageReceiptPlatformIds } from "openclaw/plugin-sdk/channel-outbound";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { chunkMarkdownTextWithMode } from "openclaw/plugin-sdk/reply-chunking";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { describe, expect, it, vi } from "vitest";
import { mattermostPlugin } from "../channel.js";
import { setMattermostRuntime } from "../runtime.js";
import { deliverMattermostReplyPayload } from "./reply-delivery.js";
import { sendMessageMattermost } from "./send.js";

const channelId = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const rootId = "rrrrrrrrrrrrrrrrrrrrrrrrrr";
const fileId = (n: number) => String(n).padStart(26, "f");

type FixtureOptions = {
  count?: number;
  uploadFailure?: number;
  postFailure?: number;
  missingId?: number;
  byteLimit?: number;
  textLimit?: number;
  chunkMode?: "length" | "newline";
  afterUpload?: (count: number) => void;
  afterPost?: (count: number) => void;
};

async function fixture(
  options: FixtureOptions,
  run: (f: {
    cfg: Parameters<typeof sendMessageMattermost>[2]["cfg"];
    files: string[];
    directory: string;
    requests: Array<{ path: string; method: string; body: string }>;
  }) => Promise<void>,
) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "mattermost-group-")));
  const files = Array.from({ length: options.count ?? 2 }, (_, i) => path.join(directory, `${i}.txt`));
  await Promise.all(files.map((file, i) => writeFile(file, `file${i}`)));
  const requests: Array<{ path: string; method: string; body: string }> = [];
  let uploads = 0;
  let posts = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ path: request.url!, method: request.method!, body });
      let result: unknown;
      let status = 201;
      if (request.url === "/api/v4/files") {
        uploads++;
        status = uploads === options.uploadFailure ? 500 : 201;
        result = { file_infos: [{ id: fileId(uploads) }] };
        options.afterUpload?.(uploads);
      } else {
        posts++;
        status = posts === options.postFailure ? 500 : 201;
        result = posts === options.missingId ? {} : {
          id: `post-${posts}`, channel_id: channelId, ...JSON.parse(body),
        };
        options.afterPost?.(posts);
      }
      const reply = () => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      };
      if (options.afterPost && request.url?.startsWith("/api/v4/posts")) {
        setImmediate(reply);
      } else {
        reply();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const core = {
    logging: { getChildLogger: () => ({ warn() {}, debug() {} }), shouldLogVerbose: () => false },
    channel: {
      activity: { record() {} },
      text: {
        convertMarkdownTables: (s: string) => s,
        resolveChunkMode: () => "length",
        chunkMarkdownTextWithMode: chunkTextForOutbound,
      },
    },
  } as unknown as PluginRuntime;
  setMattermostRuntime(core);
  try {
    await run({
      cfg: {
        agents: { defaults: { workspace: directory } },
        channels: { mattermost: {
          botToken: "fixture", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          textChunkLimit: options.textLimit,
          streaming: { chunkMode: options.chunkMode },
          mediaMaxMb: options.byteLimit === undefined ? undefined : options.byteLimit / 1024 / 1024,
          network: { dangerouslyAllowPrivateNetwork: true }, interactions: { blocks: false },
        } },
      },
      directory, files, requests,
    });
  } finally {
    server.close();
    await once(server, "close");
    await rm(directory, { recursive: true, force: true });
  }
}

async function prepareAndSend(f: Parameters<Parameters<typeof fixture>[1]>[0], extra = {}) {
  const payload = await mattermostPlugin.actions!.prepareSendPayload!({
    ctx: { cfg: f.cfg, channel: "mattermost", action: "send", params: {
      attachments: f.files.map((filePath) => ({ filePath })), ...extra,
    } },
    to: `channel:${channelId}`, payload: { text: "caption" },
  });
  return await mattermostPlugin.outbound!.sendPayload!({
    cfg: f.cfg, to: `channel:${channelId}`, text: "caption", payload: payload!,
    replyToId: rootId, silent: true, mediaLocalRoots: [f.directory],
    deliveryQueueId: "grouped-intent", deliveryPartIndex: 0, deliveryPartCount: 1,
  });
}

describe("one-post Mattermost attachment collections", () => {
  it.each([
    { grouped: false, silent: false, missingId: false },
    { grouped: false, silent: true, missingId: false },
    { grouped: true, silent: false, missingId: false },
    { grouped: true, silent: true, missingId: false },
    { grouped: false, silent: false, missingId: true },
    { grouped: false, silent: true, missingId: true },
    { grouped: true, silent: false, missingId: true },
    { grouped: true, silent: true, missingId: true },
  ])("settles an accepted create receipt after caller cancellation %j", async ({ grouped, silent, missingId }) => {
    const controller = new AbortController();
    await fixture({
      missingId: missingId ? 1 : undefined,
      afterPost: () => controller.abort(new Error("caller retired after provider acceptance")),
    }, async (f) => {
      const delivered = vi.fn();
      const ctx = {
        cfg: f.cfg, to: `channel:${channelId}`, text: "caption", silent,
        signal: controller.signal, onDeliveryResult: delivered,
      };
      const sending = grouped
        ? mattermostPlugin.message!.send!.payload!({
            ...ctx, payload: { text: ctx.text, mediaUrls: f.files },
            mediaLocalRoots: [f.directory],
          })
        : mattermostPlugin.message!.send!.text!(ctx);
      if (missingId) {
        const error = await sending.catch((e: unknown) => e);
        expect(isChannelPartialDeliveryError(error)).toBe(true);
        expect(error).toMatchObject({
          deliveryResult: { visibleReplySent: true, messageIds: [] },
        });
        expect(delivered).not.toHaveBeenCalled();
      } else {
        const result = await sending;
        expect(listMessageReceiptPlatformIds(result.receipt)).toEqual(["post-1"]);
        expect(delivered).toHaveBeenCalledOnce();
      }
      expect(controller.signal.aborted).toBe(true);
      expect(f.requests.map((r) => r.path)).toEqual([
        ...(grouped ? ["/api/v4/files", "/api/v4/files"] : []),
        `/api/v4/posts${silent ? "?silent=true" : ""}`,
      ]);
    });
  });

  it.each([false, true])("rejects cancelled silent=%s before dispatch without a create", async (silent) => {
    await fixture({}, async (f) => {
      for (const beforeCall of [true, false]) {
        const controller = new AbortController();
        if (beforeCall) controller.abort(new Error("already retired"));
        const error = await mattermostPlugin.message!.send!.text!({
          cfg: f.cfg, to: `channel:${channelId}`, text: "cancelled", silent,
          signal: controller.signal,
          onPlatformSendDispatch: () => { controller.abort(new Error("retired in handoff")); },
        }).catch((e: unknown) => e);
        if (beforeCall) {
          expect(error).toBeInstanceOf(Error);
          expect(String(error)).toContain("already retired");
        } else {
          expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
        }
        expect(isChannelPartialDeliveryError(error)).toBe(false);
        expect(f.requests).toEqual([]);
      }
    });
  });

  it("keeps the accepted group receipt when cancellation fences a caption overflow", async () => {
    const controller = new AbortController();
    await fixture({
      textLimit: 8,
      afterPost: () => controller.abort(new Error("retired before overflow")),
    }, async (f) => {
      const delivered = vi.fn();
      const error = await mattermostPlugin.message!.send!.payload!({
        cfg: f.cfg, to: `channel:${channelId}`, text: "first caption and overflow",
        payload: { text: "first caption and overflow", mediaUrls: f.files },
        signal: controller.signal, mediaLocalRoots: [f.directory],
        onDeliveryResult: delivered,
      }).catch((e: unknown) => e);
      expect(isChannelPartialDeliveryError(error)).toBe(true);
      expect(error).toMatchObject({
        deliveryResult: { visibleReplySent: true, messageIds: ["post-1"] },
      });
      expect(delivered).toHaveBeenCalledOnce();
      expect(f.requests.map((r) => r.path)).toEqual([
        "/api/v4/files", "/api/v4/files", "/api/v4/posts",
      ]);
    });
  });

  it("opts into intact host payload routing and groups through the published message bridge", async () => {
    expect(mattermostPlugin.outbound!.sendPayloadGroupsMedia).toBe(true);
    await fixture({}, async (f) => {
      const delivered = vi.fn();
      const result = await mattermostPlugin.message!.send!.payload!({
        cfg: f.cfg, to: `channel:${channelId}`, text: "caption",
        payload: { text: "caption", mediaUrls: f.files },
        mediaLocalRoots: [f.directory], threadId: rootId, silent: true,
        deliveryQueueId: "host-payload", deliveryPartIndex: 0, deliveryPartCount: 1,
        onDeliveryResult: delivered,
      });
      expect(f.requests.map((r) => r.path)).toEqual([
        "/api/v4/files", "/api/v4/files", "/api/v4/posts?silent=true",
      ]);
      expect(JSON.parse(f.requests[2].body)).toMatchObject({
        root_id: rootId, file_ids: [fileId(1), fileId(2)],
        props: { openclaw_delivery: { part_index: 0, part_count: 1 } },
      });
      expect(listMessageReceiptPlatformIds(result.receipt)).toEqual(["post-1"]);
      expect(delivered).toHaveBeenCalledOnce();
      expect(listMessageReceiptPlatformIds(delivered.mock.calls[0][0].receipt)).toEqual(["post-1"]);
    });
  });

  it.each([{}, { attachmentText: "detail" }])("uploads in order then creates one post through public action/payload seams %j", async (extra) => {
    await fixture({}, async (f) => {
      const result = await prepareAndSend(f, extra);
      expect(f.requests.map((r) => r.path)).toEqual(["/api/v4/files", "/api/v4/files", "/api/v4/posts?silent=true"]);
      expect(f.requests[0].body).toContain('filename="0.txt"');
      expect(f.requests[1].body).toContain('filename="1.txt"');
      const post = JSON.parse(f.requests[2].body);
      expect(post).toMatchObject({
        message: "caption", root_id: rootId, file_ids: [fileId(1), fileId(2)],
        props: { openclaw_delivery: { part_index: 0, part_count: 1 } },
      });
      expect(post.props.openclaw_delivery.signature).toBe(createHmac("sha256", "grouped-intent")
        .update(JSON.stringify(["openclaw.mattermost.delivery.v1", channelId, rootId, 0, 1])).digest("base64url"));
      expect(result.messageId).toBe("post-1");
      expect(listMessageReceiptPlatformIds(result.receipt!)).toEqual(["post-1"]);
    });
  });

  it("accepts ten files and rejects eleven before any upload", async () => {
    await fixture({ count: 10 }, async (f) => {
      await prepareAndSend(f);
      expect(f.requests).toHaveLength(11);
      expect(JSON.parse(f.requests[10].body).file_ids).toHaveLength(10);
      f.files.push(path.join(f.directory, "11.txt"));
      await expect(prepareAndSend(f)).rejects.toThrow("at most 10 attachments");
      await expect(mattermostPlugin.outbound!.sendPayload!({
        cfg: f.cfg, to: `channel:${channelId}`, text: "",
        payload: { mediaUrls: f.files }, mediaLocalRoots: [f.directory],
      })).rejects.toThrow("at most 10 attachments");
      expect(f.requests).toHaveLength(11);
    });
  });

  it.each(["upload", "aggregate", "local-root", "ssrf"])("does not create a visible partial post after %s failure", async (failure) => {
    await fixture({
      uploadFailure: failure === "upload" ? 2 : undefined,
      byteLimit: failure === "aggregate" ? 8 : undefined,
    }, async (f) => {
      if (failure === "local-root") f.files[1] = path.join(os.tmpdir(), "outside-authorized-roots.txt");
      if (failure === "ssrf") f.files[1] = "http://127.0.0.1:9/blocked.txt";
      const error = await prepareAndSend(f).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(isChannelPartialDeliveryError(error)).toBe(false);
      expect(f.requests.every((r) => r.path === "/api/v4/files")).toBe(true);
      expect(f.requests).toHaveLength(failure === "upload" ? 2 : 1);
      expect(f.requests.some((r) => r.method === "DELETE")).toBe(false);
    });
  });

  it.each(["fence", "signal", "dispatch-hook"])("rechecks %s authority after awaited preparation", async (mode) => {
    let retired = false;
    const controller = new AbortController();
    await fixture({ afterUpload: (count) => {
      if (count === 1 && mode !== "dispatch-hook") {
        retired = true;
        if (mode === "signal") controller.abort(new Error("retired"));
      }
    } }, async (f) => {
      await expect(mattermostPlugin.outbound!.sendPayload!({
        cfg: f.cfg, to: `channel:${channelId}`, text: "caption", payload: { text: "caption", mediaUrls: f.files },
        mediaLocalRoots: [f.directory], signal: controller.signal,
        assertDirectAdapterHandoff: () => { if (retired) throw new Error("retired"); },
        onPlatformSendDispatch: async () => { if (mode === "dispatch-hook") retired = true; },
      })).rejects.toThrow("retired");
      expect(f.requests.map((r) => r.path)).toEqual(Array(mode === "dispatch-hook" ? 2 : 1).fill("/api/v4/files"));
    });
  });

  it("stops after accepted creation without an id, with no create or cleanup retry", async () => {
    await fixture({ missingId: 1 }, async (f) => {
      const error = await prepareAndSend(f).catch((e: unknown) => e);
      expect(isChannelPartialDeliveryError(error)).toBe(true);
      expect(error).toMatchObject({ deliveryResult: { visibleReplySent: true, messageIds: [] } });
      expect(f.requests.map((r) => r.path)).toEqual(["/api/v4/files", "/api/v4/files", "/api/v4/posts?silent=true"]);
    });
  });

  it.each(["outbound", "inbound"])("chunks %s caption overflow, keeps files on the first post and returns all receipts", async (seam) => {
    await fixture({ textLimit: 8 }, async (f) => {
      const text = "abcdefgh ijklmnop qrstuvwx";
      const delivered = vi.fn();
      const result = seam === "outbound"
        ? await mattermostPlugin.outbound!.sendPayload!({
          cfg: f.cfg, to: `channel:${channelId}`, text,
          payload: { text, mediaUrls: f.files, channelData: { mattermost: { presentationButtons: [[{ text: "Open", callback_data: "open" }]] } } },
          mediaLocalRoots: [f.directory], replyToId: rootId, onDeliveryResult: delivered,
          deliveryQueueId: "overflow-intent", deliveryPartCount: 1, deliveryPartIndex: 0,
        })
        : await deliverMattermostReplyPayload({
          cfg: f.cfg, core: {
            channel: { text: { convertMarkdownTables: (s: string) => s, resolveChunkMode: () => "length" } },
          } as unknown as PluginRuntime,
          payload: { text, mediaUrls: f.files }, channelId, accountId: "default", agentId: "main",
          replyToId: rootId, textLimit: 8, tableMode: "off", sendMessage: sendMessageMattermost,
        });
      const posts = f.requests.filter((r) => r.path.startsWith("/api/v4/posts")).map((r) => JSON.parse(r.body));
      expect(posts.map((post) => post.message)).toEqual(chunkTextForOutbound(text, 8));
      expect(posts[0].file_ids).toEqual([fileId(1), fileId(2)]);
      expect(posts.slice(1).every((post) => !post.file_ids)).toBe(true);
      expect(posts.every((post) => post.root_id === rootId)).toBe(true);
      expect(listMessageReceiptPlatformIds(result.receipt!)).toEqual(["post-1", "post-2", "post-3"]);
      if (seam === "outbound") {
        expect(delivered).toHaveBeenCalledTimes(3);
        expect(posts[0].props.attachments).toBeDefined();
        expect(posts.map((post) => [post.props.openclaw_delivery.part_index, post.props.openclaw_delivery.part_count]))
          .toEqual([[0, 3], [1, 3], [2, 3]]);
      }
    });
  });

  it.each(["outbound", "inbound"])("preserves %s accepted receipts when a text-only tail fails", async (seam) => {
    await fixture({ textLimit: 8, postFailure: 2 }, async (f) => {
      const text = "abcdefgh ijklmnop qrstuvwx";
      const promise = seam === "outbound"
        ? mattermostPlugin.outbound!.sendPayload!({
          cfg: f.cfg, to: `channel:${channelId}`, text, payload: { text, mediaUrls: f.files },
          mediaLocalRoots: [f.directory],
        })
        : deliverMattermostReplyPayload({
          cfg: f.cfg, core: { channel: { text: { convertMarkdownTables: (s: string) => s, resolveChunkMode: () => "length" } } } as unknown as PluginRuntime,
          payload: { text, mediaUrls: f.files }, channelId, accountId: "default", agentId: "main",
          textLimit: 8, tableMode: "off", sendMessage: sendMessageMattermost,
        });
      const error = await promise.catch((e: unknown) => e);
      expect(isChannelPartialDeliveryError(error)).toBe(true);
      if (!isChannelPartialDeliveryError(error)) throw error;
      expect(error.deliveryResult.visibleReplySent).toBe(true);
      expect(error.deliveryResult.messageIds).toEqual(["post-1"]);
      expect(f.requests.map((r) => r.path)).toEqual(["/api/v4/files", "/api/v4/files", "/api/v4/posts", "/api/v4/posts"]);
    });
  });

  it.each(["outbound", "inbound"])("preserves configured newline/Markdown chunking for %s grouped captions", async (seam) => {
    await fixture({ textLimit: 32, chunkMode: "newline" }, async (f) => {
      const text = "short paragraph\n\n```ts\nconst a = 123456789;\nconst b = 987654321;\n```\n\nlast paragraph";
      if (seam === "outbound") {
        await mattermostPlugin.outbound!.sendPayload!({
          cfg: f.cfg, to: `channel:${channelId}`, text, payload: { text, mediaUrls: f.files },
          mediaLocalRoots: [f.directory], deliveryQueueId: "nested-intent",
          deliveryPartIndex: 2, deliveryPartCount: 4,
        });
      } else {
        await deliverMattermostReplyPayload({
          cfg: f.cfg, core: { channel: { text: { convertMarkdownTables: (s: string) => s, resolveChunkMode: () => "newline" } } } as unknown as PluginRuntime,
          payload: { text, mediaUrls: f.files }, channelId, accountId: "default", agentId: "main",
          textLimit: 32, tableMode: "off", sendMessage: sendMessageMattermost,
        });
      }
      const posts = f.requests.filter((r) => r.path === "/api/v4/posts").map((r) => JSON.parse(r.body));
      expect(posts.map((post) => post.message)).toEqual(chunkMarkdownTextWithMode(text, 32, "newline"));
      expect(posts.every((post) => post.message.length <= 32)).toBe(true);
      expect(posts[0].file_ids).toHaveLength(2);
      expect(posts.slice(1).every((post) => !post.file_ids)).toBe(true);
      // The caller's 2/4 describes a different batch. Never sign that false
      // total on locally expanded posts; media unknown-send reconciliation is off.
      expect(posts.every((post) => !post.props?.openclaw_delivery)).toBe(true);
    });
  });

  it("keeps known prefix receipts and stops on an accepted tail with no id", async () => {
    await fixture({ textLimit: 8, missingId: 2 }, async (f) => {
      const text = "abcdefgh ijklmnop qrstuvwx";
      const error = await mattermostPlugin.outbound!.sendPayload!({
        cfg: f.cfg, to: `channel:${channelId}`, text, payload: { text, mediaUrls: f.files },
        mediaLocalRoots: [f.directory],
      }).catch((e: unknown) => e);
      expect(isChannelPartialDeliveryError(error)).toBe(true);
      if (!isChannelPartialDeliveryError(error)) throw error;
      expect(error.deliveryResult.messageIds).toEqual(["post-1"]);
      expect(f.requests.filter((r) => r.path === "/api/v4/posts")).toHaveLength(2);
    });
  });
});
