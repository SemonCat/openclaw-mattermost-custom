import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../../runtime-api.js";
import { resolveMattermostPresentation } from "../normalize.js";
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
  it("renders question buttons and carries their finalization identity on the first post", async () => {
    const sendMessage = createSendMock();
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const payload = {
      text: "Which environment?\n- staging",
      presentationTextMode: "fallback" as const,
      presentation: {
        blocks: [
          { type: "text" as const, text: "Which environment?" },
          {
            type: "buttons" as const,
            buttons: [
              {
                label: "staging",
                action: {
                  type: "question" as const,
                  questionId,
                  optionValue: "staging",
                },
              },
              {
                label: "production",
                action: {
                  type: "question" as const,
                  questionId,
                  optionValue: "production",
                },
              },
            ],
          },
        ],
      },
      channelData: {
        askUser: { questionId, optionValues: ["staging", "production"] },
      },
    };

    expect(resolveMattermostPresentation(payload).buttons).toHaveLength(1);

    await deliverMattermostReplyPayload({
      core: createCore(),
      cfg: {} satisfies OpenClawConfig,
      payload,
      channelId: "town-square",
      accountId: "default",
      replyToId: "root-post",
      textLimit: 4000,
      tableMode: "off",
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "channel:town-square",
      expect.stringContaining("Which environment?"),
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              text: "staging",
              context: expect.objectContaining({ question_id: questionId, option_index: 0 }),
            }),
            expect.objectContaining({
              text: "production",
              context: expect.objectContaining({ question_id: questionId, option_index: 1 }),
            }),
          ],
        ],
        questionId,
      }),
    );
  });

  it("does not register ordinary non-question presentation buttons as questions", async () => {
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
              buttons: [{ label: "Sol", value: "openai/gpt-5.6-sol" }],
            },
          ],
        },
      },
      channelId: "town-square",
      accountId: "default",
      textLimit: 4000,
      tableMode: "off",
      sendMessage,
    });

    expect(sendMessage.mock.calls[0]?.[2]).not.toHaveProperty("questionId");
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
