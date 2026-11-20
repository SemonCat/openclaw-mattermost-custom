// Mattermost maps transport mention facts into the shared channel evaluator.
import {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
  type InboundImplicitMentionKind,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelImplicitMentions } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { resolveBotThreadMentionPolicy } from "openclaw/plugin-sdk/channel-mention-gating";
import { resolveChannelGroups } from "openclaw/plugin-sdk/channel-policy";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { MattermostPostSchema, type MattermostPost } from "./client.js";
import { matchesMattermostBotMention } from "./monitor-helpers.js";
import { resolveOncharPrefixes, stripOncharPrefix } from "./monitor-onchar.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import { hasMattermostThreadParticipation } from "./thread-participation.js";
import type { ChatType, OpenClawConfig } from "./runtime-api.js";

export function resolveMattermostInboundMentionDecision(params: {
  cfg: OpenClawConfig;
  accountId: string;
  kind: ChatType;
  requireMention: boolean;
  canDetectMention: boolean;
  wasMentioned: boolean;
  implicitMentionKinds?: readonly InboundImplicitMentionKind[];
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  commandAuthorized: boolean;
}) {
  const implicitMentions = resolveChannelImplicitMentions({
    cfg: params.cfg,
    channel: "mattermost",
    accountId: params.accountId,
  });
  return resolveInboundMentionDecision({
    facts: {
      canDetectMention: params.canDetectMention,
      wasMentioned: params.wasMentioned,
      implicitMentionKinds: params.implicitMentionKinds,
    },
    policy: {
      isGroup: params.kind !== "direct",
      requireMention: params.requireMention,
      implicitMentions,
      allowTextCommands: params.allowTextCommands,
      hasControlCommand: params.hasControlCommand,
      commandAuthorized: params.commandAuthorized,
    },
  });
}

/** Shared admission facts for normal delivery and terminal ingress notices. No session writes. */
export async function resolveMattermostPostActivation(
  monitor: MattermostMonitorContext,
  params: {
    post: MattermostPost;
    channelId: string;
    kind: ChatType;
    effectiveReplyToId?: string;
    agentId: string;
    rawText: string;
    allowTextCommands: boolean;
    isControlCommand: boolean;
    commandAuthorized: boolean;
  },
) {
  const { cfg, account, botUserId, botUsername, core } = monitor;
  const { post, channelId, kind, effectiveReplyToId, rawText, allowTextCommands,
    isControlCommand, commandAuthorized } = params;
  const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, params.agentId);
  const wasMentioned =
    kind !== "direct" &&
    (matchesMattermostBotMention(rawText, botUsername) ||
      core.channel.mentions.matchesMentionPatterns(rawText, mentionRegexes));
  const oncharEnabled = account.chatmode === "onchar" && kind !== "direct";
  const oncharPrefixes = oncharEnabled ? resolveOncharPrefixes(account.oncharPrefixes) : [];
  const oncharResult = oncharEnabled
    ? stripOncharPrefix(rawText, oncharPrefixes)
    : { triggered: false, stripped: rawText };
  const oncharTriggered = oncharResult.triggered;
  const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
  // Threads the bot already replied in auto-engage: follow-ups resume without
  // a re-mention even under requireMention. Keyed by the thread root id.
  const threadAlreadyEngaged =
    kind !== "direct" && effectiveReplyToId
      ? await hasMattermostThreadParticipation({
          accountId: account.accountId,
          channelId,
          threadRootId: effectiveReplyToId,
        })
      : false;
  const shouldRequireMention =
    kind !== "direct" &&
    core.channel.groups.resolveRequireMention({
      cfg,
      channel: "mattermost",
      accountId: account.accountId,
      groupId: channelId,
      requireMentionOverride: account.requireMention,
    });
  const groups = resolveChannelGroups(cfg, "mattermost", account.accountId);
  const requireMentionInBotThreads =
    groups?.[channelId]?.requireMentionInBotThreads ??
    groups?.["*"]?.requireMentionInBotThreads ??
    account.config.requireMentionInBotThreads;
  const nativeThreadRootId = normalizeOptionalString(post.root_id);
  let isBotOwnedThread = false;
  if (kind !== "direct" && nativeThreadRootId && requireMentionInBotThreads !== undefined) {
    try {
      const root = MattermostPostSchema.safeParse(
        await monitor.client.request<unknown>(
          `/posts/${encodeURIComponent(nativeThreadRootId)}`,
        ),
      );
      isBotOwnedThread =
        root.success &&
        root.data.id === nativeThreadRootId &&
        root.data.channel_id === channelId &&
        root.data.user_id === botUserId &&
        !root.data.delete_at &&
        !normalizeOptionalString(root.data.root_id);
    } catch (err) {
      monitor.logVerboseMessage(
        `mattermost: failed resolving thread owner channel=${channelId} root=${nativeThreadRootId}: ${String(err)}`,
      );
    }
  }
  const botThreadPolicy = resolveBotThreadMentionPolicy({
    isBotOwnedThread,
    requireMentionInBotThreads,
    requireMention: shouldRequireMention || oncharEnabled,
    implicitMentionKinds: implicitMentionKindWhen("bot_thread_participant", threadAlreadyEngaged),
  });
  const botThreadMentionRequired = isBotOwnedThread && requireMentionInBotThreads === true;
  const mentionDecision = resolveMattermostInboundMentionDecision({
    cfg,
    accountId: account.accountId,
    kind,
    requireMention: botThreadPolicy.requireMention,
    canDetectMention: canDetectMention || oncharEnabled || botThreadMentionRequired,
    wasMentioned: wasMentioned || oncharTriggered,
    implicitMentionKinds: botThreadPolicy.implicitMentionKinds,
    allowTextCommands,
    hasControlCommand: isControlCommand,
    commandAuthorized,
  });
  return { mentionDecision, oncharEnabled, oncharTriggered, oncharResult,
    wasMentioned, canDetectMention, botThreadPolicy, threadAlreadyEngaged };
}
