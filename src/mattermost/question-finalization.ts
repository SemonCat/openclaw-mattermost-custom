// Mattermost plugin module disables question controls when Gateway questions settle.
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { updateMattermostPost, type MattermostClient, type MattermostPost } from "./client.js";

const MATTERMOST_MESSAGE_LIMIT = 16_383;

function appendTerminalStatus(text: unknown, status: string): string {
  const prefix = typeof text === "string" ? text.trim() : "";
  const terminal = status ? `**${status}**` : "";
  return [prefix, terminal].filter(Boolean).join("\n\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function containsBlockAction(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsBlockAction);
  }
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.action_id === "string") {
    return true;
  }
  return Object.values(value).some(containsBlockAction);
}

function buildTerminalCardProps(
  props: Record<string, unknown> | null | undefined,
  status: string,
): Record<string, unknown> | undefined {
  const rawAttachments = props?.attachments;
  if (Array.isArray(rawAttachments) && rawAttachments.some(isRecord)) {
    let annotated = false;
    const attachments = rawAttachments.filter(isRecord).map((attachment) => {
      const { actions: _actions, ...rest } = attachment;
      if (annotated) {
        return rest;
      }
      annotated = true;
      return { ...rest, text: appendTerminalStatus(rest.text, status) };
    });
    return { attachments };
  }

  const rawBlocks = props?.mm_blocks;
  if (Array.isArray(rawBlocks)) {
    const blocks = rawBlocks.filter((block) => !containsBlockAction(block));
    if (status) {
      blocks.push({ type: "text", text: `**${status}**` });
    }
    if (blocks.length > 0) {
      return { mm_blocks: blocks };
    }
  }
  return undefined;
}

export function registerMattermostQuestionDelivery(params: {
  accountId: string;
  client: MattermostClient;
  post: MattermostPost;
  questionId?: string;
  registerChannelDelivery?: typeof questionGatewayRuntime.registerChannelDelivery;
}): void {
  const questionId = params.questionId?.trim();
  const text = params.post.message?.trim();
  if (!questionId || !text || !params.post.id) {
    return;
  }
  const register = params.registerChannelDelivery ?? questionGatewayRuntime.registerChannelDelivery;
  register({
    questionId,
    deliveryId: `mattermost:${params.accountId}:${params.post.channel_id ?? "unknown"}:${params.post.id}`,
    finalize: async (statusLine) => {
      const suffix = truncateUtf16Safe(statusLine.trim(), 512);
      const terminalCardProps = buildTerminalCardProps(params.post.props, suffix);
      if (terminalCardProps) {
        await updateMattermostPost(params.client, params.post.id, {
          message: text,
          props: terminalCardProps,
        });
        return;
      }
      const separator = suffix ? "\n\n" : "";
      const prefix = truncateUtf16Safe(
        text,
        MATTERMOST_MESSAGE_LIMIT - separator.length - suffix.length,
      );
      await updateMattermostPost(params.client, params.post.id, {
        message: `${prefix}${separator}${suffix}`,
        props: {},
      });
    },
  });
}
