import * as bindingRuntime from "openclaw/plugin-sdk/conversation-binding-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { expect, it, vi } from "vitest";
import { buildMattermostEventPlan } from "./monitor-event-plan.js";
import type { MattermostMonitorContext } from "./monitor-types.js";

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof bindingRuntime>();
  return {
    ...actual,
    resolveRuntimeConversationBindingRouteAsync: vi.fn(
      actual.resolveRuntimeConversationBindingRouteAsync,
    ),
  };
});

it.each([
  { channelType: "O", config: {}, threaded: false },
  { channelType: "D", config: {}, threaded: false },
  { channelType: "D", config: { replyToMode: "first" }, threaded: false },
  {
    channelType: "D",
    config: { replyToModeByChatType: { direct: "off" } },
    threaded: false,
  },
  {
    channelType: "D",
    config: { replyToModeByChatType: { direct: "all" } },
    threaded: true,
  },
])(
  "preserves admitted $channelType routing (threaded=$threaded) without retired origin metadata",
  async ({ channelType, config, threaded }) => {
    const monitor = {
      cfg: {},
      account: { accountId: "default", baseUrl: "https://chat.example/mm", config },
      core: {
        channel: {
          routing: {
            resolveAgentRoute: () => ({
              sessionKey: "agent:main:mattermost:channel:x",
              accountId: "default",
            }),
          },
        },
      },
      resources: { resolveChannelInfo: async () => ({ type: channelType }) },
      logVerboseMessage: () => {},
    } as unknown as MattermostMonitorContext;
    const params = {
      channelId: "channel",
      senderId: "sender",
      postId: "a".repeat(26),
      dropLabel: "test",
    };
    const plan = (await buildMattermostEventPlan(monitor, params))!;
    const context = plan.finalizeContext({ MessageSid: "synthetic" });
    expect(context).not.toHaveProperty("ConversationLink");
    expect(context).toMatchObject({
      NativeChannelId: "channel",
      SenderId: "sender",
      AccountId: "default",
      InboundAccessAuthorized: true,
      MessageSid: "synthetic",
      ReplyToId: threaded ? params.postId : undefined,
      MessageThreadId: threaded ? params.postId : undefined,
    });
    const rootId = "b".repeat(26);
    const thread = (await buildMattermostEventPlan(monitor, {
      ...params,
      threadRootId: rootId,
    }))!;
    expect(thread.finalizeContext({})).toMatchObject({
      ReplyToId: rootId,
      MessageThreadId: rootId,
      SessionKey: `agent:main:mattermost:channel:x:thread:${rootId}`,
    });
    expect(thread.thread.effectiveReplyToId).toBe(rootId);
    expect(thread.thread.parentSessionKey).toBe(
      channelType === "D" ? undefined : "agent:main:mattermost:channel:x",
    );
    expect(thread.finalizeContext({})).not.toHaveProperty("ConversationLink");
  },
);

it("selects the bound fork session before dispatch and preserves the native reply root", async () => {
  const baseRoute = {
    agentId: "main",
    accountId: "default",
    sessionKey: "agent:main:mattermost:channel:room",
  } as ResolvedAgentRoute;
  const forkKey = "agent:second:fork:synthetic";
  const rootId = "s".repeat(26);
  const selectBinding = vi.mocked(bindingRuntime.resolveRuntimeConversationBindingRouteAsync);
  selectBinding.mockClear();
  selectBinding.mockResolvedValueOnce({
    bindingRecord: null,
    bindingOwnerAvailable: true,
    boundSessionKey: forkKey,
    route: { ...baseRoute, agentId: "second", sessionKey: forkKey },
  });
  const monitor = {
    cfg: {},
    account: { accountId: "default", config: {} },
    core: { channel: { routing: { resolveAgentRoute: () => baseRoute } } },
    resources: { resolveChannelInfo: async () => ({ type: "P" }) },
  } as unknown as MattermostMonitorContext;
  const plan = (await buildMattermostEventPlan(monitor, {
    channelId: "room",
    senderId: "sender",
    postId: "p".repeat(26),
    threadRootId: rootId,
    dropLabel: "test",
  }))!;
  expect(selectBinding).toHaveBeenCalledWith({
    route: baseRoute,
    conversation: {
      channel: "mattermost",
      accountId: "default",
      conversationId: rootId,
      parentConversationId: "room",
    },
    touchBinding: false,
  });
  expect(plan.thread).toEqual({
    effectiveReplyToId: rootId,
    sessionKey: forkKey,
    parentSessionKey: undefined,
  });
  expect(plan.finalizeContext({ RawBody: "sibling turn" })).toMatchObject({
    AgentId: "second",
    SessionKey: forkKey,
    MessageThreadId: rootId,
    To: "channel:room",
  });
});
