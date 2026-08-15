// Mattermost tests cover the slash-http session-admission race/retry/fallback seam.
//
// Regression coverage for the "/model collides with session lifecycle recovery/config
// reload" incident: dispatch's admission check can reject with the core session-admission
// race message when a concurrent config hot reload changes the session record mid-flight.
// These tests prove: (1) a single safe retry re-resolves cfg/route/session state instead of
// replaying a stale snapshot, and never duplicates a successful dispatch; (2) when the race
// persists after that one retry, the user gets an actionable message (not the generic
// "Sorry..." text) with root_id preserved; (3) unrelated errors still fall back to the
// generic message via the HTTP handler's outer catch, now also with root_id preserved; and
// (4) the non-thread and immediate-success paths are unaffected.
import { ServerResponse, type IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedMattermostAccount } from "./accounts.js";

type DispatchCallRecord = {
  cfg: OpenClawConfig;
  ctxPayload: { SessionKey: string; ReplyToId?: string; MessageSid?: string };
  route: { agentId: string; sessionKey: string };
  delivery: {
    deliver: (payload: unknown) => Promise<unknown>;
  };
};

const mockState = vi.hoisted(() => ({
  configVersion: 0,
  dispatchFailCount: 0,
  deliverThenFailWithRace: false,
  dispatchCalls: [] as DispatchCallRecord[],
  parsedPayload: {
    token: "valid-token",
    command: "/oc_test",
    text: "do-a-thing",
    channel_id: "chan-1",
    user_id: "user-1",
    user_name: "alice",
    team_id: "team-1",
  } as Record<string, unknown>,
  authDecision: {
    ok: true,
    commandAuthorized: true,
    channelInfo: { id: "chan-1", type: "O", name: "town-square", display_name: "Town Square" },
    kind: "channel" as "channel" | "direct" | "group",
    chatType: "channel" as "channel" | "direct" | "group",
    channelName: "town-square",
    channelDisplay: "Town Square",
    roomLabel: "#town-square",
  },
  sendMessageMattermost: vi.fn(async () => ({ messageId: "post-1", channelId: "chan-1" })),
  deliverMattermostReplyPayload: vi.fn(async () => ({ visibleReplySent: true })),
  pinExplicitDefaultModel: vi.fn(async () => ({ pinned: false })),
  rewritePinnedModelReply: vi.fn((_text: string, modelRef: string) =>
    `Model set to ${modelRef} for this session.`,
  ),
}));

function resolveAgentRouteMock(params: { cfg: OpenClawConfig }) {
  const version = (params.cfg as { version?: number }).version ?? 0;
  return {
    agentId: "agent-1",
    dmScope: undefined,
    sessionKey: `mattermost:session:v${version}`,
    accountId: "default",
  };
}

vi.mock("../runtime.js", () => ({
  getMattermostRuntime: () => ({
    config: {
      current: () => ({ version: mockState.configVersion }) as OpenClawConfig,
    },
    channel: {
      commands: {
        shouldHandleTextCommands: () => true,
      },
      text: {
        hasControlCommand: () => false,
        resolveTextChunkLimit: () => 4000,
        resolveMarkdownTableMode: () => "collapse",
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
      },
      routing: {
        resolveAgentRoute: vi.fn(resolveAgentRouteMock),
      },
      inbound: {
        dispatch: vi.fn(async (params: DispatchCallRecord) => {
          mockState.dispatchCalls.push(params);
          const attemptNumber = mockState.dispatchCalls.length;
          if (mockState.deliverThenFailWithRace) {
            // A delivery attempt already reached the user, then dispatch overall still
            // rejected with the race pattern (e.g. a later followup-admission failure).
            // hasStartedWork must gate the retry off here regardless of the error shape.
            await params.delivery.deliver({ text: "partial" });
            throw new Error(
              `Session "${params.ctxPayload.SessionKey}" changed while starting work. Retry.`,
            );
          }
          if (attemptNumber <= mockState.dispatchFailCount) {
            // Simulate a concurrent config hot reload landing between attempts, exactly
            // like the incident: the session record a retry would target has moved on.
            mockState.configVersion += 1;
            throw new Error(
              `Session "${params.ctxPayload.SessionKey}" changed while starting work. Retry.`,
            );
          }
          await params.delivery.deliver({ text: "ok" });
          return { ok: true };
        }),
      },
    },
  }),
}));

