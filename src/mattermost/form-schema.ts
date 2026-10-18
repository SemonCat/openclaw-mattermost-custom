import { z } from "zod";

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u);
const label = z.string().trim().min(1).max(80);
const choice = z.object({ value: identifier, label }).strict();
const choices = (maximum: number) => z.array(choice).min(1).max(maximum)
  .refine((items) => new Set(items.map((item) => item.value)).size === items.length, "Duplicate values")
  .refine((items) => new Set(items.map((item) => item.label.toLowerCase())).size === items.length, "Duplicate labels");
const common = {
  id: identifier,
  label: z.string().trim().min(1).max(24),
  optional: z.boolean().optional(),
};

export function truncateDialogLabel(value: string, bytes: number): string {
  let result = "";
  for (const char of value) {
    if (Buffer.byteLength(result + char, "utf8") > bytes) break;
    result += char;
  }
  return result;
}

export const MattermostFormSchema = z.object({
  title: z.string().trim().min(1).max(24),
  fields: z.array(z.discriminatedUnion("type", [
    z.object({
      ...common, type: z.literal("select"), options: choices(50),
      multiple: z.boolean().optional(),
    }).strict(),
    z.object({
      ...common, type: z.literal("matrix"), rows: choices(30), columns: choices(10),
      multiple: z.boolean().optional(),
    }).strict(),
  ])).min(1).max(3).refine(
    (fields) => new Set(fields.map((field) => field.id)).size === fields.length,
    "Duplicate field ids",
  ),
}).strict();

export type MattermostForm = z.infer<typeof MattermostFormSchema>;
export type MattermostFormLayout = "native" | "compatible";

export type MattermostQuestion = {
  questionId: string;
  header: string;
  question: string;
  options: Array<{ label: string; value?: string }>;
  multiSelect?: boolean;
  isOther?: boolean;
  allowEmpty?: boolean;
  isSecret?: boolean;
  secretStore?: unknown;
  resource?: unknown;
  presentation?: string;
};

export const MattermostQuestionRecordSchema = z.object({
  id: z.string().regex(/^ask_[a-f0-9]{32}$/u),
  status: z.enum(["pending", "answered", "expired", "cancelled"]),
  sessionKey: z.string().min(1),
  expiresAtMs: z.number().safe().positive(),
  questions: z.array(z.object({
    questionId: identifier,
    header: z.string().max(80),
    question: z.string().min(1).max(16_383),
    options: z.array(z.object({
      label: z.string().min(1).max(4096),
      value: z.string().min(1).max(4096).optional(),
    })).max(64),
    multiSelect: z.boolean().optional(),
    isOther: z.boolean().optional(),
    allowEmpty: z.boolean().optional(),
    isSecret: z.boolean().optional(),
    secretStore: z.unknown().optional(),
    resource: z.unknown().optional(),
    presentation: z.string().optional(),
  })).min(1).max(3),
});
export type MattermostQuestionRecord = z.infer<typeof MattermostQuestionRecordSchema>;

export function isOrdinaryMattermostQuestion(record: MattermostQuestionRecord): boolean {
  return record.questions.every((q) => !q.isSecret && q.secretStore === undefined && !q.resource);
}

/** Equal-choice questions can share columns; row identities still belong to individual questions. */
export function canRenderQuestionMatrix(questions: MattermostQuestion[]): boolean {
  const first = questions[0];
  return questions.length > 1 && Boolean(first?.options.length) && first!.options.length <= 10 &&
    questions.every((q) => !q.isOther && q.multiSelect === first!.multiSelect &&
      q.allowEmpty === first!.allowEmpty &&
      JSON.stringify(q.options) === JSON.stringify(first!.options));
}

