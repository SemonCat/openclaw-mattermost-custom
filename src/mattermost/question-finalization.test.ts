import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import { registerMattermostQuestionDelivery } from "./question-finalization.js";

describe("Mattermost question finalization", () => {
  it("clears controls and annotates the delivered prompt without exposing an answer", async () => {
    const request = vi.fn(async () => ({ id: "post-1" }));
    const registerChannelDelivery = vi.fn();
    registerMattermostQuestionDelivery({
      accountId: "default",
      client: { request } as unknown as MattermostClient,
      post: {
        id: "post-1",
        channel_id: "channel-1",
        message: "Credential requested",
      },
      questionId: "ask_0123456789abcdef0123456789abcdef",
      registerChannelDelivery,
    });

    expect(registerChannelDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        questionId: "ask_0123456789abcdef0123456789abcdef",
        deliveryId: "mattermost:default:channel-1:post-1",
      }),
    );
    const finalize = registerChannelDelivery.mock.calls[0]?.[0]?.finalize as
      | ((status: string) => Promise<void>)
      | undefined;
    await finalize?.("Answered");

    expect(request).toHaveBeenCalledWith("/posts/post-1/patch", {
      method: "PUT",
      body: JSON.stringify({ id: "post-1", message: "Credential requested\n\nAnswered", props: {} }),
    });
  });

  it("retires legacy controls into a non-interactive terminal card", async () => {
    const request = vi.fn(async () => ({ id: "post-1" }));
    const registerChannelDelivery = vi.fn();
    registerMattermostQuestionDelivery({
      accountId: "default",
      client: { request } as unknown as MattermostClient,
      post: {
        id: "post-1",
        channel_id: "channel-1",
        message: "Question for you:\n\nWhich release?",
        props: {
          attachments: [
            {
              text: "Orders PR",
              color: "#3f4350",
              actions: [{ id: "question0", integration: { context: { _token: "secret" } } }],
            },
          ],
        },
      },
      questionId: "ask_0123456789abcdef0123456789abcdef",
      registerChannelDelivery,
    });

    const finalize = registerChannelDelivery.mock.calls[0]?.[0]?.finalize as
      | ((status: string) => Promise<void>)
      | undefined;
    await finalize?.("Expired");

    expect(request).toHaveBeenCalledWith("/posts/post-1/patch", {
      method: "PUT",
      body: JSON.stringify({
        id: "post-1",
        message: "Question for you:\n\nWhich release?",
        props: {
          attachments: [{ text: "Orders PR\n\n**Expired**", color: "#3f4350" }],
        },
      }),
    });
  });

  it("retires Blocks controls while preserving non-interactive content", async () => {
    const request = vi.fn(async () => ({ id: "post-1" }));
    const registerChannelDelivery = vi.fn();
    registerMattermostQuestionDelivery({
      accountId: "default",
      client: { request } as unknown as MattermostClient,
      post: {
        id: "post-1",
        channel_id: "channel-1",
        message: "Question for you:\n\nWhich release?",
        props: {
          mm_blocks: [
            { type: "text", text: "Orders PR" },
            {
              type: "container",
              content: [{ type: "button", text: "1. Create PR", action_id: "question0" }],
            },
          ],
          mm_blocks_actions: { question0: { context: { _token: "secret" } } },
        },
      },
      questionId: "ask_0123456789abcdef0123456789abcdef",
      registerChannelDelivery,
    });

    const finalize = registerChannelDelivery.mock.calls[0]?.[0]?.finalize as
      | ((status: string) => Promise<void>)
      | undefined;
    await finalize?.("Answered");

    expect(request).toHaveBeenCalledWith("/posts/post-1/patch", {
      method: "PUT",
      body: JSON.stringify({
        id: "post-1",
        message: "Question for you:\n\nWhich release?",
        props: {
          mm_blocks: [
            { type: "text", text: "Orders PR" },
            { type: "text", text: "**Answered**" },
          ],
        },
      }),
    });
  });
});