vi.mock("./runtime-api.js", () => ({
  buildModelsProviderData: vi.fn(async () => ({ providers: [], modelNames: new Map() })),
  isRequestBodyLimitError: vi.fn(() => false),
  logTypingFailure: vi.fn(),
  readRequestBodyWithLimit: vi.fn(async () => "token=valid-token"),
}));

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    createMattermostClient: vi.fn(() => ({})),
    fetchMattermostChannel: vi.fn(async () => ({
      id: "chan-1",
      type: "O",
      name: "town-square",
      display_name: "Town Square",
    })),
    sendMattermostTyping: vi.fn(async () => undefined),
  };
});

vi.mock("./model-picker.js", () => ({
  renderMattermostModelSummaryView: vi.fn(),
  renderMattermostModelsPickerView: vi.fn(),
  renderMattermostProviderPickerView: vi.fn(),
  resolveMattermostModelPickerCurrentModel: vi.fn(),
  // Bypass the model-picker fast path so every command exercises dispatch/retry.
  resolveMattermostModelPickerEntry: vi.fn(() => null),
}));

vi.mock("./model-session-pin.js", () => ({
  pinMattermostExplicitDefaultModelSelection: mockState.pinExplicitDefaultModel,
  rewriteMattermostPinnedModelReply: mockState.rewritePinnedModelReply,
}));

vi.mock("./monitor-auth.js", () => ({
  authorizeMattermostCommandInvocation: vi.fn(async () => mockState.authDecision),
  normalizeMattermostAllowList: vi.fn((value: unknown) => value),
}));

vi.mock("./reply-delivery.js", () => ({
  createMattermostReplyDeliveryBarrier: vi.fn(() => ({
    trackDmChannelResolution: vi.fn(),
    resolveTimeoutPolicy: vi.fn(),
    markDeliverySettled: vi.fn(),
  })),
  deliverMattermostReplyPayload: mockState.deliverMattermostReplyPayload,
}));

vi.mock("./send.js", () => ({
  sendMessageMattermost: mockState.sendMessageMattermost,
}));