export function renderQuestionElements(
  questions: MattermostQuestion[],
  customForm?: MattermostForm,
  layout: MattermostFormLayout = "native",
): Array<Record<string, unknown>> {
  if (questions.some((q) => q.options.length > 50)) {
    throw new Error("This question has too many options for a Mattermost dialog");
  }
  if (layout === "compatible") return renderCompatibleElements(questions, customForm);
  if (customForm) {
    return customForm.fields.map((field) => ({
      name: field.id,
      display_name: truncateDialogLabel(field.label, 24),
      optional: field.optional === true,
      ...(field.type === "matrix" ? {
        type: "checkbox_matrix",
        matrix_config: {
          rows: field.rows.map((row) => ({ text: row.label, value: row.value })),
          columns: field.columns.map((col) => ({ text: col.label, value: col.value })),
          row_selection: field.multiple === false ? "single" : "multiple",
        },
      } : {
        type: field.multiple ? "checkbox_group" : "select",
        options: field.options.map((option) => ({ text: option.label, value: option.value })),
      }),
    }));
  }
  if (canRenderQuestionMatrix(questions)) {
    const first = questions[0]!;
    return [{
      name: "matrix", display_name: "Questions", type: "checkbox_matrix",
      optional: first.allowEmpty === true,
      matrix_config: {
        rows: questions.map((q, index) => ({ text: q.header, value: `q${index}` })),
        columns: first.options.map((option, index) => ({ text: option.label, value: `v${index}` })),
        row_selection: first.multiSelect ? "multiple" : "single",
      },
    }];
  }
  return questions.flatMap((q, index) => {
    const elements: Array<Record<string, unknown>> = [{
      name: `q${index}`, display_name: truncateDialogLabel(q.header || `Question ${index + 1}`, 24),
      type: q.options.length ? (q.multiSelect ? "checkbox_group" : "select") : "textarea",
      optional: q.isOther === true || q.allowEmpty === true,
      ...(q.options.length ? {
        options: q.options.map((option, i) => ({ text: option.label, value: `v${i}` })),
      } : { max_length: 3000 }),
    }];
    if (q.isOther && q.options.length) {
      elements.push({
        name: `other${index}`, display_name: `${truncateDialogLabel(q.header, 16)}: Other`,
        type: "textarea", optional: true, max_length: 3000,
      });
    }
    return elements;
  });
}

function renderCompatibleElements(questions: MattermostQuestion[], form?: MattermostForm) {
  const select = (name: string, label: string, options: Array<{ label: string }>,
    multiple: boolean, optional: boolean, help?: string): Record<string, unknown> => ({
    name, display_name: truncateDialogLabel(label, 24), type: "select",
    optional, ...(multiple ? { multiselect: true } : {}),
    options: options.map((option, i) => ({ text: option.label, value: `v${i}` })),
    ...(help ? { help_text: truncateDialogLabel(help, 150) } : {}),
  });
  if (form) {
    return form.fields.flatMap((field, i) => field.type === "matrix"
      ? field.rows.map((row, r) => select(`m${i}r${r}`, row.label, field.columns,
        field.multiple !== false, field.optional === true, `${field.label}: ${row.label}`))
      : [select(`f${i}`, field.label, field.options, field.multiple === true, field.optional === true)]);
  }
  return questions.flatMap((q, i) => {
    const elements = q.options.length
      ? [select(`q${i}`, q.header || `Question ${i + 1}`, q.options,
        q.multiSelect === true, q.isOther === true || q.allowEmpty === true)]
      : [{
        name: `q${i}`, display_name: truncateDialogLabel(q.header || `Question ${i + 1}`, 24),
        type: "textarea", optional: q.allowEmpty === true, max_length: 3000,
      }];
    if (q.isOther && q.options.length) elements.push({
      name: `other${i}`, display_name: `${truncateDialogLabel(q.header, 16)}: Other`,
      type: "textarea", optional: true, max_length: 3000,
    });
    return elements;
  });
}

/** Mobile select dialogs serialize multi-select values as comma-joined wire tokens. */
function compatibleSelections(value: unknown, multiple: boolean): string[] {
  const selections = typeof value === "string" && value && multiple ? value.split(",") : readSelections(value);
  if (selections.some((v) => !/^v(?:0|[1-9]\d*)$/u.test(v)) ||
    new Set(selections).size !== selections.length || (!multiple && selections.length > 1)) {
    throw new Error("Invalid selection");
  }
  return selections;
}

function normalizeCompatibleSubmission(
  questions: MattermostQuestion[], submission: Record<string, unknown>, form?: MattermostForm,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = Object.create(null);
  const values = (name: string, multiple: boolean, options: Array<{ value: string }>) =>
    compatibleSelections(Object.hasOwn(submission, name) ? submission[name] : undefined, multiple)
      .map((token) => {
        const option = options[Number(token.slice(1))];
        if (!option) throw new Error("Unknown option");
        return option.value;
      });
  if (form) {
    form.fields.forEach((field, i) => {
      normalized[field.id] = field.type === "matrix"
        ? field.rows.flatMap((row, r) => {
          const selected = values(`m${i}r${r}`, field.multiple !== false, field.columns);
          return selected.length ? [`${row.value}:${selected.join(",")}`] : [];
        })
        : values(`f${i}`, field.multiple === true, field.options);
    });
  } else {
    const matrix = canRenderQuestionMatrix(questions);
    const rows: string[] = [];
    questions.forEach((q, i) => {
      const value = Object.hasOwn(submission, `q${i}`) ? submission[`q${i}`] : undefined;
      const selected = q.options.length ? compatibleSelections(value, q.multiSelect === true) : value;
      if (matrix) {
        const row = selected as string[];
        if (row.length) rows.push(`q${i}:${row.join(",")}`);
      } else normalized[`q${i}`] = selected;
      if (Object.hasOwn(submission, `other${i}`)) normalized[`other${i}`] = submission[`other${i}`];
    });
    if (matrix) normalized.matrix = rows;
  }
  return normalized;
}

