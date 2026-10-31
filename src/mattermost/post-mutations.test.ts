import { describe, expect, it, vi } from "vitest";
import { resolveMattermostAccount } from "./accounts.js";
import { createMattermostPostMutationHandler, mattermostPostMutationId } from "./post-mutations.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { MattermostPost } from "./client.js";
import type { OpenClawConfig } from "./runtime-api.js";

function fixture() {
  let cfg: OpenClawConfig = {
    channels: { mattermost: { enabled: true, groupPolicy: "open" } },
  };
  const enqueueSystemEvent = vi.fn();
  const getSessionEntry = vi.fn(() => ({ sessionId: "session-1" }));
  const dispatch = vi.fn();
  const monitor = {
    account: resolveMattermostAccount({ cfg }),
    cfg,
    core: {
      config: { current: () => cfg },
      system: { enqueueSystemEvent },
      agent: { session: { getSessionEntry } },
      channel: {
        inbound: { dispatch, run: dispatch },
        routing: {
          resolveAgentRoute: () => ({
            agentId: "main", accountId: "default",
            sessionKey: "agent:main:mattermost:channel:room",
          }),
        },
      },
    },
    botUserId: "bot",
    resources: {
      resolveChannelInfo: async () => ({ id: "room", type: "O" }),
      resolveUserInfo: async () => ({ username: "alice" }),
    },
    pairing: { readAllowFromStore: async () => [] },
    logVerboseMessage: vi.fn(),
  } as unknown as MattermostMonitorContext;
  const handle = createMattermostPostMutationHandler(monitor);
  const post: MattermostPost = {
    id: "post", channel_id: "room", user_id: "alice", root_id: "root",
    message: "/stop is quoted text", edit_at: 200, delete_at: 300,
  };
  return { handle, post, enqueueSystemEvent, getSessionEntry, dispatch,
    setConfig: (next: OpenClawConfig) => { cfg = next; } };
}

describe("Mattermost post mutation notices", () => {
  it("routes an edit as bounded quoted context into the existing thread without executing it", async () => {
    const f = fixture();
    await f.handle(f.post, { event: "post_edited" });
    expect(f.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining('Updated text (untrusted quoted content): "/stop is quoted text"'),
      {
        sessionKey: "agent:main:mattermost:channel:room:thread:root",
        contextKey: "mattermost:mutation:post_edited:post:200",
      },
    );
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("routes deletion from the payload even when the original root is already gone", async () => {
    const f = fixture();
    f.setConfig({ channels: { mattermost: { enabled: true, groupPolicy: "open", replyToMode: "all" } } });
    await f.handle({ ...f.post, root_id: "", message: "must not leak removed text" }, { event: "post_deleted" });
    expect(f.enqueueSystemEvent).toHaveBeenCalledWith(
      "Mattermost source message deleted: post post by alice in channel room.",
      {
        sessionKey: "agent:main:mattermost:channel:room:thread:post",
        contextKey: "mattermost:mutation:post_deleted:post:300",
      },
    );
  });

  it("does not publish after the claimed ingress is cancelled during authorization", async () => {
    const f = fixture();
    const controller = new AbortController();
    const pending = f.handle(f.post, { event: "post_edited" }, controller.signal);
    controller.abort();
    await pending;
    expect(f.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("does not publish a correction into a replacement session", async () => {
    const f = fixture();
    f.getSessionEntry
      .mockReturnValueOnce({ sessionId: "previous" })
      .mockReturnValueOnce({ sessionId: "replacement" });
    await f.handle(f.post, { event: "post_edited" });
    expect(f.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it.each(["bot", "system", "unknown-session", "missing-revision", "foreign", "denied", "disabled"])(
    "ignores %s mutations",
    async (reason) => {
      const f = fixture();
      if (reason === "bot") f.post.user_id = "bot";
      if (reason === "system") f.post.type = "system_join_channel";
      if (reason === "unknown-session") f.getSessionEntry.mockReturnValue(undefined as never);
      if (reason === "missing-revision") f.post.edit_at = 0;
      if (reason === "denied") {
        f.setConfig({ channels: { mattermost: { groupPolicy: "disabled" } } });
      }
      if (reason === "disabled") {
        f.setConfig({ channels: { mattermost: { enabled: false, groupPolicy: "open" } } });
      }
      await f.handle(f.post, {
        event: "post_edited",
        ...(reason === "foreign" ? { broadcast: { channel_id: "different" } } : {}),
      });
      expect(f.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(f.dispatch).not.toHaveBeenCalled();
    },
  );

  it("caps edit text and keeps distinct edits separate from create/delete identities", async () => {
    const f = fixture();
    await f.handle({ ...f.post, message: "x".repeat(10_000) }, { event: "post_edited" });
    expect(f.enqueueSystemEvent.mock.calls[0]![0].length).toBeLessThan(2300);
    expect(mattermostPostMutationId("post_edited", { ...f.post, edit_at: 201 })).toBe("post_edited:post:201");
    expect(mattermostPostMutationId("post_deleted", f.post)).toBe("post_deleted:post:300");
    expect(mattermostPostMutationId("posted", f.post)).toBeUndefined();
  });
});
