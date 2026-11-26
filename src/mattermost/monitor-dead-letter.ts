// A committed ingress failure may emit a best-effort notice, never a new turn.
import { resolveChannelMessageSourceReplyDeliveryMode } from "openclaw/plugin-sdk/channel-outbound";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMattermostGroupContext } from "../group-context.js";
import { listMattermostAccountIds, resolveMattermostAccount, resolveMattermostReplyToMode } from "./accounts.js";
import {
  createMattermostClient,
  createMattermostPost,
  fetchMattermostChannel,
  fetchMattermostPost,
  fetchMattermostUser,
  isMattermostSystemPost,
} from "./client.js";
import { resolveMattermostPostActivation } from "./monitor-activation.js";
import { resolveMattermostMonitorInboundAccess, resolveMattermostTrustedChatKind } from "./monitor-auth.js";
import { resolveMattermostThreadSessionContext } from "./monitor-context.js";
import { normalizeMention } from "./monitor-helpers.js";
import type { MattermostIngressPost } from "./monitor-ingress.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { MattermostEventPayload } from "./monitor-websocket.js";
import { isMattermostNativeSkillAllowed } from "./native-commands.js";
import { resolveAllowlistProviderRuntimeGroupPolicy, resolveDefaultGroupPolicy } from "./runtime-api.js";

export function createMattermostDeadLetterNotifier(monitor: MattermostMonitorContext) {
  return async (original: MattermostIngressPost, payload: MattermostEventPayload, signal: AbortSignal) => {
    const abortSignal = AbortSignal.any([signal, ...(monitor.abortSignal ? [monitor.abortSignal] : [])]);
    const cfg = monitor.core.config.current();
    const account = resolveMattermostAccount({ cfg, accountId: monitor.account.accountId });
    // A running monitor must not use a removed account or a replacement transport.
    if (!cfg.channels?.mattermost || !listMattermostAccountIds(cfg).includes(account.accountId) ||
        !account.enabled || account.botToken !== monitor.client.token ||
        account.baseUrl !== monitor.client.baseUrl) return;
    const assertCurrent = () => {
      abortSignal.throwIfAborted();
      if (monitor.core.config.current() !== cfg) {
        throw new Error("Mattermost dead-letter notice suppressed: policy changed.");
      }
    };
    assertCurrent();
    const channelId = original.channel_id ?? payload.data?.channel_id ?? payload.broadcast?.channel_id;
    if (payload.event !== "posted" || !channelId || original.user_id === monitor.botUserId ||
        isMattermostSystemPost(original)) return;
    const transport = createMattermostClient({
      baseUrl: monitor.client.baseUrl, botToken: monitor.client.token,
      allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
      assertRequestCurrent: assertCurrent,
    });
    // Carry the notice timeout/shutdown through reads and the HTTP transport;
    // the client also fences DNS dispatch and its safe read retry boundaries.
    const client = {
      ...transport,
      request: <T>(path: string, init?: Parameters<typeof transport.request>[1]) =>
        transport.request<T>(path, { ...init, signal: abortSignal }),
    };
    const post = await fetchMattermostPost(client, original.id);
    if (post.id !== original.id || post.channel_id !== channelId ||
        post.user_id !== original.user_id || post.delete_at || isMattermostSystemPost(post) ||
        normalizeOptionalString(post.root_id) !== normalizeOptionalString(original.root_id)) return;
    const channel = await fetchMattermostChannel(client, channelId);
    if (channel.id !== channelId || !channel.type?.trim()) return;
    const kind = resolveMattermostTrustedChatKind({ channelType: channel.type });
    const sender = await fetchMattermostUser(client, original.user_id);
    if (sender.id !== original.user_id) return;
    const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: true, groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy: resolveDefaultGroupPolicy(cfg),
    });
    const rawText = post.message ?? "";
    const commandBody = normalizeMention(rawText, monitor.botUsername).trim();
    const allowTextCommands = monitor.core.channel.commands.shouldHandleTextCommands({ cfg, surface: "mattermost" });
    const isControlCommand = allowTextCommands && monitor.core.channel.commands.isControlCommandMessage(commandBody, cfg);
    const access = await resolveMattermostMonitorInboundAccess({
      account, cfg, senderId: original.user_id, senderName: sender.username ?? original.user_id,
      channelId, kind, groupPolicy, readStoreAllowFrom: monitor.pairing.readAllowFromStore,
      allowTextCommands, hasControlCommand: isControlCommand, eventKind: "message", mayPair: false,
    });
    if (access.ingress.decision !== "allow" ||
        (kind !== "direct" && access.commandAccess.shouldBlockControlCommand)) return;
    const groupContext = resolveMattermostGroupContext({ cfg, accountId: account.accountId, channelId, kind });
    if (!(await isMattermostNativeSkillAllowed({ cfg, commandText: commandBody, skillFilter: groupContext.skillFilter }))) return;
    const route = monitor.core.channel.routing.resolveAgentRoute({
      cfg, channel: "mattermost", accountId: account.accountId, teamId: channel.team_id ?? undefined,
      peer: { kind, id: kind === "direct" ? original.user_id : channelId },
    });
    const thread = resolveMattermostThreadSessionContext({
      baseSessionKey: route.sessionKey, kind, postId: post.id,
      replyToMode: resolveMattermostReplyToMode(account, kind), threadRootId: post.root_id,
    });
    const activation = await resolveMattermostPostActivation({ ...monitor, cfg, account, client, groupPolicy }, {
      post, channelId, kind, effectiveReplyToId: thread.effectiveReplyToId,
      agentId: route.agentId, rawText, allowTextCommands, isControlCommand,
      commandAuthorized: access.commandAccess.authorized,
    });
    if (activation.mentionDecision.shouldSkip) return;
    if (resolveChannelMessageSourceReplyDeliveryMode({
      cfg, ctx: { ChatType: kind, InboundEventKind: "message" },
    }) === "message_tool_only") return;
    assertCurrent();
    await createMattermostPost(client, {
      channelId, rootId: normalizeOptionalString(post.root_id) ?? post.id, silent: true,
      message: "⚠️ Couldn't process this message. Automatic retries have stopped. Please try again.",
    });
    monitor.statusSink?.({ lastOutboundAt: Date.now() });
  };
}
