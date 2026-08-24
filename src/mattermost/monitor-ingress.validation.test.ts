// Mattermost ingress validation tests use a captured shared monitor so they run
// against the standalone npm Plugin SDK without monorepo-only test exports.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  options: undefined as unknown,
  admit: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createChannelIngressMonitor: vi.fn((options: unknown) => {
      mockState.options = options;
      return {
        start: vi.fn(),
        admit: mockState.admit,
        stop: vi.fn(async () => {}),
        waitForIdle: vi.fn(async () => {}),
      };
    }),
  };
});

import { createMattermostIngressMonitor } from "./monitor-ingress.js";

type CapturedMonitorOptions = {
  inspect: (rawEvent: string) => unknown;
  deliver: (rawEvent: string, lifecycle: unknown, claim: { id: string }) => Promise<unknown>;
};

function capturedOptions(): CapturedMonitorOptions {
  return mockState.options as CapturedMonitorOptions;
}

function postedEvent(params: { postId: string; userId?: string }): string {
  return JSON.stringify({
    event: "posted",
    data: {
      post: JSON.stringify({
        id: params.postId,
        channel_id: "channel-1",
        ...(params.userId ? { user_id: params.userId } : {}),
        message: "hello",
      }),
    },
    broadcast: { channel_id: "channel-1", user_id: "broadcast-user" },
  });
}

describe("Mattermost ingress validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.admit.mockImplementation(async (rawEvent: string) => {
      capturedOptions().inspect(rawEvent);
    });
  });

  it("drops an authorless live event visibly and keeps accepting later ingress", async () => {
    const runtime = { error: vi.fn(), log: vi.fn() };
    const monitor = createMattermostIngressMonitor({
      accountId: "default",
      queue: {} as never,
      dispatch: vi.fn(),
      runtime,
    });

    await expect(monitor.receive(postedEvent({ postId: "missing-author" }))).resolves.toBeUndefined();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Mattermost posted event is missing post.user_id"),
    );
    await expect(
      monitor.receive(postedEvent({ postId: "valid", userId: "user-1" })),
    ).resolves.toBeUndefined();
  });

  it("rejects a persisted authorless post instead of trusting broadcast.user_id", async () => {
    createMattermostIngressMonitor({
      accountId: "default",
      queue: {} as never,
      dispatch: vi.fn(),
      runtime: { error: vi.fn(), log: vi.fn() },
    });

    await expect(
      capturedOptions().deliver(
        postedEvent({ postId: "persisted-missing-author" }),
        {},
        { id: "persisted-missing-author" },
      ),
    ).rejects.toThrow("invalid post identity");
  });
});
