// Mattermost plugin module resolves native approval enablement, routing, and stable approvers.
import { resolveApprovalApprovers } from "openclaw/plugin-sdk/approval-auth-runtime";
import {
  createChannelExecApprovalProfile,
  isChannelExecApprovalClientEnabledFromConfig,
  matchesApprovalRequestFilters,
} from "openclaw/plugin-sdk/approval-client-runtime";
import { doesApprovalRequestSelectChannelAccount } from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
  SystemAgentApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { MattermostExecApprovalConfig } from "../types.js";
import {
  listMattermostAccountIds,
  resolveDefaultMattermostAccountId,
  resolveMattermostAccount,
} from "./accounts.js";
import type { OpenClawConfig } from "./runtime-api.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest | SystemAgentApprovalRequest;
const MATTERMOST_USER_ID_RE = /^[a-z0-9]{26}$/u;

export function normalizeMattermostApproverId(
  value: string | number,
): string | undefined {
  const normalized = String(value)
    .trim()
    .replace(/^(?:mattermost|user):/iu, "")
    .replace(/^@/u, "")
    .trim()
    .toLowerCase();
  return MATTERMOST_USER_ID_RE.test(normalized) ? normalized : undefined;
}

export function resolveMattermostExecApprovalConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): MattermostExecApprovalConfig {
  const account = resolveMattermostAccount(params);
  const config = account.config.execApprovals;
  return {
    ...config,
    enabled:
      account.enabled && account.botTokenStatus !== "missing"
        ? (config?.enabled ?? "auto")
        : false,
    target: config?.target ?? "channel",
  };
}

export function getMattermostExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const account = resolveMattermostAccount(params);
  const ownerAllowFrom = Array.isArray(params.cfg.commands?.ownerAllowFrom)
    ? params.cfg.commands.ownerAllowFrom
    : [];
  return resolveApprovalApprovers({
    explicit: account.config.execApprovals?.approvers,
    allowFrom: ownerAllowFrom,
    extraAllowFrom: account.config.allowFrom,
    normalizeApprover: normalizeMattermostApproverId,
  });
}

function isMattermostApprovalAccountEligible(params: {
  cfg: OpenClawConfig;
  accountId: string;
  request: ApprovalRequest;
}): boolean {
  const account = resolveMattermostAccount(params);
  const config = resolveMattermostExecApprovalConfig(params);
  return (
    account.enabled &&
    account.botTokenStatus !== "missing" &&
    Boolean(account.baseUrl) &&
    isChannelExecApprovalClientEnabledFromConfig({
      enabled: config.enabled,
      approverCount: getMattermostExecApprovalApprovers(params).length,
    }) &&
    matchesApprovalRequestFilters({
      request: params.request.request,
      agentFilter: config.agentFilter,
      sessionFilter: config.sessionFilter,
      fallbackAgentIdFromSessionKey: true,
    })
  );
}

function matchesMattermostRequestAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
}): boolean {
  const accountId = params.accountId ?? resolveDefaultMattermostAccountId(params.cfg);
  return doesApprovalRequestSelectChannelAccount({
    ...params,
    channel: "mattermost",
    defaultAccountId: resolveDefaultMattermostAccountId(params.cfg),
    eligibleAccountIds: isMattermostApprovalAccountEligible({ ...params, accountId })
      ? [accountId]
      : listMattermostAccountIds(params.cfg).filter((candidate) =>
          isMattermostApprovalAccountEligible({
            ...params,
            accountId: candidate,
          }),
        ),
  });
}

const mattermostApprovalProfile = createChannelExecApprovalProfile({
  resolveConfig: resolveMattermostExecApprovalConfig,
  resolveApprovers: getMattermostExecApprovalApprovers,
  normalizeSenderId: normalizeMattermostApproverId,
  matchesRequestAccount: matchesMattermostRequestAccount,
  fallbackAgentIdFromSessionKey: true,
  requireClientEnabledForLocalPromptSuppression: false,
});

export const isMattermostExecApprovalClientEnabled =
  mattermostApprovalProfile.isClientEnabled;
export const isMattermostExecApprovalApprover = mattermostApprovalProfile.isApprover;
export const isMattermostExecApprovalAuthorizedSender =
  mattermostApprovalProfile.isAuthorizedSender;
export const resolveMattermostExecApprovalTarget = mattermostApprovalProfile.resolveTarget;
export const shouldHandleMattermostExecApprovalRequest =
  mattermostApprovalProfile.shouldHandleRequest;

export function isMattermostExecApprovalHandlerConfigured(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const config = resolveMattermostExecApprovalConfig(params);
  return isChannelExecApprovalClientEnabledFromConfig({
    enabled: config.enabled,
    approverCount: getMattermostExecApprovalApprovers(params).length,
  });
}
