// Mattermost plugin module prepares shared routing and reply facts for monitor events.
import {
  buildChannelInboundEventContext,
  type InboundMediaFacts,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveRuntimeConversationBindingRouteAsync } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { resolveMattermostGroupContext } from "../group-context.js";
import { resolveMattermostReplyToMode } from "./accounts.js";
import type { MattermostChannel } from "./client.js";
import { resolveMattermostTrustedChatKind } from "./monitor-auth.js";
import { resolveMattermostThreadSessionContext } from "./monitor-context.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import { createMattermostReplyDeliveryBarrier } from "./reply-delivery.js";
import { logTypingFailure } from "./runtime-api.js";
import { resolveMattermostTextLimit } from "./text-limits.js";

type MattermostEventPlanParams = {
  channelId: string;
  senderId: string;
  postId?: string | null;
  threadRootId?: string | null;
  channelInfo?: MattermostChannel | null;
  channelTypeFallback?: string | null;
  teamId?: string | null;
  channelName?: string | null;
  channelDisplay?: string | null;
  dropLabel: string;
};

export async function buildMattermostEventPlan(
  monitor: Pick<
    MattermostMonitorContext,
    "core" | "cfg" | "account" | "logVerboseMessage" | "logDebugMessage"
  > & {
    resources: Pick<
      MattermostMonitorContext["resources"],
      "resolveChannelInfo" | "sendTypingIndicator"
    >;
  },
  params: MattermostEventPlanParams,
) {
  // Gather transport metadata once, normalize its optional labels, then decide
  // the route/thread identity every event consumer must share.
  const channelInfo =
    params.channelInfo ?? (await monitor.resources.resolveChannelInfo(params.channelId));
  const channelType = channelInfo?.type?.trim() || params.channelTypeFallback?.trim();
  if (!channelType) {
    monitor.logVerboseMessage(
      `mattermost: drop ${params.dropLabel} (cannot resolve channel type for ${params.channelId})`,
    );
    return null;
  }
  const kind = resolveMattermostTrustedChatKind({ channelType });
  const teamId = params.teamId ?? channelInfo?.team_id ?? undefined;
  const channelName = params.channelName ?? channelInfo?.name ?? "";
  const channelDisplay = params.channelDisplay ?? channelInfo?.display_name ?? channelName;
  const roomLabel = channelName ? `#${channelName}` : channelDisplay || `#${params.channelId}`;
  const baseRoute = monitor.core.channel.routing.resolveAgentRoute({
    cfg: monitor.cfg,
    channel: "mattermost",
    accountId: monitor.account.accountId,
    teamId,
    peer: {
      kind,
      id: kind === "direct" ? params.senderId : params.channelId,
    },
  });
  const nativeThread = resolveMattermostThreadSessionContext({
    baseSessionKey: baseRoute.sessionKey,
    kind,
    postId: params.postId,
    replyToMode: resolveMattermostReplyToMode(monitor.account, kind),
    threadRootId: params.threadRootId,
  });
  const threadRootId = params.threadRootId?.trim();
  const roomType = channelType.toUpperCase();
  const bindingRoute =
    threadRootId && (roomType === "O" || roomType === "P")
      ? await resolveRuntimeConversationBindingRouteAsync({
          route: baseRoute,
          conversation: {
            channel: "mattermost",
            accountId: baseRoute.accountId,
            conversationId: threadRootId,
            parentConversationId: params.channelId,
          },
          touchBinding: false,
        })
      : undefined;
  const route = bindingRoute?.route ?? baseRoute;
  const thread = bindingRoute?.boundSessionKey
    ? { ...nativeThread, sessionKey: bindingRoute.boundSessionKey, parentSessionKey: undefined }
    : nativeThread;
  const to = kind === "direct" ? `user:${params.senderId}` : `channel:${params.channelId}`;
  const groupContext = resolveMattermostGroupContext({
    cfg: monitor.cfg, accountId: monitor.account.accountId, channelId: params.channelId, kind,
  });

  return {
    channelId: params.channelId,
    senderId: params.senderId,
    channelInfo,
    kind,
    teamId,
    channelName,
    channelDisplay,
    roomLabel,
    route,
    thread,
    to,
    finalizeContext: <T extends Record<string, unknown> & { media?: InboundMediaFacts[] }>(
      context: T,
    ) => {
      const inboundContext = {
        ...context,
        From:
          kind === "direct"
            ? `mattermost:${params.senderId}`
            : kind === "group"
              ? `mattermost:group:${params.channelId}`
              : `mattermost:channel:${params.channelId}`,
        To: to,
        SessionKey: thread.sessionKey,
        DmScope: route.dmScope,
        ParentSessionKey: thread.parentSessionKey,
        AccountId: route.accountId,
        ChatType: kind,
        ConversationRouteContextObserved: true,
        ConversationRoutePeerId: kind === "direct" ? params.senderId : params.channelId,
        GroupChannel: channelName ? `#${channelName}` : undefined,
        GroupSpace: teamId,
        GroupSystemPrompt: groupContext.systemPrompt,
        SenderId: params.senderId,
        Provider: "mattermost" as const,
        Surface: "mattermost" as const,
        NativeChannelId: params.channelId,
        InboundAccessAuthorized: true,
        ReplyToId: thread.effectiveReplyToId,
        MessageThreadId: thread.effectiveReplyToId,
        OriginatingChannel: "mattermost" as const,
        OriginatingTo: to,
      };
      if (!bindingRoute) {
        return finalizeInboundContext(inboundContext);
      }
      return buildChannelInboundEventContext({
        channel: "mattermost",
        from: inboundContext.From,
        sender: { id: params.senderId },
        conversation: { id: params.channelId, kind },
        route: {
          ...route,
          routeSessionKey: route.sessionKey,
          dispatchSessionKey: thread.sessionKey,
          parentSessionKey: thread.parentSessionKey,
        },
        reply: { to },
        message: { rawBody: typeof context.RawBody === "string" ? context.RawBody : "" },
        media: context.media,
        extra: inboundContext,
        finalize: finalizeInboundContext,
      });
    },
    createReplyPlan: () => {
      const deliveryBarrier = createMattermostReplyDeliveryBarrier({
        isDirect: kind === "direct",
        dmRetryOptions: monitor.account.config.dmChannelRetry,
      });
      return {
        textLimit: resolveMattermostTextLimit({
          baseUrl: monitor.account.baseUrl,
          textChunkLimit: monitor.core.channel.text.resolveTextChunkLimit(
            monitor.cfg,
            "mattermost",
            monitor.account.accountId,
            { fallbackLimit: resolveMattermostTextLimit(monitor.account) },
          ),
        }),
        tableMode: monitor.core.channel.text.resolveMarkdownTableMode({
          cfg: monitor.cfg,
          channel: "mattermost",
          accountId: monitor.account.accountId,
        }),
        deliveryBarrier,
        replyPipeline: {
          typing: {
            start: () =>
              monitor.resources.sendTypingIndicator(params.channelId, thread.effectiveReplyToId),
            onStartError: (error: unknown) => {
              logTypingFailure({
                log: monitor.logDebugMessage,
                channel: "mattermost",
                target: params.channelId,
                error,
              });
            },
          },
        },
        replyOptions: {
          skillFilter: groupContext.skillFilter,
          disableBlockStreaming:
            typeof monitor.account.blockStreaming === "boolean"
              ? !monitor.account.blockStreaming
              : undefined,
        },
      };
    },
  };
}

export type MattermostEventPlan = NonNullable<Awaited<ReturnType<typeof buildMattermostEventPlan>>>;
