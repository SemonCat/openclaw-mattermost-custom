import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { getSessionBindingService } from "openclaw/plugin-sdk/session-binding-runtime";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveMattermostAccount } from "./accounts.js";
import {
  createMattermostClient,
  createMattermostPost,
  fetchMattermostChannel,
  fetchMattermostMe,
  fetchMattermostPost,
  isMattermostSystemPost,
} from "./client.js";
import { resolveMattermostTextLimit } from "./text-limits.js";

type PrepareFork = NonNullable<NonNullable<ChannelPlugin["conversationBindings"]>["prepareFork"]>;
type PreparedFork = Extract<Awaited<ReturnType<PrepareFork>>, { ok: true }>;

const nativeId = /^[a-z0-9]{26}$/u;
const nativeForkInvocationPrefix = "mattermost:fork:slash:";
const nativeForkInvocationId = /^mattermost:fork:slash:[a-f0-9]{64}$/u;

export function buildMattermostNativeForkInvocationId(triggerId: string): string {
  return nativeForkInvocationPrefix + createHash("sha256").update(triggerId).digest("hex");
}

function literalFence(text: string, minimum: number): string {
  const width = (text.match(/`+/gu) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length + 1),
    minimum,
  );
  return "`".repeat(width);
}

export const prepareMattermostFork: PrepareFork = async (params) => {
  const { source, sourceMessageId, senderId } = params;
  const channelId = source.parentConversationId?.replace(/^channel:/iu, "");
  const rootId = source.threadId;
  const isNativeInvocation = sourceMessageId !== undefined && nativeForkInvocationId.test(sourceMessageId);
  if (
    !params.isGroup ||
    !channelId || !nativeId.test(channelId) ||
    !rootId || !nativeId.test(rootId) || source.conversationId !== rootId ||
    !sourceMessageId || (!isNativeInvocation && !nativeId.test(sourceMessageId)) || sourceMessageId === rootId ||
    !senderId || !nativeId.test(senderId)
  ) {
    return {
      ok: false,
      reason: "Run /fork [title] inside an existing Mattermost channel thread, or mention the bot with the command in a thread reply.",
    };
  }
  const title = params.title ?? "Forked conversation";
  if (!title.trim() || /[\r\n]/u.test(title)) {
    return { ok: false, reason: "Use a non-empty, single-line /fork title." };
  }
  const readConfig = createRuntimeConfigReader(params.cfg);
  const account = resolveMattermostAccount({ cfg: readConfig(), accountId: params.accountId });
  if (!account.enabled || !account.baseUrl || !account.botToken) {
    return { ok: false, reason: "The selected Mattermost account is unavailable for forking." };
  }
  const titleFence = literalFence(title, 1);
  const renderedTitle = `${titleFence} ${title} ${titleFence}`;
  if (renderedTitle.length > resolveMattermostTextLimit(account)) {
    return { ok: false, reason: "The /fork title exceeds this Mattermost account's post size limit." };
  }
  const assertCurrent = () => {
    params.assertCurrent();
    params.signal?.throwIfAborted();
    const current = resolveMattermostAccount({
      cfg: readConfig(),
      accountId: account.accountId,
    });
    if (!isDeepStrictEqual(current, account)) {
      throw new Error("Mattermost account or policy changed. Send a new /fork request.");
    }
  };
  const client = createMattermostClient({
    baseUrl: account.baseUrl,
    botToken: account.botToken,
    allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
    assertRequestCurrent: assertCurrent,
  });
  const verifySource = async () => {
    const [channel, command, root, bot] = await Promise.all([
      fetchMattermostChannel(client, channelId),
      isNativeInvocation ? undefined : fetchMattermostPost(client, sourceMessageId),
      fetchMattermostPost(client, rootId),
      fetchMattermostMe(client),
    ]);
    assertCurrent();
    if (
      channel.id !== channelId || channel.delete_at || (channel.type !== "O" && channel.type !== "P") ||
      (!isNativeInvocation && (
        !command || command.id !== sourceMessageId || command.channel_id !== channelId ||
        command.root_id !== rootId || command.user_id !== senderId || command.delete_at ||
        isMattermostSystemPost(command)
      )) ||
      root.id !== rootId || root.channel_id !== channelId || root.root_id || root.delete_at ||
      isMattermostSystemPost(root) || !nativeId.test(bot.id) || bot.id === senderId
    ) {
      throw new Error("Mattermost could not verify the command and its active channel thread.");
    }
    await Promise.all([senderId, bot.id].map(async (userId) => {
      const member = await client.request<{ channel_id: string; user_id: string }>(
        `/channels/${channelId}/members/${userId}`,
        { signal: params.signal },
      );
      if (member?.channel_id !== channelId || member.user_id !== userId) {
        throw new Error("Mattermost could not verify current channel membership.");
      }
    }));
    assertCurrent();
  };
  assertCurrent();
  try {
    await verifySource();
  } catch {
    assertCurrent();
    return { ok: false, reason: "Mattermost could not verify the source thread and current channel membership." };
  }
  let creation: { sessionKey: string; result: ReturnType<PreparedFork["create"]> } | undefined;
  return {
    ok: true,
    assertCurrent,
    formatRecap: (text) => {
      const fence = literalFence(text, 3);
      return { text: `${fence}\n${text}\n${fence}` };
    },
    create: async (targetSessionKey) => {
      if (creation) {
        if (creation.sessionKey !== targetSessionKey) {
          throw new Error("This Mattermost fork already selected a different copied session.");
        }
        return await creation.result;
      }
      const result = (async () => {
        assertCurrent();
        await verifySource();
        let forkRootId: string;
        try {
          const post = await createMattermostPost(client, {
            channelId,
            message: renderedTitle,
          });
          if (!nativeId.test(post.id) || post.channel_id !== channelId || post.root_id) {
            throw new Error("Mattermost did not return a matching top-level post.");
          }
          forkRootId = post.id;
        } catch (error) {
          throw new Error(
            "Mattermost root creation was unconfirmed. Check the channel before retrying.",
            { cause: error },
          );
        }
        try {
          assertCurrent();
          const binding = await getSessionBindingService().bind({
            targetSessionKey,
            targetKind: "session",
            placement: "current",
            conversation: {
              channel: "mattermost",
              accountId: account.accountId,
              conversationId: forkRootId,
              parentConversationId: channelId,
            },
            assertCurrent,
          });
          assertCurrent();
          return {
            binding,
            url: `${client.baseUrl}/_redirect/pl/${forkRootId}`,
            notice: "The fork stays in the same Mattermost channel and has the same channel audience.",
          };
        } catch (error) {
          throw new Error(
            `Mattermost root ${forkRootId} was created, but fork binding did not finish. Check the root before retrying.`,
            { cause: error },
          );
        }
      })();
      creation = { sessionKey: targetSessionKey, result };
      return await result;
    },
  };
};
