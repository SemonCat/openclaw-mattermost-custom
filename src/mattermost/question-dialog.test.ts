import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildButtonProps, MATTERMOST_QUESTION_FORM_CONTROL_PROP, setInteractionSecret,
  generateInteractionToken, verifyInteractionToken, type MattermostDialogSubmissionPayload,
} from "./interactions.js";
import {
  buildMattermostQuestionFormButtons, createMattermostQuestionDialogController,
  MATTERMOST_QUESTION_FORM_CALLBACK,
} from "./question-dialog.js";
import { formQuestions, MattermostFormSchema } from "./form-schema.js";
import { observeMattermostServerVersion } from "./text-limits.js";
import type { MattermostClient, MattermostPost } from "./client.js";

const id = "ask_0123456789abcdef0123456789abcdef";
const form = MattermostFormSchema.parse({
  title: "Access", fields: [{
    id: "access", label: "Access", type: "matrix",
    rows: [{ value: "api", label: "API" }, { value: "web", label: "Web" }],
    columns: [{ value: "read", label: "Read" }, { value: "write", label: "Write" }],
  }],
});

function fixture(format: "legacy" | "blocks" = "legacy", custom = true) {
  const question = {
    id, status: "pending", sessionKey: "agent:test:room:thread:root",
    expiresAtMs: Date.now() + 60_000, questions: custom ? formQuestions(form) : [{
      questionId: "features", header: "Features", question: "Choose features",
      options: [{ label: "Search", value: "search" }, { label: "Files", value: "files" }],
      multiSelect: true, isOther: true,
    }],
  };
  const post: MattermostPost = {
    id: "post", user_id: "bot", channel_id: "room", root_id: "root", message: "Choose",
    props: buildButtonProps({
      accountId: "acct", channelId: "room", callbackUrl: "https://gateway/callback", format,
      buttons: [buildMattermostQuestionFormButtons(id, custom ? form : undefined)],
    }),
  };
  let opened: { dialog: { state: string; elements: unknown[] } };
  const request = vi.fn(async (path, init) => {
    if (path === "/posts/post") return post;
    if (path === "/actions/dialogs/open") {
      opened = JSON.parse(init.body); return {};
    }
    throw new Error("Unexpected Mattermost operation");
  });
  const client = {
    baseUrl: "https://forms.test", token: "token", request,
  } as unknown as MattermostClient;
  const rpc = vi.fn(async (method, args) => {
    if (method === "question.get") return { question };
    if (method === "question.resolve") { question.status = "answered"; return { status: "answered", answers: args.answers }; }
    throw new Error("Unexpected RPC");
  });
  const authorize = vi.fn(async () => question.sessionKey as string | null);
  const log = vi.fn();
  const create = () => createMattermostQuestionDialogController({
    accountId: "acct", botUserId: "bot", callbackUrl: "https://gateway/callback",
    client, rpc, authorize, log,
  });
  const open = (layout: "native" | "compatible" = "native") => create().handleInteraction({
    payload: { user_id: "user", channel_id: "room", post_id: "post", trigger_id: "trigger" },
    context: { oc_question_form: 1, question_id: id, ...(layout === "native" ? { layout } : {}) },
  });
  const submission = (): MattermostDialogSubmissionPayload => ({
    type: "dialog_submission", callback_id: MATTERMOST_QUESTION_FORM_CALLBACK,
    state: opened.dialog.state, user_id: "user", channel_id: "room",
    submission: custom ? { access: ["api:read,write", "web:read"] } : { q0: ["v0", "v1"], other0: "Reports" },
  });
  return { question, post, request, rpc, authorize, log, create, open, submission, getOpened: () => opened };
}

beforeEach(() => {
  setInteractionSecret("acct", "token");
  observeMattermostServerVersion("https://forms.test", "12.0.0");
});

