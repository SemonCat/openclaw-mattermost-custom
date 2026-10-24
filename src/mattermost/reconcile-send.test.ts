import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { listMessageReceiptPlatformIds } from "openclaw/plugin-sdk/channel-outbound";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import { mattermostPlugin } from "../channel.js";
import { setMattermostRuntime } from "../runtime.js";

const channelId = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const botId = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const rootId = "rrrrrrrrrrrrrrrrrrrrrrrrrr";
const postId = "pppppppppppppppppppppppppp";

describe("public Mattermost unknown text reconciliation", () => {
  it.each([
    "normal", "silent", "bad-signature", "wrong-author", "wrong-thread", "missing", "duplicate",
  ])("reconciles only exact signed posts after an accepted-without-id %s send", async (mode) => {
    const requests: Array<{ method: string; path: string }> = [];
    let acceptedPost: Record<string, unknown>;
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requests.push({ method: request.method!, path: request.url! });
        let result: unknown;
        if (request.method === "POST" && request.url?.startsWith("/api/v4/posts")) {
          acceptedPost = {
            ...JSON.parse(body), id: postId, user_id: botId, create_at: Date.now(),
          };
          result = {};
        } else if (request.url === "/api/v4/users/me") {
          result = { id: botId, username: "fixture-bot" };
        } else if (request.url?.startsWith(`/api/v4/channels/${channelId}/posts?since=`)) {
          const post = structuredClone(acceptedPost);
          if (mode === "bad-signature") {
            (post.props as { openclaw_delivery: { signature: string } })
              .openclaw_delivery.signature = "forged";
          }
          if (mode === "wrong-author") post.user_id = "another-author";
          if (mode === "wrong-thread") post.root_id = "another-thread";
          result = mode === "missing" ? { order: [], posts: {} } : {
            order: mode === "duplicate" ? [postId, "duplicate"] : [postId],
            posts: {
              [postId]: post,
              ...(mode === "duplicate" ? { duplicate: { ...post, id: "duplicate" } } : {}),
            },
          };
        } else {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    setMattermostRuntime({
      logging: { getChildLogger: () => ({ warn() {}, debug() {} }), shouldLogVerbose: () => false },
      channel: { activity: { record() {} } },
    } as unknown as PluginRuntime);
    try {
      const cfg = { channels: { mattermost: { accounts: { recovery: {
        botToken: "fixture", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        network: { dangerouslyAllowPrivateNetwork: true },
      } } } } };
      const silent = mode === "silent";
      const ctx = {
        cfg, to: `channel:${channelId}`, accountId: "recovery", text: "durable",
        replyToId: rootId, silent, deliveryQueueId: "recover-text",
      };
      const error = await mattermostPlugin.message!.send!.text!(ctx).catch((e: unknown) => e);
      expect(isChannelPartialDeliveryError(error)).toBe(true);
      expect(error).toMatchObject({ deliveryResult: { visibleReplySent: true, messageIds: [] } });
      expect(requests).toEqual([{ method: "POST", path: `/api/v4/posts${silent ? "?silent=true" : ""}` }]);

      const reconcile = mattermostPlugin.message!.durableFinal!.reconcileUnknownSend!;
      const result = await reconcile({
        cfg, to: ctx.to, accountId: ctx.accountId, queueId: ctx.deliveryQueueId,
        channel: "mattermost", enqueuedAt: Date.now() - 1000, retryCount: 0,
        effectiveReplyToId: rootId, payloads: [{ text: ctx.text }], silent,
      });
      if (mode === "normal" || mode === "silent") {
        expect(result.status).toBe("sent");
        if (result.status === "sent") {
          expect(result.messageId).toBe(postId);
          expect(listMessageReceiptPlatformIds(result.receipt)).toEqual([postId]);
          expect(result.receipt.parts[0]).toMatchObject({ kind: "text", replyToId: rootId });
        }
      } else {
        expect(result.status).toBe("unresolved");
        if (result.status === "unresolved") {
          expect(result.retryable).toBe(mode !== "duplicate");
          expect(result.error).toContain(mode === "duplicate" ? "duplicate provider parts" : "no exact durable delivery marker");
        }
      }
      expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
      expect(requests.slice(1).map((r) => r.path)).toEqual([
        "/api/v4/users/me", expect.stringMatching(new RegExp(`^/api/v4/channels/${channelId}/posts\\?since=\\d+$`)),
      ]);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
