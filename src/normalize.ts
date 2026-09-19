// Mattermost helper module supports normalize behavior.
import {
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  resolveMessagePresentationControlValue,
  type MessagePresentationButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import {
  resolveAskUserQuestionOptionIndex,
  resolveAskUserQuestionOptionIndices,
} from "openclaw/plugin-sdk/reply-payload";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const MATTERMOST_QUESTION_CONTEXT_KEY = "oc_question";

export type MattermostQuestionSelection = { questionId: string; optionIndex: number };

type MattermostPresentationButton = {
  id: string;
  text: string;
  callback_data?: string;
  context: Record<string, unknown>;
  style?: MessagePresentationButton["style"];
};

export function parseMattermostQuestionContext(
  context: Record<string, unknown>,
): MattermostQuestionSelection | null {
  if (context[MATTERMOST_QUESTION_CONTEXT_KEY] !== true) {
    return null;
  }
  const questionId = context.question_id;
  const optionIndex = context.option_index;
  if (typeof questionId !== "string" || !questionId || typeof optionIndex !== "number") {
    return null;
  }
  return Number.isInteger(optionIndex) && optionIndex >= 0 ? { questionId, optionIndex } : null;
}

export function resolveMattermostPresentation(params: {
  text?: string;
  presentation?: unknown;
  presentationTextMode?: "fallback";
  channelData?: Record<string, unknown>;
}) {
  const presentation = normalizeMessagePresentation(params.presentation);
  const text =
    !presentation || (params.presentationTextMode === "fallback" && params.text !== undefined)
      ? (params.text ?? "")
      : renderMessagePresentationFallbackText({ text: params.text, presentation });
  const questionOptionIndices = resolveAskUserQuestionOptionIndices({
    channelData: params.channelData,
  });
  const buttons = presentation
    ? presentation.blocks
        .filter((block) => block.type === "buttons")
        .map((block) =>
          block.buttons.flatMap((button): MattermostPresentationButton[] => {
            const action = button.action;
            if (action?.type === "question") {
              if ("intent" in action) {
                return [];
              }
              const optionIndex = resolveAskUserQuestionOptionIndex({
                questionOptionIndices,
                questionId: action.questionId,
                optionValue: action.optionValue,
              });
              return optionIndex === undefined
                ? []
                : [
                    {
                      id: `question-${optionIndex}`,
                      text: button.label,
                      context: {
                        [MATTERMOST_QUESTION_CONTEXT_KEY]: true,
                        question_id: action.questionId,
                        option_index: optionIndex,
                      },
                      style: button.style,
                    },
                  ];
            }
            if (action) {
              return [];
            }
            const value = resolveMessagePresentationControlValue(button);
            return value
              ? [
                  {
                    id: value,
                    text: button.label,
                    callback_data: value,
                    context: { callback_data: value },
                    style: button.style,
                  },
                ]
              : [];
          }),
        )
        .filter((row) => row.length > 0)
    : [];
  return { text, buttons };
}

export function normalizeMattermostMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (lower.startsWith("channel:")) {
    const id = trimmed.slice("channel:".length).trim();
    return id ? `channel:${id}` : undefined;
  }
  if (lower.startsWith("group:")) {
    const id = trimmed.slice("group:".length).trim();
    return id ? `channel:${id}` : undefined;
  }
  if (lower.startsWith("user:")) {
    const id = trimmed.slice("user:".length).trim();
    return id ? `user:${id}` : undefined;
  }
  if (lower.startsWith("mattermost:")) {
    const id = trimmed.slice("mattermost:".length).trim();
    return id ? `user:${id}` : undefined;
  }
  if (trimmed.startsWith("@")) {
    const id = trimmed.slice(1).trim();
    return id ? `@${id}` : undefined;
  }
  if (trimmed.startsWith("#")) {
    // Strip # prefix and fall through to directory lookup (same as bare names).
    // The core's resolveMessagingTarget will use the directory adapter to
    // resolve the channel name to its Mattermost ID.
    return undefined;
  }
  // Bare name without prefix — return undefined to allow directory lookup
  return undefined;
}

/** Local paths must upload successfully instead of degrading to caption-only sends. */
export function requiresMattermostMediaUpload(mediaUrl: string | undefined): boolean {
  const trimmed = mediaUrl?.trim();
  return Boolean(trimmed && !/^https?:\/\//i.test(trimmed));
}

export function looksLikeMattermostTargetId(raw: string, _normalized?: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (/^(user|channel|group|mattermost):/i.test(trimmed)) {
    return true;
  }
  if (trimmed.startsWith("@")) {
    return true;
  }
  // Mattermost IDs: 26-char alnum, or DM channels like "abc123__xyz789" (53 chars)
  return /^[a-z0-9]{26}$/i.test(trimmed) || /^[a-z0-9]{26}__[a-z0-9]{26}$/i.test(trimmed);
}
