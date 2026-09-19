import { describe, expect, it } from "vitest";
import { parseMattermostQuestionContext, resolveMattermostPresentation } from "./normalize.js";

const QUESTION_ID = "ask_0123456789abcdef0123456789abcdef";

function questionPayload(overrides?: { optionValues?: string[] }) {
  return {
    text: "Which environment?\n- staging\n- production",
    presentationTextMode: "fallback" as const,
    presentation: {
      blocks: [
        { type: "text" as const, text: "Which environment?" },
        {
          type: "buttons" as const,
          buttons: [
            {
              label: "staging",
              action: {
                type: "question" as const,
                questionId: QUESTION_ID,
                optionValue: "staging",
              },
            },
            {
              label: "production",
              action: {
                type: "question" as const,
                questionId: QUESTION_ID,
                optionValue: "production",
              },
            },
          ],
        },
      ],
    },
    channelData: {
      askUser: {
        questionId: QUESTION_ID,
        optionValues: overrides?.optionValues ?? ["staging", "production"],
      },
    },
  };
}

describe("resolveMattermostPresentation question actions", () => {
  it("encodes each option as a button carrying the Gateway option index", () => {
    const { buttons } = resolveMattermostPresentation(questionPayload());

    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toEqual([
      {
        id: "question-0",
        text: "staging",
        context: { oc_question: true, question_id: QUESTION_ID, option_index: 0 },
        style: undefined,
      },
      {
        id: "question-1",
        text: "production",
        context: { oc_question: true, question_id: QUESTION_ID, option_index: 1 },
        style: undefined,
      },
    ]);
  });

  it("uses the Gateway option order instead of rendered button order", () => {
    const { buttons } = resolveMattermostPresentation(
      questionPayload({ optionValues: ["production", "staging"] }),
    );

    expect(buttons[0]?.map((button) => [button.text, button.context.option_index])).toEqual([
      ["staging", 1],
      ["production", 0],
    ]);
  });

  it("leaves custom input and unsupported typed actions as prose", () => {
    const payload = questionPayload();
    payload.presentation.blocks[1]!.buttons!.push({
      label: "Other…",
      action: { type: "question", questionId: QUESTION_ID, intent: "custom-input" },
    } as never);

    expect(resolveMattermostPresentation(payload).buttons[0]?.map((button) => button.text)).toEqual([
      "staging",
      "production",
    ]);
    expect(
      resolveMattermostPresentation({
        text: "Deploy?",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Run", action: { type: "command", command: "/deploy" } }],
            },
          ],
        },
        channelData: payload.channelData,
      }).buttons,
    ).toEqual([]);
  });

  it("emits no question button without the Gateway option list", () => {
    const payload = questionPayload();
    expect(
      resolveMattermostPresentation({ ...payload, channelData: undefined }).buttons,
    ).toEqual([]);
  });
});

describe("parseMattermostQuestionContext", () => {
  it("reads a valid signed question selection context", () => {
    expect(
      parseMattermostQuestionContext({
        oc_question: true,
        question_id: QUESTION_ID,
        option_index: 1,
      }),
    ).toEqual({ questionId: QUESTION_ID, optionIndex: 1 });
  });

  it("ignores incomplete or unrelated contexts", () => {
    expect(parseMattermostQuestionContext({ callback_data: "deploy_approve" })).toBeNull();
    expect(parseMattermostQuestionContext({ oc_question: true })).toBeNull();
    expect(
      parseMattermostQuestionContext({ oc_question: true, question_id: QUESTION_ID }),
    ).toBeNull();
  });
});
