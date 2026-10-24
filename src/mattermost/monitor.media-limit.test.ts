import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { OpenClawConfig } from "./runtime-api.js";

const state = vi.hoisted(() => ({
  monitor: undefined as MattermostMonitorContext | undefined,
  saveRemoteMedia: vi.fn(),
  core: undefined as unknown,
}));

vi.mock("../runtime.js", () => ({ getMattermostRuntime: () => state.core }));
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createMattermostClient: () => ({
    baseUrl: "https://chat.example.com",
    token: "test-token",
    request: async () => ({ mime_type: "video/mp4", name: "clip.mp4" }),
  }),
  fetchMattermostMe: async () => ({ id: "bot-id", username: "bot" }),
}));
vi.mock("./exec-approvals.js", () => ({
  isMattermostExecApprovalHandlerConfigured: () => false,
}));
vi.mock("./interactions.js", () => ({
  computeInteractionCallbackUrl: () => "http://localhost/callback",
  resolveInteractionCallbackPath: () => "/callback",
  setInteractionCallbackUrl: vi.fn(),
  setInteractionSecret: vi.fn(),
}));
vi.mock("./monitor-interactions.js", () => ({
  registerMattermostInteractions: () => ({ stop: vi.fn(), unregister: vi.fn() }),
}));
vi.mock("./monitor-model-picker.js", () => ({
  createMattermostModelPickerInteractionHandler: vi.fn(),
}));
vi.mock("./restart-recovery-progress.js", () => ({
  attachMattermostRestartRecoveryProgress: () => ({ stop: vi.fn() }),
}));
vi.mock("./monitor-posts.js", () => ({
  createMattermostPostHandler: (monitor: MattermostMonitorContext) => {
    state.monitor = monitor;
    return vi.fn();
  },
}));
vi.mock("./monitor-reactions.js", () => ({ createMattermostReactionHandler: vi.fn() }));
vi.mock("./monitor-ingress.js", () => ({
  createMattermostIngressMonitor: () => ({ receive: vi.fn(), stop: vi.fn() }),
}));
vi.mock("./monitor-websocket.js", () => ({
  createMattermostConnectOnce: () => async () => {},
}));
vi.mock("./reconnect.js", () => ({
  runWithReconnect: async (connect: () => Promise<void>) => await connect(),
}));
vi.mock("./monitor-slash.js", () => ({ registerMattermostMonitorSlashCommands: vi.fn() }));
vi.mock("./slash-state.js", () => ({ deactivateSlashCommands: vi.fn() }));
vi.mock("./task-card-continuation.js", () => ({
  createMattermostTaskCardContinuation: () => ({ stop: vi.fn() }),
}));

import { monitorMattermostProvider } from "./monitor.js";

const MiB = 1024 * 1024;

async function startMonitor(config: OpenClawConfig = {}, accountId?: string) {
  await monitorMattermostProvider({
    config,
    accountId,
    botToken: "test-token",
    baseUrl: "https://chat.example.com",
    runtime: { log: vi.fn(), error: vi.fn() } as never,
  });
  expect(state.monitor).toBeDefined();
  return state.monitor!;
}

describe("Mattermost inbound media limit at monitor startup", () => {
  beforeEach(() => {
    state.monitor = undefined;
    state.saveRemoteMedia.mockReset().mockResolvedValue({
      path: "/tmp/clip.mp4",
      contentType: "video/mp4",
    });
    state.core = {
      channel: {
        pairing: {},
        debounce: {
          resolveInboundDebounceMs: () => 0,
          createInboundDebouncer: () => ({ enqueue: vi.fn() }),
        },
        media: { saveRemoteMedia: state.saveRemoteMedia },
      },
      logging: { getChildLogger: () => ({}), shouldLogVerbose: () => false },
      media: { mediaKindFromMime: () => "video" },
    };
  });

  it.each([
    { name: "8 MiB default", config: {}, expectedMb: 8 },
    {
      name: "agent fallback",
      config: { agents: { defaults: { mediaMaxMb: 16 } } },
      expectedMb: 16,
    },
    {
      name: "channel setting before agent fallback",
      config: {
        agents: { defaults: { mediaMaxMb: 16 } },
        channels: { mattermost: { mediaMaxMb: 32 } },
      },
      expectedMb: 32,
    },
    {
      name: "named account inherits channel setting",
      config: { channels: { mattermost: { mediaMaxMb: 32, accounts: { work: {} } } } },
      accountId: "work",
      expectedMb: 32,
    },
    {
      name: "account override before channel and agent settings",
      config: {
        agents: { defaults: { mediaMaxMb: 16 } },
        channels: { mattermost: { mediaMaxMb: 32, accounts: { work: { mediaMaxMb: 64 } } } },
      },
      accountId: "work",
      expectedMb: 64,
    },
    {
      name: "named account falls back to agent setting",
      config: {
        agents: { defaults: { mediaMaxMb: 16 } },
        channels: { mattermost: { accounts: { work: {} } } },
      },
      accountId: "work",
      expectedMb: 16,
    },
    {
      name: "explicit 1 GiB channel setting",
      config: { channels: { mattermost: { mediaMaxMb: 1024 } } },
      expectedMb: 1024,
    },
  ])("passes $name to the actual download resource", async ({ config, accountId, expectedMb }) => {
    const monitor = await startMonitor(config as OpenClawConfig, accountId);
    await expect(monitor.resources.resolveMattermostMedia(["file-video"])).resolves.toMatchObject([
      { path: "/tmp/clip.mp4", kind: "video" },
    ]);
    expect(state.saveRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({ maxBytes: expectedMb * MiB }),
    );
  });

  it("uses a virtual 1 GiB boundary without allocating the attachment", async () => {
    const monitor = await startMonitor({ channels: { mattermost: { mediaMaxMb: 1024 } } });
    const sizes = [1024 * MiB - 1, 1024 * MiB, 1024 * MiB + 1];
    state.saveRemoteMedia.mockImplementation(async ({ filePathHint, maxBytes }) => {
      const size = sizes[Number(filePathHint)];
      if (size > maxBytes) {
        throw Object.assign(new Error("size rejected"), { code: "max_bytes" });
      }
      return { path: `/tmp/virtual-${filePathHint}.mp4`, contentType: "video/mp4" };
    });
    const media = await monitor.resources.resolveMattermostMedia(["0", "1", "2"]);
    expect(media.map((entry) => entry.path)).toEqual([
      "/tmp/virtual-0.mp4",
      "/tmp/virtual-1.mp4",
      undefined,
    ]);
    expect(state.saveRemoteMedia.mock.calls.map(([params]) => params.maxBytes)).toEqual([
      1024 * MiB,
      1024 * MiB,
      1024 * MiB,
    ]);
  });
});
