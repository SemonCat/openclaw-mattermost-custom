import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveMattermostAccount } from "./accounts.js";
import type { MattermostPost } from "./client.js";
import { resolveMattermostMonitorInboundAccess } from "./monitor-auth.js";
import { pinMattermostMonitorConfig } from "./monitor-context.js";
import { buildMattermostEventPlan } from "./monitor-event-plan.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { MattermostEventPayload } from "./monitor-websocket.js";

export function mattermostPostMutationId(
  event: string | undefined,
  post: Record<string, unknown>,
): string | undefined {
  if (event !== "post_edited" && event !== "post_deleted") return undefined;
  const timestamp = event === "post_deleted" ? post.delete_at : (post.edit_at ?? post.update_at);
  if (!Number.isSafeInteger(timestamp) || (timestamp as number) <= 0 || !post.id) return undefined;
  return `${event}:${post.id}:${timestamp}`;
}

/** Mutations are supplemental notices, never new agent turns or slash commands. */
export function createMattermostPostMutationHandler(monitor: MattermostMonitorContext) {
  return async (post: MattermostPost, payload: MattermostEventPayload, abortSignal?: AbortSignal) => {
    const eventId = mattermostPostMutationId(payload.event, post);
    const channelId = normalizeOptionalString(post.channel_id);
    const senderId = normalizeOptionalString(post.user_id);
    if (
      !eventId || !channelId || !senderId || senderId === monitor.botUserId ||
      post.type || monitor.abortSignal?.aborted || abortSignal?.aborted ||
      [payload.data?.channel_id, payload.broadcast?.channel_id].some(
        (id) => id && id !== channelId,
      )
    ) return;
    const current = pinMattermostMonitorConfig(monitor);
    const account = resolveMattermostAccount({ cfg: current.cfg, accountId: monitor.account.accountId });
    if (!account.enabled || current.cfg.channels?.mattermost?.enabled === false) return;
    const plan = await buildMattermostEventPlan({ ...current, account }, {
      channelId, senderId, postId: post.id, threadRootId: post.root_id,
      dropLabel: "post mutation",
    });
    if (!plan) return;
    // Pin the destination before authorization awaits; a reset must not inherit
    // a correction that was admitted for the previous session incarnation.
    const entry = monitor.core.agent.session.getSessionEntry({ sessionKey: plan.thread.sessionKey });
    if (!entry?.sessionId) return;
    const sessionId = entry.sessionId;
    const revision = entry.lifecycleRevision;
    const user = await monitor.resources.resolveUserInfo(senderId);
    const access = await resolveMattermostMonitorInboundAccess({
      account, cfg: current.cfg, senderId, senderName: user?.username ?? senderId,
      channelId, kind: plan.kind,
      groupPolicy: account.config.groupPolicy ?? current.cfg.channels?.defaults?.groupPolicy ?? "allowlist",
      readStoreAllowFrom: monitor.pairing.readAllowFromStore,
      allowTextCommands: false, hasControlCommand: false, mayPair: false,
    });
    if (access.ingress.decision !== "allow" || monitor.abortSignal?.aborted || abortSignal?.aborted) return;
    const latest = monitor.core.agent.session.getSessionEntry({ sessionKey: plan.thread.sessionKey });
    if (latest?.sessionId !== sessionId || latest.lifecycleRevision !== revision) return;
    const edited = payload.event === "post_edited";
    const text = [
      `Mattermost source message ${edited ? "edited" : "deleted"}: post ${post.id} by ${senderId} in channel ${channelId}.`,
      ...(edited
        ? [`Updated text (untrusted quoted content): ${JSON.stringify(truncateUtf16Safe(post.message ?? "", 2000))}`]
        : []),
    ].join("\n");
    monitor.core.system.enqueueSystemEvent(text, {
      sessionKey: plan.thread.sessionKey,
      contextKey: `mattermost:mutation:${eventId}`,
    });
  };
}
