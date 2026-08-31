import type {
  OpenClawPluginApi,
  PluginCommandContext,
} from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildChannelModelHeader,
  clearSessionModelOverrideEntry,
  createMattermostChannelModelCommand,
  resolveMattermostCommandChannelId,
  setMattermostChannelModel,
  waitForMattermostChannelModelRuntime,
  type ChannelModelCommandDependencies,
} from "./channel-model-command.js";
import type { OpenClawConfig } from "./runtime-api.js";

function createContext(overrides: Partial<PluginCommandContext> = {}): PluginCommandContext {
  return {
    channel: "mattermost",
    channelId: "mattermost",
    isAuthorizedSender: true,
    agentId: "main",
    args: "",
    commandBody: "/channel_model",
    to: "channel:channel-1",
    requestConversationBinding: vi.fn(),
    detachConversationBinding: vi.fn(),
    getCurrentConversationBinding: vi.fn(),
    ...overrides,
  } as PluginCommandContext;
}

describe("resolveMattermostCommandChannelId", () => {
  it("uses the native Mattermost target instead of the provider channel id", () => {
    expect(
      resolveMattermostCommandChannelId({
        channelId: "mattermost",
        sessionKey: "agent:main:mattermost:channel:channel-1",
        to: "channel:channel-1",
      }),
    ).toBe("channel-1");
  });

  it("falls back to the native id in the session key when To is unavailable", () => {
    expect(
      resolveMattermostCommandChannelId({
        channelId: "mattermost",
        sessionKey: "agent:main:mattermost:group:private-1:thread:root-1",
        to: undefined,
      }),
    ).toBe("private-1");
  });
});

function createHarness(initialConfig: OpenClawConfig = {}) {
  const cfg = structuredClone(initialConfig);
  const mutateConfigFile = vi.fn(async (params: { mutate: (draft: OpenClawConfig) => void }) => {
    params.mutate(cfg);
    return { nextConfig: cfg };
  });
  const api = {
    runtime: {
      config: {
        current: () => cfg,
        mutateConfigFile,
      },
    },
  } as unknown as OpenClawPluginApi;
  const client = { request: vi.fn() };
  const dependencies: ChannelModelCommandDependencies = {
    buildModelsProviderData: vi.fn(async () => ({
      providers: ["openai", "anthropic"],
      byProvider: new Map([
        ["openai", new Set(["gpt-5.6-terra", "gpt-5.6-sol"])],
        ["anthropic", new Set(["claude-sonnet-4-5"])],
      ]),
      resolvedDefault: { provider: "openai", model: "gpt-5.6-terra" },
      modelNames: new Map(),
    })),
    resolveMattermostAccount: vi.fn(() => ({
      accountId: "default",
      enabled: true,
      baseUrl: "https://mattermost.example.com",
      botToken: "secret",
      config: {},
    })) as ChannelModelCommandDependencies["resolveMattermostAccount"],
    createMattermostClient: vi.fn(() => client) as unknown as ChannelModelCommandDependencies["createMattermostClient"],
    fetchMattermostChannel: vi.fn(async () => ({
      id: "channel-1",
      header: "Team notes",
    })),
    patchMattermostChannelHeader: vi.fn(async (_client, channelId, header) => ({
      id: channelId,
      header,
    })),
    waitForRuntimeConfig: vi.fn(async () => cfg),
  };
  const clearParentSessionModelOverride = vi.fn(async () => ({ status: "cleared" as const }));
  dependencies.clearParentSessionModelOverride = clearParentSessionModelOverride;
  const command = createMattermostChannelModelCommand(api, dependencies);
  return {
    api,
    cfg,
    command,
    dependencies,
    mutateConfigFile,
    clearParentSessionModelOverride,
  };
}

describe("buildChannelModelHeader", () => {
  it("preserves an existing user-managed header", () => {
    expect(buildChannelModelHeader("Team notes", "openai/gpt-5.6-sol")).toBe(
      "🤖 **Default model:** `openai/gpt-5.6-sol`\nTeam notes",
    );
  });

  it("replaces its previously managed line without duplicating it", () => {
    expect(
      buildChannelModelHeader(
        "🤖 **Default model:** `openai/old`\nTeam notes",
        "openai/gpt-5.6-sol",
      ),
    ).toBe("🤖 **Default model:** `openai/gpt-5.6-sol`\nTeam notes");
  });
});

describe("setMattermostChannelModel", () => {
  it("removes empty override containers when resetting", () => {
    const cfg: OpenClawConfig = {
      channels: { modelByChannel: { mattermost: { "channel-1": "openai/old" } } },
    };

    setMattermostChannelModel(cfg, "channel-1", undefined);

    expect(cfg.channels?.modelByChannel).toBeUndefined();
  });
});

