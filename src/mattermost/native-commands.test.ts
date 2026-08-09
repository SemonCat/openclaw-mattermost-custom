// Mattermost tests cover dynamic native command enumeration, root-first naming, and collision fallback.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "./runtime-api.js";

const mockState = vi.hoisted(() => ({
  listNativeCommandSpecsForConfig: vi.fn(),
  listProviderPluginCommandSpecs: vi.fn(),
  listSkillCommandsForAgents: vi.fn(),
}));

vi.mock("./runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-api.js")>()),
  listNativeCommandSpecsForConfig: mockState.listNativeCommandSpecsForConfig,
  listProviderPluginCommandSpecs: mockState.listProviderPluginCommandSpecs,
  listSkillCommandsForAgents: mockState.listSkillCommandsForAgents,
}));

const { buildMattermostNativeCommandSpecs, sanitizeMattermostCommandTrigger } =
  await import("./native-commands.js");

function testRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: ((code: number): never => {
      throw new Error(`exit ${code}`);
    }) as RuntimeEnv["exit"],
  } satisfies RuntimeEnv;
}

describe("sanitizeMattermostCommandTrigger", () => {
  it("lowercases and replaces disallowed characters", () => {
    expect(sanitizeMattermostCommandTrigger("My Skill!")).toBe("my_skill");
  });

  it("falls back to a safe placeholder for an all-disallowed name", () => {
    expect(sanitizeMattermostCommandTrigger("👀")).toBe("cmd");
  });

  it("keeps the prefixed fallback within Mattermost's trigger length limit", () => {
    const longName = "a".repeat(128);
    mockState.listNativeCommandSpecsForConfig.mockReturnValue([
      { name: longName, description: "Long command.", acceptsArgs: false },
    ]);
    mockState.listProviderPluginCommandSpecs.mockReturnValue([]);

    const [spec] = buildMattermostNativeCommandSpecs({
      cfg: {} as OpenClawConfig,
      nativeSkills: false,
      runtime: testRuntime(),
    });

    expect(spec?.trigger).toHaveLength(128);
    expect(spec?.fallbackTrigger).toHaveLength(128);
    expect(spec?.fallbackTrigger).toBe(`oc_${"a".repeat(125)}`);
  });
});

describe("buildMattermostNativeCommandSpecs", () => {
  it("uses the root command name when it does not collide with a Mattermost built-in", () => {
    mockState.listNativeCommandSpecsForConfig.mockReturnValue([
      { name: "stop", description: "Stop the current run.", acceptsArgs: false },
      { name: "model", description: "Show or set the model.", acceptsArgs: true },
    ]);
    mockState.listProviderPluginCommandSpecs.mockReturnValue([]);

    const specs = buildMattermostNativeCommandSpecs({
      cfg: {} as OpenClawConfig,
      nativeSkills: false,
      runtime: testRuntime(),
    });

    expect(specs).toEqual([
      expect.objectContaining({
        trigger: "stop",
        fallbackTrigger: "oc_stop",
        originalName: "stop",
      }),
      expect.objectContaining({
        trigger: "model",
        fallbackTrigger: "oc_model",
        originalName: "model",
      }),
    ]);
  });

  it("falls back to the oc_-prefixed trigger for a name reserved by Mattermost's own built-ins", () => {
    mockState.listNativeCommandSpecsForConfig.mockReturnValue([
      { name: "status", description: "Show current status.", acceptsArgs: false },
      { name: "help", description: "Show available commands.", acceptsArgs: false },
    ]);
    mockState.listProviderPluginCommandSpecs.mockReturnValue([]);

    const specs = buildMattermostNativeCommandSpecs({
      cfg: {} as OpenClawConfig,
      nativeSkills: false,
      runtime: testRuntime(),
    });

    expect(specs).toEqual([
      expect.objectContaining({ trigger: "oc_status", fallbackTrigger: "oc_status" }),
      expect.objectContaining({ trigger: "oc_help", fallbackTrigger: "oc_help" }),
    ]);
  });

  it("includes plugin-contributed commands that do not collide with core or skill commands", () => {
    mockState.listNativeCommandSpecsForConfig.mockReturnValue([
      { name: "stop", description: "Stop the current run.", acceptsArgs: false },
    ]);
    mockState.listProviderPluginCommandSpecs.mockReturnValue([
      { name: "deploy", description: "Deploy the app.", acceptsArgs: false },
    ]);

    const specs = buildMattermostNativeCommandSpecs({
      cfg: {} as OpenClawConfig,
      nativeSkills: false,
      runtime: testRuntime(),
    });

    expect(specs.map((spec) => spec.originalName)).toEqual(["stop", "deploy"]);
  });

  it("keeps the core/skill command and logs when a plugin command collides by name", () => {
    mockState.listNativeCommandSpecsForConfig.mockReturnValue([
      { name: "stop", description: "Stop the current run.", acceptsArgs: false },
    ]);
    mockState.listProviderPluginCommandSpecs.mockReturnValue([
      { name: "stop", description: "A plugin's own stop command.", acceptsArgs: false },
    ]);
    const runtime = testRuntime();

    const specs = buildMattermostNativeCommandSpecs({
      cfg: {} as OpenClawConfig,
      nativeSkills: false,
      runtime,
    });

    expect(specs).toHaveLength(1);
    expect(specs[0]?.description).toBe("Stop the current run.");
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("collides with a core or skill command"),
    );
  });

  it("does not enumerate skill commands when nativeSkills is disabled", () => {
    mockState.listNativeCommandSpecsForConfig.mockReturnValue([]);
    mockState.listProviderPluginCommandSpecs.mockReturnValue([]);

    buildMattermostNativeCommandSpecs({
      cfg: {} as OpenClawConfig,
      nativeSkills: false,
      runtime: testRuntime(),
    });

    expect(mockState.listSkillCommandsForAgents).not.toHaveBeenCalled();
    expect(mockState.listNativeCommandSpecsForConfig).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ skillCommands: undefined, provider: "mattermost" }),
    );
  });
});
