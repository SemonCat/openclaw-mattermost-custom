// Mattermost plugin module owns native model-picker interactions.
import { randomUUID } from "node:crypto";
import type { ModelsProviderData } from "openclaw/plugin-sdk/command-auth-native";
import { applySessionModelSelection } from "openclaw/plugin-sdk/model-session-runtime";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import type { MattermostPost } from "./client.js";
import type { MattermostInteractionResponse } from "./interactions.js";
import {
  buildMattermostAllowedModelRefs,
  parseMattermostModelPickerContext,
  renderMattermostModelsPickerView,
  renderMattermostProviderPickerView,
  resolveMattermostModelPickerCurrentModel,
} from "./model-picker.js";
import { pinMattermostExplicitDefaultModelSelection } from "./model-session-pin.js";
import { authorizeMattermostCommandInvocation } from "./monitor-auth.js";
import {
  buildMattermostModelPickerSelectMessageSid,
  pinMattermostMonitorConfig,
  resolveMattermostInteractionReplyRootId,
} from "./monitor-context.js";
import { buildMattermostEventPlan, type MattermostEventPlan } from "./monitor-event-plan.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { buildModelsProviderData } from "./runtime-api.js";
import { sendMessageMattermost } from "./send.js";

export type MattermostModelPickerInteractionHandler = (params: {
  payload: {
    channel_id: string;
    post_id: string;
    team_id?: string;
    user_id: string;
  };
  userName: string;
  context: Record<string, unknown>;
  post: MattermostPost;
}) => Promise<MattermostInteractionResponse | null>;

