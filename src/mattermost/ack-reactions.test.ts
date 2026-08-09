// Mattermost tests cover emoji-name resolution and the reaction transport adapter.
import { describe, expect, it, vi } from "vitest";
import {
  createMattermostStatusReactionAdapter,
  resolveMattermostReactionEmojiName,
} from "./ack-reactions.js";
import type { MattermostClient } from "./client.js";

describe("resolveMattermostReactionEmojiName", () => {
  it.each([
    ["👀", "eyes"],
    [":eyes:", "eyes"],
    ["white_check_mark", "white_check_mark"],
    ["❤️", "heart"],
    ["+1", "+1"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(resolveMattermostReactionEmojiName(input)).toBe(expected);
  });

  it.each(["", "🦄", ":eyes", "eyes:", "skin tone"])("rejects invalid name %s", (input) => {
    expect(resolveMattermostReactionEmojiName(input)).toBeNull();
  });
});

describe("createMattermostStatusReactionAdapter", () => {
  function createStubClient(request: MattermostClient["request"]): MattermostClient {
    return {
      baseUrl: "https://mattermost.example.com",
      apiBaseUrl: "https://mattermost.example.com/api/v4",
      token: "bot-token",
      request,
      fetchImpl: fetch,
    };
  }

  it("adds a reaction through the authenticated monitor client", async () => {
    const request = vi.fn(async () => ({}));
    const adapter = createMattermostStatusReactionAdapter({
      client: createStubClient(request as unknown as MattermostClient["request"]),
      botUserId: "bot-1",
      postId: "post-1",
    });

    await adapter.setReaction("brain");

    expect(request).toHaveBeenCalledExactlyOnceWith("/reactions", {
      method: "POST",
      body: JSON.stringify({ user_id: "bot-1", post_id: "post-1", emoji_name: "brain" }),
    });
  });

  it("removes a reaction through the authenticated monitor client", async () => {
    const request = vi.fn(async () => ({}));
    const adapter = createMattermostStatusReactionAdapter({
      client: createStubClient(request as unknown as MattermostClient["request"]),
      botUserId: "bot-1",
      postId: "post-1",
    });

    await adapter.removeReaction?.("brain");

    expect(request).toHaveBeenCalledExactlyOnceWith("/users/bot-1/posts/post-1/reactions/brain", {
      method: "DELETE",
    });
  });
});
