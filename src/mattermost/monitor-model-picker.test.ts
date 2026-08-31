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
  runDetachedWebhookWork: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/webhook-request-guards", () => ({
  runDetachedWebhookWork: mocks.runDetachedWebhookWork,
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
  resolveMattermostModelPickerCurrentModel: () => "openai/gpt-5.4",
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

describe("Mattermost model-picker interaction dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parseContext.mockReturnValue({
      action: "select",
      ownerUserId: "user-1",
      provider: "openai",
      model: "gpt-5.4",
      page: 0,
    });
    mocks.pinExplicitDefaultModel.mockResolvedValue({
      pinned: true,
      modelRef: "openai/gpt-5.4",
    });
    mocks.applySessionModelSelection.mockResolvedValue({
      status: "applied",
      provider: "openai",
      model: "gpt-5.4",
      effectiveModelRef: "openai/gpt-5.4",
      changed: true,
      contextTokens: 128_000,
    });
    mocks.getSessionEntry.mockReturnValue({ sessionId: "session-1", updatedAt: 1 });
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
    mocks.buildModelsProviderData.mockResolvedValue({
      byProvider: new Map([["openai", new Set(["gpt-5.4"])]]),
      providers: ["openai"],
      resolvedDefault: { provider: "openai", model: "gpt-5.4" },
      modelNames: new Map([["openai/gpt-5.4", "GPT-5.4"]]),
    });
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

  it("applies directly outside reply admission and coalesces concurrent clicks", async () => {
    let detachedRun: (() => Promise<void>) | undefined;
    mocks.runDetachedWebhookWork.mockImplementation((run: () => Promise<void>) => {
      detachedRun = run;
      return Promise.resolve();
    });
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

    const response = await handler({
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

    expect(response).toEqual({});
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ cfg: runtimeCfg }));
    expect(mocks.buildEventPlan).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: runtimeCfg }),
      expect.objectContaining({ channelId: "channel-1" }),
    );
    expect(mocks.runDetachedWebhookWork).toHaveBeenCalledOnce();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.buildModelsProviderData).not.toHaveBeenCalled();
    expect(detachedRun).toBeTypeOf("function");

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
    expect(mocks.runDetachedWebhookWork).toHaveBeenCalledOnce();
    expect(mocks.buildModelsProviderData).not.toHaveBeenCalled();

    await detachedRun?.();

    expect(mocks.buildModelsProviderData).toHaveBeenCalledOnce();
    expect(mocks.buildModelsProviderData).toHaveBeenCalledWith(runtimeCfg, "main");
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
      "✅ Model set to openai/gpt-5.4 for this session.",
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
    await detachedRun?.();

    expect(mocks.sendMessage).toHaveBeenLastCalledWith(
      "channel:channel-1",
      "❌ Model change conflicted with a newer session update. Retry.",
      expect.any(Object),
    );
    expect(mocks.pinExplicitDefaultModel).toHaveBeenCalledOnce();
  });
});
