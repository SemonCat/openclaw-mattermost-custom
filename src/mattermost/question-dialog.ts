import { createHash } from "node:crypto";
import { z } from "zod";
import { parseMattermostApiStatus, type MattermostClient, type MattermostPost } from "./client.js";
import {
  formQuestions,
  isOrdinaryMattermostQuestion,
  MattermostFormSchema,
  MattermostQuestionRecordSchema,
  parseQuestionSubmission,
  renderQuestionElements,
  truncateDialogLabel,
  type MattermostForm,
  type MattermostQuestionRecord,
} from "./form-schema.js";
import {
  generateInteractionToken,
  findMattermostBlockControl,
  MATTERMOST_QUESTION_FORM_CONTROL_PROP,
  verifyInteractionToken,
  type MattermostDialogSubmissionPayload,
  type MattermostDialogSubmissionResponse,
  type MattermostInteractionPayload,
  type MattermostInteractionResponse,
} from "./interactions.js";
import type { MattermostQuestionRpc } from "./question-rpc.js";
import { MATTERMOST_V12_TEXT_LIMIT, resolveMattermostTextLimit } from "./text-limits.js";

export const MATTERMOST_QUESTION_FORM_CALLBACK = "openclaw_question_form_v1";
const ACTION = "ocquestionform";
const WEB_ACTION = "ocquestionformweb";
const questionIdSchema = z.string().regex(/^ask_[a-f0-9]{32}$/u);
const bindingSchema = z.object({
  version: z.literal(1),
  questionId: questionIdSchema,
  userId: z.string().min(1).max(128),
  channelId: z.string().min(1).max(128),
  postId: z.string().min(1).max(128),
  sessionKey: z.string().min(1).max(512),
  expiresAtMs: z.number().safe().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  layout: z.enum(["compatible", "native"]).optional(),
  token: z.string(),
}).strict();

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function buildMattermostQuestionFormButton(questionId: string, form?: MattermostForm) {
  questionIdSchema.parse(questionId);
  return {
    id: ACTION,
    text: "Fill form",
    style: "primary" as const,
    context: {
      oc_question_form: 1,
      question_id: questionId,
      ...(form ? { form: MattermostFormSchema.parse(form) } : {}),
    },
  };
}

export function buildMattermostQuestionFormButtons(questionId: string, form?: MattermostForm) {
  const primary = buildMattermostQuestionFormButton(questionId, form);
  return [primary, {
    ...primary, id: WEB_ACTION, text: "Web form", style: "default" as const,
    context: { ...primary.context, layout: "native" },
  }];
}

function readFormContext(context: Record<string, unknown>) {
  if (context.oc_question_form !== 1 || !questionIdSchema.safeParse(context.question_id).success) {
    throw new Error("Invalid form control");
  }
  return {
    questionId: context.question_id as string,
    form: context.form === undefined ? undefined : MattermostFormSchema.parse(context.form),
  };
}

function schemaDigest(question: MattermostQuestionRecord, form?: MattermostForm): string {
  return createHash("sha256").update(JSON.stringify({ questions: question.questions, form })).digest("hex");
}

/** Re-read the public signed binding; REST omits private action integrations. */
function currentControl(post: MattermostPost, accountId: string, questionId: string, action = ACTION) {
  let hasControl = Boolean(findMattermostBlockControl(post.props?.mm_blocks, action));
  const attachments = post.props?.attachments;
  if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      const actions = record(attachment)?.actions;
      if (!Array.isArray(actions)) continue;
      for (const rawAction of actions) {
        const entry = record(rawAction);
        if (entry?.id === action) hasControl = true;
      }
    }
  }
  const control = record(post.props?.[MATTERMOST_QUESTION_FORM_CONTROL_PROP]);
  if (hasControl && control?.kind === "question_form_control_v1" &&
    control.question_id === questionId && control.channel_id === post.channel_id &&
    typeof control.signature === "string") {
    const { signature, ...unsigned } = control;
    if (verifyInteractionToken(unsigned, signature, accountId)) {
      return readFormContext({ ...unsigned, oc_question_form: 1 });
    }
  }
  throw new Error("This form control is no longer available");
}

