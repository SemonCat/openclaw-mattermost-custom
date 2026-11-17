import { describe, expect, it, vi } from "vitest";
import { mattermostApprovalCapability as approval } from "./approval-native.js";
import { shouldHandleMattermostExecApprovalRequest } from "./mattermost/exec-approvals.js";

const owner = "a".repeat(26);
const other = "b".repeat(26);
const cfg = {
  channels: { mattermost: {
    botToken: "fixture", baseUrl: "https://approval.example",
    execApprovals: { approvers: [owner], target: "both" },
    accounts: { second: { botToken: "second-fixture", baseUrl: "https://second.example" } },
  } },
};

describe("Mattermost asynchronous native approval contract", () => {
  it.each(["exec", "plugin", "system-agent"] as const)("preserves %s stable-id authorization", async approvalKind => {
    expect(await approval.authorizeActorActionAsync!({
      cfg, accountId: "default", senderId: owner, action: "approve", approvalKind,
    } as never)).toEqual({ authorized: true });
    expect(await approval.authorizeActorActionAsync!({
      cfg, accountId: "default", senderId: other, action: "approve", approvalKind,
    } as never)).toMatchObject({ authorized: false });
  });

  it.each(["channel", "dm", "both"] as const)("preserves %s delivery and disabled eligibility", async target => {
    const configured = { channels: { mattermost: {
      ...cfg.channels.mattermost, execApprovals: { approvers: [owner], target },
    } } };
    expect(await approval.nativeAsync!.describeDeliveryCapabilities!({
      cfg: configured, accountId: "default", approvalKind: "exec",
    })).toMatchObject({
      enabled: true, preferredSurface: target === "channel" ? "origin" : target === "dm" ? "approver-dm" : "both",
      supportsOriginSurface: true, supportsApproverDmSurface: true, notifyOriginWhenDmOnly: true,
    });
    const disabled = { channels: { mattermost: { ...configured.channels.mattermost, enabled: false } } };
    expect(await approval.getExecInitiatingSurfaceStateAsync!({ cfg: disabled, accountId: "default" })).toEqual({ kind: "disabled" });
    expect(await approval.delivery!.hasConfiguredDmRouteAsync!({ cfg: disabled })).toBe(false);
  });

  it("awaits account routing and retains origin thread / approver targets", async () => {
    const request = {
      id: "approval-1", createdAtMs: 1, expiresAtMs: Date.now() + 60_000,
      request: {
        command: "echo fixture", turnSourceChannel: "mattermost",
        turnSourceAccountId: "default", turnSourceTo: "channel:room", turnSourceThreadId: "thread",
      },
    };
    const input = { cfg, accountId: "default", request } as never;
    expect(await shouldHandleMattermostExecApprovalRequest(input)).toBe(true);
    expect(await shouldHandleMattermostExecApprovalRequest({ cfg, accountId: "second", request } as never)).toBe(false);
    expect(await approval.nativeAsync!.resolveOriginTarget!(input)).toEqual({ to: "channel:room", threadId: "thread" });
    expect(await approval.nativeAsync!.resolveApproverDmTargets!(input)).toEqual([{ to: `user:${owner}` }]);
    expect(approval.nativeRuntime).toBeUndefined();
    expect(approval.nativeRuntimeAsync?.eventKinds).toEqual(["exec", "plugin", "system-agent"]);
    expect(await approval.nativeRuntimeAsync!.availability.shouldHandle(input)).toBe(true);
    expect(await approval.delivery!.shouldSuppressForwardingFallbackAsync!({
      cfg, target: { channel: "slack", accountId: "default" }, request,
    } as never)).toBe(false);
  });

  it("loads the async runtime and keeps canonical terminal updates on the pending post", async () => {
    const runtime = approval.nativeRuntimeAsync!;
    const result = await runtime.presentation.buildResolvedResult({
      request: { id: "approval-1", approvalKind: "system-agent" },
      resolved: { decision: "deny" },
      view: { approvalKind: "system-agent", approvalId: "approval-1", operationSummary: "Change", terminalStatus: "cancelled" },
    } as never);
    expect(result).toMatchObject({ kind: "update", payload: { text: expect.stringMatching(/cancelled/i) } });
    const request = vi.fn(async () => ({ id: "pending-post" }));
    await runtime.transport.updateEntry({
      cfg, accountId: "default", context: { client: { request } },
      entry: { channelId: "room", postId: "pending-post" },
      payload: { text: "Canonical terminal result" },
    } as never);
    expect(request).toHaveBeenCalledWith("/posts/pending-post/patch", expect.objectContaining({
      method: "PUT", body: JSON.stringify({ id: "pending-post", message: "Canonical terminal result", props: {} }),
    }));
  });
});
