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

    expect(request).toHaveBeenCalledWith("/posts/post-1", {
      method: "PUT",
      body: JSON.stringify({ id: "post-1", message: "Credential requested\n\nAnswered", props: {} }),
    });
  });
});
