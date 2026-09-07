import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { ChunkMode } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../../runtime-api.js";
import { deliverMattermostReplyPayload } from "./reply-delivery.js";
import type { MattermostSendResult } from "./send.js";

type DeliveryParams = Parameters<typeof deliverMattermostReplyPayload>[0];
type TableMode = Parameters<
  DeliveryParams["core"]["channel"]["text"]["convertMarkdownTables"]
>[1];

function createCore(): DeliveryParams["core"] {
  return {
    channel: {
      text: {
        convertMarkdownTables: vi.fn((text: string) => text),
        resolveChunkMode: vi.fn<() => ChunkMode>(() => "length"),
        chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
      },
    },
  } as unknown as PluginRuntime;
}

function createSendMessageMock() {
  return vi.fn(async (_to: string, content: string): Promise<MattermostSendResult> => ({
    messageId: "post-1",
    channelId: "channel-1",
    content,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: "mattermost", messageId: "post-1", channelId: "channel-1" }],
      kind: "text",
    }),
  }));
}

function deliveryParams(
  payload: DeliveryParams["payload"],
  sendMessage: DeliveryParams["sendMessage"],
): DeliveryParams {
  return {
    core: createCore(),
    cfg: {} satisfies OpenClawConfig,
    payload,
    channelId: "town-square",
    accountId: "default",
    replyToId: "root-post",
    textLimit: 4_000,
    tableMode: "off" as TableMode,
    sendMessage,
  };
}

describe("Mattermost secret prompt delivery", () => {
  it("adds a credential button and question finalization identity", async () => {
    const sendMessage = createSendMessageMock();
    const questionId = "ask_0123456789abcdef0123456789abcdef";

    await deliverMattermostReplyPayload(
      deliveryParams(
        {
          text: `🔑 Agent requests credential LANGFUSE_SECRET_KEY (secret). Reply is disabled for secrets — open to provide it: https://openclaw.example/ask/${questionId}`,
          channelData: { askUser: { questionId } },
        },
        sendMessage,
      ),
    );

    expect(sendMessage).toHaveBeenCalledWith(
      "channel:town-square",
      expect.any(String),
      expect.objectContaining({
        questionId,
        buttons: [
          [
            expect.objectContaining({
              id: "ocsecretinput",
              text: "Enter credential",
              context: expect.objectContaining({ question_id: questionId }),
            }),
          ],
        ],
      }),
    );
  });

  it("does not add credential controls to an ordinary ask_user prompt", async () => {
    const sendMessage = createSendMessageMock();
    const questionId = "ask_0123456789abcdef0123456789abcdef";

    await deliverMattermostReplyPayload(
      deliveryParams(
        {
          text: "Question for you: choose one",
          channelData: { askUser: { questionId } },
        },
        sendMessage,
      ),
    );

    expect(sendMessage.mock.calls[0]?.[2]).not.toHaveProperty("buttons");
    expect(sendMessage.mock.calls[0]?.[2]).not.toHaveProperty("questionId");
  });
});
