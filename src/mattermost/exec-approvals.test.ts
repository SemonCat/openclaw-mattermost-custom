import { describe, expect, it } from "vitest";
import {
  getMattermostExecApprovalApprovers,
  isMattermostExecApprovalClientEnabled,
  normalizeMattermostApproverId,
  resolveMattermostExecApprovalTarget,
} from "./exec-approvals.js";

const ownerId = "abcdefghijklmnopqrstuvwxyz";

describe("Mattermost exec approval profile", () => {
  it("normalizes only stable Mattermost user ids", () => {
    expect(normalizeMattermostApproverId(`user:${ownerId}`)).toBe(ownerId);
    expect(normalizeMattermostApproverId("@mutable-name")).toBeUndefined();
  });

  it("auto-enables with an allowlisted stable owner and defaults to origin delivery", () => {
    const cfg = {
      channels: {
        mattermost: {
          botToken: "token",
          baseUrl: "https://mattermost.example.com",
          allowFrom: [ownerId],
        },
      },
    };
    expect(getMattermostExecApprovalApprovers({ cfg })).toEqual([ownerId]);
    expect(isMattermostExecApprovalClientEnabled({ cfg })).toBe(true);
    expect(resolveMattermostExecApprovalTarget({ cfg })).toBe("channel");
  });

  it("does not enable without a stable approver", () => {
    const cfg = {
      channels: {
        mattermost: {
          botToken: "token",
          baseUrl: "https://mattermost.example.com",
          allowFrom: ["@mutable-name"],
        },
      },
    };
    expect(getMattermostExecApprovalApprovers({ cfg })).toEqual([]);
    expect(isMattermostExecApprovalClientEnabled({ cfg })).toBe(false);
  });
});