describe("clearSessionModelOverrideEntry", () => {
  it("clears persisted model, provider, runtime, and auth profile pins", () => {
    const result = clearSessionModelOverrideEntry(
      {
        sessionId: "session-1",
        updatedAt: 1,
        providerOverride: "pc-llama",
        modelOverride: "qwen3.6-27b-uncensored-iq4_xs",
        modelOverrideSource: "user",
        modelOverrideRouteResolution: "resolved",
        modelProvider: "pc-llama",
        model: "qwen3.6-27b-uncensored-iq4_xs",
        contextTokens: 262_144,
        authProfileOverride: "local-model",
        authProfileOverrideSource: "user",
      },
      "opencode-go/deepseek-v4-flash",
    );

    expect(result.updated).toBe(true);
    expect(result.entry).not.toHaveProperty("providerOverride");
    expect(result.entry).not.toHaveProperty("modelOverride");
    expect(result.entry).not.toHaveProperty("modelProvider");
    expect(result.entry).not.toHaveProperty("model");
    expect(result.entry).not.toHaveProperty("contextTokens");
    expect(result.entry).not.toHaveProperty("authProfileOverride");
    expect(result.entry.liveModelSwitchPending).toBe(true);
  });
});

describe("/channel_model", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sets the channel override and updates the managed header", async () => {
    const harness = createHarness();

    const result = await harness.command.handler(
      createContext({ args: "OpenAI/gpt-5.6-sol" }),
    );

    expect(harness.cfg.channels?.modelByChannel?.mattermost?.["channel-1"]).toBe(
      "openai/gpt-5.6-sol",
    );
    expect(harness.mutateConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({ base: "source", afterWrite: { mode: "auto" } }),
    );
    expect(harness.dependencies.patchMattermostChannelHeader).toHaveBeenCalledWith(
      expect.anything(),
      "channel-1",
      "🤖 **Default model:** `openai/gpt-5.6-sol`\nTeam notes",
    );
    expect(result.text).toContain("Channel default model set");
  });

  it("uses the invocation config when the runtime snapshot cannot resolve channel secrets", async () => {
    const harness = createHarness();
    const invocationConfig = structuredClone(harness.cfg);
    harness.dependencies.resolveMattermostAccount = vi.fn(({ cfg }) => {
      if (cfg !== invocationConfig) {
        throw new Error('unresolved SecretRef "file:mattermost-bot:value"');
      }
      return {
        accountId: "default",
        enabled: true,
        baseUrl: "https://mattermost.example.com",
        botToken: "secret",
        config: {},
      };
    }) as ChannelModelCommandDependencies["resolveMattermostAccount"];
    harness.command = createMattermostChannelModelCommand(harness.api, harness.dependencies);

    const result = await harness.command.handler(
      createContext({ args: "openai/gpt-5.6-sol", config: invocationConfig }),
    );

    expect(result.text).toContain("Channel default model set");
    expect(harness.dependencies.resolveMattermostAccount).toHaveBeenCalledWith({
      cfg: invocationConfig,
      accountId: undefined,
    });
  });

  it("reports credential resolution failures without escaping the command handler", async () => {
    const harness = createHarness();
    harness.dependencies.resolveMattermostAccount = vi.fn(() => {
      throw new Error('unresolved SecretRef "file:mattermost-bot:value"');
    });
    harness.command = createMattermostChannelModelCommand(harness.api, harness.dependencies);

    await expect(
      harness.command.handler(createContext({ args: "openai/gpt-5.6-sol" })),
    ).resolves.toEqual({
      text: "Mattermost account credentials could not be resolved; no changes were made.",
    });
    expect(harness.mutateConfigFile).not.toHaveBeenCalled();
  });

  it("resolves a configured model alias before saving the channel override", async () => {
    const harness = createHarness({
      agents: {
        defaults: {
          models: { "openai/gpt-5.6-sol": { alias: "openai-sol" } },
        },
      },
    });

    const result = await harness.command.handler(createContext({ args: "openai-sol" }));

    expect(harness.cfg.channels?.modelByChannel?.mattermost?.["channel-1"]).toBe(
      "openai/gpt-5.6-sol",
    );
    expect(result.text).toContain("Channel default model set");
  });

  it("clears the parent channel session model override after saving the default", async () => {
    const harness = createHarness();

    const result = await harness.command.handler(
      createContext({ args: "openai/gpt-5.6-sol" }),
    );

    expect(harness.clearParentSessionModelOverride).toHaveBeenCalledWith({
      cfg: harness.cfg,
      agentId: "main",
      channelId: "channel-1",
      effectiveModel: "openai/gpt-5.6-sol",
    });
    expect(result.text).toContain("Cleared the active channel session model override");
  });

  it("does not report success or touch the session/header until runtime config is active", async () => {
    const harness = createHarness();
    let releaseRuntime!: () => void;
    const runtimeReady = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    harness.dependencies.waitForRuntimeConfig = vi.fn(async () => {
      await runtimeReady;
      return harness.cfg;
    });
    harness.command = createMattermostChannelModelCommand(harness.api, harness.dependencies);

    let completed = false;
    const resultPromise = harness.command
      .handler(createContext({ args: "openai/gpt-5.6-sol" }))
      .then((result) => {
        completed = true;
        return result;
      });
    await vi.waitFor(() => expect(harness.mutateConfigFile).toHaveBeenCalled());

    expect(completed).toBe(false);
    expect(harness.clearParentSessionModelOverride).not.toHaveBeenCalled();
    expect(harness.dependencies.patchMattermostChannelHeader).not.toHaveBeenCalled();

    releaseRuntime();
    const result = await resultPromise;
    expect(result.text).toContain("✅ Channel default model set");
  });

  it("warns without a success marker when runtime activation times out", async () => {
    const harness = createHarness();
    harness.dependencies.waitForRuntimeConfig = vi.fn(async () => {
      throw new Error("runtime activation timed out");
    });
    harness.command = createMattermostChannelModelCommand(harness.api, harness.dependencies);

    const result = await harness.command.handler(
      createContext({ args: "openai/gpt-5.6-sol" }),
    );

    expect(result.text).toContain("saved");
    expect(result.text).toContain("not active");
    expect(result.text).not.toContain("✅");
    expect(harness.clearParentSessionModelOverride).not.toHaveBeenCalled();
    expect(harness.dependencies.patchMattermostChannelHeader).not.toHaveBeenCalled();
  });

  it("resets to the agent default and removes the channel override", async () => {
    const harness = createHarness({
      channels: { modelByChannel: { mattermost: { "channel-1": "openai/gpt-5.6-sol" } } },
    });

    const result = await harness.command.handler(createContext({ args: "default" }));

    expect(harness.cfg.channels?.modelByChannel).toBeUndefined();
    expect(harness.dependencies.patchMattermostChannelHeader).toHaveBeenCalledWith(
      expect.anything(),
      "channel-1",
      "🤖 **Default model:** `openai/gpt-5.6-terra`\nTeam notes",
    );
    expect(result.text).toContain("reset to agent default");
    expect(harness.clearParentSessionModelOverride).toHaveBeenCalledWith({
      cfg: harness.cfg,
      agentId: "main",
      channelId: "channel-1",
      effectiveModel: "openai/gpt-5.6-terra",
    });
  });

  it("warns when the parent session override cannot be cleared", async () => {
    const harness = createHarness();
    harness.clearParentSessionModelOverride.mockRejectedValueOnce(new Error("session locked"));

    const result = await harness.command.handler(
      createContext({ args: "openai/gpt-5.6-sol" }),
    );

    expect(result.text).toContain("channel default is active");
    expect(result.text).toContain("session locked");
  });

  it("shows status without writing config or touching Mattermost", async () => {
    const harness = createHarness();

    const result = await harness.command.handler(createContext());

    expect(result.text).toContain("openai/gpt-5.6-terra");
    expect(harness.mutateConfigFile).not.toHaveBeenCalled();
    expect(harness.dependencies.fetchMattermostChannel).not.toHaveBeenCalled();
  });

  it("rejects models outside the available catalog", async () => {
    const harness = createHarness();

    const result = await harness.command.handler(createContext({ args: "openai/not-real" }));

    expect(result.text).toContain("Unknown model");
    expect(harness.mutateConfigFile).not.toHaveBeenCalled();
    expect(harness.dependencies.fetchMattermostChannel).not.toHaveBeenCalled();
  });

  it("rejects direct messages", async () => {
    const harness = createHarness();

    const result = await harness.command.handler(
      createContext({ channelId: "dm-channel", to: "user:user-1" }),
    );

    expect(result.text).toContain("not direct messages");
    expect(harness.dependencies.buildModelsProviderData).not.toHaveBeenCalled();
  });
});

describe("waitForMattermostChannelModelRuntime", () => {
  it("polls until the exact channel override is visible", async () => {
    const configs: OpenClawConfig[] = [
      { channels: { modelByChannel: { mattermost: { "channel-1": "openai/old" } } } },
      { channels: { modelByChannel: { mattermost: { "channel-1": "openai/new" } } } },
    ];

    await expect(
      waitForMattermostChannelModelRuntime({
        currentConfig: () => configs.shift() ?? configs[0] ?? {},
        channelId: "channel-1",
        expectedOverride: "openai/new",
        timeoutMs: 100,
        pollIntervalMs: 0,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        channels: { modelByChannel: { mattermost: { "channel-1": "openai/new" } } },
      }),
    );
  });
});
