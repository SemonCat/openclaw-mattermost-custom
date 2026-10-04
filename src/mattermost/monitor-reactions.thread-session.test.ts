// Mattermost tests cover reaction routing into the reacted post's thread session.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMattermostAccount } from "./accounts.js";
import { createMattermostReactionHandler } from "./monitor-reactions.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { MattermostEventPayload } from "./monitor-websocket.js";
import type { OpenClawConfig } from "./runtime-api.js";

describe("Mattermost reaction thread routing", () => {
  const enqueueSystemEvent = vi.fn();
  const resolvePostInfo = vi.fn();

  beforeEach(() => {
    enqueueSystemEvent.mockReset();
    resolvePostInfo.mockReset();
  });

  function createHandler() {
    const cfg = {
      channels: { mattermost: { enabled: true, groupPolicy: "open" } },
    } as OpenClawConfig;
    const account = resolveMattermostAccount({ cfg, accountId: "default" });
    const core = {
      config: { current: () => cfg },
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            accountId: "default",
            agentId: "main",
            lastRoutePolicy: "main",
            mainSessionKey: "mattermost:default:channel:room",
            sessionKey: "mattermost:default:channel:room",
          }),
        },
      },
      system: { enqueueSystemEvent },
    };
    const monitor = {
      account,
      botUserId: "bot-user",
      cfg,
      core,
      groupPolicy: "open",
      pairing: { readAllowFromStore: async () => [] },
      resources: {
        resolveChannelInfo: async () => ({ id: "room", type: "O" }),
        resolveUserInfo: async () => ({ id: "user-1", username: "alice" }),
        resolvePostInfo,
      },
      logVerboseMessage: vi.fn(),
      logDebugMessage: vi.fn(),
    } as unknown as MattermostMonitorContext;
    return createMattermostReactionHandler(monitor);
  }

  async function emit(handler: ReturnType<typeof createHandler>) {
    await handler({
      event: "reaction_added",
      data: {
        reaction: JSON.stringify({
          user_id: "user-1",
          post_id: "post-reply",
          emoji_name: "thumbsup",
        }),
      },
      broadcast: { channel_id: "room" },
    } as MattermostEventPayload);
  }

  it("routes a reply reaction to the resolved thread root", async () => {
    resolvePostInfo.mockResolvedValue({ id: "post-reply", root_id: "root-1" });
    const handler = createHandler();

    await emit(handler);

    expect(resolvePostInfo).toHaveBeenCalledWith("post-reply");
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("Mattermost reaction added"),
      expect.objectContaining({
        sessionKey: "mattermost:default:channel:room:thread:root-1",
        contextKey: "mattermost:reaction:post-reply:thumbsup:user-1:added",
      }),
    );
  });

  it("keeps the parent channel session when the post lookup fails", async () => {
    resolvePostInfo.mockResolvedValue(null);
    const handler = createHandler();

    await emit(handler);

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("Mattermost reaction added"),
      expect.objectContaining({ sessionKey: "mattermost:default:channel:room" }),
    );
  });
});
