// Mattermost tests cover channel-ready-patch plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { channelReadyPatch } from "./channel-ready-patch.js";

describe("channelReadyPatch", () => {
  it("builds a ready patch that clears any retained terminal-auth verdict", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    try {
      // toStrictEqual (unlike toEqual) treats a missing key as different from
      // an explicit `undefined` value, which is what pins the merge contract.
      expect(channelReadyPatch()).toStrictEqual({
        running: true,
        connected: true,
        lifecycle: "ready",
        lastConnectedAt: 1234,
        lastError: null,
        terminalDisconnect: undefined,
      });
    } finally {
      now.mockRestore();
    }
  });
});
