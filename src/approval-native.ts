// Mattermost plugin module exposes OpenClaw's channel-native approval capability.
import { createApproverRestrictedNativeApprovalCapability } from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
  SystemAgentApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { listMattermostAccountIds } from "./mattermost/accounts.js";
import {
  getMattermostExecApprovalApprovers,
  isMattermostExecApprovalApprover,
  isMattermostExecApprovalAuthorizedSender,
  isMattermostExecApprovalClientEnabled,
  resolveMattermostExecApprovalTarget,
  shouldHandleMattermostExecApprovalRequest,
} from "./mattermost/exec-approvals.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest | SystemAgentApprovalRequest;
type MattermostApprovalTarget = { to: string; threadId?: string };

function resolveTurnSourceTarget(request: ApprovalRequest): MattermostApprovalTarget | null {
  if (normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel) !== "mattermost") {
    return null;
  }
  const to = normalizeOptionalString(request.request.turnSourceTo);
  if (!to) {
    return null;
  }
  const threadId = normalizeOptionalString(String(request.request.turnSourceThreadId ?? ""));
  return { to, ...(threadId ? { threadId } : {}) };
}

const resolveMattermostOriginTarget = createChannelNativeOriginTargetResolver({
  channel: "mattermost",
  shouldHandleRequest: ({ cfg, accountId, request }) =>
    shouldHandleMattermostExecApprovalRequest({ cfg, accountId, request }),
  resolveTurnSourceTarget,
  resolveSessionTarget: (target) => ({
    to: target.to,
    ...(target.threadId == null ? {} : { threadId: String(target.threadId) }),
  }),
});

const resolveMattermostApproverDmTargets = createChannelApproverDmTargetResolver({
  shouldHandleRequest: ({ cfg, accountId, request }) =>
    shouldHandleMattermostExecApprovalRequest({ cfg, accountId, request }),
  resolveApprovers: getMattermostExecApprovalApprovers,
  mapApprover: (approver) => ({ to: `user:${approver}` }),
});

function describeMattermostApprovalSetup({ accountId }: { accountId?: string | null }) {
  const prefix =
    accountId && accountId !== "default"
      ? `channels.mattermost.accounts.${accountId}`
      : "channels.mattermost";
  return `Configure stable Mattermost user ids in \`${prefix}.execApprovals.approvers\`, \`${prefix}.allowFrom\`, or \`commands.ownerAllowFrom\`. Native approval cards default to the originating Mattermost conversation; set \`${prefix}.execApprovals.target\` to \`dm\` or \`both\` to change delivery.`;
}

export const mattermostApprovalCapability: ChannelApprovalCapability =
  createApproverRestrictedNativeApprovalCapability({
    channel: "mattermost",
    channelLabel: "Mattermost",
    describeExecApprovalSetup: describeMattermostApprovalSetup,
    describePluginApprovalSetup: describeMattermostApprovalSetup,
    listAccountIds: listMattermostAccountIds,
    hasApprovers: ({ cfg, accountId }) =>
      getMattermostExecApprovalApprovers({ cfg, accountId }).length > 0,
    isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
      isMattermostExecApprovalAuthorizedSender({ cfg, accountId, senderId }),
    isPluginAuthorizedSender: ({ cfg, accountId, senderId }) =>
      isMattermostExecApprovalApprover({ cfg, accountId, senderId }),
    isNativeDeliveryEnabled: ({ cfg, accountId }) =>
      isMattermostExecApprovalClientEnabled({ cfg, accountId }),
    resolveNativeDeliveryMode: ({ cfg, accountId }) =>
      resolveMattermostExecApprovalTarget({ cfg, accountId }),
    requireMatchingTurnSourceChannel: true,
    resolveSuppressionAccountId: ({ target, request }) =>
      normalizeOptionalString(target.accountId) ??
      normalizeOptionalString(request.request.turnSourceAccountId),
    resolveOriginTarget: resolveMattermostOriginTarget,
    resolveApproverDmTargets: resolveMattermostApproverDmTargets,
    notifyOriginWhenDmOnly: true,
    nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
      eventKinds: ["exec", "plugin", "system-agent"],
      isConfigured: ({ cfg, accountId }) =>
        isMattermostExecApprovalClientEnabled({ cfg, accountId }),
      shouldHandle: ({ cfg, accountId, request }) =>
        shouldHandleMattermostExecApprovalRequest({ cfg, accountId, request }),
      load: async () =>
        (await import("./mattermost/approval-handler.runtime.js"))
          .mattermostApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
    }),
  });
