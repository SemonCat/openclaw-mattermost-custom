import { describe, expect, it } from "vitest";
import {
  formQuestions, MattermostFormSchema, parseMatrixSelection, parseQuestionSubmission,
  renderQuestionElements, type MattermostQuestion,
} from "./form-schema.js";

const questions: MattermostQuestion[] = [{
  questionId: "features", header: "功能選擇測試標題很長", question: "Which features?",
  options: [{ label: "Search", value: "search" }, { label: "Files", value: "files" }],
  multiSelect: true, isOther: true,
}, {
  questionId: "where", header: "Where", question: "Which environment?",
  options: [{ label: "Production" }, { label: "Staging" }],
}];

export const matrixForm = MattermostFormSchema.parse({
  title: "Permissions",
  fields: [{
    type: "matrix", id: "access", label: "Permissions", multiple: false,
    rows: [{ value: "api", label: "API" }, { value: "web", label: "Web" }],
    columns: [{ value: "read", label: "Read" }, { value: "write", label: "Write" }],
  }],
});

describe("Mattermost question forms", () => {
  it("uses supported mobile selects for every matrix row", () => {
    const elements = renderQuestionElements(formQuestions(matrixForm), matrixForm, "compatible");
    expect(elements).toMatchObject([
      { name: "m0r0", type: "select", options: [{ value: "v0" }, { value: "v1" }] },
      { name: "m0r1", type: "select", options: [{ value: "v0" }, { value: "v1" }] },
    ]);
    expect(parseQuestionSubmission(formQuestions(matrixForm), {
      m0r0: "v0", m0r1: "v1",
    }, matrixForm, "compatible")).toEqual({ access: ["api:read", "web:write"] });
  });

  it("round-trips mobile comma-joined multi-selects without splitting canonical values", () => {
    const input = [{ ...questions[0], options: [
      { label: "Search", value: "search,all" }, { label: "Files", value: "files" },
    ] }];
    expect(renderQuestionElements(input, undefined, "compatible")[0])
      .toMatchObject({ type: "select", multiselect: true });
    expect(parseQuestionSubmission(input, { q0: "v0,v1", other0: "Reports" }, undefined, "compatible"))
      .toEqual({ features: ["search,all", "files", "Reports"] });
  });

  it("validates every mobile matrix row and keeps optional rows empty", () => {
    const form = MattermostFormSchema.parse({
      title: "Mobile", fields: [
        { type: "select", id: "features", label: "Features", multiple: true,
          options: [{ label: "Search", value: "search" }, { label: "Files", value: "files" }] },
        { ...matrixForm.fields[0], id: "rating" },
        { ...matrixForm.fields[0], id: "scenarios", multiple: true, optional: true },
      ],
    });
    const qs = formQuestions(form);
    const input = { f0: "v0,v1", m1r0: "v0", m1r1: "v1", m2r0: "v0,v1" };
    expect(parseQuestionSubmission(qs, input, form, "compatible")).toEqual({
      features: ["search", "files"], rating: ["api:read", "web:write"], scenarios: ["api:read,write"],
    });
    expect(parseQuestionSubmission(qs, { ...input, f0: ["v0", "v1"], m2r0: [] }, form, "compatible"))
      .toMatchObject({ features: ["search", "files"], scenarios: [] });
    for (const patch of [
      { f0: "v0,v0" }, { f0: "v0," }, { f0: "v01" }, { f0: "v9" },
      { f0: [] }, { m1r0: "v0,v1" }, { m1r1: "" }, { m2r0: "v2" }, { injected: "v0" },
    ]) {
      expect(() => parseQuestionSubmission(qs, { ...input, ...patch }, form, "compatible")).toThrow();
    }
    const elements = renderQuestionElements(qs, form, "compatible");
    expect(elements).toHaveLength(5);
    expect(elements.every((e) => e.type === "select")).toBe(true);
  });

  it("preserves equal-choice canonical answers without rendering a mobile matrix", () => {
    const qs = ["one", "two"].map((id) => ({ ...questions[0], questionId: id, isOther: false }));
    expect(renderQuestionElements(qs, undefined, "compatible").map((e) => e.type))
      .toEqual(["select", "select"]);
    expect(parseQuestionSubmission(qs, { q0: "v0,v1", q1: "v1" }, undefined, "compatible"))
      .toEqual({ one: ["search", "files"], two: ["files"] });
  });

  it("renders checkbox groups with Other and preserves canonical values for every question", () => {
    const elements = renderQuestionElements(questions);
    expect(elements.map((e) => e.type)).toEqual(["checkbox_group", "textarea", "select"]);
    expect(Buffer.byteLength(String(elements[0].display_name))).toBeLessThanOrEqual(24);
    expect(parseQuestionSubmission(questions, {
      q0: ["v0", "v1"], other0: "Reports", q1: "v1",
    })).toEqual({ features: ["search", "files", "Reports"], where: ["Staging"] });
    expect(() => parseQuestionSubmission(questions, { q0: [], q1: "v0" })).toThrow();
    expect(() => parseQuestionSubmission(questions, { q0: ["v9"], q1: "v0" })).toThrow();
    expect(() => parseQuestionSubmission(questions, { q0: ["v0", "v0"], q1: "v0" })).toThrow();
    expect(() => parseQuestionSubmission(questions, { q0: ["v0"], q1: ["v0", "v1"] })).toThrow();
    expect(() => parseQuestionSubmission(questions, { q0: ["v0"], q1: "v0", injected: "x" })).toThrow();
  });

  it("combines matching ordinary questions into a matrix without losing Other support", () => {
    const equal = questions.map((q, i) => ({ ...questions[0], questionId: `q${i}`, isOther: false }));
    expect(renderQuestionElements(equal)[0]).toMatchObject({ type: "checkbox_matrix" });
    expect(parseQuestionSubmission(equal, { matrix: ["q0:v0,v1", "q1:v1"] }))
      .toEqual({ q0: ["search", "files"], q1: ["files"] });
    expect(renderQuestionElements(questions.map(() => questions[0]))[0].type).toBe("checkbox_group");
  });

  it("parses native matrix encoding and rejects forged or ambiguous cells", () => {
    expect(parseQuestionSubmission(formQuestions(matrixForm), {
      access: ["api:read", "web:write"],
    }, matrixForm)).toEqual({ access: ["api:read", "web:write"] });
    for (const value of [
      ["api:read,write", "web:read"], ["api:read", "api:write", "web:read"],
      ["api:read"], ["api:missing", "web:read"], ["unknown:read", "web:read"],
      ["api:read:write", "web:read"], ["api:read,read", "web:read"],
    ]) {
      expect(() => parseQuestionSubmission(formQuestions(matrixForm), { access: value }, matrixForm)).toThrow();
    }
    expect(parseMatrixSelection(["constructor:read"], ["constructor"], ["read"], true, false))
      .toEqual({ constructor: ["read"] });
  });

  it("supports optional unanswered rows and multiple choices per row", () => {
    expect(parseMatrixSelection(["api:read,write"], ["api", "web"], ["read", "write"], true, true))
      .toEqual({ api: ["read", "write"] });
    const optional = [{ ...questions[0], allowEmpty: true, isOther: false }];
    expect(parseQuestionSubmission(optional, {})).toEqual({ features: [] });
  });

  it("rejects unsupported schemas and preserves whole unicode labels", () => {
    const bad = structuredClone(matrixForm);
    bad.fields[0].id = "bad:id";
    expect(MattermostFormSchema.safeParse(bad).success).toBe(false);
    expect(() => renderQuestionElements([{ ...questions[0], options: Array(51).fill({ label: "x" }) }])).toThrow();
    expect(() => parseQuestionSubmission([{ ...questions[0], options: [] }], { q0: "a".repeat(3001) })).toThrow();
  });
});
