// Mattermost tests cover dynamic native command enumeration, root-first naming, and collision fallback.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "./runtime-api.js";

const mockState = vi.hoisted(() => ({
  listNativeCommandSpecsForConfig: vi.fn(),
  listProviderPluginCommandSpecs: vi.fn(),
  prepareSkillCommandsForAgents: vi.fn(),
}));

vi.mock("./runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-api.js")>()),
  listNativeCommandSpecsForConfig: mockState.listNativeCommandSpecsForConfig,
  listProviderPluginCommandSpecs: mockState.listProviderPluginCommandSpecs,
  prepareSkillCommandsForAgents: mockState.prepareSkillCommandsForAgents,
}));

const { buildMattermostNativeCommandSpecs, sanitizeMattermostCommandTrigger, isMattermostNativeSkillAllowed } =
  await import("./native-commands.js");

it("filters native skill invocation before dispatch while preserving ordinary commands", async () => {
  mockState.prepareSkillCommandsForAgents.mockReturnValue([{ name: "review_code", skillName: "code-review" }]);
  const allowed = (commandText: string, skillFilter?: string[]) => isMattermostNativeSkillAllowed({ cfg: {}, commandText, skillFilter });
  expect(await allowed("/review_code file")).toBe(true);
  expect(await allowed("/review_code file", [])).toBe(false);
  expect(await allowed("/review_code file", ["other"])).toBe(false);
  expect(await allowed("/review_code file", ["code-review"])).toBe(true);
  expect(await allowed("/skill code-review file", [])).toBe(false);
  expect(await allowed("/skill CODE_REVIEW file", ["other"])).toBe(false);
  expect(await allowed("/skill review-code file", ["code-review"])).toBe(true);
  expect(await allowed("/skill code-review file", ["code-review"])).toBe(true);
  expect(await allowed("/status", [])).toBe(true);
  mockState.prepareSkillCommandsForAgents.mockReset();
});

it("does not authorize a filtered skill while asynchronous discovery is unavailable", async () => {
  mockState.prepareSkillCommandsForAgents.mockRejectedValueOnce(new Error("catalog unavailable"));
  await expect(isMattermostNativeSkillAllowed({
    cfg: {}, commandText: "/skill code-review", skillFilter: [],
  })).rejects.toThrow("catalog unavailable");
  mockState.prepareSkillCommandsForAgents.mockReset();
});

