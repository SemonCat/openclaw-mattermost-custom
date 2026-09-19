// Mattermost plugin module registers interactive callback transport handling.
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { parseMattermostQuestionContext } from "../normalize.js";
import {
  createMattermostApprovalInteractionHandler,
  parseMattermostApprovalAction,
} from "./approval-interaction.js";
import { isMattermostExecApprovalApprover } from "./exec-approvals.js";
import { createMattermostInteractionIngressMonitor } from "./interaction-ingress.js";
import {
  createMattermostInteractionHandler,
  createMattermostInteractionProcessor,
  type MattermostInteractionResponse,
} from "./interactions.js";
import { authorizeMattermostCommandInvocation } from "./monitor-auth.js";
import {
  buildMattermostButtonInteractionMessageSid,
  pinMattermostMonitorConfig,
  resolveMattermostInteractionReplyRootId,
} from "./monitor-context.js";
import { buildMattermostEventPlan } from "./monitor-event-plan.js";
import type { MattermostModelPickerInteractionHandler } from "./monitor-model-picker.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import { deliverMattermostReplyPayload } from "./reply-delivery.js";
import type { ReplyPayload } from "./runtime-api.js";
import { registerPluginHttpRoute } from "./runtime-api.js";
import { createMattermostSecretDialogController } from "./secret-dialog.js";
import { sendMessageMattermost } from "./send.js";

type MattermostInteractionDispatch = NonNullable<
  Parameters<typeof createMattermostInteractionHandler>[0]["handleInteraction"]
>;

function createMattermostQuestionInteractionHandler(
  monitor: MattermostMonitorContext,
): MattermostInteractionDispatch {
  const { account, core, pairing, resources, runtime } = monitor;
  return async (interaction) => {
    const selection = parseMattermostQuestionContext(interaction.context);
    if (!selection) {
      return null;
    }
    const eventMonitor = pinMattermostMonitorConfig(monitor);
    const { cfg } = eventMonitor;
    const channelInfo = await resources.resolveChannelInfo(interaction.payload.channel_id);
    const decide = async () =>
      await authorizeMattermostCommandInvocation({
        account,
        cfg,
        senderId: interaction.payload.user_id,
        senderName: interaction.userName,
        channelId: interaction.payload.channel_id,
        channelInfo,
        readStoreAllowFrom: pairing.readAllowFromStore,
        allowTextCommands: core.channel.commands.shouldHandleTextCommands({
          cfg,
          surface: "mattermost",
        }),
        hasControlCommand: false,
      });
    const auth = await decide();
    if (!auth.ok) {
      return { ephemeral_text: `OpenClaw ignored this action for ${auth.roomLabel}.` };
    }
    try {
      const result = await questionGatewayRuntime.resolveOption({
        cfg,
        questionId: selection.questionId,
        optionIndex: selection.optionIndex,
        senderId: interaction.payload.user_id,
        clientDisplayName: `Mattermost question (${account.accountId})`,
        authorize: async () => (await decide()).ok,
      });
      if (result.status === "denied") {
        return { ephemeral_text: `OpenClaw ignored this action for ${auth.roomLabel}.` };
      }
      if (result.status !== "answered") {
        return { ephemeral_text: "This question was already answered." };
      }
    } catch (error) {
      runtime.error?.(`mattermost question interaction failed: ${String(error)}`);
      return { ephemeral_text: "Could not submit this answer." };
    }
    const response: MattermostInteractionResponse = {
      update: {
        message: interaction.post.message ?? "",
        props: {
          attachments: [
            { text: `✓ **${interaction.actionName}** selected by @${interaction.userName}` },
          ],
        },
      },
      ephemeral_text: "Answer submitted.",
    };
    return response;
  };
}

