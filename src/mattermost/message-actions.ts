import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeMattermostMessagingTarget } from "../normalize.js";
import { resolveMattermostAccount } from "./accounts.js";
import {
  createMattermostClient,
  deleteMattermostPost,
  fetchMattermostChannel,
  fetchMattermostMe,
  fetchMattermostPinnedPosts,
  fetchMattermostPost,
  fetchMattermostPostReactions,
  setMattermostPostPinned,
  updateMattermostPostMessageWithReadback,
  type MattermostClient,
  type MattermostFetch,
  type MattermostPost,
  type MattermostReaction,
} from "./client.js";
import type { OpenClawConfig } from "./runtime-api.js";

type ConversationReadInvocationOrigin = NonNullable<
  ChannelMessageActionContext["conversationReadOrigin"]
>;

type MattermostPostActionContext = {
  cfg: OpenClawConfig;
  postId: string;
  accountId?: string | null;
  authorizedTarget?: string;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  fetchImpl?: MattermostFetch;
};

type AuthorizedTarget = { kind: "channel"; id: string } | { kind: "user"; id: string };

function parseAuthorizedTarget(rawTarget?: string): AuthorizedTarget | null {
  const normalized = rawTarget ? normalizeMattermostMessagingTarget(rawTarget) : undefined;
  if (normalized?.startsWith("channel:")) {
    const id = normalizeOptionalString(normalized.slice("channel:".length));
    return id ? { kind: "channel", id } : null;
  }
  if (normalized?.startsWith("user:")) {
    const id = normalizeOptionalString(normalized.slice("user:".length));
    return id ? { kind: "user", id } : null;
  }
  return null;
}

function createActionClient(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  fetchImpl?: MattermostFetch;
}): MattermostClient {
  const account = resolveMattermostAccount({ cfg: params.cfg, accountId: params.accountId });
  const baseUrl = normalizeOptionalString(account.baseUrl);
  const botToken = normalizeOptionalString(account.botToken);
  if (!baseUrl || !botToken) {
    throw new Error("Mattermost botToken/baseUrl missing.");
  }
  return createMattermostClient({
    baseUrl,
    botToken,
    fetchImpl: params.fetchImpl,
    allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
  });
}

async function assertPostTarget(params: {
  client: MattermostClient;
  post: MattermostPost;
  authorizedTarget?: string;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
}): Promise<void> {
  if (params.conversationReadOrigin === "direct-operator") {
    return;
  }
  const target = parseAuthorizedTarget(params.authorizedTarget);
  if (!target) {
    throw new Error(
      "Mattermost delegated post actions require a canonical authorized conversation target.",
    );
  }
  const postChannelId = normalizeOptionalString(params.post.channel_id);
  if (!postChannelId) {
    throw new Error("Mattermost post is missing its conversation binding.");
  }
  if (target.kind === "channel") {
    if (postChannelId !== target.id) {
      throw new Error("Mattermost post belongs to a different conversation.");
    }
    return;
  }

  const [me, channel] = await Promise.all([
    fetchMattermostMe(params.client),
    fetchMattermostChannel(params.client, postChannelId),
  ]);
  const botUserId = normalizeOptionalString(me.id);
  const participants =
    channel.name
      ?.split("__")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .toSorted() ?? [];
  const authorizedParticipants = botUserId ? [botUserId, target.id].toSorted() : [];
  if (
    channel.type !== "D" ||
    participants.length !== 2 ||
    authorizedParticipants.length !== 2 ||
    participants[0] !== authorizedParticipants[0] ||
    participants[1] !== authorizedParticipants[1]
  ) {
    throw new Error("Mattermost post belongs to a different direct conversation.");
  }
}

async function resolveAuthorizedPost(
  params: MattermostPostActionContext,
): Promise<{ client: MattermostClient; post: MattermostPost }> {
  const client = createActionClient(params);
  const post = await fetchMattermostPost(client, params.postId);
  await assertPostTarget({
    client,
    post,
    authorizedTarget: params.authorizedTarget,
    conversationReadOrigin: params.conversationReadOrigin,
  });
  return { client, post };
}

export async function editMattermostMessageAction(
  params: MattermostPostActionContext & { message: string },
): Promise<MattermostPost> {
  const message = normalizeOptionalString(params.message);
  if (!message) {
    throw new Error("Mattermost edit requires non-empty message text.");
  }
  const { client } = await resolveAuthorizedPost(params);
  return await updateMattermostPostMessageWithReadback(client, params.postId, message);
}

export async function deleteMattermostMessageAction(
  params: MattermostPostActionContext,
): Promise<void> {
  const { client } = await resolveAuthorizedPost(params);
  await deleteMattermostPost(client, params.postId);
}

export async function listMattermostMessageReactionsAction(
  params: MattermostPostActionContext,
): Promise<MattermostReaction[]> {
  const { client } = await resolveAuthorizedPost(params);
  return await fetchMattermostPostReactions(client, params.postId);
}

export async function setMattermostMessagePinnedAction(
  params: MattermostPostActionContext & { pinned: boolean },
): Promise<void> {
  const { client } = await resolveAuthorizedPost(params);
  await setMattermostPostPinned(client, params.postId, params.pinned);
}

export async function listMattermostPinnedMessagesAction(params: {
  cfg: OpenClawConfig;
  channelId: string;
  accountId?: string | null;
  authorizedTarget?: string;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  fetchImpl?: MattermostFetch;
}): Promise<MattermostPost[]> {
  const channelId = normalizeOptionalString(params.channelId);
  if (!channelId) {
    throw new Error("Mattermost list-pins requires a channel id.");
  }
  if (params.conversationReadOrigin !== "direct-operator") {
    const target = parseAuthorizedTarget(params.authorizedTarget);
    if (target?.kind !== "channel" || target.id !== channelId) {
      throw new Error(
        "Mattermost delegated pinned-post reads require the authorized channel target.",
      );
    }
  }
  const client = createActionClient(params);
  return await fetchMattermostPinnedPosts(client, channelId);
}
