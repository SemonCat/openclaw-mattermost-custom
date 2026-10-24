import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { register } = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock("openclaw/plugin-sdk/question-gateway-runtime", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/question-gateway-runtime")>();
  return { ...actual, questionGatewayRuntime: {
    ...actual.questionGatewayRuntime, registerChannelDelivery: register,
  } };
});

import { mattermostPlugin } from "../channel.js";
import { setMattermostRuntime } from "../runtime.js";

const channelId = "cccccccccccccccccccccccccc";
const questionId = "ask_0123456789abcdef0123456789abcdef";

beforeEach(() => {
  register.mockClear();
  setMattermostRuntime({
    logging: { getChildLogger: () => ({ warn() {} }), shouldLogVerbose: () => false },
    channel: { activity: { record() {} } },
  } as never);
});

describe("accepted question delivery retains its terminal lifecycle", () => {
  it.each([
    { blocks: false, retire: "signal" },
    { blocks: true, retire: "signal" },
    { blocks: false, retire: "handoff" },
    { blocks: true, retire: "handoff" },
  ])("retires controls after $retire expires (blocks=$blocks)", async ({ blocks, retire }) => {
    const requests: Array<{
      path: string; method: string; token?: string; body: Record<string, unknown>;
    }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const parsed = JSON.parse(body);
        requests.push({
          path: request.url!, method: request.method!, token: request.headers.authorization,
          body: parsed,
        });
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ ...parsed, id: "question-post", channel_id: channelId }));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const controller = new AbortController();
      let sendCurrent = true;
      const cfg = { channels: { mattermost: {
        botToken: "wrong-default-token", baseUrl: "https://wrong-default.invalid",
        accounts: { questions: {
          botToken: "question-account-token",
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          network: { dangerouslyAllowPrivateNetwork: true },
          interactions: { blocks, callbackUrl: "https://gateway.example/callback" },
        } },
      } } };
      const delivered = vi.fn();
      const result = await mattermostPlugin.outbound!.sendPayload!({
        cfg, accountId: "questions", to: `channel:${channelId}`, text: "Which release?",
        signal: controller.signal,
        assertDirectAdapterHandoff: () => { if (!sendCurrent) throw new Error("send retired"); },
        onDeliveryResult: delivered,
        payload: {
          text: "Which release?", channelData: {
            askUser: { questionId },
            mattermost: {
              attachmentText: "Choose a release",
              presentationButtons: [[{ text: "Stable", callback_data: "stable" }]],
            },
          },
        },
      } as never);
      expect(result.messageId).toBe("question-post");
      expect(delivered).toHaveBeenCalledOnce();
      expect(register).toHaveBeenCalledOnce();
      expect(register.mock.calls[0][0]).toMatchObject({
        questionId, deliveryId: `mattermost:questions:${channelId}:question-post`,
      });
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0].body.props)).toContain(blocks ? "action_id" : "actions");

      if (retire === "signal") controller.abort(new Error("caller cancelled after acceptance"));
      else sendCurrent = false;
      await register.mock.calls[0][0].finalize("Cancelled");

      expect(requests.map(({ method, path }) => [method, path])).toEqual([
        ["POST", "/api/v4/posts"], ["PUT", "/api/v4/posts/question-post/patch"],
      ]);
      expect(requests.every(({ token }) => token === "Bearer question-account-token")).toBe(true);
      const terminal = requests[1].body;
      expect(terminal.message).toBe("Which release?");
      expect(JSON.stringify(terminal.props)).toContain("Cancelled");
      expect(JSON.stringify(terminal.props)).not.toMatch(/action_id|actions|callback|_token/);
      expect(delivered).toHaveBeenCalledOnce();
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
