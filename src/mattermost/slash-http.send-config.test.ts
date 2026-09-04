// Mattermost tests cover slash http.send config plugin behavior.
import { ServerResponse, type IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedMattermostAccount } from "./accounts.js";

const mockState = vi.hoisted(() => ({
  runtimeConfig: {} as OpenClawConfig,
  readRequestBodyWithLimit: vi.fn(async () => "token=valid-token"),
  isRequestBodyLimitError: vi.fn(
    (error: unknown, code: string) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === code,
  ),
  sendHttpRequestRejection: vi.fn(
    async (
      _req: IncomingMessage,
      res: ServerResponse,
      statusCode: number,
      body: string,
    ) => {
      res.statusCode = statusCode;
      res.end(body);
    },
  ),
  parseSlashCommandPayload: vi.fn(() => ({
    token: "valid-token",
    command: "/oc_models",
    text: "models",
    channel_id: "chan-1",
    user_id: "user-1",
    user_name: "alice",
    team_id: "team-1",
  })),
  resolveCommandText: vi.fn((_trigger: string, text: string) => text),
  buildModelsProviderData: vi.fn(async () => ({ providers: [], modelNames: new Map() })),
  resolveMattermostModelPickerEntry: vi.fn((): { kind: string } | null => ({ kind: "summary" })),
  resolveMattermostModelPickerCurrentModel: vi.fn(),
  renderMattermostModelSummaryView: vi.fn(() => ({ text: "model summary", buttons: [] })),
  authorizeMattermostCommandInvocation: vi.fn(() => ({
    ok: true,
    commandAuthorized: true,
    channelInfo: { id: "chan-1", type: "O", name: "town-square", display_name: "Town Square" },
    kind: "channel",
    chatType: "channel",
    channelName: "town-square",
    channelDisplay: "Town Square",
    roomLabel: "#town-square",
  })),
  createMattermostClient: vi.fn(() => ({})),
  fetchMattermostChannel: vi.fn(async () => ({
    id: "chan-1",
    type: "O",
    name: "town-square",
    display_name: "Town Square",
  })),
  sendMessageMattermost: vi.fn(async () => ({ messageId: "post-1", channelId: "chan-1" })),
  normalizeMattermostAllowList: vi.fn((value: unknown) => value),
  getMattermostCommand: vi.fn(async () => ({
    id: "cmd-1",
    token: "valid-token",
    team_id: "team-1",
    trigger: "oc_models",
    method: "P",
    url: "https://gateway.example.com/slash",
    delete_at: 0,
  })),
  listMattermostCommands: vi.fn(async () => []),
  dispatchInbound: vi.fn(async () => undefined),
}));

vi.mock("./runtime-api.js", () => {
  return {
    buildModelsProviderData: mockState.buildModelsProviderData,
    createChannelMessageReplyPipeline: vi.fn(() => ({
      onModelSelected: vi.fn(),
      typingCallbacks: {},
    })),
    createDedupeCache: vi.fn(() => ({
      check: () => false,
    })),
    createReplyPrefixOptions: vi.fn(() => ({})),
    createTypingCallbacks: vi.fn(() => ({ onReplyStart: vi.fn() })),
    isRequestBodyLimitError: mockState.isRequestBodyLimitError,
    logTypingFailure: vi.fn(),
    formatInboundFromLabel: vi.fn(() => ""),
    rawDataToString: vi.fn((value: unknown) => (typeof value === "string" ? value : "")),
    readRequestBodyWithLimit: mockState.readRequestBodyWithLimit,
    sendHttpRequestRejection: mockState.sendHttpRequestRejection,
    resolveThreadSessionKeys: vi.fn(
      (params: { baseSessionKey: string; threadId?: string; parentSessionKey?: string }) => ({
        sessionKey: params.threadId
          ? `${params.baseSessionKey}:thread:${params.threadId}`
          : params.baseSessionKey,
        parentSessionKey: params.parentSessionKey,
      }),
    ),
  };
});

vi.mock("../runtime.js", () => ({
  getMattermostRuntime: () => ({
    config: {
      current: () => mockState.runtimeConfig,
    },
    channel: {
      commands: {
        shouldHandleTextCommands: () => true,
      },
      text: {
        hasControlCommand: () => false,
        resolveTextChunkLimit: () => 4000,
        resolveMarkdownTableMode: () => "off",
      },
      inbound: { dispatch: mockState.dispatchInbound },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
      },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "agent-1",
          sessionKey: "mattermost:session:1",
          accountId: "default",
        })),
      },
    },
  }),
}));

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    createMattermostClient: mockState.createMattermostClient,
    fetchMattermostChannel: mockState.fetchMattermostChannel,
    normalizeMattermostBaseUrl: vi.fn((value: string | undefined) => value?.trim() ?? ""),
    sendMattermostTyping: vi.fn(),
  };
});

