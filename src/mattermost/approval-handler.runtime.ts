// Mattermost plugin module renders and delivers native approval cards.
import type {
  ChannelApprovalCapabilityHandlerContext,
  ChannelApprovalKind,
  PendingApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  buildChannelApprovalExpiredText as buildSharedApprovalExpiredText,
  buildChannelApprovalResolvedText as buildSharedApprovalResolvedText,
  createChannelApprovalNativeRuntimeAdapter,
  type ExpiredApprovalView,
  type ResolvedApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import {
  buildExecApprovalPendingReplyPayload,
  buildPluginApprovalPendingReplyPayload,
  formatExecApprovalExpiresIn,
  type ExecApprovalPendingReplyParams,
} from "openclaw/plugin-sdk/approval-reply-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
  SystemAgentApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MattermostClient } from "./client.js";
import { updateMattermostPost } from "./client.js";
import {
  isMattermostExecApprovalHandlerConfigured,
  shouldHandleMattermostExecApprovalRequest,
} from "./exec-approvals.js";
import { sendMessageMattermost } from "./send.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest | SystemAgentApprovalRequest;
type PendingDelivery = {
  text: string;
  buttons: Array<Record<string, unknown>>;
};
type PreparedTarget = { to: string; threadId?: string };
type PendingEntry = { channelId: string; postId: string };
type FinalDelivery = { text: string };
type MattermostApprovalContext = { client: MattermostClient };

function resolveHandlerContext(params: ChannelApprovalCapabilityHandlerContext): {
  accountId: string;
  context: MattermostApprovalContext;
} | null {
  const accountId = normalizeOptionalString(params.accountId);
  const context = params.context as MattermostApprovalContext | undefined;
  return accountId && context?.client ? { accountId, context } : null;
}

function mapApprovalButtons(view: PendingApprovalView): Array<Record<string, unknown>> {
  return view.actions.flatMap((descriptor) => {
    const action = descriptor.action;
    if (!action || action.type !== "approval") {
      return [];
    }
    return [
      {
        id: `ocapproval${action.decision.replaceAll("-", "")}`,
        text: descriptor.label,
        style: action.decision === "deny" ? "danger" : "primary",
        context: {
          __openclaw_approval_version: 1,
          approval_id: action.approvalId,
          approval_kind: action.approvalKind,
          decision: action.decision,
        },
      },
    ];
  });
}

export function buildMattermostApprovalPendingPayload(params: {
  request: ApprovalRequest;
  approvalKind: ChannelApprovalKind;
  nowMs: number;
  view: PendingApprovalView;
}): PendingDelivery {
  if (params.approvalKind === "system-agent") {
    if (params.view.approvalKind !== "system-agent") {
      throw new Error("system-agent approval request and view kinds do not match");
    }
    return {
      text: [
        "#### OpenClaw change requires approval",
        `**Change:** ${params.view.operationSummary}`,
        `**Agent:** ${params.view.agentId ?? "unknown"}`,
        `**Expires in:** ${formatExecApprovalExpiresIn(
          params.request.expiresAtMs,
          params.nowMs,
        )}`,
      ].join("\n"),
      buttons: mapApprovalButtons(params.view),
    };
  }
  const payload =
    params.approvalKind === "plugin"
      ? buildPluginApprovalPendingReplyPayload({
          request: params.request as PluginApprovalRequest,
          nowMs: params.nowMs,
        })
      : buildExecApprovalPendingReplyPayload({
          approvalId: params.request.id,
          approvalSlug: params.request.id.slice(0, 8),
          approvalCommandId: params.request.id,
          warningText:
            params.view.approvalKind === "exec"
              ? (params.view.warningText ?? undefined)
              : undefined,
          command: params.view.approvalKind === "exec" ? params.view.commandText : "",
          cwd:
            params.view.approvalKind === "exec" ? (params.view.cwd ?? undefined) : undefined,
          host:
            params.view.approvalKind === "exec" && params.view.host === "node"
              ? "node"
              : "gateway",
          nodeId:
            params.view.approvalKind === "exec" ? (params.view.nodeId ?? undefined) : undefined,
          scope:
            params.view.approvalKind === "exec" ? (params.view.scope ?? undefined) : undefined,
          allowedDecisions: params.view.actions.map((action) => action.decision),
          expiresAtMs: params.request.expiresAtMs,
          nowMs: params.nowMs,
        } satisfies ExecApprovalPendingReplyParams);
  return {
    text: payload.text ?? "Approval required",
    buttons: mapApprovalButtons(params.view),
  };
}

export function buildMattermostApprovalResolvedText(params: {
  request: ApprovalRequest;
  resolved: Parameters<typeof buildSharedApprovalResolvedText>[0]["resolved"];
  view: ResolvedApprovalView;
}): string {
  return buildSharedApprovalResolvedText(params);
}

export function buildMattermostApprovalExpiredText(params: {
  request: ApprovalRequest;
  view: ExpiredApprovalView;
}): string {
  return buildSharedApprovalExpiredText(params);
}

export const mattermostApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  PendingDelivery,
  PreparedTarget,
  PendingEntry,
  never,
  FinalDelivery
>({
  eventKinds: ["exec", "plugin", "system-agent"],
  availability: {
    isConfigured: (params) => {
      const resolved = resolveHandlerContext(params);
      return resolved
        ? isMattermostExecApprovalHandlerConfigured({
            cfg: params.cfg,
            accountId: resolved.accountId,
          })
        : false;
    },
    shouldHandle: (params) => {
      const resolved = resolveHandlerContext(params);
      return resolved
        ? shouldHandleMattermostExecApprovalRequest({
            cfg: params.cfg,
            accountId: resolved.accountId,
            request: params.request,
          })
        : false;
    },
  },
  presentation: {
    buildPendingPayload: ({ request, approvalKind, nowMs, view }) =>
      buildMattermostApprovalPendingPayload({ request, approvalKind, nowMs, view }),
    buildResolvedResult: ({ request, resolved, view }) => ({
      kind: "update",
      payload: { text: buildMattermostApprovalResolvedText({ request, resolved, view }) },
    }),
    buildExpiredResult: ({ request, view }) => ({
      kind: "update",
      payload: { text: buildMattermostApprovalExpiredText({ request, view }) },
    }),
  },
  transport: {
    prepareTarget: ({ plannedTarget }) => ({
      dedupeKey: buildChannelApprovalNativeTargetKey(plannedTarget.target),
      target: {
        to: plannedTarget.target.to,
        ...(plannedTarget.target.threadId == null
          ? {}
          : { threadId: String(plannedTarget.target.threadId) }),
      },
    }),
    deliverPending: async ({ cfg, accountId, context, preparedTarget, pendingPayload }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return null;
      }
      const result = await sendMessageMattermost(preparedTarget.to, pendingPayload.text, {
        cfg,
        accountId: resolved.accountId,
        replyToId: preparedTarget.threadId,
        buttons: pendingPayload.buttons,
      });
      return { channelId: result.channelId, postId: result.messageId };
    },
    updateEntry: async ({ cfg, accountId, context, entry, payload }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return;
      }
      await updateMattermostPost(resolved.context.client, entry.postId, {
        message: payload.text,
        props: {},
      });
    },
  },
  interactions: {
    clearPendingActions: async ({ cfg, accountId, context, entry }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return;
      }
      await updateMattermostPost(resolved.context.client, entry.postId, { props: {} });
    },
  },
});
