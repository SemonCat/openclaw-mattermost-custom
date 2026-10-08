import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveMattermostAccount } from "./accounts.js";
import { createMattermostClient, fetchMattermostChannel, normalizeMattermostSearchQuery, searchMattermostChannelPosts, type MattermostFetch } from "./client.js";
import { authorizeMattermostReadTarget, type ReadContext } from "./read.js";
import type { OpenClawConfig } from "./runtime-api.js";
import type { MattermostConfig } from "../types.js";

export async function searchMattermostMessages(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  channelId: string;
  query: string;
  senderId?: string;
  limit?: number;
  context: ReadContext;
  fetchImpl?: MattermostFetch;
}) {
  const query = normalizeMattermostSearchQuery(params.query);
  const limit = params.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Mattermost search limit must be 1–50.");
  if (params.senderId !== undefined && !/^[a-z0-9]{26}$/.test(params.senderId)) throw new Error("Mattermost search senderId must be a stable user id.");
  const account = resolveMattermostAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.enabled) throw new Error(`Mattermost account "${account.accountId}" is disabled`);
  if (!(account.config.actions?.search ?? (params.cfg.channels?.mattermost as MattermostConfig | undefined)?.actions?.search ?? false)) throw new Error("Mattermost message search is disabled in config");
  if (!account.baseUrl || !account.botToken) throw new Error("Mattermost botToken/baseUrl missing.");
  const client = createMattermostClient({ baseUrl: account.baseUrl, botToken: account.botToken, fetchImpl: params.fetchImpl, allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config) });
  const authorized = await authorizeMattermostReadTarget({ ...params, account, client, publicCrossChannelOnly: true });
  const channel = authorized ?? await fetchMattermostChannel(client, params.channelId);
  if (channel.id !== params.channelId || (channel.type !== "O" && channel.type !== "P") ||
    !channel.team_id || !/^[a-z0-9_-]{1,64}$/.test(channel.name ?? "")) {
    throw new Error("Mattermost search requires a team-backed channel with a valid channel name.");
  }
  const source = await searchMattermostChannelPosts(client, { teamId: channel.team_id, channelId: params.channelId, channelName: channel.name!, query });
  const matches = source.messages.filter(post => !post.delete_at && (!params.senderId || post.user_id === params.senderId));
  let chars = 0;
  let textTruncated = false;
  const messages = matches.slice(0, limit).flatMap(post => {
    const safe = sanitizeAssistantVisibleText(post.message ?? "");
    const remaining = 12_000 - chars;
    if (remaining <= 0) { textTruncated = true; return []; }
    const snippet = truncateUtf16Safe(safe, Math.min(500, remaining));
    chars += snippet.length;
    textTruncated ||= snippet.length < safe.length;
    return [{
      id: post.id, senderId: post.user_id, snippet, threadId: post.root_id || post.id,
      permalink: `${client.baseUrl}/_redirect/pl/${encodeURIComponent(post.id)}`,
      ...(post.create_at === undefined || post.create_at === null ? {} : { timestamp: post.create_at }),
    }];
  });
  return {
    messages, sourceCount: source.sourceCount, orderedCount: source.orderedCount,
    eligibleCount: matches.length, outputCount: messages.length,
    truncated: matches.length > messages.length || textTruncated,
    completeness: "unknown" as const,
    // SQL search ignores page/per_page; index freshness and provider caps are unknown.
    note: "One bounded API response; provider index completeness and freshness are unknown. Sender filtering is local to that response.",
  };
}
