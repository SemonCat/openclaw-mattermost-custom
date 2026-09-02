import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import { createMattermostPostWithButtonFallback } from "./button-delivery.js";

function createClient(request: MattermostClient["request"]): MattermostClient {
  return {
    baseUrl: "https://chat.example.com",
    apiBaseUrl: "https://chat.example.com/api/v4",
    token: "token",
    request,
    fetchImpl: vi.fn() as MattermostClient["fetchImpl"],
  };
}

describe("createMattermostPostWithButtonFallback", () => {
  it("uses native Blocks on the first accepted create", async () => {
    const request = vi.fn<MattermostClient["request"]>(async () => ({ id: "post-1" }) as never);
    const blockProps = { mm_blocks: [{ type: "text", text: "Choose" }] };

    const result = await createMattermostPostWithButtonFallback({
      client: createClient(request),
      post: { channelId: "CHAN1", message: "Choose", props: blockProps },
      legacyProps: { attachments: [] },
    });

    expect(result).toMatchObject({ post: { id: "post-1" }, props: blockProps });
    expect(request).toHaveBeenCalledOnce();
  });

  it("falls back once after an explicit HTTP 400 rejection", async () => {
    const request = vi
      .fn<MattermostClient["request"]>()
      .mockRejectedValueOnce(new Error("Mattermost API 400 Bad Request: blocks disabled"))
      .mockResolvedValueOnce({ id: "legacy-post" });
    const warn = vi.fn();
    const legacyProps = { attachments: [{ actions: [] }] };

    const result = await createMattermostPostWithButtonFallback({
      client: createClient(request),
      post: { channelId: "CHAN1", message: "Choose", props: { mm_blocks: [] } },
      legacyProps,
      warn,
    });

    expect(result).toMatchObject({ post: { id: "legacy-post" }, props: legacyProps });
    expect(request).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    const fallbackBody = request.mock.calls[1]?.[1]?.body;
    expect(typeof fallbackBody === "string" ? JSON.parse(fallbackBody) : undefined).toMatchObject({
      props: legacyProps,
    });
  });

  it("does not retry an ambiguous provider failure", async () => {
    const request = vi
      .fn<MattermostClient["request"]>()
      .mockRejectedValueOnce(new Error("socket closed after write"));

    await expect(
      createMattermostPostWithButtonFallback({
        client: createClient(request),
        post: { channelId: "CHAN1", message: "Choose", props: { mm_blocks: [] } },
        legacyProps: { attachments: [] },
      }),
    ).rejects.toThrow("socket closed after write");
    expect(request).toHaveBeenCalledOnce();
  });
});