vi.mock("./model-picker.js", () => ({
  renderMattermostModelSummaryView: mockState.renderMattermostModelSummaryView,
  renderMattermostModelsPickerView: vi.fn(),
  renderMattermostProviderPickerView: vi.fn(),
  resolveMattermostModelPickerCurrentModel: mockState.resolveMattermostModelPickerCurrentModel,
  resolveMattermostModelPickerEntry: mockState.resolveMattermostModelPickerEntry,
}));

vi.mock("./monitor-auth.js", () => ({
  authorizeMattermostCommandInvocation: mockState.authorizeMattermostCommandInvocation,
  normalizeMattermostAllowList: mockState.normalizeMattermostAllowList,
}));

vi.mock("./reply-delivery.js", () => ({
  createMattermostReplyDeliveryBarrier: vi.fn(() => ({
    markDeliverySettled: vi.fn(),
    resolveTimeoutPolicy: vi.fn(),
    trackDmChannelResolution: vi.fn(),
  })),
  deliverMattermostReplyPayload: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendMessageMattermost: mockState.sendMessageMattermost,
}));

vi.mock("./slash-commands.js", () => ({
  MATTERMOST_SLASH_POST_METHOD: "P",
  getMattermostCommand: mockState.getMattermostCommand,
  listMattermostCommands: mockState.listMattermostCommands,
  normalizeSlashCommandTrigger: (command: string) => command.replace(/^\//, "").trim(),
  parseSlashCommandPayload: mockState.parseSlashCommandPayload,
  resolveCommandText: mockState.resolveCommandText,
}));

let createSlashCommandHttpHandler: typeof import("./slash-http.js").createSlashCommandHttpHandler;
const callbackUrlFixture = "https://gateway.example.com/slash";

function createRequest(body = "token=valid-token"): IncomingMessage {
  const req = new PassThrough();
  const incoming = req as PassThrough & IncomingMessage;
  incoming.method = "POST";
  incoming.url = "/slash";
  incoming.headers = {
    "content-type": "application/x-www-form-urlencoded",
  };
  process.nextTick(() => {
    req.end(body);
  });
  return incoming;
}

function createResponse(): {
  res: ServerResponse;
  getBody: () => string;
} {
  let body = "";
  class TestServerResponse extends ServerResponse {
    override setHeader() {
      return this;
    }

    override end(): this;
    override end(cb: () => void): this;
    override end(chunk: string | Buffer | Uint8Array, cb?: () => void): this;
    override end(
      chunk: string | Buffer | Uint8Array,
      encoding: BufferEncoding,
      cb?: () => void,
    ): this;
    override end(
      chunkOrCb?: string | Buffer | Uint8Array | (() => void),
      encodingOrCb?: BufferEncoding | (() => void),
      cb?: () => void,
    ): this {
      const chunk = typeof chunkOrCb === "function" ? undefined : chunkOrCb;
      const callback =
        typeof chunkOrCb === "function"
          ? chunkOrCb
          : typeof encodingOrCb === "function"
            ? encodingOrCb
            : cb;
      body = chunk ? String(chunk) : "";
      callback?.();
      return this;
    }
  }

  const res = new TestServerResponse(createRequest(""));
  return {
    res,
    getBody: () => body,
  };
}

const accountFixture: ResolvedMattermostAccount = {
  accountId: "default",
  enabled: true,
  botToken: "bot-token",
  baseUrl: "https://chat.example.com",
  botTokenSource: "config",
  baseUrlSource: "config",
  streamingMode: "partial",
  config: {},
};

describe("slash-http cfg threading", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockState.runtimeConfig = {} as OpenClawConfig;
    mockState.readRequestBodyWithLimit.mockClear();
    mockState.isRequestBodyLimitError.mockClear();
    mockState.sendHttpRequestRejection.mockClear();
    mockState.parseSlashCommandPayload.mockClear();
    mockState.resolveCommandText.mockClear();
    mockState.buildModelsProviderData.mockClear();
    mockState.resolveMattermostModelPickerEntry.mockClear();
    mockState.resolveMattermostModelPickerCurrentModel.mockClear();
    mockState.renderMattermostModelSummaryView.mockClear();
    mockState.authorizeMattermostCommandInvocation.mockClear();
    mockState.createMattermostClient.mockClear();
    mockState.fetchMattermostChannel.mockClear();
    mockState.sendMessageMattermost.mockClear();
    mockState.normalizeMattermostAllowList.mockClear();
    mockState.getMattermostCommand.mockClear();
    mockState.listMattermostCommands.mockClear();
    mockState.dispatchInbound.mockClear();
    ({ createSlashCommandHttpHandler } = await import("./slash-http.js"));
  });

  it("uses the current runtime config after the monitor config is superseded", async () => {
    const startupCfg = {
      channels: {
        mattermost: {
          botToken: "startup-secret-ref",
        },
      },
    } as OpenClawConfig;
    const runtimeCfg = {
      channels: {
        mattermost: {
          botToken: "runtime-secret-ref",
        },
      },
    } as OpenClawConfig;
    mockState.runtimeConfig = runtimeCfg;
    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: startupCfg,
      runtime: {} as RuntimeEnv,
      registeredCommands: [
        {
          id: "cmd-1",
          teamId: "team-1",
          trigger: "oc_models",
          token: "valid-token",
          url: callbackUrlFixture,
          managed: false,
        },
      ],
    });
    const response = createResponse();

    await handler(createRequest(), response.res);

    expect(response.res.statusCode).toBe(200);
    expect(response.getBody()).toContain("Processing");
    expect(mockState.authorizeMattermostCommandInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: runtimeCfg }),
    );
    expect(mockState.buildModelsProviderData).toHaveBeenCalledWith(runtimeCfg, "agent-1");
    expect(mockState.sendMessageMattermost).toHaveBeenCalledWith(
      "channel:chan-1",
      "No models available.",
      expect.objectContaining({
        cfg: runtimeCfg,
        accountId: "default",
      }),
    );
    expect(mockState.readRequestBodyWithLimit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ destroyOnLimit: false }),
    );
  });

  it("uses the shared rejection lifecycle for an oversized slash request", async () => {
    const error = Object.assign(new Error("too large"), { code: "PAYLOAD_TOO_LARGE" });
    mockState.readRequestBodyWithLimit.mockRejectedValueOnce(error);
    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      registeredCommands: [],
    });
    const req = createRequest();
    const response = createResponse();

    await handler(req, response.res);

    expect(mockState.sendHttpRequestRejection).toHaveBeenCalledWith(
      req,
      response.res,
      413,
      "Payload Too Large",
    );
  });

  it("reads the thread session when rendering a bare /model picker", async () => {
    mockState.parseSlashCommandPayload.mockReturnValueOnce({
      token: "valid-token",
      command: "/oc_models",
      text: "model",
      channel_id: "chan-1",
      user_id: "user-1",
      user_name: "alice",
      team_id: "team-1",
      root_id: "root-1",
    });
    mockState.buildModelsProviderData.mockResolvedValueOnce({
      byProvider: new Map([["openai", new Set(["gpt-5.6-sol"])]]),
      providers: ["openai"],
      resolvedDefault: { provider: "openai", model: "gpt-5.6-sol" },
      modelNames: new Map(),
    });
    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      registeredCommands: [
        {
          id: "cmd-1",
          teamId: "team-1",
          trigger: "oc_models",
          token: "valid-token",
          url: callbackUrlFixture,
          managed: false,
        },
      ],
    });

    await handler(createRequest(), createResponse().res);

    expect(mockState.resolveMattermostModelPickerCurrentModel).toHaveBeenCalledWith(
      expect.objectContaining({
        route: {
          agentId: "agent-1",
          sessionKey: "mattermost:session:1:thread:root-1",
        },
      }),
    );
  });

  it("keeps authoritative route and team scope on direct slash conversations", async () => {
    mockState.resolveMattermostModelPickerEntry.mockReturnValueOnce(null);
    mockState.parseSlashCommandPayload.mockReturnValueOnce({
      token: "valid-token",
      command: "/oc_status",
      text: "status",
      channel_id: "dm-1",
      user_id: "user-1",
      user_name: "alice",
      team_id: "team-1",
    });
    mockState.getMattermostCommand.mockResolvedValueOnce({
      id: "cmd-status",
      token: "valid-token",
      team_id: "team-1",
      trigger: "oc_status",
      method: "P",
      url: callbackUrlFixture,
      delete_at: 0,
    });
    mockState.authorizeMattermostCommandInvocation.mockReturnValueOnce({
      ok: true,
      commandAuthorized: true,
      channelInfo: { id: "dm-1", type: "D", name: "alice", display_name: "Alice" },
      kind: "direct",
      chatType: "direct",
      channelName: "alice",
      channelDisplay: "Alice",
      roomLabel: "Alice",
    });
    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      registeredCommands: [
        {
          id: "cmd-status",
          teamId: "team-1",
          trigger: "oc_status",
          token: "valid-token",
          url: callbackUrlFixture,
          managed: false,
        },
      ],
    });

    await handler(createRequest(), createResponse().res);

    expect(mockState.dispatchInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        ctxPayload: expect.objectContaining({
          ChatType: "direct",
          ConversationRouteContextObserved: true,
          ConversationRoutePeerId: "user-1",
          GroupSpace: "team-1",
          InboundAccessAuthorized: true,
        }),
      }),
    );
  });

  it("rejects a cached token that Mattermost has rotated", async () => {
    mockState.parseSlashCommandPayload.mockReturnValueOnce({
      token: "old-token",
      command: "/oc_models",
      text: "models",
      channel_id: "chan-1",
      user_id: "user-1",
      user_name: "alice",
      team_id: "team-1",
    });
    mockState.getMattermostCommand.mockResolvedValueOnce({
      id: "cmd-1",
      token: "new-token",
      team_id: "team-1",
      trigger: "oc_models",
      method: "P",
      url: callbackUrlFixture,
      delete_at: 0,
    });

    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      registeredCommands: [
        {
          id: "cmd-1",
          teamId: "team-1",
          trigger: "oc_models",
          token: "old-token",
          url: callbackUrlFixture,
          managed: false,
        },
      ],
    });
    const response = createResponse();

    await handler(createRequest("token=old-token"), response.res);

    expect(response.res.statusCode).toBe(401);
    expect(response.getBody()).toContain("Unauthorized: invalid command token.");
    expect(mockState.getMattermostCommand).toHaveBeenCalledTimes(1);
    expect(mockState.fetchMattermostChannel).not.toHaveBeenCalled();
    expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
  });

  it("rejects an unknown token after Mattermost confirms the mismatch", async () => {
    mockState.parseSlashCommandPayload.mockReturnValueOnce({
      token: "unknown-token",
      command: "/oc_models",
      text: "models",
      channel_id: "chan-1",
      user_id: "user-1",
      user_name: "alice",
      team_id: "team-1",
    });
    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      registeredCommands: [
        {
          id: "cmd-1",
          teamId: "team-1",
          trigger: "oc_models",
          token: "valid-token",
          url: callbackUrlFixture,
          managed: false,
        },
      ],
    });
    const response = createResponse();

    await handler(createRequest("token=unknown-token"), response.res);

    expect(response.res.statusCode).toBe(401);
    expect(mockState.getMattermostCommand).toHaveBeenCalledTimes(1);
    expect(mockState.fetchMattermostChannel).not.toHaveBeenCalled();
    expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
  });

  it("accepts a refreshed callback token after Mattermost confirms the rotation", async () => {
    mockState.parseSlashCommandPayload.mockReturnValueOnce({
      token: "new-token",
      command: "/oc_models",
      text: "models",
      channel_id: "chan-1",
      user_id: "user-1",
      user_name: "alice",
      team_id: "team-1",
    });
    mockState.getMattermostCommand.mockResolvedValueOnce({
      id: "cmd-1",
      token: "new-token",
      team_id: "team-1",
      trigger: "oc_models",
      method: "P",
      url: callbackUrlFixture,
      delete_at: 0,
    });

    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      registeredCommands: [
        {
          id: "cmd-1",
          teamId: "team-1",
          trigger: "oc_models",
          token: "old-token",
          url: callbackUrlFixture,
          managed: false,
        },
      ],
    });
    const response = createResponse();

    await handler(createRequest("token=new-token"), response.res);

    expect(response.res.statusCode).toBe(200);
    expect(response.getBody()).toContain("Processing");
    expect(mockState.getMattermostCommand).toHaveBeenCalledTimes(1);
    expect(mockState.fetchMattermostChannel).toHaveBeenCalled();
    expect(mockState.sendMessageMattermost).toHaveBeenCalled();
  });
});
