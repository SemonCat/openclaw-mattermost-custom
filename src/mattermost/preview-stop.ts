import { randomUUID } from "node:crypto";
import { resolveMattermostAccount } from "./accounts.js";
import { fetchMattermostPost, updateMattermostPost, type MattermostClient } from "./client.js";
import {
  buildButtonAttachments,
  resolveInteractionCallbackUrl,
  type MattermostValidatedInteraction,
  type MattermostInteractionResponse,
} from "./interactions.js";
import { authorizeMattermostCommandInvocation } from "./monitor-auth.js";
import { pinMattermostMonitorConfig } from "./monitor-context.js";
import type { MattermostMonitorContext } from "./monitor-types.js";

const CONTROL = "openclaw_preview_stop";
const ACTION_ID = "openclawstop";
type Entry = {
  token: string;
  channelId: string;
  senderId: string;
  sessionKey: string;
  ownsPost: (postId: string) => boolean;
  current: () => boolean;
  abort: () => void;
};
const registries = new WeakMap<MattermostClient, Map<string, Entry>>();
function registry(monitor: MattermostMonitorContext) {
  let entries = registries.get(monitor.client);
  if (!entries) {
    entries = new Map();
    registries.set(monitor.client, entries);
  }
  return entries;
}

/** The capability belongs to this source's signal, never a session-wide abort. */
export function createMattermostPreviewStop(params: {
  monitor: MattermostMonitorContext;
  channelId: string;
  senderId: string;
  sessionKey: string;
}) {
  const { monitor } = params;
  const controller = new AbortController();
  const entries = registry(monitor);
  const posts = new Set<string>();
  const tokens = new Set<string>();
  let entry: Entry | undefined;
  let finished = false;
  let stopped = false;
  let activeRunId: string | undefined;
  const retire = () => {
    if (entry && entries.get(params.sessionKey) === entry) entries.delete(params.sessionKey);
    entry = undefined;
  };
  return {
    signal: controller.signal,
    get stopped() { return stopped; },
    activate(runId: string) {
      if (finished || monitor.abortSignal?.aborted || activeRunId === runId) return;
      retire();
      activeRunId = runId;
      let identity;
      try {
        identity = monitor.core.agent.session.getSessionEntry({ sessionKey: params.sessionKey });
      } catch {
        return;
      }
      if (!identity?.sessionId) return;
      const sessionId = identity.sessionId;
      const revision = identity.lifecycleRevision;
      const owner: Entry = {
        ...params,
        token: randomUUID(),
        ownsPost: (postId) => posts.has(postId),
        current: () => {
          if (finished || controller.signal.aborted || monitor.abortSignal?.aborted ||
              entries.get(params.sessionKey) !== owner) return false;
          try {
            const latest = monitor.core.agent.session.getSessionEntry({ sessionKey: params.sessionKey });
            return latest?.sessionId === sessionId && latest.lifecycleRevision === revision;
          } catch {
            return false;
          }
        },
        abort: () => {
          stopped = true;
          controller.abort(new DOMException("Stopped by the Mattermost turn owner", "AbortError"));
        },
      };
      entry = owner;
      tokens.add(owner.token);
      entries.set(params.sessionKey, owner);
    },
    props(): Record<string, unknown> | undefined {
      if (!entry?.current()) return undefined;
      return {
        // Mattermost strips integration contexts from REST post reads. Keep a
        // public nonce beside the signed callback so replay can verify custody.
        [CONTROL]: entry.token,
        attachments: buildButtonAttachments({
          accountId: monitor.account.accountId,
          callbackUrl: resolveInteractionCallbackUrl(monitor.account.accountId, monitor.cfg),
          buttons: [{
            id: ACTION_ID, name: "Stop", style: "danger",
            context: { [CONTROL]: entry.token, __openclaw_channel_id: params.channelId },
          }],
        }),
      };
    },
    notePost(postId: string) { posts.add(postId); },
    async finish() {
      finished = true;
      retire();
      for (const postId of posts) {
        try {
          const post = await fetchMattermostPost(monitor.client, postId);
          if (post.id !== postId || post.channel_id !== params.channelId ||
              post.user_id !== monitor.botUserId || post.delete_at) continue;
          const attachments = post.props?.attachments;
          const token = post.props?.[CONTROL];
          if (!Array.isArray(attachments) || typeof token !== "string" || !tokens.has(token)) continue;
          const next = attachments.flatMap((attachment) => {
            if (!attachment || typeof attachment !== "object" || !Array.isArray(attachment.actions)) {
              return [attachment];
            }
            const actions = attachment.actions.filter((action: { id?: string }) => action?.id !== ACTION_ID);
            return actions.length || attachment.text ? [{ ...attachment, actions }] : [];
          });
          const props: Record<string, unknown> = { ...post.props, attachments: next };
          delete props[CONTROL];
          await updateMattermostPost(monitor.client, postId, {
            props,
          });
        } catch (error) {
          monitor.logVerboseMessage(`mattermost Stop cleanup failed: ${String(error)}`);
        }
      }
    },
  };
}

/** Always consumes Stop controls, including expired durable callback replays. */
export async function handleMattermostPreviewStop(
  monitor: MattermostMonitorContext,
  interaction: Pick<MattermostValidatedInteraction, "payload" | "context" | "userName">,
): Promise<MattermostInteractionResponse | null> {
  if (!(CONTROL in interaction.context)) return null;
  const stale = { ephemeral_text: "This Stop button has expired." };
  const token = interaction.context[CONTROL];
  const entry = [...registry(monitor).values()].find((candidate) => candidate.token === token);
  if (!entry || !entry.ownsPost(interaction.payload.post_id) || entry.channelId !== interaction.payload.channel_id ||
      entry.senderId !== interaction.payload.user_id || !entry.current()) return stale;
  const post = await fetchMattermostPost(monitor.client, interaction.payload.post_id);
  const attachments = post.props?.attachments;
  if (post.id !== interaction.payload.post_id || post.channel_id !== entry.channelId ||
      post.user_id !== monitor.botUserId || post.delete_at ||
      post.props?.[CONTROL] !== token ||
      !Array.isArray(attachments) || !attachments.some((attachment) =>
        Array.isArray(attachment?.actions) && attachment.actions.some(
          (action: { id?: string }) => action?.id === ACTION_ID,
        ),
      )) return stale;
  const channelInfo = await monitor.resources.resolveChannelInfo(entry.channelId);
  const current = pinMattermostMonitorConfig(monitor);
  const account = resolveMattermostAccount({ cfg: current.cfg, accountId: monitor.account.accountId });
  if (!account.enabled || current.cfg.channels?.mattermost?.enabled === false) return stale;
  const allowTextCommands = monitor.core.channel.commands.shouldHandleTextCommands({
    cfg: current.cfg, surface: "mattermost",
  });
  const decision = await authorizeMattermostCommandInvocation({
    account, cfg: current.cfg, senderId: interaction.payload.user_id,
    senderName: interaction.userName, channelId: entry.channelId, channelInfo,
    readStoreAllowFrom: monitor.pairing.readAllowFromStore,
    allowTextCommands, hasControlCommand: true,
  });
  if (!allowTextCommands || !decision.ok || !decision.commandAuthorized) {
    return { ephemeral_text: "You are not authorized to stop this turn." };
  }
  // Authorization awaits may outlive replacement, reset, completion or restart.
  if (!entry.current()) return stale;
  entry.abort();
  return { ephemeral_text: "Stop requested." };
}