function readSelections(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value;
  throw new Error("Invalid selection");
}

export function parseMatrixSelection(
  value: unknown, rows: string[], columns: string[], multiple: boolean, optional: boolean,
): Record<string, string[]> {
  const selected: Record<string, string[]> = Object.create(null);
  for (const entry of readSelections(value)) {
    const [row, raw, ...extra] = entry.split(":");
    const cols = raw?.split(",") ?? [];
    if (!row || extra.length || !rows.includes(row) || Object.hasOwn(selected, row) ||
      !cols.length || cols.some((c) => !columns.includes(c)) ||
      new Set(cols).size !== cols.length || (!multiple && cols.length > 1)) {
      throw new Error("Invalid matrix selection");
    }
    selected[row] = cols;
  }
  if (!optional && rows.some((row) => !selected[row]?.length)) throw new Error("Answer every row");
  return selected;
}

export function parseQuestionSubmission(
  questions: MattermostQuestion[], submission: Record<string, unknown>, customForm?: MattermostForm,
  layout: MattermostFormLayout = "native",
): Record<string, string[]> {
  const allowed = new Set(renderQuestionElements(questions, customForm, layout).map((element) => element.name));
  if (Object.keys(submission).some((key) => !allowed.has(key))) throw new Error("Unknown form field");
  if (layout === "compatible") {
    return parseQuestionSubmission(questions, normalizeCompatibleSubmission(questions, submission, customForm), customForm);
  }
  if (customForm) {
    return Object.fromEntries(customForm.fields.map((field) => {
      const value = Object.hasOwn(submission, field.id) ? submission[field.id] : undefined;
      let selected: string[];
      if (field.type === "matrix") {
        const rows = parseMatrixSelection(value, field.rows.map((r) => r.value),
          field.columns.map((c) => c.value), field.multiple !== false, field.optional === true);
        selected = field.rows.filter((row) => rows[row.value]?.length)
          .map((row) => `${row.value}:${rows[row.value]!.join(",")}`);
      } else {
        selected = readSelections(value);
        if (selected.some((v) => !field.options.some((o) => o.value === v)) ||
          (!field.multiple && selected.length > 1)) throw new Error("Invalid option");
      }
      if ((!field.optional && !selected.length) || new Set(selected).size !== selected.length) {
        throw new Error("Select a valid answer");
      }
      return [field.id, selected];
    }));
  }
  const matrix = canRenderQuestionMatrix(questions)
    ? parseMatrixSelection(submission.matrix, questions.map((_, i) => `q${i}`),
      questions[0]!.options.map((_, i) => `v${i}`), questions[0]!.multiSelect === true,
      questions[0]!.allowEmpty === true)
    : undefined;
  return Object.fromEntries(questions.map((q, index) => {
    let values = matrix ? matrix[`q${index}`] ?? [] : readSelections(submission[`q${index}`]);
    if (q.options.length) {
      values = values.map((value) => {
        const optionIndex = q.options.findIndex((_, i) => `v${i}` === value);
        if (optionIndex < 0) throw new Error("Unknown option");
        return q.options[optionIndex]!.value ?? q.options[optionIndex]!.label;
      });
    }
    const other = submission[`other${index}`];
    if (other !== undefined && other !== null && other !== "") {
      if (!q.isOther || typeof other !== "string" || !other.trim() || other.length > 3000) {
        throw new Error("Invalid custom answer");
      }
      values.push(other);
    }
    if (values.some((v) => !v.trim() || v.length > (q.options.length ? 4096 : 3000)) ||
      (!q.allowEmpty && !values.length) || (!q.multiSelect && values.length > 1) ||
      new Set(values).size !== values.length) throw new Error("Select a valid answer");
    return [q.questionId, values];
  }));
}

/** The same canonical specification is used for request creation and callback verification. */
export function formQuestions(form: MattermostForm): MattermostQuestion[] {
  return form.fields.map((field) => ({
    questionId: field.id,
    header: Array.from(field.label).slice(0, 12).join(""),
    question: field.label,
    presentation: "form",
    options: field.type === "select"
      ? field.options.map((o) => ({ label: o.label, value: o.value })) : [],
    multiSelect: field.type === "matrix" || field.multiple === true,
    allowEmpty: field.optional === true,
    isOther: false,
  }));
}
