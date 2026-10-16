// Mattermost tests cover native model-picker interaction dispatch ownership.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applySessionModelSelection: vi.fn(),
  authorize: vi.fn(),
  buildEventPlan: vi.fn(),
  buildModelsProviderData: vi.fn(),
  dispatch: vi.fn(),
  getSessionEntry: vi.fn(),
  parseContext: vi.fn(),
  pinExplicitDefaultModel: vi.fn(),
  sendMessage: vi.fn(),
  currentModel: vi.fn(),
  currentRuntime: vi.fn(),
  renderRuntimePicker: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/model-session-runtime", () => ({
  applySessionModelSelection: mocks.applySessionModelSelection,
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry: mocks.getSessionEntry,
  resolveStorePath: () => "/tmp/mattermost-model-picker-sessions.sqlite",
}));

vi.mock("./model-picker.js", () => ({
  buildMattermostAllowedModelRefs: () => new Set(["openai/gpt-5.4"]),
  parseMattermostModelPickerContext: mocks.parseContext,
  renderMattermostModelsPickerView: () => ({ text: "updated picker", buttons: [] }),
  renderMattermostProviderPickerView: () => ({ text: "provider picker", buttons: [] }),
  renderMattermostRuntimePickerView: mocks.renderRuntimePicker,
  resolveMattermostModelPickerCurrentModel: mocks.currentModel,
  resolveMattermostModelPickerCurrentRuntime: mocks.currentRuntime,
}));

vi.mock("./model-session-pin.js", () => ({
  pinMattermostExplicitDefaultModelSelection: mocks.pinExplicitDefaultModel,
  rewriteMattermostPinnedModelReply: (_text: string, modelRef: string) =>
    `Model set to ${modelRef} for this session.`,
}));

vi.mock("./monitor-auth.js", () => ({
  authorizeMattermostCommandInvocation: mocks.authorize,
}));

vi.mock("./monitor-event-plan.js", () => ({
  buildMattermostEventPlan: mocks.buildEventPlan,
}));

vi.mock("./runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-api.js")>("./runtime-api.js");
  return {
    ...actual,
    buildModelsProviderData: mocks.buildModelsProviderData,
  };
});

vi.mock("./send.js", () => ({
  sendMessageMattermost: mocks.sendMessage,
}));

import { createMattermostModelPickerInteractionHandler } from "./monitor-model-picker.js";
import type { MattermostMonitorContext } from "./monitor-types.js";

const modelsData = {
  byProvider: new Map([["openai", new Set(["gpt-5.4"])]]),
  providers: ["openai"],
  resolvedDefault: { provider: "openai", model: "gpt-5.4" },
  modelNames: new Map([["openai/gpt-5.4", "GPT-5.4"]]),
};

function interactionFixture() {
  const updateModelPickerPost = vi.fn(async () => ({}));
  const monitor = {
    account: { accountId: "default", config: {} },
    cfg: {},
    core: {
      config: { current: () => ({}) },
      channel: {
        commands: { shouldHandleTextCommands: () => true },
        text: { hasControlCommand: () => true },
      },
    },
    pairing: { readAllowFromStore: vi.fn(async () => []) },
    resources: {
      resolveChannelInfo: vi.fn(async () => ({ id: "channel-1", type: "O" })),
      updateModelPickerPost,
    },
    runtime: { error: vi.fn() },
  } as unknown as MattermostMonitorContext;
  const handler = createMattermostModelPickerInteractionHandler(monitor);
  return {
    updateModelPickerPost,
    click: (userId = "user-1") => handler({
      payload: {
        channel_id: "channel-1",
        post_id: "picker-post-1",
        user_id: userId,
      },
      userName: "tester",
      context: {},
      post: { id: "picker-post-1", channel_id: "channel-1", message: "picker" },
    }),
  };
}

