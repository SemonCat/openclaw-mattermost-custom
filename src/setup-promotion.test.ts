import { describe, expect, it } from "vitest";
import { mattermostSetupAdapter } from "./setup-core.js";

describe("Mattermost setup account promotion", () => {
  it("moves both credentials when setup promotes a single account", () => {
    expect(mattermostSetupAdapter.singleAccountKeysToMove).toEqual(["botToken", "baseUrl"]);
    expect(mattermostSetupAdapter.namedAccountPromotionKeys).toEqual(["botToken", "baseUrl"]);
  });
});