export function registerMattermostInteractions(params: {
  monitor: MattermostMonitorContext;
  interactionPath: string;
  interactionCallbackUrl: string;
  allowedSourceIps: string[];
  handleModelPickerInteraction: MattermostModelPickerInteractionHandler;
  abortSignal?: AbortSignal;
}): { unregister: () => void; stop: () => Promise<void> } {
  const { monitor } = params;
  const { account, botUserId, cfg: startupCfg, client, core, pairing, resources, runtime } =
    monitor;
  const { resolveChannelInfo } = resources;
  const handleApprovalInteraction = createMattermostApprovalInteractionHandler({
    cfg: () => pinMattermostMonitorConfig(monitor).cfg,
    accountId: account.accountId,
  });
  const secretDialog = createMattermostSecretDialogController({
    accountId: account.accountId,
    callbackUrl: params.interactionCallbackUrl,
    client,
    cfg: () => pinMattermostMonitorConfig(monitor).cfg,
    isAuthorizedUser: (senderId) =>
      isMattermostExecApprovalApprover({
        cfg: pinMattermostMonitorConfig(monitor).cfg,
        accountId: account.accountId,
        senderId,
      }),
    log: (message) => runtime.error?.(message),
  });
  const handleQuestionInteraction = createMattermostQuestionInteractionHandler(monitor);
  const interactionOptions: Parameters<typeof createMattermostInteractionProcessor>[0] = {
    client,
    botUserId,
    accountId: account.accountId,
    allowedSourceIps: params.allowedSourceIps,
    trustedProxies: startupCfg.gateway?.trustedProxies,
    allowRealIpFallback: startupCfg.gateway?.allowRealIpFallback === true,
    handleImmediateInteraction: secretDialog.handleInteraction,
    handleDialogSubmission: secretDialog.handleSubmission,
    handleInteraction: async (interaction) =>
      (await handleApprovalInteraction(interaction)) ??
      (await handleQuestionInteraction(interaction)) ??
      (await params.handleModelPickerInteraction(interaction)),
    authorizeButtonClick: async ({ payload }) => {
      const eventMonitor = pinMattermostMonitorConfig(monitor);
      const { cfg } = eventMonitor;
      const approvalAction = parseMattermostApprovalAction(payload.context ?? {});
      if (
        approvalAction !== null &&
        isMattermostExecApprovalApprover({
          cfg,
          accountId: account.accountId,
          senderId: payload.user_id,
        })
      ) {
        return { ok: true as const };
      }
      const channelInfo = await resolveChannelInfo(payload.channel_id);
      const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
        cfg,
        surface: "mattermost",
      });
      const decision = await authorizeMattermostCommandInvocation({
        account,
        cfg,
        senderId: payload.user_id,
        senderName: payload.user_name ?? "",
        channelId: payload.channel_id,
        channelInfo,
        readStoreAllowFrom: pairing.readAllowFromStore,
        allowTextCommands,
        hasControlCommand: false,
      });
      if (decision.ok) {
        return { ok: true as const };
      }
      return {
        ok: false as const,
        response: {
          ephemeral_text: `OpenClaw ignored this action for ${decision.roomLabel}.`,
        },
      };
    },
    resolveSessionKey: async ({ channelId, userId, post }) => {
      const eventMonitor = pinMattermostMonitorConfig(monitor);
      const eventPlan = await buildMattermostEventPlan(eventMonitor, {
        channelId,
        senderId: userId,
        postId: post.id,
        threadRootId: post.root_id,
        dropLabel: "interaction session event",
      });
      if (!eventPlan) {
        throw new Error("Mattermost channel type could not be resolved");
      }
      return eventPlan.thread.sessionKey;
    },
    dispatchButtonClick: async (button) => {
      const eventMonitor = pinMattermostMonitorConfig(monitor);
      const { cfg } = eventMonitor;
      const sourcePostId = button.post.id || button.postId;
      const interactionMessageSid = buildMattermostButtonInteractionMessageSid({
        postId: button.postId,
        actionId: button.actionId,
      });
      const eventPlan = await buildMattermostEventPlan(eventMonitor, {
        channelId: button.channelId,
        senderId: button.userId,
        postId: sourcePostId,
        threadRootId: button.post.root_id,
        dropLabel: "interaction dispatch",
      });
      if (!eventPlan) {
        return;
      }
      const { channelDisplay, channelId, kind, route, thread, to } = eventPlan;
      const bodyText = `[Button click: user @${button.userName} selected "${button.actionName}"]`;
      const ctxPayload = eventPlan.finalizeContext({
        Body: bodyText,
        BodyForAgent: bodyText,
        RawBody: bodyText,
        CommandBody: bodyText,
        ConversationLabel: `mattermost:${button.userName}`,
        GroupSubject: kind !== "direct" ? channelDisplay || button.channelId : undefined,
        SenderName: button.userName,
        MessageSid: interactionMessageSid,
        WasMentioned: true,
        CommandAuthorized: false,
      });
      const { deliveryBarrier, replyOptions, replyPipeline, tableMode, textLimit } =
        eventPlan.createReplyPlan();
      await core.channel.inbound.dispatch({
        cfg,
        channel: "mattermost",
        accountId: account.accountId,
        route: {
          agentId: route.agentId,
          dmScope: route.dmScope,
          sessionKey: thread.sessionKey,
        },
        ctxPayload,
        delivery: {
          observeMessageSent: true,
          deliver: async (payload: ReplyPayload) => {
            const result = await deliverMattermostReplyPayload({
              core,
              cfg,
              payload,
              channelId,
              accountId: account.accountId,
              agentId: route.agentId,
              replyToId: resolveMattermostInteractionReplyRootId({
                kind,
                threadRootId: thread.effectiveReplyToId,
                replyToId: payload.replyToId,
                interactionMessageSid,
                sourcePostId,
              }),
              textLimit,
              tableMode,
              sendMessage: sendMessageMattermost,
              onDmChannelResolution: deliveryBarrier.trackDmChannelResolution,
            });
            if (result.visibleReplySent) {
              runtime.log?.(`delivered button-click reply to ${to}`);
            }
            return result;
          },
          onError: (err, info) => {
            runtime.error?.(`mattermost button-click ${info.kind} reply failed: ${String(err)}`);
          },
        },
        replyPipeline,
        dispatcherOptions: {
          resolveFollowupAdmissionBarrierTimeoutPolicy: deliveryBarrier.resolveTimeoutPolicy,
          onDeliverySettled: deliveryBarrier.markDeliverySettled,
          humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
        },
        replyOptions,
      });
    },
    log: (message: string) => runtime.log?.(message),
  };
  let interactionIngress: ReturnType<typeof createMattermostInteractionIngressMonitor> | undefined;
  const unregister = registerPluginHttpRoute({
    path: params.interactionPath,
    fallbackPath: "/mattermost/interactions/default",
    auth: "plugin",
    handler: createMattermostInteractionHandler({
      ...interactionOptions,
      admitInteraction: async (interaction) => {
        if (!interactionIngress) {
          throw new Error("Mattermost interaction ingress is not ready");
        }
        return await interactionIngress.admit(interaction);
      },
    }),
    pluginId: "mattermost",
    source: "mattermost-interactions",
    accountId: account.accountId,
    log: (message: string) => runtime.log?.(message),
    replaceExisting: true,
    throwOnFailure: true,
  });
  try {
    interactionIngress = createMattermostInteractionIngressMonitor({
      accountId: account.accountId,
      dispatch: createMattermostInteractionProcessor(interactionOptions),
      runtime,
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    });
  } catch (error) {
    unregister();
    throw error;
  }
  return { unregister, stop: interactionIngress.stop };
}