describe("Mattermost model-picker interaction dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parseContext.mockReturnValue({
      action: "apply",
      ownerUserId: "user-1",
      provider: "openai",
      model: "gpt-5.4",
      page: 0,
    });
    mocks.pinExplicitDefaultModel.mockResolvedValue({
      pinned: true,
      modelRef: "openai/gpt-5.4",
    });
    mocks.currentModel.mockReturnValue("openai/gpt-5.4");
    mocks.currentRuntime.mockReturnValue("openclaw");
    mocks.renderRuntimePicker.mockReturnValue({ text: "runtime picker", buttons: [] });
    mocks.applySessionModelSelection.mockResolvedValue({
      status: "applied",
      provider: "openai",
      model: "gpt-5.4",
      effectiveModelRef: "openai/gpt-5.4",
      agentRuntime: "openclaw",
      changed: true,
      contextTokens: 128_000,
    });
    mocks.getSessionEntry.mockReturnValue({
      sessionId: "session-1", updatedAt: 1,
      providerOverride: "openai", modelOverride: "gpt-5.4", agentRuntimeOverride: "openclaw",
    });
    mocks.authorize.mockResolvedValue({
      ok: true,
      commandAuthorized: true,
      channelInfo: { id: "channel-1", team_id: "team-1", type: "O" },
      kind: "channel",
      chatType: "channel",
      channelName: "lifecycle",
      channelDisplay: "Lifecycle",
      roomLabel: "#lifecycle",
    });
    mocks.buildModelsProviderData.mockResolvedValue(modelsData);
    mocks.sendMessage.mockResolvedValue({
      id: "confirmation-1",
      content: "model updated",
    });
    mocks.buildEventPlan.mockResolvedValue({
      channelDisplay: "Lifecycle",
      kind: "channel",
      roomLabel: "#lifecycle",
      route: { agentId: "main", dmScope: "per-peer", sessionKey: "agent:main:mm" },
      thread: { sessionKey: "agent:main:mm", effectiveReplyToId: undefined },
      to: "channel:channel-1",
      finalizeContext: (context: Record<string, unknown>) => context,
    });
    mocks.dispatch.mockImplementation(() => new Promise(() => undefined));
  });

  it("keeps selection attached to the durable claim and coalesces concurrent clicks", async () => {
    let releaseModelsData: (() => void) | undefined;
    mocks.buildModelsProviderData.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseModelsData = () => resolve(modelsData);
        }),
    );
    const updateModelPickerPost = vi.fn(async () => ({}));
    const startupCfg = { agents: { defaults: { model: { primary: "openai/startup" } } } };
    const runtimeCfg = { agents: { defaults: { model: { primary: "openai/current" } } } };
    const monitor = {
      account: { accountId: "default", config: {} },
      cfg: startupCfg,
      core: {
        config: { current: vi.fn(() => runtimeCfg) },
        channel: {
          commands: { shouldHandleTextCommands: vi.fn(() => true) },
          inbound: { dispatch: mocks.dispatch },
          text: {
            convertMarkdownTables: vi.fn((text: string) => text),
            hasControlCommand: vi.fn(() => true),
          },
        },
      },
      pairing: { readAllowFromStore: vi.fn(async () => []) },
      resources: {
        resolveChannelInfo: vi.fn(async () => ({ id: "channel-1", type: "O" })),
        updateModelPickerPost,
      },
      runtime: { error: vi.fn() },
    } as unknown as MattermostMonitorContext;
    const handler = createMattermostModelPickerInteractionHandler(monitor);

    const selection = handler({
      payload: {
        channel_id: "channel-1",
        post_id: "picker-post-1",
        team_id: "team-1",
        user_id: "user-1",
      },
      userName: "tester",
      context: {},
      post: { id: "picker-post-1", channel_id: "channel-1", message: "picker" },
    });

    await vi.waitFor(() => expect(mocks.buildModelsProviderData).toHaveBeenCalledOnce());
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ cfg: runtimeCfg }));
    expect(mocks.buildEventPlan).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: runtimeCfg }),
      expect.objectContaining({ channelId: "channel-1" }),
    );
    expect(mocks.dispatch).not.toHaveBeenCalled();

    await expect(
      handler({
        payload: {
          channel_id: "channel-1",
          post_id: "picker-post-1",
          team_id: "team-1",
          user_id: "user-1",
        },
        userName: "tester",
        context: {},
        post: { id: "picker-post-1", channel_id: "channel-1", message: "picker" },
      }),
    ).resolves.toEqual({ ephemeral_text: "A model change is already in progress for this chat." });
    releaseModelsData?.();
    await expect(selection).resolves.toEqual({});

    expect(mocks.buildModelsProviderData).toHaveBeenCalledOnce();
    expect(mocks.buildModelsProviderData).toHaveBeenCalledWith(runtimeCfg, "main", {
      sessionEntry: expect.objectContaining({ sessionId: "session-1", updatedAt: 1 }),
    });
    expect(mocks.applySessionModelSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: runtimeCfg,
        agentId: "main",
        sessionKey: "agent:main:mm",
        storePath: "/tmp/mattermost-model-picker-sessions.sqlite",
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        currentProvider: "openai",
        currentModel: "gpt-5.4",
        modelCatalog: [{ provider: "openai", id: "gpt-5.4", name: "GPT-5.4" }],
        request: {
          provider: "openai",
          model: "gpt-5.4",
          isDefault: true,
          runtime: { kind: "unchanged" },
        },
        markLiveSwitchPending: true,
      }),
    );
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.pinExplicitDefaultModel).toHaveBeenCalledWith(
      expect.objectContaining({
        modelsData: expect.objectContaining({ providers: ["openai"] }),
      }),
    );
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      "channel:channel-1",
      "✅ Model set to openai/gpt-5.4 with runtime openclaw for this session.",
      expect.objectContaining({
        cfg: runtimeCfg,
        accountId: "default",
        replyToId: "picker-post-1",
      }),
    );
    expect(updateModelPickerPost).toHaveBeenCalledWith(
      expect.objectContaining({ message: "updated picker" }),
    );

    mocks.applySessionModelSelection.mockResolvedValueOnce({
      status: "conflict",
      message: "Model change conflicted with a newer session update. Retry.",
    });
    await expect(
      handler({
        payload: {
          channel_id: "channel-1",
          post_id: "picker-post-1",
          team_id: "team-1",
          user_id: "user-1",
        },
        userName: "tester",
        context: {},
        post: { id: "picker-post-1", channel_id: "channel-1", message: "picker" },
      }),
    ).resolves.toEqual({});

    expect(mocks.sendMessage).toHaveBeenLastCalledWith(
      "channel:channel-1",
      "❌ Model change conflicted with a newer session update. Retry.",
      expect.any(Object),
    );
    expect(mocks.pinExplicitDefaultModel).toHaveBeenCalledOnce();
  });

  it("builds model menus from the thread session pinned account", async () => {
    mocks.parseContext.mockReturnValue({
      action: "providers",
      ownerUserId: "user-1",
      page: 0,
    });
    const sessionEntry = { sessionId: "thread-session", updatedAt: 2, providerOverride: "openai" };
    mocks.getSessionEntry.mockReturnValue(sessionEntry);
    const runtimeCfg = { agents: { defaults: { model: { primary: "openai/current" } } } };
    const updateModelPickerPost = vi.fn(async () => ({}));
    const monitor = {
      account: { accountId: "default", config: {} },
      cfg: {},
      core: {
        config: { current: vi.fn(() => runtimeCfg) },
        channel: {
          commands: { shouldHandleTextCommands: vi.fn(() => true) },
          inbound: { dispatch: mocks.dispatch },
          text: { hasControlCommand: vi.fn(() => true) },
        },
      },
      pairing: { readAllowFromStore: vi.fn(async () => []) },
      resources: {
        resolveChannelInfo: vi.fn(async () => ({ id: "channel-1", type: "O" })),
        updateModelPickerPost,
      },
      runtime: { error: vi.fn() },
    } as unknown as MattermostMonitorContext;

    await createMattermostModelPickerInteractionHandler(monitor)({
      payload: {
        channel_id: "channel-1",
        post_id: "picker-post-1",
        team_id: "team-1",
        user_id: "user-1",
      },
      userName: "tester",
      context: {},
      post: { id: "picker-post-1", channel_id: "channel-1", message: "picker" },
    });

    expect(mocks.buildModelsProviderData).toHaveBeenCalledWith(runtimeCfg, "main", {
      sessionEntry,
    });
    expect(updateModelPickerPost).toHaveBeenCalledWith(
      expect.objectContaining({ message: "provider picker" }),
    );
  });

  it("requires runtime confirmation before selecting a model", async () => {
    mocks.parseContext.mockReturnValue({
      action: "select", ownerUserId: "user-1", provider: "openai", model: "gpt-5.4", page: 1,
    });
    const { click, updateModelPickerPost } = interactionFixture();
    await click();
    expect(mocks.renderRuntimePicker).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openai", model: "gpt-5.4", currentRuntime: "openclaw",
    }));
    expect(updateModelPickerPost).toHaveBeenCalledWith(expect.objectContaining({
      message: "runtime picker",
    }));
    expect(mocks.applySessionModelSelection).not.toHaveBeenCalled();
    expect(mocks.pinExplicitDefaultModel).not.toHaveBeenCalled();
  });

  it("submits a host-advertised runtime and reads back its persisted selection", async () => {
    mocks.parseContext.mockReturnValue({
      action: "apply", ownerUserId: "user-1", provider: "openai", model: "gpt-5.4",
      page: 1, runtime: "codex",
    });
    mocks.buildModelsProviderData.mockResolvedValue({
      ...modelsData,
      runtimeChoicesByModel: new Map([["openai/gpt-5.4", [
        { id: "codex", label: "Codex", description: "Use Codex" },
      ]]]),
    });
    mocks.applySessionModelSelection.mockResolvedValue({
      status: "applied", effectiveModelRef: "openai/gpt-5.4", agentRuntime: "codex",
    });
    mocks.currentRuntime.mockReturnValue("codex");
    mocks.getSessionEntry.mockReturnValue({
      sessionId: "session-1", providerOverride: "openai", modelOverride: "gpt-5.4",
      agentRuntimeOverride: "codex",
    });
    await interactionFixture().click();
    expect(mocks.applySessionModelSelection).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ runtime: { kind: "set", runtime: "codex" } }),
    }));
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      "channel:channel-1",
      "✅ Model set to openai/gpt-5.4 with runtime codex for this session.",
      expect.any(Object),
    );
  });

  it.each(["stale-runtime", "missing-runtime", "empty-runtimes", "expired-catalog"] as const)(
    "refuses %s without mutating the session",
    async (kind) => {
      mocks.parseContext.mockReturnValue({
        action: "apply", ownerUserId: "user-1", provider: "openai", model: "gpt-5.4",
        page: 1, ...(kind !== "missing-runtime" ? { runtime: "codex" } : {}),
      });
      mocks.buildModelsProviderData.mockResolvedValue({
        ...modelsData,
        runtimeChoicesByModel: new Map([["openai/gpt-5.4",
          kind === "empty-runtimes" ? [] : [
            { id: "openclaw", label: "OpenClaw", description: "Built-in" },
          ],
        ]]),
        isCurrent: () => kind !== "expired-catalog",
      });
      await interactionFixture().click();
      expect(mocks.applySessionModelSelection).not.toHaveBeenCalled();
      expect(mocks.sendMessage.mock.calls[0]?.[1]).toContain("changed");
    },
  );

  it.each(["model", "runtime"] as const)("reports persisted %s mismatch truthfully", async (field) => {
    mocks.parseContext.mockReturnValue({
      action: "apply", ownerUserId: "user-1", provider: "openai", model: "gpt-5.4",
      page: 1, runtime: "openclaw",
    });
    mocks.buildModelsProviderData.mockResolvedValue({
      ...modelsData,
      runtimeChoicesByModel: new Map([["openai/gpt-5.4", [
        { id: "openclaw", label: "OpenClaw", description: "Built-in" },
      ]]]),
    });
    mocks.getSessionEntry.mockReturnValue({
      sessionId: "session-1", providerOverride: "openai",
      modelOverride: field === "model" ? "newer" : "gpt-5.4",
      agentRuntimeOverride: field === "runtime" ? "codex" : "openclaw",
    });
    await interactionFixture().click();
    expect(mocks.sendMessage.mock.calls[0]?.[1]).toContain("but current selection");
    expect(mocks.sendMessage.mock.calls[0]?.[1]).not.toContain("✅");
  });

  it("rejects other users before reading or applying a runtime", async () => {
    await expect(interactionFixture().click("other-user")).resolves.toEqual({
      ephemeral_text: "Only the person who opened this picker can use it.",
    });
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.buildModelsProviderData).not.toHaveBeenCalled();
    expect(mocks.applySessionModelSelection).not.toHaveBeenCalled();
  });
});
