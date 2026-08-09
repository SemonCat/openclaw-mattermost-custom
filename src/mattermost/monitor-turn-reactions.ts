// Mattermost plugin module owns inbound ack and status-reaction lifecycle for one turn.
import {
  createStatusReactionController,
  DEFAULT_TIMING,
  logAckFailure,
  resolveAckReaction,
  shouldAckReaction as shouldAckReactionGate,
  type StatusReactionController,
} from "openclaw/plugin-sdk/channel-feedback";
import {
  createMattermostStatusReactionAdapter,
  MATTERMOST_STATUS_REACTION_EMOJIS,
  resolveMattermostReactionEmojiName,
} from "./ack-reactions.js";
import type { MattermostClient } from "./client.js";
import type { OpenClawConfig } from "./runtime-api.js";

export type MattermostTurnReactionGateFacts = {
  isDirect: boolean;
  isGroup: boolean;
  canDetectMention: boolean;
  effectiveWasMentioned: boolean;
  shouldBypassMention: boolean;
};

type MattermostReactionLifecycleOwner = object;
type MattermostReactionRegistration = "owner" | "joined" | "standalone";

export type MattermostReactionLifecycleStore = ReturnType<
  typeof createMattermostReactionLifecycleStore
>;

/**
 * Shares lifecycle updates with posts steered into the same active Mattermost session.
 * Core has no generic cross-message correlation for status reactions (each channel's
 * ack/status wiring is built fresh per inbound dispatch call), so this store is the
 * Mattermost-local mechanism: the first post for a sessionKey becomes the "owner" and the
 * shared source of truth; a later post arriving while the owner is still active "joins" it
 * so both posts' reactions transition together and settle once, when the owner finishes.
 */
export function createMattermostReactionLifecycleStore() {
  const entries = new Map<
    string,
    { owner: MattermostReactionLifecycleOwner; controllers: Set<StatusReactionController> }
  >();

  const attach = (params: {
    sessionKey: string;
    owner: MattermostReactionLifecycleOwner;
    controller: StatusReactionController;
    allowJoin: boolean;
  }): MattermostReactionRegistration => {
    const active = entries.get(params.sessionKey);
    if (!active) {
      entries.set(params.sessionKey, {
        owner: params.owner,
        controllers: new Set([params.controller]),
      });
      return "owner";
    }
    if (!params.allowJoin) {
      return "standalone";
    }
    active.controllers.add(params.controller);
    return "joined";
  };

  const update = (
    sessionKey: string,
    owner: MattermostReactionLifecycleOwner,
    apply: (controller: StatusReactionController) => Promise<void> | void,
  ) => {
    const active = entries.get(sessionKey);
    if (!active || active.owner !== owner) {
      return false;
    }
    for (const controller of active.controllers) {
      void Promise.resolve(apply(controller)).catch(() => undefined);
    }
    return true;
  };

  const detach = (sessionKey: string, controller: StatusReactionController) => {
    entries.get(sessionKey)?.controllers.delete(controller);
  };

  const finish = async (
    sessionKey: string,
    owner: MattermostReactionLifecycleOwner,
    apply: (controller: StatusReactionController) => Promise<void>,
  ) => {
    const active = entries.get(sessionKey);
    if (!active || active.owner !== owner) {
      return false;
    }
    entries.delete(sessionKey);
    await Promise.all(Array.from(active.controllers, (controller) => apply(controller)));
    return true;
  };

  return { attach, update, detach, finish };
}

