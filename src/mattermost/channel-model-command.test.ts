import type {
  OpenClawPluginApi,
  PluginCommandContext,
} from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildChannelModelHeader,
  createMattermostChannelModelCommand,
  resolveMattermostCommandChannelId,
  setMattermostChannelModel,
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
    config: {},
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
  };
  const command = createMattermostChannelModelCommand(api, dependencies);
  return { api, cfg, command, dependencies, mutateConfigFile };
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
