import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import {
  buildMattermostSecretPromptButton,
  createMattermostSecretDialogController,
} from "./secret-dialog.js";
import { setInteractionSecret } from "./interactions.js";

const QUESTION_ID = "ask_0123456789abcdef0123456789abcdef";
const USER_ID = "abcdefghijklmnopqrstuvwxyz";
const CHANNEL_ID = "channel-1";

function createClient(request = vi.fn(async () => ({}))): MattermostClient {
  return {
    baseUrl: "https://chat.example.com",
    apiBaseUrl: "https://chat.example.com/api/v4",
    token: "bot-token",
    request,
    fetchImpl: vi.fn<typeof fetch>(),
  };
}

const SECRET_PROMPT = `🔑 Agent requests credential LANGFUSE_SECRET_KEY (secret). Reply is disabled for secrets — open to provide it: https://openclaw.example/ask/${QUESTION_ID}`;

describe("Mattermost secret prompt button", () => {
  it("adds a signed-provider action only for the canonical secret prompt", () => {
    const result = buildMattermostSecretPromptButton({
      text: SECRET_PROMPT,
      channelData: { askUser: { questionId: QUESTION_ID } },
    });

    expect(result).toEqual({
      questionId: QUESTION_ID,
      button: {
        id: "ocsecretinput",
        text: "Enter credential",
        style: "primary",
        context: {
          __openclaw_secret_dialog_version: 1,
          question_id: QUESTION_ID,
        },
      },
    });
    expect(
      buildMattermostSecretPromptButton({
        text: "Question for you: pick a deployment",
        channelData: { askUser: { questionId: QUESTION_ID } },
      }),
    ).toBeNull();
  });
});

