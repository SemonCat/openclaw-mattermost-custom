// Mattermost plugin module owns one accepted message's reply turn and delivery.
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  hasVisibleInboundReplyDispatch,
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
  readAgentRunTerminalOutcome,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  bindIngressLifecycleToReplyOptions,
  createMessageReceiptFromOutboundResults,
  createChannelProgressDraftCompositor,
  createLivePreviewLifecycle,
  listMessageReceiptPlatformIds,
} from "openclaw/plugin-sdk/channel-outbound";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import {
  getReplyPayloadTtsSupplement,
  isReplyPayloadTerminalContent,
  stripReplyPayloadResponsePrefix,
} from "openclaw/plugin-sdk/reply-payload";
import type { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { resolveInboundLastRouteSessionKey } from "openclaw/plugin-sdk/routing";
import {
  fetchMattermostPost,
  type MattermostPost,
} from "./client.js";
import {
  createMattermostDraftPreviewBoundaryController,
  createMattermostDraftStream,
} from "./draft-stream.js";
import { normalizeMattermostAllowEntry } from "./monitor-auth.js";
import {
  canFinalizeMattermostPreviewInPlace,
  formatMattermostFinalDeliveryOutcomeLog,
  resolveMattermostReplyRootId,
  shouldSuppressMattermostDefaultToolProgressMessages,
  shouldUpdateMattermostDraftToolProgress,
} from "./monitor-context.js";
import {
  deliverMattermostReplyWithDraftPreview,
  type MattermostPreviewFinalResolution,
} from "./monitor-draft-delivery.js";
import type { MattermostEventPlan } from "./monitor-event-plan.js";
import {
  keepMattermostIngressAliveWhileDispatchPending,
  type MattermostIngressLifecycle,
} from "./monitor-ingress.js";
import {
  createMattermostMessageReactionRuntime,
  type MattermostReactionLifecycleStore,
  type MattermostTurnReactionGateFacts,
} from "./monitor-turn-reactions.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import { buildMattermostPostIdentityProps } from "./post-identity.js";
import { restoreMattermostTaskMessage } from "./task-progress-projection.js";
import { deliverMattermostReplyPayload, joinMattermostVisibleContent } from "./reply-delivery.js";
import type { HistoryEntry, ReplyPayload } from "./runtime-api.js";
import { createChannelMessageReplyPipeline } from "./runtime-api.js";
import { sendMessageMattermost } from "./send.js";
import { retainMattermostProgressDraft } from "./monitor-progress-continuation.js";
import { withMattermostSessionAdmissionRetry } from "./session-admission-retry.js";
import { recordMattermostThreadParticipation } from "./thread-participation.js";
import {
  createMattermostTaskProgressCard,
  type MattermostVisibleWorkSession,
} from "./task-progress-card.js";

type MattermostInboundTurnParams = {
  post: MattermostPost;
  rawText: string;
  ctxPayload: ReturnType<typeof finalizeInboundContext>;
  eventPlan: MattermostEventPlan;
  historyKey: string | null;
  historyLimit: number;
  channelHistories: Map<string, HistoryEntry[]>;
  pinnedMainDmOwner: string | null;
  turnAdoptionLifecycle?: MattermostIngressLifecycle;
  reactionLifecycleStore: MattermostReactionLifecycleStore;
  ackGate: Omit<MattermostTurnReactionGateFacts, "isDirect" | "isGroup">;
};

type MattermostReplyDispatchResult = {
  queuedFinal?: boolean;
  counts?: Partial<Record<"tool" | "block" | "final", number>>;
  failedCounts?: Partial<Record<"tool" | "block" | "final", number>>;
  observedReplyDelivery?: boolean;
  deferredToActiveRun?: "steer" | "followup";
};

function readVisibleWorkSessionStatus(
  value: unknown,
): MattermostVisibleWorkSession["status"] {
  switch (value) {
    case "queued":
    case "running":
    case "done":
    case "failed":
    case "interrupted":
    case "killed":
    case "timeout":
      return value;
    default:
      return undefined;
  }
}

function createDisabledMattermostDraftStream(): ReturnType<typeof createMattermostDraftStream> {
  const noopAsync = async () => {};
  return {
    update: () => {},
    updateAssistantText: () => {},
    promoteFinalParts: async () => {},
    flush: noopAsync,
    postId: () => undefined,
    isSilent: () => false,
    clear: noopAsync,
    deleteCurrentMessage: noopAsync,
    discardPending: noopAsync,
    seal: noopAsync,
    stop: noopAsync,
    forceNewMessage: noopAsync,
    handoffPostIdentity: async () => undefined,
    settleBoundaries: noopAsync,
    resolveFinalText: (text) => ({ kind: "full", text, publishedParts: [] }),
    findPostAfter: async () => undefined,
  };
}

export async function dispatchMattermostInboundTurn(
  monitor: MattermostMonitorContext,
  params: MattermostInboundTurnParams,
): Promise<void> {
  const { account, botUserId, cfg, client, core, runtime } = monitor;
  const {
    ackGate,
    channelHistories,
    ctxPayload,
    eventPlan,
    historyKey,
    historyLimit,
    pinnedMainDmOwner,
    post,
    rawText,
    reactionLifecycleStore,
    turnAdoptionLifecycle,
  } = params;
  const { channelId, kind, route, senderId, thread, to } = eventPlan;
  const { effectiveReplyToId } = thread;
  const sourceQueuedLifecycleSupported =
    core.capabilities?.includes("queued-source-lifecycle-v1") === true;
  const reactions = createMattermostMessageReactionRuntime({
    cfg,
    client,
    botUserId,
    agentId: route.agentId,
    accountId: account.accountId,
    postId: post.id ?? "",
    sessionKey: thread.sessionKey,
    lifecycleStore: reactionLifecycleStore,
    gate: {
      isDirect: kind === "direct",
      isGroup: kind !== "direct",
      canDetectMention: ackGate.canDetectMention,
      effectiveWasMentioned: ackGate.effectiveWasMentioned,
      shouldBypassMention: ackGate.shouldBypassMention,
    },
    log: monitor.logVerboseMessage,
  });
  reactions.startIngressReceipt();
  const {
    deliveryBarrier,
    replyOptions,
    replyPipeline: baseReplyPipeline,
    tableMode,
    textLimit,
  } = eventPlan.createReplyPlan();
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "mattermost", account.accountId);
  const { onModelSelected, typingCallbacks, resolveResponsePrefix, ...dispatcherPipeline } =
    createChannelMessageReplyPipeline({
      cfg,
      agentId: route.agentId,
      channel: "mattermost",
      accountId: account.accountId,
      typing: baseReplyPipeline.typing,
    });
  // Provider drafts are visible before outbound modifiers run. Keep them off whenever a hook
  // can rewrite or cancel so the original payload cannot escape the durable delivery gate.
  const hookRunner = getGlobalHookRunner();
  const allowProviderPreview = !(
    (hookRunner?.hasHooks("reply_payload_sending") ?? false) ||
    (hookRunner?.hasHooks("message_sending") ?? false)
  );
  const draftPreviewEnabled = allowProviderPreview && account.streamingMode !== "off";
  const draftToolProgressEnabled =
    draftPreviewEnabled && shouldUpdateMattermostDraftToolProgress(account);
  const suppressDefaultToolProgressMessages =
    draftPreviewEnabled && shouldSuppressMattermostDefaultToolProgressMessages(account);
  let claimResultPost: (() => Promise<string | undefined>) | undefined;
  let unsubscribeAgentEvents: (() => void) | undefined;
  let agentEventsShouldStop = false;
  const stopAgentEvents = () => {
    agentEventsShouldStop = true;
    unsubscribeAgentEvents?.();
    unsubscribeAgentEvents = undefined;
  };
  monitor.taskCardContinuation?.retireSession(thread.sessionKey);
  let initialRunId: string | undefined;
  let continuationRegistered = false;
  let continuationSessionId: string | undefined;
  let progressDraftAdopted = false;
  let continuationOwner: ReturnType<NonNullable<MattermostMonitorContext["taskCardContinuation"]>["register"]>;
  const taskProgressCard = createMattermostTaskProgressCard({
    client,
    channelId,
    rootId: effectiveReplyToId,
    postProps: buildMattermostPostIdentityProps("task_progress", {
      accountId: account.accountId,
      agentId: route.agentId,
      channelId,
      ...(effectiveReplyToId ? { threadId: effectiveReplyToId } : {}),
    }),
    claimResultPost: async () => await claimResultPost?.(),
    onSettled: stopAgentEvents,
    log: monitor.logVerboseMessage,
  });
  const registerContinuation = () => {
    if (continuationRegistered || !initialRunId || !monitor.taskCardContinuation) return;
    try {
      const entry = core.agent.session.getSessionEntry({
        agentId: route.agentId, sessionKey: thread.sessionKey,
      });
      if (!entry?.sessionId) return;
      continuationSessionId = entry.sessionId;
      continuationOwner = monitor.taskCardContinuation.register({
        agentId: route.agentId, sessionId: entry.sessionId,
        sessionKey: thread.sessionKey, initialRunId, card: taskProgressCard,
      });
      continuationRegistered = true;
    } catch (error: unknown) {
      monitor.logVerboseMessage(`mattermost continuation identity unavailable: ${String(error)}`);
    }
  };
  const draftStream = draftPreviewEnabled
    ? createMattermostDraftStream({
        client,
        silentProgress: true,
        workDetails: true,
        channelId,
        rootId: effectiveReplyToId,
        postProps: buildMattermostPostIdentityProps("turn_result", {
          accountId: account.accountId,
          agentId: route.agentId,
          channelId,
          ...(effectiveReplyToId ? { threadId: effectiveReplyToId } : {}),
        }),
        beforeCreatePost: taskProgressCard.settleBeforeResultPostCreate,
        throttleMs: 1200,
        companion: account.config.streaming?.transport === "companion",
        maxChars: textLimit,
        chunkText: (value) =>
          core.channel.text.chunkMarkdownTextWithMode(
            core.channel.text.convertMarkdownTables(value, tableMode),
            textLimit,
            chunkMode,
          ),
        log: monitor.logVerboseMessage,
        warn: monitor.logVerboseMessage,
      })
    : createDisabledMattermostDraftStream();
  claimResultPost = draftStream.handoffPostIdentity;
  const previewBoundaryController = createMattermostDraftPreviewBoundaryController({
    enabled: draftPreviewEnabled && account.streamingMode === "block",
    forceNewMessage: async () => {
      await draftStream.forceNewMessage();
    },
  });
  let lastPartialText = "";
  let lastAssistantSourceText = "";
  let firstAssistantPreviewPrefix: string | undefined;
  let firstAssistantPreviewPrefixPending = true;
  let currentAssistantPreviewUsesPrefix = false;
  let blockPreviewActivity: "none" | "reasoning" | "text" | "tool" = "none";
  let blockPreviewAssistantMessagePending = false;
  const progressDraft = createChannelProgressDraftCompositor({
    preparedItems: true,
    toolIcons: true,
    entry: account.config,
    mode: account.streamingMode,
    active: draftPreviewEnabled,
    seed: `${account.accountId}:${channelId}`,
    shouldStartNow: (line) => typeof line === "object" && line.kind === "item",
    update: async (previewText, options) => {
      draftStream.update(previewText);
      if (options?.flush) {
        await draftStream.flush();
      }
    },
    deleteCurrent: () => draftStream.deleteCurrentMessage(),
  });
  unsubscribeAgentEvents =
    core.events?.onAgentEvent?.((evt) => {
      taskProgressCard.noteAgentEvent(evt);
    }) ?? (() => {});
  if (agentEventsShouldStop) {
    stopAgentEvents();
  }
  const enterBlockPreviewActivity = (activity: "reasoning" | "text" | "tool") => {
    if (account.streamingMode !== "block") {
      return undefined;
    }
    const continuingToolActivity = activity === "tool" && blockPreviewActivity === "tool";
    const continuingTextActivity =
      activity === "text" &&
      blockPreviewActivity === "text" &&
      !blockPreviewAssistantMessagePending;
    const continuingReasoningActivity =
      activity === "reasoning" && blockPreviewActivity === "reasoning";
    const continuesCurrentActivity =
      continuingToolActivity || continuingTextActivity || continuingReasoningActivity;
    // A successor reuses reasoning placeholders; other boundaries seal assistant prose or retire tool progress.
    const startsNewGeneration = !continuesCurrentActivity && blockPreviewActivity !== "reasoning";
    if (startsNewGeneration) {
      currentAssistantPreviewUsesPrefix = false;
    }
    const boundarySettled = startsNewGeneration
      ? previewBoundaryController.noteBoundary()
      : undefined;
    // Message-start is only a candidate boundary: consecutive tools stay together, while the first visible text or reasoning starts a new block.
    if (!continuesCurrentActivity) {
      progressDraft.resetActivity();
    }
    blockPreviewActivity = activity;
    blockPreviewAssistantMessagePending = false;
    if (activity === "tool") {
      lastPartialText = "";
      lastAssistantSourceText = "";
    }
    return boundarySettled;
  };
  const previewLifecycle = createLivePreviewLifecycle<ReplyPayload, string>({
    draft: draftPreviewEnabled
      ? {
          flush: draftStream.flush,
          id: draftStream.postId,
          seal: draftStream.seal,
          discardPending: draftStream.discardPending,
          clear: draftStream.clear,
        }
      : undefined,
    onFinalStarted: () => progressDraft.markFinalReplyStarted(),
    onFinalDelivered: () => progressDraft.markFinalReplyDelivered(),
    onCleanupFailure: (err) =>
      monitor.logVerboseMessage(`mattermost draft preview cleanup failed: ${String(err)}`),
  });

  const resolvePreviewFinalText = (text?: string): MattermostPreviewFinalResolution | undefined => {
    const resolution = draftStream.resolveFinalText(typeof text === "string" ? text : "");
    const confirmedDelivery =
      resolution.publishedParts.length > 0
        ? (() => {
            const receipt = createMessageReceiptFromOutboundResults({
              results: resolution.publishedParts.map((part) => ({
                channel: "mattermost",
                messageId: part.messageId,
                channelId,
              })),
              kind: "preview",
              ...(effectiveReplyToId ? { replyToId: effectiveReplyToId } : {}),
            });
            return {
              outcome: "text" as const,
              messageIds: listMessageReceiptPlatformIds(receipt),
              receipt,
              visibleReplySent: true,
              content: joinMattermostVisibleContent(
                resolution.publishedParts.map((part) => part.content),
              ),
            };
          })()
        : undefined;
    const deliveryText = resolution.kind === "already-delivered" ? "" : resolution.text;
    const formatted = core.channel.text.convertMarkdownTables(deliveryText, tableMode);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(formatted, textLimit, chunkMode);
    if (!chunks.length && formatted) {
      chunks.push(formatted);
    }
    if (chunks.length !== 1) {
      return {
        deliveryText,
        confirmedDelivery,
        alreadyDelivered: resolution.kind === "already-delivered",
      };
    }
    const trimmed = chunks[0]?.trim();
    if (!trimmed) {
      return {
        deliveryText,
        confirmedDelivery,
        alreadyDelivered: resolution.kind === "already-delivered",
      };
    }
    return {
      editText: trimmed,
      deliveryText,
      confirmedDelivery,
      alreadyDelivered: false,
    };
  };

  const updateDraftFromPartial = (text?: string, delta = false) => {
    if (typeof text !== "string") return undefined;
    const source = delta ? lastAssistantSourceText + text : text;
    lastAssistantSourceText = source;
    const cleaned = source.trim();
    if (!cleaned || cleaned === lastPartialText) {
      return undefined;
    }
    // Ordered snapshots replace this message's draft, including corrections that shorten it.
    const boundarySettled = enterBlockPreviewActivity("text");
    progressDraft.resetActivity({ suppressed: true });
    lastPartialText = cleaned;
    if (firstAssistantPreviewPrefixPending) {
      firstAssistantPreviewPrefix = resolveResponsePrefix?.();
      firstAssistantPreviewPrefixPending = false;
      currentAssistantPreviewUsesPrefix = Boolean(firstAssistantPreviewPrefix);
    }
    const previewText =
      currentAssistantPreviewUsesPrefix && firstAssistantPreviewPrefix
        ? cleaned.startsWith(firstAssistantPreviewPrefix)
          ? cleaned
          : `${firstAssistantPreviewPrefix} ${cleaned}`
        : cleaned;
    draftStream.updateAssistantText(previewText);
    previewBoundaryController.noteUpdate();
    return boundarySettled;
  };

  // Set as soon as any core reply/tool callback or delivery attempt fires, proving this
  // attempt passed admission and started user-visible work. A session-admission retry must
  // never re-run past that point, so this flag — not knowledge of which core call site can
  // throw after partial side effects — is what gates the retry below.
  let hasStartedWork = false;
  const dispatcherOptions: NonNullable<ChannelInboundTurnPlan["dispatcherOptions"]> = {
    ...dispatcherPipeline,
    resolveFollowupAdmissionBarrierTimeoutPolicy: deliveryBarrier.resolveTimeoutPolicy,
    onDeliverySettled: deliveryBarrier.markDeliverySettled,
    humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
    typingCallbacks,
    onReplyStart: async () => {
      hasStartedWork = true;
      await typingCallbacks?.onReplyStart();
      if (canUpdateReactionsFromRenderer()) {
        reactions.setThinking();
      }
    },
  };
  let anyReplyDelivered = false;
  let queuedFollowupActive = false;
  let queuedFollowupDeliveryError = false;
  let sourceQueuedLifecycleObserved = false;
  const canUpdateReactionsFromRenderer = () =>
    !sourceQueuedLifecycleSupported || Boolean(initialRunId) || queuedFollowupActive;
  let queuedReactionSettlement: Promise<void> | undefined;
  const admitQueuedReactions = () => {
    if (queuedFollowupActive || queuedReactionSettlement) {
      return;
    }
    queuedFollowupActive = true;
    queuedFollowupDeliveryError = false;
    anyReplyDelivered = false;
    reactions.admitQueuedFollowup();
  };
  const settleQueuedReactions = (result?: {
    dispatchError: boolean;
    anyReplyDelivered: boolean;
  }) => {
    queuedReactionSettlement ??= (async () => {
      try {
        await reactions.finishQueuedFollowup(
          result ?? { dispatchError: queuedFollowupDeliveryError, anyReplyDelivered },
        );
      } finally {
        queuedFollowupActive = false;
      }
    })();
    return queuedReactionSettlement;
  };
  // Keep the structural extension optional on the published SDK's begin-only
  // contract. Older hosts retain the source run-start and legacy runner paths.
  const queuedReactionCorrelation = {
    begin: () => {
      if (queuedReactionSettlement) {
        return;
      }
      queuedFollowupActive = false;
      return reactions.beginQueuedFollowup();
    },
    onAdmitted: () => {
      sourceQueuedLifecycleObserved = true;
      admitQueuedReactions();
    },
    onToolStart: (payload: { name?: string; toolCallId?: string }) => {
      if (sourceQueuedLifecycleObserved && queuedFollowupActive) {
        reactions.setTool(payload.name);
      }
    },
    onSettled: (result: { dispatchError: boolean; anyReplyDelivered: boolean }) => {
      sourceQueuedLifecycleObserved = true;
      return settleQueuedReactions(result);
    },
  };
  let resolveQueuedFollowupLifecycle: (() => void) | undefined;
  const queuedFollowupLifecycleSettled = new Promise<void>((resolve) => {
    resolveQueuedFollowupLifecycle = resolve;
  });
  const pendingDispatchIngress = turnAdoptionLifecycle
    ? keepMattermostIngressAliveWhileDispatchPending(turnAdoptionLifecycle)
    : undefined;
  const ingressReplyOptions = pendingDispatchIngress
    ? bindIngressLifecycleToReplyOptions(pendingDispatchIngress.lifecycle)
    : undefined;
  const deferredTurnAdoptionLifecycle = ingressReplyOptions?.turnAdoptionLifecycle
    ? {
        ...ingressReplyOptions.turnAdoptionLifecycle,
        // Core owns a deferred follow-up after the initial dispatch returns. Its
        // terminal settlement is the safe point to release this turn's provider
        // presentation resources, including plan/tool callbacks and subscriptions.
        onSettled: () => {
          resolveQueuedFollowupLifecycle?.();
          resolveQueuedFollowupLifecycle = undefined;
        },
      }
    : undefined;
  const delivery: ChannelInboundTurnPlan["delivery"] = {
    observeMessageSent: true,
    deliver: async (payloadEntry: ReplyPayload, info) => {
      hasStartedWork = true;
      // A plan callback may still be publishing because OpenClaw orders callback starts,
      // not their completion. Join any task-card write already queued for this delivery.
      const taskCardBarrier = taskProgressCard.settleBeforeResultPost();
      if (taskCardBarrier) {
        await taskCardBarrier;
      }
      if (
        !progressDraftAdopted && draftPreviewEnabled && account.streamingMode === "progress" &&
        info.kind === "final" && info.adoptProgressDraft && monitor.taskCardContinuation &&
        initialRunId && continuationSessionId && taskProgressCard.postId() &&
        !payloadEntry.isError && !payloadEntry.isCommentary && !payloadEntry.isReasoning &&
        !payloadEntry.mediaUrl && !payloadEntry.mediaUrls?.length &&
        payloadEntry.interactive === undefined && payloadEntry.presentation === undefined &&
        payloadEntry.channelData === undefined && !previewLifecycle.previewFinalized
      ) {
        const snapshot = progressDraft.getSnapshot();
        const text = progressDraft.getText().trimEnd();
        if (text && (progressDraft.hasStatusHeadline || progressDraft.hasPlanProgress || snapshot.lines.length)) {
          const assertCurrent = () => {
            monitor.abortSignal?.throwIfAborted();
            if (core.agent.session.getSessionEntry({ sessionKey: thread.sessionKey })?.sessionId !== continuationSessionId) {
              throw new Error("Mattermost progress session changed");
            }
          };
          assertCurrent();
          // Freeze and confirm the old producer before giving its identity to a new owner.
          progressDraft.markFinalReplyStarted();
          await draftStream.stop();
          const postId = draftStream.postId();
          if (postId) {
            const confirmed = await fetchMattermostPost(client, postId)
              .then((post) => restoreMattermostTaskMessage(post, botUserId)).catch((error: unknown) => {
              assertCurrent();
              monitor.logVerboseMessage(`mattermost progress adoption confirmation failed: ${String(error)}`);
              return undefined;
            });
            assertCurrent();
            if (confirmed && confirmed.id === postId && confirmed.channel_id === channelId &&
                (confirmed.root_id || undefined) === effectiveReplyToId &&
                confirmed.user_id === botUserId && confirmed.message === text) {
              let releaseRetained: (() => void) | undefined;
              const retained = retainMattermostProgressDraft({
                client, channelId, rootId: effectiveReplyToId, postId, text, snapshot,
                silent: confirmed.props?.silent_notification === true,
                entry: account.config, seed: `${account.accountId}:${channelId}`, maxChars: textLimit,
                abortSignal: monitor.abortSignal, assertCurrent, log: monitor.logVerboseMessage,
                ownsChildActivity: taskProgressCard.ownsChildActivity,
                onRetired: () => releaseRetained?.(),
              });
              if (info.adoptProgressDraft(retained)) {
                progressDraftAdopted = true;
                taskProgressCard.suppressChildToolProgress();
                previewLifecycle.retainPreview();
                if (!retained.retired) releaseRetained = monitor.taskCardContinuation.retainProgressDraft({
                  agentId: route.agentId, sessionId: continuationSessionId,
                  sessionKey: thread.sessionKey, draft: retained,
                });
                // Preserve buffered native input when attaching host custody.
                // A fenced owner needs fresh registration, with no old correlation.
                if (!continuationOwner?.adoptDraft(retained)) {
                  continuationOwner = monitor.taskCardContinuation.register({
                    agentId: route.agentId, sessionId: continuationSessionId,
                    sessionKey: thread.sessionKey, initialRunId, card: taskProgressCard,
                    adoptedDraft: retained,
                  });
                }
                anyReplyDelivered = true;
                return { visibleReplySent: true };
              }
              // Rejection leaves the original draft to ordinary final delivery/cleanup.
              retained.release();
            }
          }
        }
      }
      if (info.kind === "final") {
        await enterBlockPreviewActivity("text");
        // Final text uses only confirmed-visible generations, so join prior boundary work before deciding whether to edit in place.
        await draftStream.settleBoundaries();
        if (!payloadEntry.isCommentary && !payloadEntry.isReasoning && !payloadEntry.isError &&
            !payloadEntry.isStatusNotice) {
          const finalText = payloadEntry.text ?? getReplyPayloadTtsSupplement(payloadEntry)?.spokenText;
          if (typeof finalText === "string") await draftStream.promoteFinalParts(finalText);
        }
      }
      // A visible same-thread final can be a send or an in-place draft edit; either path records participation.
      let threadParticipationRecorded = false;
      const markThreadParticipation = async () => {
        if (!threadParticipationRecorded && kind !== "direct" && effectiveReplyToId) {
          threadParticipationRecorded = true;
          await recordMattermostThreadParticipation(
            account.accountId,
            channelId,
            effectiveReplyToId,
            { agentId: route.agentId },
          );
        }
      };
      if (
        draftPreviewEnabled && !previewLifecycle.finalStarted &&
        info.kind === "block" && payloadEntry.textMode === "delta" &&
        typeof payloadEntry.text === "string" && isReplyPayloadTerminalContent(payloadEntry) &&
        !payloadEntry.isError && !payloadEntry.mediaUrl && !payloadEntry.mediaUrls?.length &&
        !payloadEntry.presentation && !payloadEntry.interactive && !payloadEntry.channelData &&
        canFinalizeMattermostPreviewInPlace({
          kind, previewRootId: effectiveReplyToId, threadRootId: effectiveReplyToId,
          replyToId: payloadEntry.replyToId,
        })
      ) {
        const text = lastAssistantSourceText
          ? stripReplyPayloadResponsePrefix(payloadEntry, payloadEntry.text)
          : payloadEntry.text;
        await updateDraftFromPartial(text, true);
        await draftStream.flush();
        const messageId = draftStream.postId();
        if (messageId) {
          const result = {
            outcome: "text" as const,
            visibleReplySent: true,
            messageIds: [messageId],
            receipt: createMessageReceiptFromOutboundResults({
              results: [{ channel: "mattermost", channelId, messageId }],
              kind: "preview",
              ...(effectiveReplyToId ? { replyToId: effectiveReplyToId } : {}),
            }),
            content: payloadEntry.text,
          };
          try {
            await markThreadParticipation();
          } catch (error) {
            throw createChannelPartialDeliveryError(error, result);
          }
          anyReplyDelivered = true;
          return result;
        }
      }
      const result = await deliverMattermostReplyWithDraftPreview({
        payload: payloadEntry,
        info,
        kind,
        client,
        previewLifecycle,
        effectiveReplyToId,
        resolvePreviewFinalText,
        logVerboseMessage: monitor.logVerboseMessage,
        recordThreadParticipation: markThreadParticipation,
        findPostAfterPreview: draftStream.findPostAfter,
        mustSendFinalAsNewPost: () => draftStream.isSilent?.() === true,
        preservePreview: async () => {
          await draftStream.forceNewMessage();
          await draftStream.stop();
        },
        deliverPayload: async (payloadToDeliver) => {
          const finalTextResolution =
            info.kind === "final" &&
            !payloadToDeliver.isStatusNotice &&
            !payloadToDeliver.isError &&
            typeof payloadToDeliver.text === "string"
              ? draftStream.resolveFinalText(payloadToDeliver.text)
              : undefined;
          const resolvedPayload = finalTextResolution
            ? {
                ...payloadToDeliver,
                text:
                  finalTextResolution.kind === "already-delivered" ? "" : finalTextResolution.text,
              }
            : payloadToDeliver;
          const deliveryResult = await deliverMattermostReplyPayload({
            core,
            cfg,
            payload: resolvedPayload,
            channelId,
            accountId: account.accountId,
            agentId: route.agentId,
            replyToId: resolveMattermostReplyRootId({
              kind,
              threadRootId: effectiveReplyToId,
              replyToId: payloadToDeliver.replyToId,
            }),
            textLimit,
            tableMode,
            workDetails: info.kind === "tool",
            sendMessage: sendMessageMattermost,
            onDmChannelResolution: deliveryBarrier.trackDmChannelResolution,
          }).catch(async (error: unknown) => {
            if (isChannelPartialDeliveryError(error)) {
              await markThreadParticipation();
            }
            throw error;
          });
          // Record only visible sends so reasoning-only, empty, or suppressed threads do not auto-engage later.
          if (deliveryResult.outcome === "text" || deliveryResult.outcome === "media") {
            await markThreadParticipation();
          } else if (
            deliveryResult.outcome === "empty" &&
            finalTextResolution?.kind === "already-delivered"
          ) {
            // The terminal payload confirms the already-published assistant block as
            // the visible final reply even though this delivery has no remaining text.
            await markThreadParticipation();
          }
          const deliveryLog = formatMattermostFinalDeliveryOutcomeLog({
            outcome: deliveryResult.outcome,
            payload: resolvedPayload,
            to,
            accountId: account.accountId,
            agentId: route.agentId,
          });
          if (deliveryLog) {
            runtime.log?.(deliveryLog);
          }
          return deliveryResult;
        },
      }).catch(async (error: unknown) => {
        if (isChannelPartialDeliveryError(error)) {
          await markThreadParticipation();
        }
        throw error;
      });
      if (result.visibleReplySent) {
        await markThreadParticipation();
        anyReplyDelivered = true;
      }
      return result;
    },
    onError: (err, info) => {
      if (info.kind === "final") {
        previewLifecycle.observeFailure();
      }
      if (queuedFollowupActive) {
        queuedFollowupDeliveryError = true;
      }
      runtime.error?.(`mattermost ${info.kind} reply failed: ${String(err)}`);
    },
  };
  const inboundLastRouteSessionKey = resolveInboundLastRouteSessionKey({
    route,
    sessionKey: route.sessionKey,
  });

  const turnStartedAt = Date.now();
  let dispatchError = false;
  let turnResult: Awaited<ReturnType<typeof core.channel.inbound.run>> | undefined;
  let presentationCleanupStarted = false;
  const finishPresentation = async () => {
    if (presentationCleanupStarted) {
      return;
    }
    presentationCleanupStarted = true;
    try {
      await draftStream.stop();
    } catch (err) {
      monitor.logVerboseMessage(`mattermost draft preview cleanup failed: ${String(err)}`);
    }
    const dispatchResult = turnResult?.dispatched
      ? (turnResult.dispatchResult as MattermostReplyDispatchResult)
      : undefined;
    const finalDeliveryFailed = (dispatchResult?.failedCounts?.final ?? 0) > 0;
    // Silent progress is not an answer. Retire it even when no final was sent or
    // execution failed; an adopted draft belongs to the host continuation.
    if (!progressDraftAdopted && draftStream.isSilent?.() === true) {
      try {
        await draftStream.clear();
      } catch (err) {
        monitor.logVerboseMessage(`mattermost progress preview cleanup failed: ${String(err)}`);
      }
    }
    await previewLifecycle.cleanup({
      failed: dispatchError || finalDeliveryFailed || queuedFollowupDeliveryError,
    });
    try {
      const directChildSessions = core.agent.session
        .listSessionEntries({
          agentId: route.agentId,
          readOnly: true,
        })
        .flatMap(({ sessionKey, entry }) => {
          if (
            entry.spawnedBy !== thread.sessionKey ||
            typeof entry.createdAt !== "number" ||
            entry.createdAt < turnStartedAt
          ) {
            return [];
          }
          return [
            {
              sessionKey,
              label: typeof entry.label === "string" ? entry.label : undefined,
              sessionId: entry.sessionId,
              status: readVisibleWorkSessionStatus(entry.status),
            } satisfies MattermostVisibleWorkSession,
          ];
        });
      if (directChildSessions.length > 0 && taskProgressCard.hasProgress()) {
        registerContinuation();
        await taskProgressCard.noteVisibleWorkSessions(directChildSessions);
      }
    } catch (error: unknown) {
      monitor.logVerboseMessage(
        `mattermost hidden work session discovery failed parent=${thread.sessionKey}: ${String(error)}`,
      );
    }
    await taskProgressCard.finish({
      outcome: readAgentRunTerminalOutcome(dispatchResult),
      deliveryFailed: dispatchError || finalDeliveryFailed || queuedFollowupDeliveryError,
    });
    continuationOwner?.finishInitial();
    await reactions.finish({
      dispatchError: dispatchError || finalDeliveryFailed || queuedFollowupDeliveryError,
      anyReplyDelivered: anyReplyDelivered || hasVisibleInboundReplyDispatch(dispatchResult),
    });
  };
  try {
    turnResult = await withMattermostSessionAdmissionRetry({
      hasStartedWork: () => hasStartedWork,
      run: () =>
        core.channel.inbound.run({
          channel: "mattermost",
          accountId: route.accountId,
          raw: post,
          adapter: {
            ingest: () => ({
              id: post.id ?? `${to}:${Date.now()}`,
              timestamp: post.create_at ?? undefined,
              rawText,
              textForAgent: ctxPayload.BodyForAgent,
              textForCommands: ctxPayload.CommandBody,
              raw: post,
            }),
            resolveTurn: () => ({
              cfg,
              channel: "mattermost",
              accountId: route.accountId,
              route: {
                agentId: route.agentId,
                dmScope: route.dmScope,
                sessionKey: route.sessionKey,
              },
              ctxPayload,
              afterRecord: reactions.activateAfterRecord,
              record: {
                updateLastRoute:
                  kind === "direct"
                    ? {
                        sessionKey: inboundLastRouteSessionKey,
                        channel: "mattermost",
                        to,
                        accountId: route.accountId,
                        mainDmOwnerPin:
                          inboundLastRouteSessionKey === route.mainSessionKey && pinnedMainDmOwner
                            ? {
                                ownerRecipient: pinnedMainDmOwner,
                                senderRecipient: normalizeMattermostAllowEntry(senderId),
                                onSkip: ({ ownerRecipient, senderRecipient }) => {
                                  monitor.logVerboseMessage(
                                    `mattermost: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                                  );
                                },
                              }
                            : undefined,
                      }
                    : undefined,
                onRecordError: (err) => {
                  monitor.logVerboseMessage(
                    `mattermost: failed updating session meta id=${post.id ?? "unknown"}: ${String(err)}`,
                  );
                },
              },
              history: {
                isGroup: Boolean(historyKey),
                historyKey: historyKey ?? undefined,
                historyMap: channelHistories,
                limit: historyLimit,
              },
              dispatcherOptions,
              delivery,
              replyOptions: {
                skillFilter: replyOptions.skillFilter,
                progressPreambleEnabled: draftToolProgressEnabled,
                commentaryProgressEnabled: progressDraft.commentaryProgressEnabled,
                ...(deferredTurnAdoptionLifecycle
                  ? { turnAdoptionLifecycle: deferredTurnAdoptionLifecycle }
                  : {}),
                allowProgressCallbacksWhenSourceDeliverySuppressed:
                  true,
                allowToolLifecycleWhenProgressHidden:
                  draftToolProgressEnabled || reactions.statusReactionsEnabled ? true : undefined,
                preserveProgressCallbackStartOrder: draftPreviewEnabled ? true : undefined,
                onObservedReplyDelivery:
                  draftPreviewEnabled || reactions.statusReactionsEnabled
                    ? async () => {
                        anyReplyDelivered = true;
                        if (draftPreviewEnabled) {
                          await previewLifecycle.observeDelivery({ visibleReplySent: true });
                        }
                      }
                    : undefined,
                disableBlockStreaming: draftPreviewEnabled ? true : replyOptions.disableBlockStreaming,
                ...(suppressDefaultToolProgressMessages
                  ? { suppressDefaultToolProgressMessages: true }
                  : {}),
                queuedDeliveryCorrelations: reactions.statusReactionsEnabled
                  ? [queuedReactionCorrelation]
                  : undefined,
                onAgentRunStart: (runId) => {
                  hasStartedWork = true;
                  reactions.noteRunStart(runId);
                  initialRunId ??= runId;
                  taskProgressCard.noteRunStart(runId);
                },
                onVisibleWorkSessions: async (sessions, creation) => {
                  hasStartedWork = true;
                  try {
                    const visibleWorkSessions: MattermostVisibleWorkSession[] = [];
                    const parent = core.agent.session.getSessionEntry({
                      agentId: route.agentId, sessionKey: thread.sessionKey,
                    });
                    const candidates: MattermostVisibleWorkSession[] = [...sessions];
                    if (creation && !candidates.some((session) =>
                      session.sessionKey === creation.createdSessionKey)) {
                      candidates.push({ sessionKey: creation.createdSessionKey, status: "queued" });
                    }
                    for (const session of candidates) {
                      try {
                        const entry = core.agent.session.getSessionEntry({
                          sessionKey: session.sessionKey,
                        });
                        // The no-URL creation key proves existence, not a public label
                        // or foreign-parent authority. Validate its exact parent first.
                        if (creation?.createdSessionKey === session.sessionKey &&
                            (!parent?.sessionId || !entry ||
                              entry.spawnedBy !== thread.sessionKey ||
                              entry.spawnedBySessionId && entry.spawnedBySessionId !== parent.sessionId)) continue;
                        if (entry?.spawnedBy && entry.spawnedBy !== thread.sessionKey ||
                            entry?.spawnedBySessionId && parent?.sessionId &&
                              entry.spawnedBySessionId !== parent.sessionId) continue;
                        visibleWorkSessions.push({
                          ...session,
                          label: session.label ?? (typeof entry?.label === "string" ? entry.label : undefined),
                          sessionId: entry?.sessionId,
                          status: readVisibleWorkSessionStatus(entry?.status) ?? session.status,
                        });
                      } catch (error: unknown) {
                        monitor.logVerboseMessage(
                          `mattermost work session state read failed session=${session.sessionKey}: ${String(error)}`,
                        );
                      }
                    }
                    if (!visibleWorkSessions.length) return;
                    registerContinuation();
                    // The SDK awaits this callback before child dispatch. Join the
                    // serialized write so lifecycle events cannot outrun its admission.
                    await taskProgressCard.noteVisibleWorkSessions(visibleWorkSessions);
                  } catch (error: unknown) {
                    monitor.logVerboseMessage(
                      `mattermost work session card callback failed: ${String(error)}`,
                    );
                  }
                },
                onModelSelected,
                onPlanUpdate: async (planUpdate) => {
                  hasStartedWork = true;
                  registerContinuation();
                  try {
                    await taskProgressCard.updatePlan(planUpdate);
                  } catch (error: unknown) {
                    monitor.logVerboseMessage(
                      `mattermost task progress card callback failed: ${String(error)}`,
                    );
                  }
                  return true;
                },
                onPartialReply: (payloadResult) =>
                  account.streamingMode === "progress"
                    ? false
                    : updateDraftFromPartial(payloadResult.text),
                onAssistantMessageStart: () => {
                  lastPartialText = "";
                  lastAssistantSourceText = "";
                  progressDraft.beginAssistantMessage();
                  if (account.streamingMode === "block") {
                    blockPreviewAssistantMessagePending = true;
                    return false;
                  }
                  return false;
                },
                onReasoningEnd: () => {
                  // Hidden reasoning has no boundary; only rendered text, reasoning, or tools rotate preview posts.
                  lastPartialText = "";
                  progressDraft.resetReasoningProgress();
                  return false;
                },
                onReasoningStream: async (payloadResult) => {
                  hasStartedWork = true;
                  if (canUpdateReactionsFromRenderer()) {
                    reactions.setThinking();
                  }
                  if (account.streamingMode === "progress") {
                    return await progressDraft.pushReasoningProgress(
                      payloadResult.text || "Thinking…",
                      {
                        snapshot: payloadResult.isReasoningSnapshot === true,
                      },
                    );
                  }
                  if (!lastPartialText) {
                    const boundarySettled = enterBlockPreviewActivity("reasoning");
                    draftStream.update("Thinking…");
                    previewBoundaryController.noteUpdate();
                    await boundarySettled;
                  }
                  return false;
                },
                onToolStart: async (payloadValue) => {
                  hasStartedWork = true;
                  taskProgressCard.noteToolStart(payloadValue);
                  if (canUpdateReactionsFromRenderer() && !sourceQueuedLifecycleObserved) {
                    reactions.setTool(payloadValue.name);
                  }
                  if (!draftToolProgressEnabled) {
                    return false;
                  }
                  const boundarySettled = enterBlockPreviewActivity("tool");
                  const progressSettled = progressDraft.pushToolEvent(payloadValue);
                  previewBoundaryController.noteUpdate();
                  const [, visible] = await Promise.all([boundarySettled, progressSettled]);
                  return visible;
                },
                onItemEvent: async (payloadLocal) => {
                  if (payloadLocal.kind === "tool" && payloadLocal.phase === "end") {
                    if (payloadLocal.name === "progress_card") {
                      taskProgressCard.noteToolEnd(payloadLocal.toolCallId);
                    }
                  }
                  if (!draftToolProgressEnabled) {
                    return false;
                  }
                  if (payloadLocal.kind === "subagent" &&
                      taskProgressCard.ownsChildActivity(payloadLocal.itemId)) return false;
                  if (payloadLocal.hideFromChannelProgress || payloadLocal.suppressChannelProgress) {
                    return progressDraft.pushItemEvent(payloadLocal);
                  }
                  const boundarySettled = enterBlockPreviewActivity("tool");
                  const progressSettled = progressDraft.pushItemEvent(payloadLocal);
                  previewBoundaryController.noteUpdate();
                  const [, visible] = await Promise.all([boundarySettled, progressSettled]);
                  return visible;
                },
                onCompactionStart: () => {
                  if (canUpdateReactionsFromRenderer()) {
                    reactions.setCompacting();
                  }
                },
                onCompactionEnd: () => {
                  if (canUpdateReactionsFromRenderer()) {
                    reactions.cancelPending();
                    reactions.setThinking();
                  }
                },
                onQueuedFollowupAdmitted: () => {
                  lastPartialText = "";
                  lastAssistantSourceText = "";
                  if (!sourceQueuedLifecycleSupported) {
                    admitQueuedReactions();
                  }
                },
                onQueuedFollowupSettled: async () => {
                  if (!sourceQueuedLifecycleSupported && !sourceQueuedLifecycleObserved) {
                    await settleQueuedReactions();
                  }
                },
              },
            }),
          },
        }),
    });
  } catch (err) {
    dispatchError = true;
    throw err;
  } finally {
    // Once core returns, an admitted turn has completed the claim and a queued
    // follow-up owns its own retry heartbeat. This timer only bridges the
    // in-call steer/admission wait where core cannot heartbeat the provider.
    pendingDispatchIngress?.stop();
    const dispatchResult = turnResult?.dispatched
      ? (turnResult.dispatchResult as MattermostReplyDispatchResult)
      : undefined;
    if (dispatchResult?.deferredToActiveRun === "followup" && deferredTurnAdoptionLifecycle) {
      void queuedFollowupLifecycleSettled
        .then(finishPresentation)
        .catch((error: unknown) => {
          monitor.logVerboseMessage(
            `mattermost queued follow-up presentation cleanup failed: ${String(error)}`,
          );
        });
    } else {
      await finishPresentation();
    }
  }
}
