import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionEntry = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry,
  resolveStorePath: () => "/tmp/mattermost-sessions.sqlite",
}));

import { createMattermostThreadBackfill } from "./monitor-thread-backfill.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { HistoryEntry, OpenClawConfig } from "./runtime-api.js";

const cfg = { channels: { mattermost: { groupPolicy: "open" } } } as OpenClawConfig;

function createFixture(request = vi.fn()) {
  const channelHistories = new Map<string, HistoryEntry[]>();
  const monitor = {
    account: { accountId: "default", config: { groupPolicy: "open" } },
    cfg,
    client: { request },
    groupPolicy: "open",
    pairing: { readAllowFromStore: vi.fn(async () => []) },
    logVerboseMessage: vi.fn(),
  } as unknown as MattermostMonitorContext;
  const recover = createMattermostThreadBackfill({
    monitor,
    channelHistories,
    historyLimit: 10,
  });
  return { channelHistories, monitor, recover, request };
}

function turn() {
  return {
    cfg,
    historyKey: "agent:main:mattermost:channel:chan-1:thread:root-1",
    agentId: "main",
    channelId: "chan-1",
    kind: "channel" as const,
    threadRootId: "root-1",
    currentPostId: "post-3",
    currentPostTimestamp: 300,
  };
}

describe("Mattermost thread backfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionEntry.mockReturnValue(undefined);
  });

  it("recovers bounded prior thread posts before dispatch", async () => {
    const request = vi.fn(async () => ({
      order: ["root-1", "post-2", "post-3"],
      posts: {
        "root-1": {
          id: "root-1",
          user_id: "user-1",
          channel_id: "chan-1",
          message: "root question",
          create_at: 100,
        },
        "post-2": {
          id: "post-2",
          user_id: "user-2",
          channel_id: "chan-1",
          root_id: "root-1",
          message: "prior reply",
          create_at: 200,
        },
        "post-3": {
          id: "post-3",
          user_id: "user-1",
          channel_id: "chan-1",
          root_id: "root-1",
          message: "current",
          create_at: 300,
        },
      },
    }));
    const { channelHistories, recover } = createFixture(request);

    await expect(recover(turn())).resolves.toEqual({
      current: true,
      history: [
        { sender: "user-1", body: "root question", timestamp: 100, messageId: "root-1" },
        { sender: "user-2", body: "prior reply", timestamp: 200, messageId: "post-2" },
      ],
    });
    expect(request.mock.calls[0]?.[0]).toContain(
      "/posts/root-1/thread?perPage=11&direction=up&fromPost=post-3&fromCreateAt=300",
    );
    expect(channelHistories.get(turn().historyKey)).toHaveLength(2);
  });

  it("drops a completion invalidated by a session rotation", async () => {
    let release: ((value: unknown) => void) | undefined;
    const request = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { recover } = createFixture(request);
    const pending = recover(turn());
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    getSessionEntry.mockReturnValue({ sessionId: "new-session", lifecycleRevision: 1 });
    release?.({ order: [], posts: {} });

    await expect(pending).resolves.toEqual({ current: false, history: undefined });
  });

  it("fails open without blocking the inbound turn", async () => {
    const { monitor, recover } = createFixture(vi.fn(async () => {
      throw new Error("Mattermost API 403 Forbidden");
    }));

    await expect(recover(turn())).resolves.toEqual({ current: true, history: undefined });
    expect(monitor.logVerboseMessage).toHaveBeenCalledWith(
      expect.stringContaining("thread recovery gave up"),
    );
  });
});
