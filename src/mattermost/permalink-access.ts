import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ResolvedMattermostAccount } from "./accounts.js";
import { fetchMattermostChannel, fetchMattermostMe, type MattermostChannel, type MattermostClient } from "./client.js";
import { collectMattermostPermalinkReferences, type MattermostThreadTarget } from "./thread-context.js";

export const MATTERMOST_PERMALINK_BINDING = "mattermost.permalink-posts";
const nativeId = /^[a-z0-9]{26}$/u;
const bindingKey = randomBytes(32);
const pageSize = 100;
const maxPages = 5;

export function postedMattermostPermalinkIds(account: ResolvedMattermostAccount, text: string): string[] {
  const config = account.config.permalinkHydration;
  if (config?.enabled === false || !account.baseUrl) return [];
  const limit = config?.maxLinks;
  return collectMattermostPermalinkReferences({
    text,
    baseUrl: account.baseUrl,
    allowedOrigins: config?.allowedOrigins,
    maxLinks: limit && Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 5) : 3,
    postedOnly: true,
  });
}

type PermalinkBindingScope = {
  account: ResolvedMattermostAccount;
  currentChannelId: string;
  requesterId: string;
};

function signBinding(scope: PermalinkBindingScope, postIds: readonly string[]): Buffer {
  return createHmac("sha256", bindingKey).update(JSON.stringify([
    scope.account.accountId, scope.account.baseUrl, scope.currentChannelId, scope.requesterId, postIds,
  ])).digest();
}

export function createMattermostPostedPermalinkBinding(scope: PermalinkBindingScope, text: string) {
  const postIds = postedMattermostPermalinkIds(scope.account, text);
  return postIds.length > 0 ? { postIds, signature: signBinding(scope, postIds).toString("hex") } : undefined;
}

export function matchesMattermostPostedPermalinkBinding(
  scope: PermalinkBindingScope,
  value: unknown,
  postId: string,
): boolean {
  if (!value || typeof value !== "object") return false;
  const { postIds, signature } = value as Record<string, unknown>;
  return Array.isArray(postIds) && postIds.length <= 5 &&
    postIds.every((id) => typeof id === "string" && /^[a-z0-9]{26}$/iu.test(id)) &&
    postIds.includes(postId) && typeof signature === "string" && /^[0-9a-f]{64}$/u.test(signature) &&
    timingSafeEqual(signBinding(scope, postIds), Buffer.from(signature, "hex"));
}

function isVerifiableTeamChannel(channel: MattermostChannel, expectedId: string): boolean {
  return channel?.id === expectedId &&
    typeof channel.team_id === "string" && nativeId.test(channel.team_id) &&
    !channel.delete_at && (channel.type === "O" || channel.type === "P") &&
    !channel.shared && !channel.group_constrained && !channel.scheme_id &&
    !channel.policy_id && !channel.policy_enforced && !channel.policy_auto_add;
}

async function fetchAudience(client: MattermostClient, channelId: string): Promise<Set<string>> {
  const members = new Set<string>();
  for (let page = 0; page < maxPages; page += 1) {
    const batch = await client.request<Array<{ channel_id: string; user_id: string; delete_at?: number }>>(
      `/channels/${channelId}/members?page=${page}&per_page=${pageSize}`,
    );
    if (!Array.isArray(batch) || batch.length > pageSize) break;
    for (const member of batch) {
      if (member?.channel_id !== channelId || typeof member.user_id !== "string" ||
          !nativeId.test(member.user_id) || member.delete_at || members.has(member.user_id)) {
        throw new Error("Mattermost permalink audience is unverifiable.");
      }
      members.add(member.user_id);
    }
    if (batch.length < pageSize) return members;
  }
  throw new Error("Mattermost permalink audience exceeds the verification bound.");
}

export async function authorizePostedMattermostPermalink(params: {
  client: MattermostClient;
  currentChannelId: string;
  requesterId: string | undefined;
  target: MattermostThreadTarget;
}): Promise<boolean> {
  const { client, currentChannelId, requesterId, target } = params;
  const { requestedPost: post, requestedPostId, channel: destination } = target;
  const destinationId = post.channel_id;
  if (!requesterId || !nativeId.test(requesterId) || !nativeId.test(currentChannelId) ||
      !destinationId || !nativeId.test(destinationId) || currentChannelId === destinationId ||
      post.id !== requestedPostId || post.delete_at || !isVerifiableTeamChannel(destination, destinationId)) {
    return false;
  }
  try {
    const [source, bot] = await Promise.all([
      fetchMattermostChannel(client, currentChannelId),
      fetchMattermostMe(client),
    ]);
    if (!isVerifiableTeamChannel(source, currentChannelId) || source.team_id !== destination.team_id ||
        (source.type === "O" && destination.type === "P") ||
        typeof bot?.id !== "string" || !nativeId.test(bot.id) || bot.id === requesterId) {
      return false;
    }
    const [currentAudience, destinationAudience] = await Promise.all([
      fetchAudience(client, currentChannelId),
      fetchAudience(client, destinationId),
    ]);
    return currentAudience.has(requesterId) && currentAudience.has(bot.id) &&
      [...currentAudience].every((id) => destinationAudience.has(id));
  } catch {
    return false;
  }
}