describe("Mattermost native question dialogs", () => {
  it.each(["legacy", "blocks"] as const)("opens a mobile-compatible %s form by default and resolves row selections", async (format) => {
    const f = fixture(format);
    expect(await f.open("compatible")).toEqual({});
    expect(f.getOpened().dialog.elements).toMatchObject([
      { name: "m0r0", type: "select", multiselect: true },
      { name: "m0r1", type: "select", multiselect: true },
    ]);
    expect(await f.create().handleSubmission({
      ...f.submission(), submission: { m0r0: "v0,v1", m0r1: "v0" },
    })).toEqual({ statusCode: 200, body: {} });
    expect(f.rpc).toHaveBeenCalledWith("question.resolve", expect.objectContaining({
      answers: { answers: { access: ["api:read,write", "web:read"] } },
    }));
  });

  it("binds the layout to the signed dialog state", async () => {
    const f = fixture();
    await f.open("compatible");
    const payload = f.submission();
    const state = JSON.parse(Buffer.from(payload.state, "base64url").toString("utf8"));
    state.layout = "native";
    payload.state = Buffer.from(JSON.stringify(state)).toString("base64url");
    expect((await f.create().handleSubmission(payload)).statusCode).toBe(403);
    expect(f.rpc.mock.calls.filter(([method]) => method === "question.resolve")).toHaveLength(0);
  });

  it("accepts a still-pending native dialog opened before the mobile adaptation", async () => {
    const f = fixture();
    await f.open("compatible");
    const payload = f.submission();
    const { layout, token, ...old } = JSON.parse(Buffer.from(payload.state, "base64url").toString("utf8"));
    payload.state = Buffer.from(JSON.stringify({
      ...old, token: generateInteractionToken({ callback_id: MATTERMOST_QUESTION_FORM_CALLBACK, ...old }, "acct"),
    })).toString("base64url");
    expect(await f.create().handleSubmission(payload)).toEqual({ statusCode: 200, body: {} });
    expect(f.rpc).toHaveBeenCalledWith("question.resolve", expect.objectContaining({
      answers: { answers: { access: ["api:read,write", "web:read"] } },
    }));
  });

  it("requires the current visible web control before opening the native layout", async () => {
    const f = fixture("legacy");
    const attachment = (f.post.props!.attachments as any[])[0];
    attachment.actions = attachment.actions.filter((a: any) => a.id !== "ocquestionformweb");
    expect(await f.open()).toHaveProperty("ephemeral_text");
    expect(await f.open("compatible")).toEqual({});
  });

  it.each(["legacy", "blocks"] as const)(
    "opens a %s form when the REST post omits private action integrations",
    async (format) => {
      const f = fixture(format);
      if (format === "legacy") {
        for (const attachment of f.post.props!.attachments as any[]) {
          for (const action of attachment.actions ?? []) delete action.integration;
        }
      } else {
        delete f.post.props!.mm_blocks_actions;
      }
      expect(await f.open()).toEqual({});
      expect(f.request).toHaveBeenCalledWith("/actions/dialogs/open", expect.anything());
      expect(await f.create().handleSubmission(f.submission())).toEqual({ statusCode: 200, body: {} });
    },
  );

  it.each(["missing", "signature", "channel", "question", "form", "visible-control"] as const)(
    "rejects a changed public form binding: %s",
    async (change) => {
      const f = fixture("blocks");
      const control = f.post.props![MATTERMOST_QUESTION_FORM_CONTROL_PROP] as Record<string, unknown>;
      if (change === "missing") delete f.post.props![MATTERMOST_QUESTION_FORM_CONTROL_PROP];
      if (change === "signature") control.signature = "invalid";
      if (change === "channel") control.channel_id = "foreign";
      if (change === "question") control.question_id = "ask_ffffffffffffffffffffffffffffffff";
      if (change === "form") control.form = { ...form, title: "Changed" };
      if (change === "visible-control") delete f.post.props!.mm_blocks;
      expect(await f.open()).toHaveProperty("ephemeral_text");
      expect(f.request).not.toHaveBeenCalledWith("/actions/dialogs/open", expect.anything());
      expect(f.log).toHaveBeenCalledWith(
        "mattermost question form: dialog open failed stage=current-control status=none",
      );
    },
  );

  it("does not expose a callback token through the public form signature", () => {
    const f = fixture("blocks");
    const control = f.post.props![MATTERMOST_QUESTION_FORM_CONTROL_PROP] as Record<string, unknown>;
    expect(control).not.toHaveProperty("_token");
    const { signature, ...unsigned } = control;
    expect(verifyInteractionToken(unsigned, String(signature), "acct")).toBe(true);
    expect(verifyInteractionToken({
      action_id: "ocquestionform", oc_question_form: 1, question_id: id,
      __openclaw_channel_id: "room", form,
    }, String(signature), "acct")).toBe(false);
  });

  it.each(["legacy", "blocks"] as const)("resolves the original question through a %s control after controller recreation", async (format) => {
    const f = fixture(format);
    expect(await f.open()).toEqual({});
    expect(f.getOpened().dialog.elements[0]).toMatchObject({ type: "checkbox_matrix" });
    expect(await f.create().handleSubmission(f.submission())).toEqual({ statusCode: 200, body: {} });
    expect(f.rpc).toHaveBeenCalledWith("question.resolve", {
      id, answers: { answers: { access: ["api:read,write", "web:read"] } }, resolvedBy: "mattermost:user",
    });
    await f.create().handleSubmission(f.submission());
    expect(f.rpc.mock.calls.filter(([method]) => method === "question.resolve")).toHaveLength(1);
    expect(f.request.mock.calls.map(([path]) => path)).not.toContain("/posts");
  });

  it("preserves built-in multi-select values and Other answers", async () => {
    const f = fixture("legacy", false);
    await f.open();
    expect(f.getOpened().dialog.elements.map((e: any) => e.type)).toEqual(["checkbox_group", "textarea"]);
    await f.create().handleSubmission(f.submission());
    expect(f.rpc).toHaveBeenCalledWith("question.resolve", expect.objectContaining({
      answers: { answers: { features: ["search", "files", "Reports"] } },
    }));
  });

  it.each(["user", "channel", "signature", "expired", "schema", "control", "bot", "route", "auth"] as const)(
    "rejects changed %s bindings without resolving", async (change) => {
      const f = fixture(); await f.open();
      const payload = f.submission();
      if (change === "user") payload.user_id = "other";
      if (change === "channel") payload.channel_id = "other";
      if (change === "signature") payload.state = payload.state.slice(0, -8) + "AAAA";
      if (change === "expired") f.question.expiresAtMs = Date.now() - 1;
      if (change === "schema") f.question.questions[0].question = "Changed";
      if (change === "control") f.post.props = {};
      if (change === "bot") f.post.user_id = "other";
      if (change === "route") f.authorize.mockResolvedValue("foreign:session");
      if (change === "auth") f.authorize.mockResolvedValue(null);
      expect((await f.create().handleSubmission(payload)).statusCode).toBe(403);
      expect(f.rpc.mock.calls.filter(([method]) => method === "question.resolve")).toHaveLength(0);
    },
  );

  it("rechecks authorization after reading and validating answers", async () => {
    const f = fixture(); await f.open();
    f.authorize.mockResolvedValueOnce(f.question.sessionKey).mockResolvedValueOnce(null);
    expect((await f.create().handleSubmission(f.submission())).statusCode).toBe(403);
    expect(f.rpc.mock.calls.filter(([method]) => method === "question.resolve")).toHaveLength(0);
  });

  it("leaves invalid and cancelled forms pending", async () => {
    const f = fixture(); await f.open();
    const invalid = f.submission(); invalid.submission.access = ["api:unknown"];
    expect((await f.create().handleSubmission(invalid)).body).toHaveProperty("errors.access");
    expect(await f.create().handleSubmission({ ...f.submission(), cancelled: true })).toEqual({ statusCode: 200, body: {} });
    expect(f.rpc.mock.calls.filter(([method]) => method === "question.resolve")).toHaveLength(0);
  });

  it("reads back an ambiguous accepted resolution instead of retrying it", async () => {
    const f = fixture(); await f.open();
    f.rpc.mockImplementation(async (method) => {
      if (method === "question.get") return { question: f.question };
      f.question.status = "answered";
      throw new Error("lost response");
    });
    expect(await f.create().handleSubmission(f.submission())).toEqual({ statusCode: 200, body: {} });
    expect(f.rpc.mock.calls.filter(([method]) => method === "question.resolve")).toHaveLength(1);
  });

  it("denies ordinary forms for secret questions and old servers", async () => {
    const f = fixture();
    Object.assign(f.question.questions[0], { isSecret: true });
    expect(await f.open()).toHaveProperty("ephemeral_text");
    expect(f.request).not.toHaveBeenCalledWith("/actions/dialogs/open", expect.anything());
    delete (f.question.questions[0] as any).isSecret;
    observeMattermostServerVersion("https://forms.test", "11.11.1");
    expect(await f.open()).toHaveProperty("ephemeral_text");
    expect(f.request).not.toHaveBeenCalledWith("/actions/dialogs/open", expect.anything());
  });
});