it.each([
  [" /REVIEW_CODE file\nmore input ", false],
  ["/skill REVIEW-CODE file", false],
  ["/SKILL Code_Review file\nmore input", false],
  ["/skill release_notes", false],
  ["/review-code file", true],
  ["/code-review file", true],
  ["/skill", true],
  ["/skill unknown file", true],
  ["/status", true],
  ["prose /review_code file", true],
])("preserves host invocation matching for %j", async (commandText, expected) => {
  mockState.prepareSkillCommandsForAgents.mockReturnValue([
    { name: "review_code", skillName: "code-review" },
    { name: "release_notes", skillName: "Release Notes" },
  ]);
  try {
    expect(await isMattermostNativeSkillAllowed({ cfg: {}, commandText, skillFilter: [] })).toBe(expected);
    expect(await isMattermostNativeSkillAllowed({
      cfg: {}, commandText, skillFilter: ["code-review", "Release Notes"],
    })).toBe(true);
  } finally {
    mockState.prepareSkillCommandsForAgents.mockReset();
  }
});

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

  it("keeps the prefixed fallback within Mattermost's trigger length limit", async () => {
    const longName = "a".repeat(128);
    mockState.listNativeCommandSpecsForConfig.mockReturnValue([
      { name: longName, description: "Long command.", acceptsArgs: false },
    ]);
    mockState.listProviderPluginCommandSpecs.mockReturnValue([]);

    const [spec] = await buildMattermostNativeCommandSpecs({
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
  it("uses the root command name when it does not collide with a Mattermost built-in", async () => {
    mockState.listNativeCommandSpecsForConfig.mockReturnValue([
      { name: "stop", description: "Stop the current run.", acceptsArgs: false },
      { name: "model", description: "Show or set the model.", acceptsArgs: true },
    ]);
    mockState.listProviderPluginCommandSpecs.mockReturnValue([]);

    const specs = await buildMattermostNativeCommandSpecs({
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

  it("falls back to the oc_-prefixed trigger for a name reserved by Mattermost's own built-ins", async () => {
    mockState.listNativeCommandSpecsForConfig.mockReturnValue([
      { name: "status", description: "Show current status.", acceptsArgs: false },
      { name: "help", description: "Show available commands.", acceptsArgs: false },
    ]);
    mockState.listProviderPluginCommandSpecs.mockReturnValue([]);

    const specs = await buildMattermostNativeCommandSpecs({
      cfg: {} as OpenClawConfig,
      nativeSkills: false,
      runtime: testRuntime(),
    });

    expect(specs).toEqual([
      expect.objectContaining({ trigger: "oc_status", fallbackTrigger: "oc_status" }),
      expect.objectContaining({ trigger: "oc_help", fallbackTrigger: "oc_help" }),
    ]);
  });

  it("includes plugin-contributed commands that do not collide with core or skill commands", async () => {
    mockState.listNativeCommandSpecsForConfig.mockReturnValue([
      { name: "stop", description: "Stop the current run.", acceptsArgs: false },
    ]);
    mockState.listProviderPluginCommandSpecs.mockReturnValue([
      { name: "deploy", description: "Deploy the app.", acceptsArgs: false },
    ]);

    const specs = await buildMattermostNativeCommandSpecs({
      cfg: {} as OpenClawConfig,
      nativeSkills: false,
      runtime: testRuntime(),
    });

    expect(specs.map((spec) => spec.originalName)).toEqual(["stop", "deploy"]);
  });

  it("keeps the core/skill command and logs when a plugin command collides by name", async () => {
    mockState.listNativeCommandSpecsForConfig.mockReturnValue([
      { name: "stop", description: "Stop the current run.", acceptsArgs: false },
    ]);
    mockState.listProviderPluginCommandSpecs.mockReturnValue([
      { name: "stop", description: "A plugin's own stop command.", acceptsArgs: false },
    ]);
    const runtime = testRuntime();

    const specs = await buildMattermostNativeCommandSpecs({
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

  it("does not enumerate skill commands when nativeSkills is disabled", async () => {
    mockState.listNativeCommandSpecsForConfig.mockReturnValue([]);
    mockState.listProviderPluginCommandSpecs.mockReturnValue([]);

    await buildMattermostNativeCommandSpecs({
      cfg: {} as OpenClawConfig,
      nativeSkills: false,
      runtime: testRuntime(),
    });

    expect(mockState.prepareSkillCommandsForAgents).not.toHaveBeenCalled();
    expect(mockState.listNativeCommandSpecsForConfig).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ skillCommands: undefined, provider: "mattermost" }),
    );
  });

  it("waits for prepared remote skills before building the native catalog", async () => {
    const skills = [{ name: "review_code", skillName: "code-review" }];
    let release!: (value: typeof skills) => void;
    mockState.prepareSkillCommandsForAgents.mockImplementationOnce(
      () => new Promise<typeof skills>((resolve) => { release = resolve; }),
    );
    mockState.listNativeCommandSpecsForConfig.mockClear();
    mockState.listNativeCommandSpecsForConfig.mockReturnValue([
      { name: "review_code", description: "Review code." },
    ]);
    mockState.listProviderPluginCommandSpecs.mockReturnValue([]);
    try {
      const pending = buildMattermostNativeCommandSpecs({
        cfg: {}, nativeSkills: true, runtime: testRuntime(),
      });
      expect(mockState.listNativeCommandSpecsForConfig).not.toHaveBeenCalled();
      release(skills);
      expect(await pending).toEqual([
        expect.objectContaining({ trigger: "review_code", originalName: "review_code" }),
      ]);
      expect(mockState.listNativeCommandSpecsForConfig).toHaveBeenCalledWith(
        {}, { skillCommands: skills, provider: "mattermost" },
      );
    } finally {
      mockState.prepareSkillCommandsForAgents.mockReset();
    }
  });

  it("keeps core commands available when asynchronous skill preparation fails", async () => {
    mockState.prepareSkillCommandsForAgents.mockRejectedValueOnce(new Error("remote unavailable"));
    mockState.listNativeCommandSpecsForConfig.mockReturnValue([
      { name: "stop", description: "Stop." },
    ]);
    mockState.listProviderPluginCommandSpecs.mockReturnValue([]);
    const runtime = testRuntime();
    try {
      expect(await buildMattermostNativeCommandSpecs({
        cfg: {}, nativeSkills: true, runtime,
      })).toEqual([expect.objectContaining({ trigger: "stop" })]);
      expect(runtime.error).toHaveBeenCalledWith(
        "mattermost: failed to list skill commands: Error: remote unavailable",
      );
    } finally {
      mockState.prepareSkillCommandsForAgents.mockReset();
    }
  });
});