describe("Mattermost secret dialog controller", () => {
  it("opens a password dialog from the canonical secret prompt", async () => {
    setInteractionSecret("acct", "bot-token");
    const request = vi.fn(async () => ({}));
    const resolveSecretQuestion = vi.fn();
    const controller = createMattermostSecretDialogController({
      accountId: "acct",
      callbackUrl: "https://gateway.example/mattermost/interactions/acct",
      client: createClient(request),
      cfg: () => ({}),
      resolveSecretQuestion,
      isAuthorizedUser: (userId) => userId === USER_ID,
    });

    const response = await controller.handleInteraction({
      payload: {
        type: "",
        user_id: USER_ID,
        channel_id: CHANNEL_ID,
        post_id: "post-1",
        trigger_id: "trigger-1",
      },
      userName: "edison",
      actionId: "ocsecretinput",
      actionName: "Enter credential",
      originalMessage: SECRET_PROMPT,
      context: {
        __openclaw_secret_dialog_version: 1,
        question_id: QUESTION_ID,
      },
      post: { id: "post-1", channel_id: CHANNEL_ID },
    });

    expect(response).toEqual({});
    expect(resolveSecretQuestion).not.toHaveBeenCalled();
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body)) as {
      url: string;
      dialog: {
        introduction_text: string;
        state: string;
        elements: Array<Record<string, unknown>>;
      };
    };
    expect(request).toHaveBeenCalledWith(
      "/actions/dialogs/open",
      expect.objectContaining({ method: "POST" }),
    );
    expect(body.url).toBe("https://gateway.example/mattermost/interactions/acct");
    expect(body.dialog.introduction_text).toContain("LANGFUSE\\_SECRET\\_KEY");
    expect(body.dialog.elements).toContainEqual(
      expect.objectContaining({
        name: "secret_value",
        type: "text",
        subtype: "password",
        optional: false,
      }),
    );
    expect(body.dialog.state).not.toContain("LANGFUSE_SECRET_KEY");
  });

  it("submits the secret directly to canonical question.resolve without echoing it", async () => {
    setInteractionSecret("acct", "bot-token");
    const resolveSecretQuestion = vi.fn(async () => ({
      status: "answered" as const,
      questionId: "secret_value",
    }));
    const request = vi.fn(async () => ({}));
    const cfg = {};
    const controller = createMattermostSecretDialogController({
      accountId: "acct",
      callbackUrl: "https://gateway.example/mattermost/interactions/acct",
      client: createClient(request),
      cfg: () => cfg,
      resolveSecretQuestion,
      isAuthorizedUser: (userId) => userId === USER_ID,
    });
    await controller.handleInteraction({
      payload: {
        user_id: USER_ID,
        channel_id: CHANNEL_ID,
        post_id: "post-1",
        trigger_id: "trigger-1",
      },
      userName: "edison",
      actionId: "ocsecretinput",
      actionName: "Enter credential",
      originalMessage: SECRET_PROMPT,
      context: {
        __openclaw_secret_dialog_version: 1,
        question_id: QUESTION_ID,
      },
      post: { id: "post-1", channel_id: CHANNEL_ID },
    });
    const openBody = JSON.parse(String(request.mock.calls[0]?.[1]?.body)) as {
      dialog: { state: string; callback_id: string };
    };
    const secret = "test-secret-value-that-must-not-be-echoed";

    const result = await controller.handleSubmission({
      type: "dialog_submission",
      callback_id: openBody.dialog.callback_id,
      state: openBody.dialog.state,
      user_id: USER_ID,
      channel_id: CHANNEL_ID,
      submission: { secret_value: secret },
      cancelled: false,
    });

    expect(result).toEqual({ statusCode: 200, body: {} });
    expect(resolveSecretQuestion).toHaveBeenCalledWith({
      cfg,
      questionId: QUESTION_ID,
      secretValue: secret,
      senderId: `mattermost:${USER_ID}`,
      clientDisplayName: `Mattermost credential (${USER_ID})`,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("rejects a submission whose signed user binding does not match", async () => {
    setInteractionSecret("acct", "bot-token");
    const resolveSecretQuestion = vi.fn();
    const request = vi.fn(async () => ({}));
    const controller = createMattermostSecretDialogController({
      accountId: "acct",
      callbackUrl: "https://gateway.example/mattermost/interactions/acct",
      client: createClient(request),
      cfg: () => ({}),
      resolveSecretQuestion,
      isAuthorizedUser: () => true,
    });
    await controller.handleInteraction({
      payload: {
        user_id: USER_ID,
        channel_id: CHANNEL_ID,
        post_id: "post-1",
        trigger_id: "trigger-1",
      },
      userName: "edison",
      actionId: "ocsecretinput",
      actionName: "Enter credential",
      originalMessage: SECRET_PROMPT,
      context: {
        __openclaw_secret_dialog_version: 1,
        question_id: QUESTION_ID,
      },
      post: { id: "post-1", channel_id: CHANNEL_ID },
    });
    const openBody = JSON.parse(String(request.mock.calls[0]?.[1]?.body)) as {
      dialog: { state: string; callback_id: string };
    };
    resolveSecretQuestion.mockClear();

    const result = await controller.handleSubmission({
      type: "dialog_submission",
      callback_id: openBody.dialog.callback_id,
      state: openBody.dialog.state,
      user_id: "different-user",
      channel_id: CHANNEL_ID,
      submission: { secret_value: "never-forward" },
      cancelled: false,
    });

    expect(result.statusCode).toBe(403);
    expect(resolveSecretQuestion).not.toHaveBeenCalled();
  });

  it("keeps resolver failures generic and leaves the dialog open for retry", async () => {
    setInteractionSecret("acct", "bot-token");
    const resolveSecretQuestion = vi.fn(async () => {
      throw new Error("request failed");
    });
    const request = vi.fn(async () => ({}));
    const log = vi.fn();
    const controller = createMattermostSecretDialogController({
      accountId: "acct",
      callbackUrl: "https://gateway.example/mattermost/interactions/acct",
      client: createClient(request),
      cfg: () => ({}),
      resolveSecretQuestion,
      isAuthorizedUser: () => true,
      log,
    });
    await controller.handleInteraction({
      payload: {
        user_id: USER_ID,
        channel_id: CHANNEL_ID,
        post_id: "post-1",
        trigger_id: "trigger-1",
      },
      userName: "edison",
      actionId: "ocsecretinput",
      actionName: "Enter credential",
      originalMessage: SECRET_PROMPT,
      context: {
        __openclaw_secret_dialog_version: 1,
        question_id: QUESTION_ID,
      },
      post: { id: "post-1", channel_id: CHANNEL_ID },
    });
    const openBody = JSON.parse(String(request.mock.calls[0]?.[1]?.body)) as {
      dialog: { state: string; callback_id: string };
    };
    const secret = "not-in-response-or-log";

    const result = await controller.handleSubmission({
      type: "dialog_submission",
      callback_id: openBody.dialog.callback_id,
      state: openBody.dialog.state,
      user_id: USER_ID,
      channel_id: CHANNEL_ID,
      submission: { secret_value: secret },
      cancelled: false,
    });

    expect(result.statusCode).toBe(200);
    expect(result.body).toHaveProperty("errors.secret_value");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(log).toHaveBeenCalledWith("mattermost secret dialog: question resolution failed");
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });
});
