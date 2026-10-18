import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  request: vi.fn(), rpc: vi.fn(), finalize: vi.fn(),
}));
vi.mock("./client.js", async (original) => ({
  ...await original<typeof import("./client.js")>(),
  createMattermostClient: (params: { baseUrl: string; botToken: string }) => ({
    baseUrl: params.baseUrl, token: params.botToken, request: mocks.request,
  }),
}));
vi.mock("./question-rpc.js", () => ({
  createMattermostQuestionRpc: () => mocks.rpc,
}));
vi.mock("openclaw/plugin-sdk/question-gateway-runtime", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/question-gateway-runtime")>();
  return { ...actual, questionGatewayRuntime: {
    ...actual.questionGatewayRuntime, registerChannelDelivery: mocks.finalize,
  } };
});

import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { chunkMarkdownTextWithMode } from "openclaw/plugin-sdk/reply-chunking";
import { setMattermostRuntime } from "../runtime.js";
import { mattermostPlugin } from "../channel.js";
import { sendMessageMattermost } from "./send.js";
import { deliverMattermostReplyPayload } from "./reply-delivery.js";
import { observeMattermostServerVersion } from "./text-limits.js";

const id = "ask_0123456789abcdef0123456789abcdef";
const cfg = {
  channels: { mattermost: {
    enabled: true, baseUrl: "https://delivery-forms.test", botToken: "token",
    interactions: { blocks: false, callbackUrl: "https://gateway/callback" },
  } },
};
const question = {
  id, status: "pending", sessionKey: "session", expiresAtMs: Date.now() + 60_000,
  questions: [{
    questionId: "choices", header: "Choices", question: "Which?",
    options: [{ label: "A" }, { label: "B" }], multiSelect: true, isOther: true,
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  observeMattermostServerVersion(cfg.channels.mattermost.baseUrl, "12.0.0");
  mocks.rpc.mockResolvedValue({ question });
  mocks.request.mockImplementation(async (path, init) => {
    if (path === "/posts") return {
      ...JSON.parse(init.body), id: `post-${mocks.request.mock.calls.filter(([p]) => p === "/posts").length}`,
      user_id: "bot",
    };
    if (path.endsWith("/patch")) return { id: "post-1", ...JSON.parse(init.body) };
    return { id: "bot", username: "bot" };
  });
  setMattermostRuntime({
    logging: { getChildLogger: () => ({ warn: vi.fn() }), shouldLogVerbose: () => false },
    channel: { activity: { record: vi.fn() } },
  } as never);
});

describe("Mattermost question forms delivery seams", () => {
  it("turns a canonical question marker into one signed native form control and retires it", async () => {
    await sendMessageMattermost("channel:cccccccccccccccccccccccccc", "Which?", { cfg, questionId: id, replyToId: "root" });
    const body = JSON.parse(mocks.request.mock.calls.find(([path]) => path === "/posts")![1].body);
    expect(body).toMatchObject({
      channel_id: "cccccccccccccccccccccccccc", root_id: "root",
      props: { openclaw_question_form: {
        kind: "question_form_control_v1", question_id: id,
        channel_id: "cccccccccccccccccccccccccc", signature: expect.any(String),
      }, attachments: [{ actions: [{
        id: "ocquestionform", integration: { context: {
          question_id: id, oc_question_form: 1, _token: expect.any(String),
        } },
      }, { id: "ocquestionformweb", integration: { context: { layout: "native" } } }] }] },
    });
    expect(mocks.finalize).toHaveBeenCalledOnce();
    await mocks.finalize.mock.calls[0][0].finalize("Answered");
    const terminal = JSON.parse(mocks.request.mock.calls.find(([path]) => path.endsWith("/patch"))![1].body);
    expect(terminal.props.attachments[0].actions).toBeUndefined();
    expect(terminal.props.openclaw_question_form).toBeUndefined();
    expect(terminal.props.attachments[0].text).toContain("Answered");
  });

  it("preserves the canonical id only on the first physical inbound prompt chunk", async () => {
    const send = vi.fn(async (_to, text, opts) => ({
      messageId: `post-${send.mock.calls.length}`, channelId: "cccccccccccccccccccccccccc", content: text,
      receipt: createMessageReceiptFromOutboundResults({ results: [{ channel: "mattermost", messageId: `post-${send.mock.calls.length}`, channelId: "cccccccccccccccccccccccccc" }], kind: "text" }),
    }));
    await deliverMattermostReplyPayload({
      cfg, channelId: "cccccccccccccccccccccccccc", accountId: "default", tableMode: "off", textLimit: 20,
      payload: { text: "Question content ".repeat(5), channelData: { askUser: { questionId: id } } },
      core: { channel: { text: {
        convertMarkdownTables: (text: string) => text, resolveChunkMode: () => "length",
        chunkMarkdownTextWithMode,
      } } } as never,
      sendMessage: send,
    });
    expect(send.mock.calls.length).toBeGreaterThan(1);
    expect(send.mock.calls[0][2].questionId).toBe(id);
    expect(send.mock.calls.slice(1).every((call) => call[2].questionId === undefined)).toBe(true);
  });

  it("carries ask_user metadata through the outbound adapter when no presentation exists", async () => {
    await mattermostPlugin.outbound!.sendPayload!({
      cfg, to: "channel:cccccccccccccccccccccccccc", text: "Which?", payload: {
        text: "Which?", channelData: { askUser: { questionId: id } },
      },
    } as never);
    const creates = mocks.request.mock.calls.filter(([path]) => path === "/posts");
    expect(creates).toHaveLength(1);
    expect(JSON.parse(creates[0][1].body).props.attachments[0].actions[0].id).toBe("ocquestionform");
  });

  it("retains text fallback for old servers, unavailable questions and existing single-choice controls", async () => {
    observeMattermostServerVersion(cfg.channels.mattermost.baseUrl, "11.11.1");
    await sendMessageMattermost("channel:cccccccccccccccccccccccccc", "Fallback", { cfg, questionId: id });
    expect(mocks.rpc).not.toHaveBeenCalled();
    observeMattermostServerVersion(cfg.channels.mattermost.baseUrl, "12.0.0");
    mocks.rpc.mockRejectedValue(new Error("unavailable"));
    await sendMessageMattermost("channel:cccccccccccccccccccccccccc", "Fallback", { cfg, questionId: id });
    await sendMessageMattermost("channel:cccccccccccccccccccccccccc", "Single", { cfg, questionId: id,
      buttons: [[{ id: "single", text: "A", context: { oc_question: true } }]],
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls.filter(([path]) => path === "/posts")).toHaveLength(3);
  });
});
