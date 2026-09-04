// Mattermost plugin module resolves HMAC-authenticated native approval button callbacks.
import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { MattermostInteractionResponse } from "./interactions.js";
import { isMattermostExecApprovalApprover } from "./exec-approvals.js";
import type { OpenClawConfig } from "./runtime-api.js";

const APPROVAL_CONTEXT_VERSION_KEY = "__openclaw_approval_version";

type MattermostApprovalAction = {
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  decision: "allow-once" | "allow-always" | "deny";
};

export function parseMattermostApprovalAction(
  context: Record<string, unknown>,
): MattermostApprovalAction | null | "invalid" {
  if (context[APPROVAL_CONTEXT_VERSION_KEY] !== 1) {
    return null;
  }
  const approvalId = context.approval_id;
  const approvalKind = context.approval_kind;
  const decision = context.decision;
  if (
    typeof approvalId !== "string" ||
    !approvalId.trim() ||
    (approvalKind !== "exec" &&
      approvalKind !== "plugin" &&
      approvalKind !== "system-agent") ||
    (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny")
  ) {
    return "invalid";
  }
  return { approvalId: approvalId.trim(), approvalKind, decision };
}

function formatDecision(value: string | undefined): string {
  return value === "allow-once"
    ? "Allowed once"
    : value === "allow-always"
      ? "Allowed always"
      : value === "deny"
        ? "Denied"
        : "Resolved";
}

export function buildMattermostCanonicalApprovalTerminalText(params: {
  result: ApprovalResolveResult;
  fallbackApprovalId: string;
}): string {
  const { approval } = params.result;
  const outcome =
    approval.status === "allowed" || approval.status === "denied"
      ? formatDecision(approval.decision)
      : approval.status === "expired"
        ? "Expired"
        : "Cancelled";
  const heading = params.result.applied
    ? "#### Approval resolved"
    : "#### Approval already resolved";
  return [
    heading,
    `**Canonical result:** ${outcome}`,
    `**ID:** ${approval.id || params.fallbackApprovalId}`,
  ].join("\n");
}

export function createMattermostApprovalInteractionHandler(params: {
  cfg: () => OpenClawConfig;
  accountId: string;
}): (input: {
  payload: { user_id: string };
  originalMessage: string;
  context: Record<string, unknown>;
}) => Promise<MattermostInteractionResponse | null> {
  return async (input) => {
    const action = parseMattermostApprovalAction(input.context);
    if (action === null) {
      return null;
    }
    if (action === "invalid") {
      return {
        update: {
          message: "#### Approval action unavailable\nThis button is invalid or no longer actionable.",
          props: {},
        },
      };
    }
    const cfg = params.cfg();
    if (
      !isMattermostExecApprovalApprover({
        cfg,
        accountId: params.accountId,
        senderId: input.payload.user_id,
      })
    ) {
      return { ephemeral_text: "You are not authorized to resolve this approval." };
    }
    try {
      const result = await resolveApprovalOverGateway({
        cfg,
        approvalId: action.approvalId,
        approvalKind: action.approvalKind,
        decision: action.decision,
        channel: "mattermost",
        accountId: params.accountId,
        senderId: input.payload.user_id,
      });
      return {
        update: {
          message: buildMattermostCanonicalApprovalTerminalText({
            result,
            fallbackApprovalId: action.approvalId,
          }),
          props: {},
        },
      };
    } catch (error) {
      const message = String(error);
      if (/not found|no longer pending|expired|already (?:resolved|decided)/iu.test(message)) {
        return {
          update: {
            message: [
              "#### Approval no longer pending",
              "It was already resolved or expired; the canonical decision is unavailable here.",
              `**ID:** ${action.approvalId}`,
            ].join("\n"),
            props: {},
          },
        };
      }
      throw error;
    }
  };
}
