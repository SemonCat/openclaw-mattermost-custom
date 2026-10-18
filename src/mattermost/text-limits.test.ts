import { describe, expect, it } from "vitest";
import { observeMattermostServerVersion, resolveMattermostTextLimit } from "./text-limits.js";

describe("Mattermost server text limits", () => {
  it("uses the legacy bound until a v12 response is observed and handles downgrades", () => {
    const baseUrl = "https://version-boundary.example.test";
    expect(resolveMattermostTextLimit({ baseUrl })).toBe(16_383);
    observeMattermostServerVersion(baseUrl, "11.11.1.35958890150.hash.false");
    expect(resolveMattermostTextLimit({ baseUrl })).toBe(16_383);
    observeMattermostServerVersion(baseUrl, "12.0.0.38519854955.hash.false");
    expect(resolveMattermostTextLimit({ baseUrl })).toBe(262_144);
    observeMattermostServerVersion(baseUrl, null);
    expect(resolveMattermostTextLimit({ baseUrl })).toBe(262_144);
    observeMattermostServerVersion(baseUrl, "11.11.1");
    expect(resolveMattermostTextLimit({ baseUrl })).toBe(16_383);
  });

  it("isolates instances and subpaths while normalizing API URLs", () => {
    observeMattermostServerVersion("https://isolated.example.test/new/", "12.0.0");
    expect(resolveMattermostTextLimit({ baseUrl: "https://isolated.example.test/new/api/v4" })).toBe(262_144);
    expect(resolveMattermostTextLimit({ baseUrl: "https://isolated.example.test/old" })).toBe(16_383);
    expect(resolveMattermostTextLimit({ baseUrl: "https://another.example.test/new" })).toBe(16_383);
  });

  it("honors smaller operator limits and clamps them to the observed server bound", () => {
    const baseUrl = "https://configured-limit.example.test";
    observeMattermostServerVersion(baseUrl, "12.0.0");
    expect(resolveMattermostTextLimit({ baseUrl, textChunkLimit: 4000 })).toBe(4000);
    expect(resolveMattermostTextLimit({ baseUrl, textChunkLimit: 262_144 })).toBe(262_144);
    expect(resolveMattermostTextLimit({ baseUrl, textChunkLimit: 999_999 })).toBe(262_144);
    observeMattermostServerVersion(baseUrl, "11.11.1");
    expect(resolveMattermostTextLimit({ baseUrl, textChunkLimit: 262_144 })).toBe(16_383);
  });

  it.each(["invalid", "12", "12.0", "-12.0.0", "99999999999999999.0.0"])(
    "does not enable large posts from an invalid version %s",
    (version) => {
      const baseUrl = `https://invalid-version.example.test/${encodeURIComponent(version)}`;
      observeMattermostServerVersion(baseUrl, version);
      expect(resolveMattermostTextLimit({ baseUrl })).toBe(16_383);
    },
  );
});
