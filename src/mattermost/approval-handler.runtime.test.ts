import { describe, expect, it } from "vitest";
import {
  buildMattermostApprovalExpiredText,
  buildMattermostApprovalPendingPayload,
  buildMattermostApprovalResolvedText,
} from "./approval-handler.runtime.js";

const actions = [
  {
    label: "Allow once",
    style: "primary",
    decision: "allow-once",
    action: {
      type: "approval",
      approvalId: "approval-1",
      approvalKind: "exec",
      decision: "allow-once",
    },
  },
  {
    label: "Always allow",
    style: "primary",
    decision: "allow-always",
    action: {
      type: "approval",
      approvalId: "approval-1",
      approvalKind: "exec",
      decision: "allow-always",
    },
  },
  {
    label: "Deny",
    style: "danger",
    decision: "deny",
    action: {
      type: "approval",
      approvalId: "approval-1",
      approvalKind: "exec",
      decision: "deny",
    },
  },
];

describe("Mattermost native approval renderer", () => {
  it("renders an exec request with typed Mattermost approval buttons", () => {
    const payload = buildMattermostApprovalPendingPayload({
      request: { id: "approval-1", expiresAtMs: Date.now() + 60_000 } as never,
      approvalKind: "exec",
      nowMs: Date.now(),
      view: {
        approvalKind: "exec",
        commandText: "npm test",
        host: "gateway",
        actions,
      } as never,
    });
    expect(payload.text).toContain("npm test");
    expect(payload.buttons).toHaveLength(3);
    expect(payload.buttons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "Deny",
          style: "danger",
          context: expect.objectContaining({
            __openclaw_approval_version: 1,
            approval_id: "approval-1",
            approval_kind: "exec",
            decision: "deny",
          }),
        }),
      ]),
    );
  });

  it("renders system-agent approval context without exposing untyped callbacks", () => {
    const payload = buildMattermostApprovalPendingPayload({
      request: { id: "approval-2", expiresAtMs: Date.now() + 60_000 } as never,
      approvalKind: "system-agent",
      nowMs: Date.now(),
      view: {
        approvalKind: "system-agent",
        operationSummary: "Restart managed service",
        agentId: "main",
        actions: actions.map((entry) => ({
          ...entry,
          action: { ...entry.action, approvalId: "approval-2", approvalKind: "system-agent" },
        })),
      } as never,
    });
    expect(payload.text).toContain("OpenClaw change requires approval");
    expect(payload.text).toContain("Restart managed service");
    expect(payload.buttons.every((button) => button.context)).toBe(true);
  });

  it.each([
    {
      label: "applied",
      resolved: { decision: "allow-once" },
      view: { applicationStatus: "applied" },
      expected: "approved and applied",
    },
    {
      label: "not applied",
      resolved: { decision: "allow-once" },
      view: { applicationStatus: "not-applied" },
      expected: "not applied",
    },
    {
      label: "cancelled",
      resolved: { decision: "deny" },
      view: { terminalStatus: "cancelled" },
      expected: "cancelled",
    },
  ])("renders a truthful $label system-agent terminal card", ({ resolved, view, expected }) => {
    const text = buildMattermostApprovalResolvedText({
      request: { id: "approval-2", approvalKind: "system-agent" } as never,
      resolved: resolved as never,
      view: {
        approvalKind: "system-agent",
        approvalId: "approval-2",
        operationSummary: "Restart managed service",
        ...view,
      } as never,
    });
    expect(text.toLowerCase()).toContain(expected);
  });

  it("renders an expired system-agent card", () => {
    const text = buildMattermostApprovalExpiredText({
      request: {
        id: "approval-2",
        request: {
          title: "OpenClaw change",
          description: "Restart managed service",
          command: "restart managed service",
          proposalHash: "a".repeat(64),
          allowedDecisions: ["allow-once", "deny"],
          sessionId: "session-1",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      } as never,
      view: {
        approvalKind: "system-agent",
        approvalId: "approval-2",
        operationSummary: "Restart managed service",
      } as never,
    });
    expect(text.toLowerCase()).toContain("expired");
    expect(text).toContain("No change was made");
  });
});