export async function readMattermostQuestion(rpc: MattermostQuestionRpc, id: string) {
  const result = await rpc("question.get", { id });
  const question = MattermostQuestionRecordSchema.parse(record(result)?.question);
  if (question.id !== id || !isOrdinaryMattermostQuestion(question)) {
    throw new Error("This question cannot be answered using an ordinary form");
  }
  return question;
}

export function createMattermostQuestionDialogController(params: {
  accountId: string;
  botUserId: string;
  callbackUrl: string;
  client: MattermostClient;
  rpc: MattermostQuestionRpc;
  /** Re-check current account, sender and channel access and return the originating route. */
  authorize: (userId: string, post: MattermostPost) => Promise<string | null>;
  log?: (message: string) => void;
}) {
  const load = async (userId: string, channelId: string, postId: string, questionId: string) => {
    const post = await params.client.request<MattermostPost>(`/posts/${encodeURIComponent(postId)}`);
    if (post.id !== postId || post.channel_id !== channelId || post.user_id !== params.botUserId ||
      post.delete_at) throw new Error("Invalid form source");
    const question = await readMattermostQuestion(params.rpc, questionId);
    const sessionKey = await params.authorize(userId, post);
    if (!sessionKey || sessionKey !== question.sessionKey) throw new Error("Form access denied");
    return { post, question, sessionKey };
  };
  const validateForm = (question: MattermostQuestionRecord, form?: MattermostForm) => {
    if (form && JSON.stringify(formQuestions(form).map(normalizeQuestion)) !==
      JSON.stringify(question.questions.map(normalizeQuestion))) {
      throw new Error("The form no longer matches the question");
    }
    renderQuestionElements(question.questions, form);
  };
  return {
    async handleInteraction(input: {
      payload: MattermostInteractionPayload;
      context: Record<string, unknown>;
    }): Promise<MattermostInteractionResponse | null> {
      if (input.context.oc_question_form !== 1) return null;
      let stage = "context";
      try {
        const { questionId } = readFormContext(input.context);
        const layout = input.context.layout === undefined ? "compatible"
          : z.enum(["compatible", "native"]).parse(input.context.layout);
        const { payload } = input;
        if (!payload.trigger_id) throw new Error("Missing dialog trigger");
        stage = "source-question-access";
        const { post, question, sessionKey } = await load(
          payload.user_id, payload.channel_id, payload.post_id, questionId,
        );
        if (question.status !== "pending" || question.expiresAtMs <= Date.now()) {
          return { ephemeral_text: "This question is no longer pending." };
        }
        stage = "current-control";
        const { form } = currentControl(post, params.accountId, questionId, layout === "native" ? WEB_ACTION : ACTION);
        stage = "schema";
        validateForm(question, form);
        if (resolveMattermostTextLimit({ baseUrl: params.client.baseUrl }) < MATTERMOST_V12_TEXT_LIMIT) {
          throw new Error("Mattermost 12 is required");
        }
        const unsigned = {
          version: 1, questionId, userId: payload.user_id, channelId: payload.channel_id,
          postId: post.id, sessionKey, expiresAtMs: question.expiresAtMs,
          digest: schemaDigest(question, form), layout,
        };
        const state = Buffer.from(JSON.stringify({
          ...unsigned,
          token: generateInteractionToken({ callback_id: MATTERMOST_QUESTION_FORM_CALLBACK, ...unsigned }, params.accountId),
        })).toString("base64url");
        // Access may change while reading the question and its schema.
        stage = "access-recheck";
        if (await params.authorize(payload.user_id, post) !== sessionKey) throw new Error("Form access denied");
        stage = "dialog-request";
        await params.client.request("/actions/dialogs/open", {
          method: "POST",
          body: JSON.stringify({
            trigger_id: payload.trigger_id, url: params.callbackUrl,
            dialog: {
              callback_id: MATTERMOST_QUESTION_FORM_CALLBACK,
              title: truncateDialogLabel(form?.title ?? "OpenClaw questions", 80),
              introduction_text: [
                ...question.questions.map((q) => q.question),
                ...(layout === "compatible" ? ["Multi-select: tap a field to choose several options. Matrices show one field per row."] : []),
              ].join("\n\n"),
              elements: renderQuestionElements(question.questions, form, layout),
              submit_label: "Submit", notify_on_cancel: false, state,
            },
          }),
        });
        return {};
      } catch (error) {
        params.log?.(`mattermost question form: dialog open failed stage=${stage} status=${parseMattermostApiStatus(error) ?? "none"}`);
        return { ephemeral_text: "Could not open this form. It may have expired; use the original question link." };
      }
    },
    async handleSubmission(payload: MattermostDialogSubmissionPayload): Promise<MattermostDialogSubmissionResponse> {
      let field = "q0";
      try {
        if (payload.callback_id !== MATTERMOST_QUESTION_FORM_CALLBACK || payload.state.length > 4096) {
          throw new Error("Invalid form state");
        }
        const state = bindingSchema.parse(JSON.parse(Buffer.from(payload.state, "base64url").toString("utf8")));
        const { token, ...unsigned } = state;
        if (state.userId !== payload.user_id || state.channelId !== payload.channel_id ||
          !verifyInteractionToken({ callback_id: MATTERMOST_QUESTION_FORM_CALLBACK, ...unsigned }, token, params.accountId)) {
          throw new Error("Form access denied");
        }
        const { post, question, sessionKey } = await load(
          payload.user_id, payload.channel_id, state.postId, state.questionId,
        );
        if (state.sessionKey !== sessionKey) throw new Error("Form route changed");
        if (question.status !== "pending") return { statusCode: 200, body: {} };
        if (state.expiresAtMs !== question.expiresAtMs || state.expiresAtMs <= Date.now()) {
          throw new Error("Form expired");
        }
        const { form } = currentControl(post, params.accountId, state.questionId,
          state.layout === "native" ? WEB_ACTION : ACTION);
        validateForm(question, form);
        if (schemaDigest(question, form) !== state.digest) throw new Error("Form changed");
        if (payload.cancelled) return { statusCode: 200, body: {} };
        const layout = state.layout ?? "native";
        field = String(renderQuestionElements(question.questions, form, layout)[0]!.name);
        let answers: Record<string, string[]>;
        try {
          answers = parseQuestionSubmission(question.questions, payload.submission, form, layout);
        } catch {
          return { statusCode: 200, body: { errors: { [field]: "Check your selections and answer every required question." } } };
        }
        if (await params.authorize(payload.user_id, post) !== sessionKey) throw new Error("Form access denied");
        try {
          await params.rpc("question.resolve", {
            id: state.questionId, answers: { answers }, resolvedBy: `mattermost:${payload.user_id}`,
          });
        } catch {
          // A lost response may follow an accepted answer. Never blindly replay the mutation.
          const latest = await readMattermostQuestion(params.rpc, state.questionId);
          if (latest.status === "pending") {
            return { statusCode: 200, body: { errors: { [field]: "Answer status is uncertain. Check the original question before submitting again." } } };
          }
        }
        return { statusCode: 200, body: {} };
      } catch {
        params.log?.("mattermost question form: submission unavailable or unauthorized");
        return { statusCode: 403, body: { error: "This form is unavailable or you no longer have access." } };
      }
    },
  };
}

function normalizeQuestion(q: MattermostQuestionRecord["questions"][number]) {
  return {
    id: q.questionId, header: q.header, question: q.question, options: q.options,
    multiSelect: q.multiSelect === true, allowEmpty: q.allowEmpty === true,
    isOther: q.isOther === true, presentation: q.presentation,
  };
}
