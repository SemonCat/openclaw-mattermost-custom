import {
  createMattermostPost,
  parseMattermostApiStatus,
  type MattermostClient,
  type MattermostPost,
} from "./client.js";

type MattermostPostCreateInput = {
  channelId: string;
  message: string;
  rootId?: string;
  fileIds?: string[];
  props?: Record<string, unknown>;
};

/**
 * Retry native Blocks as legacy attachments only after an explicit provider rejection.
 * Ambiguous transport/receipt failures may already have created a visible post and must escape.
 */
export async function createMattermostPostWithButtonFallback(params: {
  client: MattermostClient;
  post: MattermostPostCreateInput;
  legacyProps?: Record<string, unknown>;
  warn?: (message: string) => void;
}): Promise<{ post: MattermostPost; props?: Record<string, unknown> }> {
  try {
    return {
      post: await createMattermostPost(params.client, params.post),
      props: params.post.props,
    };
  } catch (error: unknown) {
    if (!params.legacyProps || parseMattermostApiStatus(error) !== 400) {
      throw error;
    }
    params.warn?.("mattermost send: native Blocks rejected; retrying with legacy attachments");
    return {
      post: await createMattermostPost(params.client, {
        ...params.post,
        props: params.legacyProps,
      }),
      props: params.legacyProps,
    };
  }
}
