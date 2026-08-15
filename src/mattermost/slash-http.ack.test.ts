import { describe, expect, it } from "vitest";
import { resolveMattermostSlashAcknowledgement } from "./slash-http.js";

describe("resolveMattermostSlashAcknowledgement", () => {
  it("describes the first stage of a channel model mutation", () => {
    expect(resolveMattermostSlashAcknowledgement("/channel_model sol")).toContain(
      "Waiting for Gateway runtime activation",
    );
  });

  it("keeps read-only channel model commands on the generic acknowledgement", () => {
    expect(resolveMattermostSlashAcknowledgement("/channel_model status")).toBe("Processing...");
    expect(resolveMattermostSlashAcknowledgement("/channel_model help")).toBe("Processing...");
    expect(resolveMattermostSlashAcknowledgement("/channel_model")).toBe("Processing...");
  });
});
