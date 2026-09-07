// Mattermost plugin module presents OpenClaw secret questions as password dialogs.
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { MattermostClient, MattermostPost } from "./client.js";
import {
  generateInteractionToken,
  verifyInteractionToken,
  type MattermostDialogSubmissionPayload,
  type MattermostDialogSubmissionResponse,
  type MattermostInteractionPayload,
  type MattermostInteractionResponse,
} from "./interactions.js";
import type { OpenClawConfig } from "./runtime-api.js";

const SECRET_DIALOG_CONTEXT_VERSION_KEY = "__openclaw_secret_dialog_version";
const SECRET_DIALOG_CONTEXT_VERSION = 1;
const SECRET_DIALOG_ACTION_ID = "ocsecretinput";
const SECRET_DIALOG_CALLBACK_ID = "openclaw_secret_input_v1";
const SECRET_DIALOG_FIELD_NAME = "secret_value";
const SECRET_DIALOG_MAX_VALUE_CHARS = 16_383;
const QUESTION_ID_RE = /^ask_[a-f0-9]{32}$/u;
const SECRET_PROMPT_RE =
  /^🔑 Agent requests credential ([A-Z][A-Z0-9_]{0,127}) \(secret\)\. Reply is disabled for secrets\b/u;

type ResolveSecretQuestion = (params: {
  cfg: OpenClawConfig;
  questionId: string;
  secretValue: string;
  senderId?: string | null;
  clientDisplayName?: string;
}) => Promise<
  | { status: "answered"; questionId: string }
  | { status: "already-terminal"; reason: "already-terminal" | "not-found" }
>;

type SecretCapableQuestionRuntime = typeof questionGatewayRuntime & {
  resolveSecret?: ResolveSecretQuestion;
};

type SecretDialogState = {
  version: 1;
  questionId: string;
  userId: string;
  channelId: string;
  postId: string;
  token: string;
};

export type MattermostSecretPromptButton = {
  questionId: string;
  button: {
    id: string;
    text: string;
    style: "primary";
    context: Record<string, unknown>;
  };
};

export function buildMattermostSecretPromptButton(
  payload: Pick<ReplyPayload, "text" | "channelData">,
): MattermostSecretPromptButton | null {
  const questionId = questionGatewayRuntime.readAskUserQuestionId(payload as ReplyPayload);
  if (!questionId || !QUESTION_ID_RE.test(questionId) || !SECRET_PROMPT_RE.test(payload.text ?? "")) {
    return null;
  }
  return {
    questionId,
    button: {
      id: SECRET_DIALOG_ACTION_ID,
      text: "Enter credential",
      style: "primary",
      context: {
        [SECRET_DIALOG_CONTEXT_VERSION_KEY]: SECRET_DIALOG_CONTEXT_VERSION,
        question_id: questionId,
      },
    },
  };
}

