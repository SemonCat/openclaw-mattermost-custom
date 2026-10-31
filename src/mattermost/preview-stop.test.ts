import { describe, expect, it, vi } from "vitest";
import { resolveMattermostAccount } from "./accounts.js";
import type { MattermostPost } from "./client.js";
import { setInteractionSecret } from "./interactions.js";
import { createMattermostPreviewStop, handleMattermostPreviewStop } from "./preview-stop.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { OpenClawConfig } from "./runtime-api.js";

function fixture() {
  let cfg: OpenClawConfig = {
    channels: { mattermost: { groupPolicy: "open", allowFrom: ["alice"], botToken: "test", baseUrl: "https://mm.example" } },
  };
  let identity = { sessionId: "session", lifecycleRevision: 1 };
  let channelRead = async () => ({ id: "room", type: "O" });
  const posts = new Map<string, MattermostPost>();
  const monitor = {
    cfg, account: resolveMattermostAccount({ cfg }), botUserId: "bot",
    core: {
      config: { current: () => cfg },
      agent: { session: { getSessionEntry: () => identity } },
      channel: { commands: { shouldHandleTextCommands: () => true } },
    },
    resources: { resolveChannelInfo: () => channelRead() },
    pairing: { readAllowFromStore: async () => [] },
    client: { request: async (path: string) => posts.get(path.split("/")[2]!) },
    logVerboseMessage: vi.fn(),
  } as unknown as MattermostMonitorContext;
  setInteractionSecret(monitor.account.accountId, "test");
  const create = () => createMattermostPreviewStop({
    monitor, channelId: "room", senderId: "alice", sessionKey: "session",
  });
  const click = (control: ReturnType<typeof create>) => {
    const props = control.props()!;
    const attachments = props.attachments as Array<{
      actions: Array<{ integration: { context: Record<string, unknown> } }>;
    }>;
    const context = attachments[0]!.actions[0]!.integration.context;
    control.notePost("preview");
    posts.set("preview", {
      id: "preview", channel_id: "room", user_id: "bot", props,
    });
    expect(context._token).toEqual(expect.any(String));
    expect(context.__openclaw_channel_id).toBe("room");
    return {
      context, userName: "alice",
      payload: { user_id: "alice", channel_id: "room", post_id: "preview" },
    };
  };
  return { monitor, create, click,
    posts,
    rotate: () => { identity = { sessionId: "replacement", lifecycleRevision: 2 }; },
    deny: () => { cfg = { channels: { mattermost: { groupPolicy: "disabled" } } }; },
    onChannelRead: (next: typeof channelRead) => { channelRead = next; },
  };
}

describe("preview Stop source ownership", () => {
  it("aborts only its own source after current command authorization and consumes replay", async () => {
    const f = fixture();
    const owner = f.create();
    const unrelated = f.create();
    owner.activate("run");
    const click = f.click(owner);
    expect(await handleMattermostPreviewStop(f.monitor, click)).toEqual({ ephemeral_text: "Stop requested." });
    expect(owner.signal.aborted).toBe(true);
    expect(unrelated.signal.aborted).toBe(false);
    expect(owner.stopped).toBe(true);
    expect(await handleMattermostPreviewStop(f.monitor, click)).toEqual({ ephemeral_text: "This Stop button has expired." });
  });

  it.each(["foreign-sender", "foreign-channel", "foreign-post", "removed-control", "replacement", "rotation", "finished", "disabled", "restart"])(
    "consumes %s callbacks without cancellation",
    async (reason) => {
      const f = fixture();
      const owner = f.create();
      owner.activate("run");
      const click = f.click(owner);
      if (reason === "foreign-sender") click.payload.user_id = "bob";
      if (reason === "foreign-channel") click.payload.channel_id = "elsewhere";
      if (reason === "foreign-post") click.payload.post_id = "another-post";
      if (reason === "removed-control") f.posts.get("preview")!.props = {};
      if (reason === "replacement") f.create().activate("new-run");
      if (reason === "rotation") f.rotate();
      if (reason === "finished") await owner.finish();
      if (reason === "disabled") f.deny();
      const monitor = reason === "restart" ? { ...f.monitor, client: { ...f.monitor.client } } : f.monitor;
      expect(await handleMattermostPreviewStop(monitor, click)).not.toBeNull();
      expect(owner.signal.aborted).toBe(false);
    },
  );

  it("rechecks current ownership after awaited authorization", async () => {
    const f = fixture();
    const owner = f.create();
    owner.activate("run");
    const click = f.click(owner);
    f.onChannelRead(async () => {
      f.create().activate("replacement");
      return { id: "room", type: "O" };
    });
    await handleMattermostPreviewStop(f.monitor, click);
    expect(owner.signal.aborted).toBe(false);
  });

  it("ignores unrelated controls", async () => {
    const f = fixture();
    expect(await handleMattermostPreviewStop(f.monitor, {
      context: {}, userName: "alice",
      payload: { user_id: "alice", channel_id: "room", post_id: "preview" },
    })).toBeNull();
  });

  it("shares ownership with a freshly pinned config view of the same monitor", async () => {
    const f = fixture();
    const owner = f.create();
    owner.activate("run");
    expect(await handleMattermostPreviewStop({ ...f.monitor }, f.click(owner))).toEqual({
      ephemeral_text: "Stop requested.",
    });
  });

  it("verifies the public custody marker when REST strips callback integrations", async () => {
    const f = fixture();
    const owner = f.create();
    owner.activate("run");
    const click = f.click(owner);
    const attachments = f.posts.get("preview")!.props!.attachments as Array<{
      actions: Array<Record<string, unknown>>;
    }>;
    delete attachments[0]!.actions[0]!.integration;
    expect(await handleMattermostPreviewStop(f.monitor, click)).toEqual({
      ephemeral_text: "Stop requested.",
    });
  });
});
