// Mattermost plugin module hydrates authorized same-instance permalinks before model dispatch.
import type { ResolvedMattermostAccount } from "./accounts.js";
import type { MattermostClient, MattermostPost } from "./client.js";
import { isMattermostThreadTargetAllowed } from "./read.js";
import type { OpenClawConfig } from "./runtime-api.js";
import {
  collectMattermostPermalinkReferences,
  fetchMattermostThreadContext,
  formatMattermostThreadContextForPrompt,
  resolveMattermostThreadTarget,
} from "./thread-context.js";

const DEFAULT_MAX_LINKS = 3;
const DEFAULT_MAX_POSTS = 50;
const DEFAULT_MAX_CHARS = 20_000;

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isSafeInteger(value) || value === undefined || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

export async function hydrateMattermostPermalinks(params: {
  cfg: OpenClawConfig;
  account: ResolvedMattermostAccount;
  client: MattermostClient;
  currentChannelId: string;
  text: string;
  props?: MattermostPost["props"];
  implicitPostIds?: readonly string[];
  log?: (message: string) => void;
}): Promise<string> {
  const config = params.account.config.permalinkHydration;
  if (config?.enabled === false || !params.account.baseUrl) {
    return "";
  }
  const maxLinks = boundedInteger(config?.maxLinks, DEFAULT_MAX_LINKS, 5);
  const maxPosts = boundedInteger(config?.maxPosts, DEFAULT_MAX_POSTS, 100);
  const maxChars = boundedInteger(config?.maxChars, DEFAULT_MAX_CHARS, 60_000);
  const postIds = collectMattermostPermalinkReferences({
    text: params.text,
    props: params.props,
    implicitPostIds: params.implicitPostIds,
    baseUrl: params.account.baseUrl,
    allowedOrigins: config?.allowedOrigins,
    maxLinks,
  });
  if (postIds.length === 0) {
    return "";
  }

  const hydrated: string[] = [];
  let remainingChars = maxChars;
  for (const postId of postIds) {
    if (remainingChars <= 0) {
      break;
    }
    try {
      const target = await resolveMattermostThreadTarget({ client: params.client, postId });
      if (
        !isMattermostThreadTargetAllowed({
          cfg: params.cfg,
          account: params.account,
          currentChannelId: params.currentChannelId,
          targetChannel: target.channel,
        })
      ) {
        params.log?.(
          `mattermost permalink hydration denied targetChannel=${target.channel.id} currentChannel=${params.currentChannelId}`,
        );
        continue;
      }
      const context = await fetchMattermostThreadContext({
        client: params.client,
        target,
        limit: maxPosts,
      });
      const rendered = formatMattermostThreadContextForPrompt(context, remainingChars);
      hydrated.push(rendered);
      remainingChars -= rendered.length;
    } catch (error) {
      params.log?.(`mattermost permalink hydration failed post=${postId}: ${String(error)}`);
    }
  }
  return hydrated.join("\n\n");
}
