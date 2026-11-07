import { expect, it } from "vitest";
import { buildMattermostEventPlan } from "./monitor-event-plan.js";
import type { MattermostMonitorContext } from "./monitor-types.js";

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
