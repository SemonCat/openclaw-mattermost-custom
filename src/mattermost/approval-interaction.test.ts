import { describe, expect, it, vi } from "vitest";

const resolveApprovalOverGateway = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/approval-gateway-runtime")>()),
  resolveApprovalOverGateway,
}));

import {
  buildMattermostCanonicalApprovalTerminalText,
  createMattermostApprovalInteractionHandler,
  parseMattermostApprovalAction,
} from "./approval-interaction.js";

const ownerId = "abcdefghijklmnopqrstuvwxyz";
const cfg = {
  channels: {
    mattermost: {
      botToken: "token",
      baseUrl: "https://mattermost.example.com",
      execApprovals: { approvers: [ownerId] },
    },
  },
};

describe("Mattermost approval interactions", () => {
  it("parses only the reserved typed approval namespace", () => {
    expect(parseMattermostApprovalAction({ action_id: "other" })).toBeNull();
    expect(
      parseMattermostApprovalAction({
        __openclaw_approval_version: 1,
        approval_id: "approval-1",
        approval_kind: "exec",
        decision: "allow-once",
      }),
    ).toEqual({ approvalId: "approval-1", approvalKind: "exec", decision: "allow-once" });
  });

  it("rejects an unauthorized actor without touching Gateway", async () => {
    const handler = createMattermostApprovalInteractionHandler({ cfg: () => cfg, accountId: "default" });
    const response = await handler({
      payload: { user_id: "zyxwvutsrqponmlkjihgfedcba" },
      originalMessage: "pending",
      context: {
        __openclaw_approval_version: 1,
        approval_id: "approval-1",
        approval_kind: "exec",
        decision: "deny",
      },
    });
    expect(response).toEqual({ ephemeral_text: "You are not authorized to resolve this approval." });
    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("resolves through the canonical Gateway service and terminalizes the card", async () => {
    resolveApprovalOverGateway.mockResolvedValueOnce({
      applied: true,
      approval: { id: "approval-1", status: "allowed", decision: "allow-once" },
    });
    const handler = createMattermostApprovalInteractionHandler({ cfg: () => cfg, accountId: "default" });
    const response = await handler({
      payload: { user_id: ownerId },
      originalMessage: "pending",
      context: {
        __openclaw_approval_version: 1,
        approval_id: "approval-1",
        approval_kind: "exec",
        decision: "allow-once",
      },
    });
    expect(resolveApprovalOverGateway).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: "approval-1",
      approvalKind: "exec",
      decision: "allow-once",
      channel: "mattermost",
      senderId: ownerId,
    }));
    expect(response).toEqual({
      update: {
        message: expect.stringContaining("Canonical result:** Allowed once"),
        props: {},
      },
    });
  });

  it("renders applied and already-resolved truth distinctly", () => {
    const approval = { id: "approval-1", status: "denied", decision: "deny" } as const;
    expect(buildMattermostCanonicalApprovalTerminalText({ result: { applied: true, approval }, fallbackApprovalId: "fallback" })).toContain("Approval resolved");
    expect(buildMattermostCanonicalApprovalTerminalText({ result: { applied: false, approval }, fallbackApprovalId: "fallback" })).toContain("Approval already resolved");
  });
});