vi.mock("./slash-commands.js", () => ({
  MATTERMOST_SLASH_POST_METHOD: "P",
  getMattermostCommand: vi.fn(async () => ({
    id: "cmd-1",
    token: "valid-token",
    team_id: "team-1",
    trigger: "oc_test",
    method: "P",
    url: "https://gateway.example.com/slash",
    delete_at: 0,
  })),
  listMattermostCommands: vi.fn(async () => []),
  normalizeSlashCommandTrigger: (command: string) => command.replace(/^\//, "").trim(),
  parseSlashCommandPayload: vi.fn(() => mockState.parsedPayload),
  resolveCommandText: vi.fn((_trigger: string, text: string) => text),
}));

import { createSlashCommandHttpHandler } from "./slash-http.js";

const callbackUrlFixture = "https://gateway.example.com/slash";

function createRequest(body = "token=valid-token"): IncomingMessage {
  const req = new PassThrough();
  const incoming = req as PassThrough & IncomingMessage;
  incoming.method = "POST";
  incoming.url = "/slash";
  incoming.headers = { "content-type": "application/x-www-form-urlencoded" };
  process.nextTick(() => {
    req.end(body);
  });
  return incoming;
}

function createResponse(): { res: ServerResponse; getBody: () => string } {
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
  return { res, getBody: () => body };
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

const registeredCommandFixture = {
  id: "cmd-1",
  teamId: "team-1",
  trigger: "oc_test",
  token: "valid-token",
  url: callbackUrlFixture,
  managed: false,
};

async function runHandler(payloadOverrides: Record<string, unknown> = {}) {
  mockState.parsedPayload = {
    token: "valid-token",
    command: "/oc_test",
    text: "do-a-thing",
    channel_id: "chan-1",
    user_id: "user-1",
    user_name: "alice",
    team_id: "team-1",
    ...payloadOverrides,
  };
  const handler = createSlashCommandHttpHandler({
    account: accountFixture,
    cfg: {} as OpenClawConfig,
    runtime: {} as RuntimeEnv,
    registeredCommands: [registeredCommandFixture],
  });
  const response = createResponse();
  const promise = handler(createRequest(), response.res);
  // Flush the retry helper's 300ms delay (slash-http.ts does not override retryDelayMs).
  await vi.advanceTimersByTimeAsync(1000);
  await promise;
  return response;
}

describe("slash-http session-admission race retry and fallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockState.configVersion = 0;
    mockState.dispatchFailCount = 0;
    mockState.deliverThenFailWithRace = false;
    mockState.dispatchCalls = [];
    mockState.authDecision = {
      ok: true,
      commandAuthorized: true,
      channelInfo: { id: "chan-1", type: "O", name: "town-square", display_name: "Town Square" },
      kind: "channel",
      chatType: "channel",
      channelName: "town-square",
      channelDisplay: "Town Square",
      roomLabel: "#town-square",
    };
    mockState.sendMessageMattermost.mockClear();
    mockState.deliverMattermostReplyPayload.mockClear();
    mockState.deliverMattermostReplyPayload.mockResolvedValue({ visibleReplySent: true });
    mockState.pinExplicitDefaultModel.mockClear();
    mockState.pinExplicitDefaultModel.mockResolvedValue({ pinned: false });
    mockState.rewritePinnedModelReply.mockClear();
  });

  it("retries exactly once on the session-admission race, re-resolving session state, with no duplicate delivery", async () => {
    mockState.dispatchFailCount = 1;

    await runHandler({ root_id: undefined });

    expect(mockState.dispatchCalls).toHaveLength(2);
    // The retry must not replay the first attempt's session snapshot: config "changed"
    // (simulated by the dispatch mock) between attempts, so the second call's session key
    // reflects freshly re-resolved routing, not the stale first-attempt closure.
    expect(mockState.dispatchCalls[0]?.ctxPayload.SessionKey).toBe("mattermost:session:v0");
    expect(mockState.dispatchCalls[1]?.ctxPayload.SessionKey).toBe("mattermost:session:v1");
    // Both attempts are still the same logical invocation.
    expect(mockState.dispatchCalls[0]?.ctxPayload.MessageSid).toBe(
      mockState.dispatchCalls[1]?.ctxPayload.MessageSid,
    );
    // Delivery only happens once, on the successful retry — never on the failed first attempt.
    expect(mockState.deliverMattermostReplyPayload).toHaveBeenCalledTimes(1);
    // No error fallback of any kind was sent; the retry recovered silently.
    expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
  });

  it("keeps a single dispatch call on the ordinary immediate-success path", async () => {
    mockState.dispatchFailCount = 0;

    await runHandler();

    expect(mockState.dispatchCalls).toHaveLength(1);
    expect(mockState.deliverMattermostReplyPayload).toHaveBeenCalledTimes(1);
    expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
  });

  it("pins an explicitly named global default to the resolved thread session", async () => {
    mockState.pinExplicitDefaultModel.mockResolvedValueOnce({
      pinned: true,
      modelRef: "openai/gpt-5.6-sol",
    });

    await runHandler({
      root_id: "root-model",
      text: "/model openai/gpt-5.6-sol",
    });

    const dispatch = mockState.dispatchCalls[0];
    expect(dispatch).toBeDefined();
    expect(mockState.pinExplicitDefaultModel).toHaveBeenCalledWith(
      expect.objectContaining({
        commandText: "/model openai/gpt-5.6-sol",
        sessionKey: dispatch?.ctxPayload.SessionKey,
      }),
    );
    expect(mockState.deliverMattermostReplyPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          text: "Model set to openai/gpt-5.6-sol for this session.",
        }),
        replyToId: "root-model",
      }),
    );
  });

  it("does not retry, and does not duplicate dispatch, once delivery has started — even on a matching race error", async () => {
    mockState.deliverThenFailWithRace = true;

    await runHandler({ root_id: "root-post-3" });

    // hasStartedWork gates the retry off regardless of the error shape: exactly one
    // dispatch call, no second attempt.
    expect(mockState.dispatchCalls).toHaveLength(1);
    expect(mockState.deliverMattermostReplyPayload).toHaveBeenCalledTimes(1);
    // The actionable-message path is skipped (it only applies while hasStartedWork is
    // false); the error falls through to the HTTP handler's generic fallback instead.
    expect(mockState.sendMessageMattermost).toHaveBeenCalledTimes(1);
    const [to, text, options] = mockState.sendMessageMattermost.mock.calls[0] as [
      string,
      string,
      { replyToId?: string },
    ];
    expect(to).toBe("channel:chan-1");
    expect(text).toBe("Sorry, something went wrong processing that command.");
    expect(options.replyToId).toBe("root-post-3");
  });

  it("returns an actionable, non-generic error and preserves root_id when the race persists in a thread", async () => {
    mockState.dispatchFailCount = 2; // both the first attempt and the single retry fail

    await runHandler({ root_id: "root-post-1" });

    expect(mockState.dispatchCalls).toHaveLength(2);
    expect(mockState.deliverMattermostReplyPayload).not.toHaveBeenCalled();
    expect(mockState.sendMessageMattermost).toHaveBeenCalledTimes(1);
    const [to, text, options] = mockState.sendMessageMattermost.mock.calls[0] as [
      string,
      string,
      { replyToId?: string },
    ];
    expect(to).toBe("channel:chan-1");
    expect(text).not.toContain("Sorry, something went wrong");
    expect(text.toLowerCase()).toMatch(/wait|retry|again/);
    // The visible failure must land back in the thread the command was invoked from.
    expect(options.replyToId).toBe("root-post-1");
  });

  it("omits replyToId for a non-thread channel invocation of the same actionable error", async () => {
    mockState.dispatchFailCount = 2;

    await runHandler({ root_id: undefined });

    expect(mockState.sendMessageMattermost).toHaveBeenCalledTimes(1);
    const [, , options] = mockState.sendMessageMattermost.mock.calls[0] as [
      string,
      string,
      { replyToId?: string },
    ];
    expect(options.replyToId).toBeUndefined();
  });

  it("keeps a flat DM flat: a stray root_id does not thread the actionable error", async () => {
    mockState.dispatchFailCount = 2;
    mockState.authDecision = {
      ...mockState.authDecision,
      kind: "direct",
      chatType: "direct",
    };

    await runHandler({ root_id: "root-post-1" });

    expect(mockState.sendMessageMattermost).toHaveBeenCalledTimes(1);
    const [to, , options] = mockState.sendMessageMattermost.mock.calls[0] as [
      string,
      string,
      { replyToId?: string },
    ];
    expect(to).toBe("user:user-1");
    expect(options.replyToId).toBeUndefined();
  });

  it("falls back to the generic message with root_id preserved for an unrelated dispatch error", async () => {
    mockState.dispatchFailCount = 0;
    mockState.deliverMattermostReplyPayload.mockRejectedValueOnce(new Error("boom: unrelated"));

    await runHandler({ root_id: "root-post-2" });

    expect(mockState.dispatchCalls).toHaveLength(1);
    expect(mockState.sendMessageMattermost).toHaveBeenCalledTimes(1);
    const [to, text, options] = mockState.sendMessageMattermost.mock.calls[0] as [
      string,
      string,
      { replyToId?: string },
    ];
    expect(to).toBe("channel:chan-1");
    expect(text).toBe("Sorry, something went wrong processing that command.");
    expect(options.replyToId).toBe("root-post-2");
  });
});
