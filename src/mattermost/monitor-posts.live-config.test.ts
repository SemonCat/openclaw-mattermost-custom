import { describe, expect, it, vi } from "vitest";

const buildEventPlan = vi.hoisted(() => vi.fn(async () => null));

vi.mock("./monitor-event-plan.js", () => ({
  buildMattermostEventPlan: buildEventPlan,
}));

import { createMattermostPostHandler } from "./monitor-posts.js";
import type { MattermostMonitorContext } from "./monitor-types.js";

describe("Mattermost post live config", () => {
  it("pins the current runtime config before planning an inbound event", async () => {
    const startupCfg = { channels: { modelByChannel: { mattermost: { room: "openai/old" } } } };
    const runtimeCfg = { channels: { modelByChannel: { mattermost: { room: "openai/new" } } } };
    const monitor = {
      account: { accountId: "default", config: {} },
      botUserId: "bot-1",
      cfg: startupCfg,
      core: { config: { current: vi.fn(() => runtimeCfg) } },
      groupPolicy: "open",
      pairing: {},
      resources: {},
      logVerboseMessage: vi.fn(),
    } as unknown as MattermostMonitorContext;
    const handler = createMattermostPostHandler(monitor);

    await handler(
      {
        id: "post-1",
        channel_id: "room",
        user_id: "user-1",
        message: "hello",
      },
      { event: "posted", data: { channel_type: "O" } },
    );

    expect(buildEventPlan).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: runtimeCfg }),
      expect.objectContaining({ channelId: "room", senderId: "user-1" }),
    );
    expect(monitor.cfg).toBe(startupCfg);
  });
});
