// Mattermost tests cover bot-owned thread mention policy without monorepo test helpers.
import { resolveChannelGroupRequireMention } from "openclaw/plugin-sdk/channel-policy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MattermostAccountConfig } from "../types.js";
import { resolveMattermostAccount } from "./accounts.js";
import type { MattermostPost } from "./client.js";
import { createMattermostPostHandler } from "./monitor-posts.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { OpenClawConfig } from "./runtime-api.js";

const dispatch = vi.hoisted(() => vi.fn());
const hasParticipation = vi.hoisted(() => vi.fn());
const resolveEnvelope = vi.hoisted(() => vi.fn());

vi.mock("./monitor-turn.js", () => ({ dispatchMattermostInboundTurn: dispatch }));
vi.mock("./thread-participation.js", () => ({
  hasMattermostThreadParticipation: hasParticipation,
}));
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  resolveInboundSessionEnvelopeContextAsync: resolveEnvelope,
}));
vi.mock("openclaw/plugin-sdk/session-store-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/session-store-runtime")>()),
  getSessionEntry: () => undefined,
}));

describe("Mattermost bot-owned thread mention policy", () => {
  beforeEach(() => {
    dispatch.mockReset();
    hasParticipation.mockReset().mockResolvedValue(false);
    resolveEnvelope.mockReset().mockResolvedValue({ envelopeOptions: {} });
  });

  function setup(config: Partial<MattermostAccountConfig> = {}, botUsername = "bot") {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          requireMention: true,
          groupPolicy: "open",
          historyLimit: 0,
          ...config,
        },
      },
    };
    const account = resolveMattermostAccount({ cfg, accountId: "default" });
    const core = {
      config: { current: () => cfg },
      channel: {
        activity: { record: vi.fn() },
        commands: {
          shouldHandleTextCommands: () => false,
          isControlCommandMessage: () => false,
        },
        groups: { resolveRequireMention: resolveChannelGroupRequireMention },
        mentions: {
          buildMentionRegexes: () => [],
          matchesMentionPatterns: () => false,
        },
        routing: {
          resolveAgentRoute: () => ({
            agentId: "main",
            channel: "mattermost",
            accountId: "default",
            sessionKey: "agent:main:mattermost:channel:room",
            mainSessionKey: "agent:main:main",
            lastRoutePolicy: "session",
            matchedBy: "default",
          }),
        },
      },
    };
    const root: MattermostPost = {
      id: "root",
      channel_id: "room",
      user_id: "bot",
      message: "Discussion started by the bot",
      create_at: 1,
    };
    const request = vi.fn(async (endpoint: string) => {
      if (endpoint !== "/posts/root") {
        throw new Error(`Unexpected Mattermost request: ${endpoint}`);
      }
      return root;
    });
    const monitor = {
      cfg,
      account,
      core,
      client: { request },
      botUserId: "bot",
      botUsername,
      groupPolicy: account.config.groupPolicy ?? "open",
      pairing: { readAllowFromStore: async () => [] },
      resources: {
        resolveChannelInfo: async () => ({ id: "room", type: "O" }),
        resolveUserInfo: async (id: string) => ({ id, username: id }),
        resolveMattermostMedia: async () => [],
      },
      runtime: { log: vi.fn(), error: vi.fn() },
      logVerboseMessage: vi.fn(),
      logDebugMessage: vi.fn(),
    } as unknown as MattermostMonitorContext;
    const handler = createMattermostPostHandler(monitor);
    return {
      root,
      request,
      receive: (post: Partial<MattermostPost> = {}) =>
        handler(
          {
            id: "follow-up",
            root_id: "root",
            channel_id: "room",
            user_id: "sender",
            message: "Continue the discussion",
            create_at: 2,
            ...post,
          },
          { data: { sender_name: "sender" } },
        ),
    };
  }

  it("waits for the asynchronous session envelope before dispatch", async () => {
    const fixture = setup({ requireMentionInBotThreads: false });
    const started = Promise.withResolvers<void>();
    const envelope = Promise.withResolvers<{ envelopeOptions: {} }>();
    resolveEnvelope.mockImplementation(() => {
      started.resolve();
      return envelope.promise;
    });
    const receiving = fixture.receive();
    try {
      await started.promise;
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      envelope.resolve({ envelopeOptions: {} });
      await receiving;
    }
    expect(resolveEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "main", sessionKey: "agent:main:mattermost:channel:room:thread:root",
    }));
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it.each([
    { scope: "account", config: { requireMentionInBotThreads: false } },
    {
      scope: "wildcard group",
      config: {
        requireMentionInBotThreads: true,
        groups: { "*": { requireMentionInBotThreads: false } },
      },
    },
    {
      scope: "exact group",
      config: {
        requireMentionInBotThreads: true,
        groups: {
          "*": { requireMentionInBotThreads: true },
          room: { requireMentionInBotThreads: false },
        },
      },
    },
  ])("admits an unmentioned bot-thread reply configured at $scope scope", async ({ config }) => {
    const fixture = setup(config);

    await fixture.receive();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[1].ctxPayload).toMatchObject({
      BodyForAgent: "Continue the discussion",
      MessageThreadId: "root",
    });
  });

  it("requires a mention even after prior participation when explicitly configured", async () => {
    const fixture = setup({ requireMention: false, requireMentionInBotThreads: true });
    hasParticipation.mockResolvedValue(true);

    await fixture.receive();
    expect(dispatch).not.toHaveBeenCalled();

    await fixture.receive({ id: "mentioned-follow-up", message: "@bot continue" });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it.each([false, true])("preserves omitted-policy participation behavior (%s)", async (engaged) => {
    const fixture = setup();
    hasParticipation.mockResolvedValue(engaged);

    await fixture.receive();

    expect(dispatch).toHaveBeenCalledTimes(engaged ? 1 : 0);
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it.each([
    { name: "another author's root", patch: { user_id: "someone-else" } },
    { name: "another post id", patch: { id: "different-root" } },
    { name: "another channel", patch: { channel_id: "different-room" } },
    { name: "a deleted root", patch: { delete_at: 10 } },
    { name: "an unreadable root", patch: null },
  ])("retains mention gating for $name", async ({ patch }) => {
    const fixture = setup({ requireMentionInBotThreads: false });
    if (patch) {
      fixture.request.mockResolvedValue({ ...fixture.root, ...patch });
    } else {
      fixture.request.mockRejectedValue(new Error("Mattermost API 403 Forbidden"));
    }

    await fixture.receive();

    expect(dispatch).not.toHaveBeenCalled();
    expect(fixture.request).toHaveBeenCalledOnce();
  });

  it("keeps a strict bot thread closed when no mention detector is available", async () => {
    const fixture = setup({ requireMention: false, requireMentionInBotThreads: true }, "");

    await fixture.receive();

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("recovers room history for a new root turn through the real post handler", async () => {
    const fixture = setup({
      requireMention: false, historyLimit: 3, replyToMode: "all",
      referenceMedia: { enabled: false }, permalinkHydration: { enabled: false },
    });
    fixture.request.mockImplementation(async (endpoint: string) => {
      expect(endpoint).toBe("/channels/room/posts?per_page=4&before=new-root");
      return {
        order: ["earlier-root"],
        posts: {
          "earlier-root": {
            id: "earlier-root", channel_id: "room", user_id: "sender",
            create_at: 1, message: "Discussion before the restart",
          },
        },
      } as never;
    });
    await fixture.receive({ id: "new-root", root_id: "", create_at: 2, message: "@bot continue" });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]![1].ctxPayload).toMatchObject({
      MessageThreadId: "new-root",
      InboundHistory: [
        expect.objectContaining({ body: "Discussion before the restart", messageId: "earlier-root" }),
      ],
    });
    expect(fixture.request).toHaveBeenCalledOnce();
  });
});
