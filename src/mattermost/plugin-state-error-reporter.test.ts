// Mattermost tests cover plugin-state-error-reporter plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { createPluginStateErrorReporter } from "./plugin-state-error-reporter.js";

describe("createPluginStateErrorReporter", () => {
  it("logs state failures with plugin bindings and default details", () => {
    const warn = vi.fn();
    const getChildLogger = vi.fn(() => ({ warn }));
    const report = createPluginStateErrorReporter(
      () => ({ logging: { getChildLogger } }) as never,
      "mattermost",
      "thread-participation-state",
      "Mattermost persistent thread participation state failed",
    );

    report(new Error("boom"));

    expect(getChildLogger).toHaveBeenCalledWith({
      plugin: "mattermost",
      feature: "thread-participation-state",
    });
    expect(warn).toHaveBeenCalledWith("Mattermost persistent thread participation state failed", {
      error: "Error: boom",
    });
  });

  it("swallows failures from runtime lookup and error formatting instead of throwing", () => {
    const runtimeUnavailable = createPluginStateErrorReporter(
      () => {
        throw new Error("runtime unavailable");
      },
      "mattermost",
      "thread-participation-state",
      "Mattermost persistent thread participation state failed",
    );
    const formattingFailure = createPluginStateErrorReporter(
      () => ({ logging: { getChildLogger: () => ({ warn: vi.fn() }) } }) as never,
      "mattermost",
      "thread-participation-state",
      "Mattermost persistent thread participation state failed",
      () => {
        throw new Error("formatting failed");
      },
    );

    expect(() => runtimeUnavailable(new Error("boom"))).not.toThrow();
    expect(() => formattingFailure(new Error("boom"))).not.toThrow();
  });

  it("returns undefined from the missing runtime when no logger is available", () => {
    const report = createPluginStateErrorReporter(
      () => undefined,
      "mattermost",
      "thread-participation-state",
      "Mattermost persistent thread participation state failed",
    );

    expect(() => report(new Error("boom"))).not.toThrow();
  });
});
