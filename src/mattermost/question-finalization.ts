// Mattermost plugin module disables question controls when Gateway questions settle.
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { updateMattermostPost, type MattermostClient, type MattermostPost } from "./client.js";

const MATTERMOST_MESSAGE_LIMIT = 16_383;

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
