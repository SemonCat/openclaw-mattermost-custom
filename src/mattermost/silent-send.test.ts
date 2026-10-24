import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { mattermostPlugin } from "../channel.js";
import { setMattermostRuntime } from "../runtime.js";
import { createMattermostClient, createMattermostPost } from "./client.js";

const channelId = "aaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("explicit Mattermost silent delivery", () => {
  it.each([true, false, undefined])("carries silent=%s through public text/media/payload adapters", async (silent) => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requests.push({ path: request.url!, body: JSON.parse(body) });
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: `post-${requests.length}`, channel_id: channelId }));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    setMattermostRuntime({
      logging: { getChildLogger: () => ({ warn() {}, debug() {} }), shouldLogVerbose: () => false },
      channel: { activity: { record() {} } },
    } as unknown as PluginRuntime);
    try {
      const cfg = { channels: { mattermost: {
        botToken: "fixture", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        network: { dangerouslyAllowPrivateNetwork: true },
      } } };
      const dispatched = vi.fn();
      const delivered = vi.fn();
      const ctx = { cfg, to: `channel:${channelId}`, text: "hello", silent,
        onPlatformSendDispatch: dispatched, onDeliveryResult: delivered };
      const outbound = mattermostPlugin.outbound!;
      await outbound.sendText!(ctx);
      // No media URL also exercises the public media adapter without mocking its sender.
      await outbound.sendMedia!({ ...ctx, mediaUrl: "" });
      await outbound.sendPayload!({ ...ctx, payload: { text: "hello" } });
      const payload = await mattermostPlugin.actions!.prepareSendPayload!({
        ctx: { cfg, channel: "mattermost", action: "send", params: { silent, attachmentText: "detail" } },
        to: ctx.to, payload: { text: "hello" },
      });
      await outbound.sendPayload!({ ...ctx, payload: payload! });
      expect(requests).toHaveLength(4);
      expect(requests.every((r) => r.path === `/api/v4/posts${silent === true ? "?silent=true" : ""}`)).toBe(true);
      expect(requests.map((r) => r.body)).toEqual(Array(4).fill({ channel_id: channelId, message: "hello" }));
      expect(dispatched).toHaveBeenCalledTimes(4);
      expect(delivered).toHaveBeenCalledTimes(4);
      expect(delivered.mock.calls[0][0]).toMatchObject({ messageId: "post-1", receipt: { parts: [expect.objectContaining({ platformMessageId: "post-1" })] } });
      expect(mattermostPlugin.message?.durableFinal?.capabilities.silent).toBe(true);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it.each(["missing-id", "unreadable", "forbidden"])("never retries a silent create after %s", async (failure) => {
    const fetchImpl = vi.fn(async () => failure === "missing-id"
      ? Response.json({})
      : failure === "forbidden"
        ? Response.json({ message: "integration author required" }, { status: 403 })
        : new Response("{", { headers: { "content-type": "application/json" } }));
    const client = createMattermostClient({ baseUrl: "https://mm.example.test", botToken: "fixture", fetchImpl });
    const error = await createMattermostPost(client, { channelId, message: "quiet", silent: true }).catch((e: unknown) => e);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe("https://mm.example.test/api/v4/posts?silent=true");
    if (failure === "forbidden") {
      expect(isChannelPartialDeliveryError(error)).toBe(false);
      expect(String(error)).toContain("403");
    } else {
      expect(isChannelPartialDeliveryError(error)).toBe(true);
      expect(error).toMatchObject({
        deliveryResult: { visibleReplySent: true, messageIds: [] },
      });
    }
  });

  it.each(["/posts?silent=true", "/posts/other?silent=true"])("records dispatch only for the exact create path %s", async (path) => {
    let retired = false;
    const fetchImpl = vi.fn(async () => Response.json({ id: "post" }));
    const client = createMattermostClient({
      baseUrl: "https://mm.example.test", botToken: "fixture", fetchImpl,
      assertRequestCurrent: () => { if (retired) throw new Error("retired"); },
    });
    await client.request(path, { method: "POST", body: "{}" });
    retired = true;
    expect(() => client.assertRequestCurrent!()).toThrow();
    try { client.assertRequestCurrent!(); } catch (error) {
      expect(error instanceof PlatformMessageNotDispatchedError).toBe(path !== "/posts?silent=true");
    }
    await expect(client.request("/posts?silent=true", { method: "POST", body: "{}" })).rejects.toThrow("retired");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
