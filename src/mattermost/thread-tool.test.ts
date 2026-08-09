import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { createMattermostClient } from "./client.js";
import { createMattermostTestConfig, requestUrl } from "./reactions.test-helpers.js";
import { createMattermostThreadTool } from "./thread-tool.js";

const ROOT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const LINK_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("mattermost_thread tool", () => {
  it("is available only in a trusted Mattermost conversation", () => {
    const cfg = createMattermostTestConfig("thread-tool-surface");
    const api = { config: cfg } as OpenClawPluginApi;

    expect(
      createMattermostThreadTool(api, {
        runtimeConfig: cfg,
        messageChannel: "slack",
        nativeChannelId: "CURRENT",
      }),
    ).toBeNull();
    expect(
      createMattermostThreadTool(api, {
        runtimeConfig: cfg,
        messageChannel: "mattermost",
        nativeChannelId: "CURRENT",
      }),
    ).toMatchObject({ name: "mattermost_thread", resultContentSource: "network" });
  });

  it("reads an authorized same-instance thread and rejects foreign-host links", async () => {
    const cfg = createMattermostTestConfig("thread-tool-read");
    const baseUrl = cfg.channels!.mattermost!.baseUrl!;
    cfg.channels!.mattermost!.permalinkHydration = {
      allowedOrigins: ["https://public.example.com"],
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.endsWith(`/api/v4/posts/${LINK_ID}`)) {
        return jsonResponse({
          id: LINK_ID,
          root_id: ROOT_ID,
          channel_id: "CURRENT",
          user_id: "user-1",
          message: "reply",
          create_at: 2_000,
        });
      }
      if (url.endsWith("/api/v4/channels/CURRENT")) {
        return jsonResponse({ id: "CURRENT", type: "P", display_name: "Private current" });
      }
      if (url.includes(`/api/v4/posts/${ROOT_ID}/thread?perPage=`)) {
        return jsonResponse({
          order: [ROOT_ID, LINK_ID],
          posts: {
            [ROOT_ID]: {
              id: ROOT_ID,
              channel_id: "CURRENT",
              user_id: "user-1",
              message: "root",
              create_at: 1_000,
            },
            [LINK_ID]: {
              id: LINK_ID,
              root_id: ROOT_ID,
              channel_id: "CURRENT",
              user_id: "user-1",
              message: "reply",
              create_at: 2_000,
            },
          },
        });
      }
      if (url.endsWith("/api/v4/users/ids")) {
        return jsonResponse([{ id: "user-1", username: "alice" }]);
      }
      throw new Error(`Unexpected Mattermost request: ${url}`);
    });
    const client = createMattermostClient({ baseUrl, botToken: "token", fetchImpl });
    const context = {
      runtimeConfig: cfg,
      messageChannel: "mattermost",
      nativeChannelId: "CURRENT",
    } satisfies OpenClawPluginToolContext;
    const tool = createMattermostThreadTool({ config: cfg } as OpenClawPluginApi, context, {
      createClient: () => client,
    });
    expect(tool).not.toBeNull();

    const result = await tool!.execute("call-1", {
      url_or_post_id: `${baseUrl}/team/pl/${LINK_ID}`,
    });
    expect(result.details).toMatchObject({
      untrusted: true,
      requestedPostId: LINK_ID,
      rootPostId: ROOT_ID,
      channel: { id: "CURRENT", type: "P" },
      posts: [{ id: ROOT_ID }, { id: LINK_ID }],
    });

    await expect(
      tool!.execute("call-public", {
        url_or_post_id: `https://public.example.com/team/pl/${LINK_ID}`,
      }),
    ).resolves.toMatchObject({ details: { requestedPostId: LINK_ID } });

    await expect(
      tool!.execute("call-2", {
        url_or_post_id: `https://evil.example.com/team/pl/${LINK_ID}`,
      }),
    ).rejects.toThrow("same-instance Mattermost /pl/ permalink");
  });
});