export function createMattermostModelPickerInteractionHandler(
  monitor: MattermostMonitorContext,
): MattermostModelPickerInteractionHandler {
  const { account, core, pairing, resources, runtime } = monitor;
  const { resolveChannelInfo, updateModelPickerPost } = resources;
  const activeModelSelections = new Set<string>();

  const applyModelPickerSelection = async (params: {
    cfg: OpenClawConfig;
    data: ModelsProviderData;
    eventPlan: MattermostEventPlan;
    model: string;
    provider: string;
  }): Promise<string> => {
    const { route, thread } = params.eventPlan;
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: route.agentId });
    const persistedSessionEntry = getSessionEntry({
      storePath,
      sessionKey: thread.sessionKey,
      readConsistency: "latest",
    });
    const sessionEntryMissing = persistedSessionEntry === undefined;
    const sessionEntry = persistedSessionEntry ?? {
      sessionId: randomUUID(),
      updatedAt: Date.now(),
    };
    const currentModelRef = resolveMattermostModelPickerCurrentModel({
      cfg: params.cfg,
      route: { agentId: route.agentId, sessionKey: thread.sessionKey },
      data: params.data,
      readConsistency: "latest",
    });
    const separator = currentModelRef.indexOf("/");
    const currentProvider =
      separator > 0 ? currentModelRef.slice(0, separator) : params.data.resolvedDefault.provider;
    const currentModel =
      separator > 0 ? currentModelRef.slice(separator + 1) : params.data.resolvedDefault.model;
    const modelCatalog = [...params.data.byProvider.entries()].flatMap(([provider, models]) =>
      [...models].map((model) => ({
        provider,
        id: model,
        name: params.data.modelNames.get(`${provider}/${model}`) ?? model,
      })),
    );
    const targetModelRef = `${params.provider}/${params.model}`;
    const applied = await applySessionModelSelection({
      cfg: params.cfg,
      agentId: route.agentId,
      sessionKey: thread.sessionKey,
      storePath,
      sessionEntry,
      sessionStore: { [thread.sessionKey]: sessionEntry },
      allowCreate: sessionEntryMissing,
      defaultProvider: params.data.resolvedDefault.provider,
      defaultModel: params.data.resolvedDefault.model,
      currentProvider,
      currentModel,
      modelCatalog,
      canPersistStickyModelSelection: false,
      request: {
        provider: params.provider,
        model: params.model,
        isDefault:
          targetModelRef ===
          `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`,
        runtime: { kind: "unchanged" },
      },
      markLiveSwitchPending: true,
    });
    if (applied.status !== "applied") {
      return `❌ ${applied.message}`;
    }
    await pinMattermostExplicitDefaultModelSelection({
      agentId: route.agentId,
      cfg: params.cfg,
      commandText: `/model ${applied.effectiveModelRef}`,
      modelsData: params.data,
      sessionKey: thread.sessionKey,
    });
    return `✅ Model set to ${applied.effectiveModelRef} for this session.`;
  };

  return async (params) => {
    const pickerState = parseMattermostModelPickerContext(params.context);
    if (!pickerState) {
      return null;
    }
    if (pickerState.ownerUserId !== params.payload.user_id) {
      return { ephemeral_text: "Only the person who opened this picker can use it." };
    }
    const eventMonitor = pinMattermostMonitorConfig(monitor);
    const { cfg } = eventMonitor;
    const updatePickerPost = (message: string, buttons?: Array<unknown>) =>
      updateModelPickerPost({
        channelId: params.payload.channel_id,
        postId: params.payload.post_id,
        message,
        buttons,
      });

    const channelInfo = await resolveChannelInfo(params.payload.channel_id);
    const pickerCommandText =
      pickerState.action === "select"
        ? `/model ${pickerState.provider}/${pickerState.model}`
        : pickerState.action === "list"
          ? `/models ${pickerState.provider}`
          : "/models";
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg,
      surface: "mattermost",
    });
    const auth = await authorizeMattermostCommandInvocation({
      account,
      cfg,
      senderId: params.payload.user_id,
      senderName: params.userName,
      channelId: params.payload.channel_id,
      channelInfo,
      readStoreAllowFrom: pairing.readAllowFromStore,
      allowTextCommands,
      hasControlCommand: core.channel.text.hasControlCommand(pickerCommandText, cfg),
    });
    if (!auth.ok) {
      if (auth.denyReason === "dm-pairing") {
        const { code } = await pairing.upsertPairingRequest({
          id: params.payload.user_id,
          meta: { name: params.userName },
        });
        return {
          ephemeral_text: core.channel.pairing.buildPairingReply({
            channel: "mattermost",
            idLine: `Your Mattermost user id: ${params.payload.user_id}`,
            code,
          }),
        };
      }
      const denyText =
        auth.denyReason === "unknown-channel"
          ? "Temporary error: unable to determine channel type. Please try again."
          : auth.denyReason === "dm-disabled"
            ? "This bot is not accepting direct messages."
            : auth.denyReason === "channels-disabled"
              ? "Model picker actions are disabled in channels."
              : auth.denyReason === "channel-no-allowlist"
                ? "Model picker actions are not configured for this channel."
                : "Unauthorized.";
      return { ephemeral_text: denyText };
    }

    const teamId = auth.channelInfo.team_id ?? params.payload.team_id ?? undefined;
    const eventPlan = await buildMattermostEventPlan(eventMonitor, {
      channelId: params.payload.channel_id,
      senderId: params.payload.user_id,
      postId: params.post.id || params.payload.post_id,
      threadRootId: params.post.root_id,
      channelInfo: auth.channelInfo,
      teamId,
      channelName: auth.channelName,
      channelDisplay: auth.channelDisplay,
      dropLabel: "model picker event",
    });
    if (!eventPlan) {
      return {
        ephemeral_text: "Temporary error: unable to determine channel type. Please try again.",
      };
    }
    const modelSessionRoute = {
      agentId: eventPlan.route.agentId,
      sessionKey: eventPlan.thread.sessionKey,
    };
    if (pickerState.action !== "select") {
      const data = await buildModelsProviderData(cfg, eventPlan.route.agentId);
      if (data.providers.length === 0) {
        return await updatePickerPost("No models available.");
      }
      const currentModel = resolveMattermostModelPickerCurrentModel({
        cfg,
        route: modelSessionRoute,
        data,
      });
      const view =
        pickerState.action === "providers" || pickerState.action === "back"
          ? renderMattermostProviderPickerView({
              ownerUserId: pickerState.ownerUserId,
              data,
              currentModel,
            })
          : renderMattermostModelsPickerView({
              ownerUserId: pickerState.ownerUserId,
              data,
              provider: pickerState.provider,
              page: pickerState.page,
              currentModel,
            });
      return await updatePickerPost(view.text, view.buttons);
    }

    const targetModelRef = `${pickerState.provider}/${pickerState.model}`;
    if (activeModelSelections.has(eventPlan.thread.sessionKey)) {
      return { ephemeral_text: "A model change is already in progress for this chat." };
    }
    activeModelSelections.add(eventPlan.thread.sessionKey);
    const messageSid = buildMattermostModelPickerSelectMessageSid({
      postId: params.payload.post_id,
      provider: pickerState.provider,
      model: pickerState.model,
    });

    // The durable callback drain runs only after HTTP ACK, so keep this work attached to
    // the queue claim. Marking the row complete before persistence would reopen the
    // restart-loss window that durable admission is intended to close.
    try {
      const data = await buildModelsProviderData(cfg, eventPlan.route.agentId);
      let notice: string;
      if (!buildMattermostAllowedModelRefs(data).has(targetModelRef)) {
        notice = `❌ That model is no longer available: ${targetModelRef}`;
      } else {
        try {
          notice = await applyModelPickerSelection({
            cfg,
            data,
            eventPlan,
            provider: pickerState.provider,
            model: pickerState.model,
          });
        } catch (error) {
          runtime.error?.(`mattermost model picker selection failed: ${String(error)}`);
          notice = `❌ Failed to set ${targetModelRef}. Try /oc_model ${targetModelRef} directly.`;
        }
      }
      await sendMessageMattermost(`channel:${params.payload.channel_id}`, notice, {
        cfg,
        accountId: account.accountId,
        replyToId: resolveMattermostInteractionReplyRootId({
          kind: eventPlan.kind,
          threadRootId: eventPlan.thread.effectiveReplyToId,
          replyToId: messageSid,
          interactionMessageSid: messageSid,
          sourcePostId: params.post.id || params.payload.post_id,
        }),
      });
      if (data.providers.length === 0) {
        await updatePickerPost("No models available.");
        return {};
      }
      const currentModel = resolveMattermostModelPickerCurrentModel({
        cfg,
        route: modelSessionRoute,
        data,
        readConsistency: "latest",
      });
      const view = renderMattermostModelsPickerView({
        ownerUserId: pickerState.ownerUserId,
        data,
        provider: pickerState.provider,
        page: pickerState.page,
        currentModel,
      });
      await updatePickerPost(view.text, view.buttons);
    } catch (err: unknown) {
      runtime.error?.(`mattermost model picker select failed: ${String(err)}`);
      try {
        await updatePickerPost(
          `❌ Failed to set ${targetModelRef}. Try /oc_model ${targetModelRef} directly.`,
        );
      } catch (updateError) {
        runtime.error?.(`mattermost model picker failure update failed: ${String(updateError)}`);
      }
    } finally {
      activeModelSelections.delete(eventPlan.thread.sessionKey);
    }

    return {};
  };
}
