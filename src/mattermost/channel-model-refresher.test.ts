import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_MODEL_HEADER_PATCH_DELAY_MS,
  CHANNEL_MODEL_HEADER_REFRESH_INTERVAL_MS,
  CHANNEL_MODEL_HEADER_STARTUP_DELAY_MS,
  createMattermostChannelModelHeaderRefresherService,
  refreshMattermostChannelModelHeaders,
  type ChannelModelHeaderRefresherDependencies,
} from "./channel-model-refresher.js";

function createHarness() {
  const cfg = {
    channels: {
      modelByChannel: {
        mattermost: {
          "channel-override": "provider/channel-model",
        },
      },
    },
  };
  const request = vi.fn(async () => [
    {
      id: "channel-default",
      type: "O",
      team_id: "team-1",
      header: "Team notes",
    },
    {
      id: "channel-override",
      type: "P",
      team_id: "team-1",
      header: "🤖 **Default model:** `old/model`\nPrivate notes",
    },
    {
      id: "channel-unchanged",
      type: "O",
      team_id: "team-1",
      header: "🤖 **Default model:** `provider/main-model`",
    },
    { id: "direct-message", type: "D", header: "DM notes" },
  ]);
  const client = {
    baseUrl: "https://mattermost.example.com",
    apiBaseUrl: "https://mattermost.example.com/api/v4",
    token: "token",
    request,
    fetchImpl: vi.fn(),
  };
  const dependencies: ChannelModelHeaderRefresherDependencies = {
    buildModelsProviderData: vi.fn(async (_cfg, agentId) => ({
      providers: ["provider"],
      byProvider: new Map([["provider", new Set(["main-model"])]]),
      resolvedDefault: { provider: "provider", model: `${agentId}-model` },
      aliases: [],
    })) as never,
    createMattermostClient: vi.fn(() => client) as never,
    fetchMattermostMe: vi.fn(async () => ({ id: "bot-user" })),
    listMattermostAccountIds: vi.fn(() => ["default"]),
    patchMattermostChannelHeader: vi.fn(async (_client, channelId, header) => ({
      id: channelId,
      header,
    })),
    resolveAgentRoute: vi.fn(() => ({ agentId: "main" })) as never,
    resolveMattermostAccount: vi.fn(() => ({
      accountId: "default",
      enabled: true,
      baseUrl: "https://mattermost.example.com",
      botToken: "token",
      config: {},
    })) as never,
    delay: vi.fn(async () => {}),
  };
  const api = {
    runtime: {
      config: { current: () => cfg },
    },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { api, client, dependencies, logger, request };
}

describe("refreshMattermostChannelModelHeaders", () => {
  it("refreshes visible channel headers sequentially with effective routed defaults", async () => {
    const harness = createHarness();

    const stats = await refreshMattermostChannelModelHeaders(harness as never);

    expect(harness.request).toHaveBeenCalledWith("/users/bot-user/channels?per_page=200");
    expect(harness.dependencies.patchMattermostChannelHeader).toHaveBeenNthCalledWith(
      1,
      harness.client,
      "channel-default",
      "🤖 **Default model:** `provider/main-model`\nTeam notes",
    );
    expect(harness.dependencies.patchMattermostChannelHeader).toHaveBeenNthCalledWith(
      2,
      harness.client,
      "channel-override",
      "🤖 **Default model:** `provider/channel-model`\nPrivate notes",
    );
    expect(harness.dependencies.delay).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.delay).toHaveBeenNthCalledWith(
      1,
      CHANNEL_MODEL_HEADER_PATCH_DELAY_MS,
      undefined,
    );
    expect(stats).toEqual({
      accounts: 1,
      scanned: 3,
      updated: 2,
      unchanged: 1,
      skipped: 0,
      errors: 0,
    });
  });

  it("continues after one channel update fails and still applies the write delay", async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.patchMattermostChannelHeader)
      .mockRejectedValueOnce(new Error("patch failed"))
      .mockResolvedValueOnce({ id: "channel-override" });

    const stats = await refreshMattermostChannelModelHeaders(harness as never);

    expect(harness.dependencies.patchMattermostChannelHeader).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.delay).toHaveBeenCalledTimes(2);
    expect(stats.updated).toBe(1);
    expect(stats.errors).toBe(1);
    expect(harness.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("channel channel-default failed: patch failed"),
    );
  });
});

describe("createMattermostChannelModelHeaderRefresherService", () => {
  it("runs after startup, waits one hour between completed passes, and stops cleanly", async () => {
    const harness = createHarness();
    harness.dependencies.delay = vi.fn(async (milliseconds, signal) => {
      if (milliseconds !== CHANNEL_MODEL_HEADER_REFRESH_INTERVAL_MS) {
        return;
      }
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const service = createMattermostChannelModelHeaderRefresherService(
      harness.api as never,
      harness.dependencies,
    );
    const context = { logger: harness.logger };

    service.start(context as never);
    await vi.waitFor(() => {
      expect(harness.logger.info).toHaveBeenCalledOnce();
    });

    expect(harness.dependencies.delay).toHaveBeenNthCalledWith(
      1,
      CHANNEL_MODEL_HEADER_STARTUP_DELAY_MS,
      expect.any(AbortSignal),
    );
    expect(harness.dependencies.delay).toHaveBeenLastCalledWith(
      CHANNEL_MODEL_HEADER_REFRESH_INTERVAL_MS,
      expect.any(AbortSignal),
    );

    await service.stop?.(context as never);
    expect(harness.logger.error).not.toHaveBeenCalled();
  });
});
