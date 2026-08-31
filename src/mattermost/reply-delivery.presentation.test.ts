import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../../runtime-api.js";
import { deliverMattermostReplyPayload } from "./reply-delivery.js";
import type { MattermostSendResult } from "./send.js";

function createCore(): PluginRuntime {
  return {
    channel: {
      text: {
        convertMarkdownTables: (text: string) => text,
        resolveChunkMode: () => "length",
        chunkMarkdownTextWithMode: (text: string) => [text],
      },
    },
  } as unknown as PluginRuntime;
}

function createSendMock() {
  return vi.fn(async (_to: string, text: string): Promise<MattermostSendResult> => ({
    messageId: "post-1",
    channelId: "channel-1",
    content: text,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: "mattermost", messageId: "post-1", channelId: "channel-1" }],
      kind: "text",
    }),
  }));
}

describe("Mattermost normal reply presentation delivery", () => {
  it("renders presentation text and sends buttons on the first provider post", async () => {
    const sendMessage = createSendMock();

    await deliverMattermostReplyPayload({
      core: createCore(),
      cfg: {} satisfies OpenClawConfig,
      payload: {
        presentation: {
          blocks: [
            { type: "text", text: "Choose one" },
            {
              type: "buttons",
              buttons: [
                { label: "Sol", value: "openai/gpt-5.6-sol", style: "primary" },
              ],
            },
          ],
        },
      },
      channelId: "town-square",
      accountId: "default",
      replyToId: "root-post",
      textLimit: 4000,
      tableMode: "off",
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "channel:town-square",
      expect.stringContaining("Choose one"),
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              text: "Sol",
              callback_data: "openai/gpt-5.6-sol",
              style: "primary",
            }),
          ],
        ],
      }),
    );
  });

  it("requires successful upload for local media replies", async () => {
    const sendMessage = createSendMock();

    await deliverMattermostReplyPayload({
      core: createCore(),
      cfg: {} satisfies OpenClawConfig,
      payload: { text: "caption", mediaUrl: "/tmp/photo.png" },
      channelId: "town-square",
      accountId: "default",
      textLimit: 4000,
      tableMode: "off",
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "channel:town-square",
      "caption",
      expect.objectContaining({
        mediaUrl: "/tmp/photo.png",
        requireMediaUpload: true,
      }),
    );
  });
});