function readSecretQuestionId(context: Record<string, unknown>): string | null {
  const questionId = context.question_id;
  return context[SECRET_DIALOG_CONTEXT_VERSION_KEY] === SECRET_DIALOG_CONTEXT_VERSION &&
    typeof questionId === "string" &&
    QUESTION_ID_RE.test(questionId)
    ? questionId
    : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function signDialogState(
  state: Omit<SecretDialogState, "token">,
  accountId: string,
): string {
  const token = generateInteractionToken(
    { action_id: SECRET_DIALOG_CALLBACK_ID, ...state },
    accountId,
  );
  return Buffer.from(JSON.stringify({ ...state, token }), "utf8").toString("base64url");
}

function readDialogState(raw: string, accountId: string): SecretDialogState | null {
  if (!raw || raw.length > 2_048) {
    return null;
  }
  try {
    const state = readRecord(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (
      state?.version !== SECRET_DIALOG_CONTEXT_VERSION ||
      typeof state.questionId !== "string" ||
      !QUESTION_ID_RE.test(state.questionId) ||
      typeof state.userId !== "string" ||
      !state.userId ||
      typeof state.channelId !== "string" ||
      !state.channelId ||
      typeof state.postId !== "string" ||
      !state.postId ||
      typeof state.token !== "string"
    ) {
      return null;
    }
    const unsigned = {
      version: SECRET_DIALOG_CONTEXT_VERSION,
      questionId: state.questionId,
      userId: state.userId,
      channelId: state.channelId,
      postId: state.postId,
    } as const;
    return verifyInteractionToken(
      { action_id: SECRET_DIALOG_CALLBACK_ID, ...unsigned },
      state.token,
      accountId,
    )
      ? { ...unsigned, token: state.token }
      : null;
  } catch {
    return null;
  }
}

function escapeDialogMarkdown(value: string): string {
  return value.replace(/[\\`*_~<>]/gu, (match) => `\\${match}`);
}

function readSecretName(message: string): string | null {
  return SECRET_PROMPT_RE.exec(message)?.[1] ?? null;
}

function buildIntroduction(name: string): string {
  return [
    `Store **${escapeDialogMarkdown(name)}** in OpenClaw's protected secret store.`,
    "The value is sent directly to OpenClaw and is never posted to Mattermost.",
    "Use the OpenClaw Web UI link in the post to review host restrictions before submitting.",
  ].join("\n\n");
}

export function createMattermostSecretDialogController(params: {
  accountId: string;
  callbackUrl: string;
  client: MattermostClient;
  cfg: () => OpenClawConfig;
  isAuthorizedUser: (userId: string) => boolean;
  resolveSecretQuestion?: ResolveSecretQuestion;
  log?: (message: string) => void;
}): {
  handleInteraction: (input: {
    payload: MattermostInteractionPayload;
    userName: string;
    actionId: string;
    actionName: string;
    originalMessage: string;
    context: Record<string, unknown>;
    post: MattermostPost;
  }) => Promise<MattermostInteractionResponse | null>;
  handleSubmission: (
    payload: MattermostDialogSubmissionPayload,
  ) => Promise<MattermostDialogSubmissionResponse>;
} {
  const resolveSecretQuestion =
    params.resolveSecretQuestion ??
    (questionGatewayRuntime as SecretCapableQuestionRuntime).resolveSecret;

  return {
    handleInteraction: async (input) => {
      const questionId = readSecretQuestionId(input.context);
      if (!questionId) {
        return null;
      }
      if (!params.isAuthorizedUser(input.payload.user_id)) {
        return { ephemeral_text: "You are not authorized to provide OpenClaw credentials." };
      }
      const triggerId = input.payload.trigger_id?.trim();
      if (!triggerId) {
        return { ephemeral_text: "This credential dialog could not be opened. Please retry." };
      }
      const name = readSecretName(input.originalMessage);
      if (!name || !resolveSecretQuestion) {
        return {
          ephemeral_text:
            "Direct credential entry is unavailable in this OpenClaw runtime. Use the Web UI link.",
        };
      }
      const state = signDialogState(
        {
          version: SECRET_DIALOG_CONTEXT_VERSION,
          questionId,
          userId: input.payload.user_id,
          channelId: input.payload.channel_id,
          postId: input.payload.post_id,
        },
        params.accountId,
      );
      await params.client.request("/actions/dialogs/open", {
        method: "POST",
        body: JSON.stringify({
          trigger_id: triggerId,
          url: params.callbackUrl,
          dialog: {
            callback_id: SECRET_DIALOG_CALLBACK_ID,
            title: "OpenClaw credential",
            introduction_text: buildIntroduction(name),
            elements: [
              {
                display_name: "Credential",
                name: SECRET_DIALOG_FIELD_NAME,
                type: "text",
                subtype: "password",
                optional: false,
                min_length: 1,
                max_length: SECRET_DIALOG_MAX_VALUE_CHARS,
              },
            ],
            submit_label: "Store",
            notify_on_cancel: false,
            state,
          },
        }),
      });
      return {};
    },

    handleSubmission: async (payload) => {
      if (payload.callback_id !== SECRET_DIALOG_CALLBACK_ID) {
        return { statusCode: 400, body: { error: "Unknown dialog" } };
      }
      const state = readDialogState(payload.state, params.accountId);
      if (
        !state ||
        state.userId !== payload.user_id ||
        state.channelId !== payload.channel_id ||
        !params.isAuthorizedUser(payload.user_id)
      ) {
        return { statusCode: 403, body: { error: "Credential submission is not authorized" } };
      }
      if (payload.cancelled === true) {
        return { statusCode: 200, body: {} };
      }
      const secret = payload.submission[SECRET_DIALOG_FIELD_NAME];
      if (typeof secret !== "string" || secret.length === 0) {
        return {
          statusCode: 200,
          body: { errors: { [SECRET_DIALOG_FIELD_NAME]: "Enter a credential." } },
        };
      }
      if (secret.length > SECRET_DIALOG_MAX_VALUE_CHARS) {
        return {
          statusCode: 200,
          body: { errors: { [SECRET_DIALOG_FIELD_NAME]: "Credential is too long." } },
        };
      }
      if (!resolveSecretQuestion) {
        return {
          statusCode: 200,
          body: {
            errors: {
              [SECRET_DIALOG_FIELD_NAME]:
                "Direct credential entry is unavailable. Use the OpenClaw Web UI.",
            },
          },
        };
      }
      try {
        await resolveSecretQuestion({
          cfg: params.cfg(),
          questionId: state.questionId,
          secretValue: secret,
          senderId: `mattermost:${payload.user_id}`,
          clientDisplayName: `Mattermost credential (${payload.user_id})`,
        });
        return { statusCode: 200, body: {} };
      } catch {
        // The exception may originate after the value crossed the RPC boundary.
        params.log?.("mattermost secret dialog: question resolution failed");
      }
      return {
        statusCode: 200,
        body: {
          errors: {
            [SECRET_DIALOG_FIELD_NAME]:
              "OpenClaw could not store this credential. Retry or use the OpenClaw Web UI.",
          },
        },
      };
    },
  };
}
