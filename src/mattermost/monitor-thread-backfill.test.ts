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

function createFixture(request = vi.fn(), config = cfg, historyLimit = 10) {
  const channelHistories = new Map<string, HistoryEntry[]>();
  const monitor = {
    account: { accountId: "default", config: config.channels?.mattermost ?? {} },
    cfg: config,
    botUserId: "bot",
    client: { request },
    groupPolicy: "open",
    pairing: { readAllowFromStore: vi.fn(async () => []) },
    logVerboseMessage: vi.fn(),
  } as unknown as MattermostMonitorContext;
  const recover = createMattermostThreadBackfill({
    monitor,
    channelHistories,
    historyLimit,
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

function roomTurn() {
  return {
    ...turn(),
    threadRootId: undefined,
    excludedMessageIds: ["batched-1"],
  };
}

function roomPage() {
  return {
    order: ["post-3", "old", "reply", "deleted", "system", "bot-post", "future", "batched-1"],
    posts: {
      "post-3": { id: "post-3", channel_id: "chan-1", user_id: "user-1", create_at: 300, message: "current" },
      old: { id: "old", channel_id: "chan-1", user_id: "user-1", create_at: 100, message: "earlier discussion" },
      reply: { id: "reply", channel_id: "chan-1", user_id: "user-1", create_at: 120, root_id: "old", message: "another thread" },
      deleted: { id: "deleted", channel_id: "chan-1", user_id: "user-1", create_at: 130, delete_at: 200, message: "removed" },
      system: { id: "system", channel_id: "chan-1", user_id: "user-1", create_at: 140, type: "system_join_channel", message: "joined" },
      "bot-post": { id: "bot-post", channel_id: "chan-1", user_id: "bot", create_at: 150, message: "preview" },
      future: { id: "future", channel_id: "chan-1", user_id: "user-1", create_at: 400, message: "newer" },
      "batched-1": { id: "batched-1", channel_id: "chan-1", user_id: "user-1", create_at: 250, message: "already in turn" },
    },
  };
}

describe("Mattermost room history recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionEntry.mockReturnValue(undefined);
  });

  it("takes one bounded prior channel page and retains only visible root messages", async () => {
    const { recover, request } = createFixture(vi.fn(async () => roomPage()));
    const result = await recover(roomTurn());
    expect(result).toEqual({
      current: true,
      history: [
        { sender: "user-1", body: "earlier discussion", timestamp: 100, messageId: "old" },
      ],
    });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe("/channels/chan-1/posts?per_page=11&before=post-3");
    await recover(roomTurn());
    expect(request).toHaveBeenCalledOnce();
  });

  it("applies the current sender visibility policy before including history", async () => {
    const config = {
      channels: {
        mattermost: {
          groupPolicy: "allowlist", groupAllowFrom: ["other-user"],
          contextVisibility: "allowlist",
        },
      },
    } as OpenClawConfig;
    const { recover } = createFixture(vi.fn(async () => roomPage()), config);
    expect(await recover({ ...roomTurn(), cfg: config })).toEqual({
      current: true,
      history: [],
    });
  });

  it.each(["foreign", "wrong-id", "invalid-time", "oversized", "missing-ordered-post"])(
    "omits the entire page on %s provider data, including rows outside the output window",
    async (violation) => {
      const page = roomPage();
      const posts = page.posts as Record<string, Record<string, unknown>>;
      if (violation === "foreign") {
        posts.hidden = { id: "hidden", channel_id: "different", create_at: 500 };
      } else if (violation === "wrong-id") {
        posts.hidden = { id: "different", channel_id: "chan-1", create_at: 500 };
      } else if (violation === "invalid-time") {
        posts.hidden = { id: "hidden", channel_id: "chan-1", create_at: -1 };
      } else if (violation === "missing-ordered-post") {
        page.order.push("missing");
      } else {
        for (let i = 0; i < 201; i++) {
          posts[`hidden-${i}`] = { id: `hidden-${i}`, channel_id: "chan-1", create_at: 500 };
        }
      }
      const { recover, channelHistories } = createFixture(vi.fn(async () => page));
      expect(await recover(roomTurn())).toEqual({ current: true, history: undefined });
      expect(channelHistories.size).toBe(0);
    },
  );

  it("does not publish a room snapshot after a turn is cancelled", async () => {
    let release!: (value: unknown) => void;
    const { recover, channelHistories } = createFixture(
      vi.fn(() => new Promise((resolve) => { release = resolve; })),
    );
    const controller = new AbortController();
    const pending = recover({ ...roomTurn(), abortSignal: controller.signal });
    controller.abort();
    release(roomPage());
    expect(await pending).toEqual({ current: false, history: undefined });
    expect(channelHistories.size).toBe(0);
  });

  it("does not read channel history for flat DMs or disabled history", async () => {
    const { recover, request } = createFixture();
    await recover({ ...roomTurn(), kind: "direct" });
    expect(request).not.toHaveBeenCalled();
    const disabled = createFixture(vi.fn(), cfg, 0);
    await disabled.recover(roomTurn());
    expect(disabled.request).not.toHaveBeenCalled();
  });
});