/** Builds ack and lifecycle reactions for one accepted Mattermost post. */
export function createMattermostMessageReactionRuntime(params: {
  cfg: OpenClawConfig;
  client: MattermostClient;
  botUserId: string;
  agentId: string;
  accountId: string;
  postId: string;
  sessionKey: string;
  lifecycleStore: MattermostReactionLifecycleStore;
  gate: MattermostTurnReactionGateFacts;
  log: (message: string) => void;
}) {
  const {
    cfg,
    client,
    botUserId,
    agentId,
    accountId,
    postId,
    sessionKey,
    lifecycleStore,
    gate,
    log,
  } = params;
  const rawAckReaction = resolveAckReaction(cfg, agentId, { channel: "mattermost", accountId });
  const ackReaction = rawAckReaction ? resolveMattermostReactionEmojiName(rawAckReaction) : null;
  if (rawAckReaction && !ackReaction) {
    log(`mattermost: unsupported ack reaction ${JSON.stringify(rawAckReaction)}`);
  }
  const shouldSendAckReaction = Boolean(
    postId &&
    ackReaction &&
    shouldAckReactionGate({
      scope: cfg.messages?.ackReactionScope,
      isDirect: gate.isDirect,
      isGroup: gate.isGroup,
      isMentionableGroup: gate.isGroup,
      canDetectMention: gate.canDetectMention,
      effectiveWasMentioned: gate.effectiveWasMentioned,
      shouldBypassMention: gate.shouldBypassMention,
    }),
  );
  const statusReactionsEnabled =
    shouldSendAckReaction && cfg.messages?.statusReactions?.enabled === true;
  const adapter = createMattermostStatusReactionAdapter({ client, botUserId, postId });
  const target = `mattermost:${postId}`;
  const controller: StatusReactionController = createStatusReactionController({
    enabled: statusReactionsEnabled,
    adapter,
    initialEmoji: ackReaction ?? "",
    emojis: MATTERMOST_STATUS_REACTION_EMOJIS,
    timing: DEFAULT_TIMING,
    onError: (err) => {
      logAckFailure({ log, channel: "mattermost", target, error: err });
    },
  });

  let initialAckReactionQueued = false;
  const lifecycleOwner: MattermostReactionLifecycleOwner = {};
  let registration: MattermostReactionRegistration | undefined;
  const queueInitialAckReactionAfterRecord = () => {
    if (initialAckReactionQueued) {
      return;
    }
    initialAckReactionQueued = true;
    if (statusReactionsEnabled) {
      // Only steer mode is known to actually resume the owner's still-running turn; other
      // queue modes eventually run this post's own independent turn, so joining them would
      // strand this controller. A misconfigured/inconsistent effective mode still self-heals
      // in finish() below once this call's own dispatch outcome proves it wasn't steered.
      registration = lifecycleStore.attach({
        sessionKey,
        owner: lifecycleOwner,
        controller,
        allowJoin:
          (cfg.messages?.queue?.byChannel?.mattermost ?? cfg.messages?.queue?.mode ?? "steer") ===
          "steer",
      });
      void controller.setQueued();
      return;
    }
    if (!shouldSendAckReaction || !ackReaction) {
      return;
    }
    void adapter.setReaction(ackReaction).catch((err: unknown) => {
      logAckFailure({ log, channel: "mattermost", target, error: err });
    });
  };

  const update = (apply: (target: StatusReactionController) => Promise<void> | void) => {
    if (registration === "owner") {
      lifecycleStore.update(sessionKey, lifecycleOwner, apply);
      return;
    }
    if (registration !== "joined") {
      void Promise.resolve(apply(controller)).catch(() => undefined);
    }
  };

  const finish = async (result: { dispatchError: boolean; anyReplyDelivered: boolean }) => {
    if (!statusReactionsEnabled || !initialAckReactionQueued) {
      return;
    }
    const settle = async (targetController: StatusReactionController) => {
      if (result.dispatchError) {
        // setError() already sweeps every intermediate reaction (queued/thinking/tool/...)
        // in one pass and keeps only the error emoji; that failure marker must stay visible
        // on the post as the turn's recorded outcome.
        await targetController.setError();
        return;
      }
      if (result.anyReplyDelivered) {
        // Same sweep, but for the success emoji; it stays visible as the turn's outcome.
        await targetController.setDone();
        return;
      }
      // No error and no visible reply: there is no terminal emoji to show, so drop the
      // queued/intermediate reactions instead of leaving 👀 stranded or restoring it.
      await targetController.clear();
    };
    if (registration === "owner") {
      await lifecycleStore.finish(sessionKey, lifecycleOwner, settle);
      return;
    }
    // A "joined" post that never actually observes its own error or delivery was genuinely
    // steered into the owner's turn: the owner's finish() above settles it. But if this call's
    // own dispatch produced real evidence of an independent run (its own error, or its own
    // visible delivery), the queue-mode prediction above was wrong for this message, and
    // waiting for the owner would leave this reaction stuck forever (the owner may have
    // already finished and removed the shared entry). Self-detach and settle from real facts.
    if (registration === "joined" && !result.dispatchError && !result.anyReplyDelivered) {
      return;
    }
    if (registration === "joined") {
      lifecycleStore.detach(sessionKey, controller);
    }
    await settle(controller);
  };

  return {
    statusReactionsEnabled,
    controller,
    queueInitialAckReactionAfterRecord,
    setThinking: () => update((targetController) => targetController.setThinking()),
    setTool: (toolName?: string) =>
      update((targetController) => targetController.setTool(toolName)),
    setCompacting: () => update((targetController) => targetController.setCompacting()),
    cancelPending: () => update((targetController) => targetController.cancelPending()),
    finish,
  };
}
