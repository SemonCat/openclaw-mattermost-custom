import { describe, expect, it } from "vitest";
import setupEntry from "./setup-entry.js";

describe("Mattermost setup entry", () => {
  it("exposes the 9.6 bundled-channel contract for Doctor inspection", () => {
    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");
    expect(setupEntry.loadSetupPlugin).toBeTypeOf("function");
    expect(setupEntry.loadSetupSecrets).toBeTypeOf("function");
    expect(setupEntry.features?.legacyStateMigrations).not.toBe(true);
  });
});
