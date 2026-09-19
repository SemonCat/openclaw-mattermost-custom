import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  createHandler: vi.fn(),
  createProcessor: vi.fn(),
  registerRoute: vi.fn(() => () => {}),
  resolveOption: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/question-gateway-runtime", () => ({
  questionGatewayRuntime: { resolveOption: mocks.resolveOption },
}));
vi.mock("./monitor-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor-auth.js")>()),
  authorizeMattermostCommandInvocation: mocks.authorize,
}));
vi.mock("./interactions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./interactions.js")>()),
  createMattermostInteractionHandler: mocks.createHandler,
  createMattermostInteractionProcessor: mocks.createProcessor,
}));
vi.mock("./interaction-ingress.js", () => ({
  createMattermostInteractionIngressMonitor: () => ({
    admit: vi.fn(),
    stop: vi.fn(async () => {}),
  }),
}));
vi.mock("./runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-api.js")>()),
  registerPluginHttpRoute: mocks.registerRoute,
}));

import { registerMattermostInteractions } from "./monitor-interactions.js";

const QUESTION_ID = "ask_0123456789abcdef0123456789abcdef";
const cfg = {};
const resolveChannelInfo = vi.fn(async () => ({ id: "chan-1", type: "O" }));

type CapturedOptions = {
  handleInteraction?: (interaction: never) => Promise<{
    update?: { message: string; props?: Record<string, unknown> };
    ephemeral_text?: string;
  } | null>;
  authorizeButtonClick?: (interaction: never) => Promise<{
    ok: boolean;
    response?: { update?: unknown; ephemeral_text?: string };
  }>;
};

function captureOptions(handleModelPickerInteraction = vi.fn(async () => null)): CapturedOptions {
  registerMattermostInteractions({
    monitor: {
      account: { accountId: "main", config: {} },
      cfg,
      client: {},
      core: {
        config: { current: () => cfg },
        channel: { commands: { shouldHandleTextCommands: () => true } },
      },
      pairing: { readAllowFromStore: async () => [] },
      resources: { resolveChannelInfo },
      runtime: { error: vi.fn(), log: vi.fn() },
      botUserId: "bot",
    },
    interactionPath: "/mattermost/interactions/main",
    interactionCallbackUrl: "https://gateway.example/mattermost/interactions/main",
    allowedSourceIps: ["127.0.0.1"],
    handleModelPickerInteraction,
  } as never);
  const options = mocks.createHandler.mock.calls[0]?.[0] as CapturedOptions | undefined;
  if (!options) {
    throw new Error("registration did not create interaction options");
  }
  return options;
}

function questionInteraction(context: Record<string, unknown>) {
  return {
    payload: {
      channel_id: "chan-1",
      post_id: "post-1",
      user_id: "user-1",
      user_name: "ada",
    },
    userName: "ada",
    actionId: "question-1",
    actionName: "production",
    originalMessage: "Which environment?",
    context,
    post: { id: "post-1", message: "Which environment?" },
  } as never;
}

const questionContext = {
  oc_question: true,
  question_id: QUESTION_ID,
  option_index: 1,
};

describe("Mattermost question interactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createHandler.mockImplementation(() => async () => {});
    mocks.createProcessor.mockImplementation(() => vi.fn());
    mocks.resolveOption.mockResolvedValue({ status: "answered" });
    mocks.authorize.mockResolvedValue({ ok: true, roomLabel: "#town-square" });
  });

  it("submits the offered option and retires the prompt", async () => {
    const handler = captureOptions().handleInteraction;
    expect(handler).toBeTypeOf("function");

    const response = await handler!(questionInteraction(questionContext));

    expect(mocks.resolveOption).toHaveBeenCalledWith(
      expect.objectContaining({
        questionId: QUESTION_ID,
        optionIndex: 1,
        senderId: "user-1",
      }),
    );
    expect(response).toEqual({
      update: {
        message: "Which environment?",
        props: { attachments: [{ text: "✓ **production** selected by @ada" }] },
      },
      ephemeral_text: "Answer submitted.",
    });
  });

  it("rechecks current authorization inside the Gateway resolution", async () => {
    const handler = captureOptions().handleInteraction!;
    await handler(questionInteraction(questionContext));

    const authorize = mocks.resolveOption.mock.calls[0]?.[0]?.authorize;
    expect(authorize).toBeTypeOf("function");
    await authorize();
    expect(mocks.authorize).toHaveBeenCalledTimes(2);
  });

  it("keeps the prompt when policy denies or the question is terminal", async () => {
    mocks.authorize.mockResolvedValueOnce({ ok: false, roomLabel: "#town-square" });
    const denied = await captureOptions().handleInteraction!(questionInteraction(questionContext));
    expect(denied).toEqual({ ephemeral_text: "OpenClaw ignored this action for #town-square." });
    expect(mocks.resolveOption).not.toHaveBeenCalled();

    mocks.authorize.mockResolvedValue({ ok: true, roomLabel: "#town-square" });
    mocks.resolveOption.mockResolvedValue({ status: "already-terminal" });
    const terminal = await captureOptions().handleInteraction!(questionInteraction(questionContext));
    expect(terminal).toEqual({ ephemeral_text: "This question was already answered." });
  });

  it("does not mutate the post when transport authorization refuses a click", async () => {
    mocks.authorize.mockResolvedValue({ ok: false, roomLabel: "#town-square" });
    const authorize = captureOptions().authorizeButtonClick!;

    const response = await authorize({
      payload: { channel_id: "chan-1", user_id: "mallory", user_name: "mallory" },
      post: { id: "post-1", message: "Which environment?", props: { attachments: [] } },
    } as never);

    expect(response).toEqual({
      ok: false,
      response: { ephemeral_text: "OpenClaw ignored this action for #town-square." },
    });
  });

  it("delegates unrelated clicks to the model picker", async () => {
    const picker = vi.fn(async () => ({ ephemeral_text: "picker" }));
    const response = await captureOptions(picker).handleInteraction!(
      questionInteraction({ callback_data: "models" }),
    );

    expect(mocks.resolveOption).not.toHaveBeenCalled();
    expect(picker).toHaveBeenCalledOnce();
    expect(response).toEqual({ ephemeral_text: "picker" });
  });
});
