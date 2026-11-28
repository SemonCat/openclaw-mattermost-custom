import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { getSessionBindingService } from "openclaw/plugin-sdk/session-binding-runtime";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveMattermostAccount } from "./accounts.js";
import {
  assertMattermostTeamChannel,
  createMattermostPrivateTeamChannel,
  findMattermostTeamChannel,
  hasMattermostChannelAccessPolicy,
  listMattermostChannelAudience,
  mattermostNativeId as nativeId,
  readMattermostChannelSlug,
  verifyMattermostChannelActors,
  verifyMattermostPrivateChannelAudience,
} from "./channel-create.js";
import {
  createMattermostClient,
  createMattermostPost,
  fetchMattermostChannel,
  fetchMattermostMe,
  fetchMattermostPost,
  isMattermostSystemPost,
  type MattermostChannel,
  type MattermostClient,
} from "./client.js";
import { resolveMattermostTextLimit } from "./text-limits.js";

type PrepareFork = NonNullable<NonNullable<ChannelPlugin["conversationBindings"]>["prepareFork"]>;
type PreparedFork = Extract<Awaited<ReturnType<PrepareFork>>, { ok: true }>;

const nativeForkInvocationPrefix = "mattermost:fork:slash:";
const nativeForkInvocationId = /^mattermost:fork:slash:[a-f0-9]{64}$/u;
const defaultForkTitle = "Forked conversation";
const forkDestinationUsage = "Use /fork --channel <~slug|slug|channel:ID> [title].";

type ForkDestination = { id: string } | { name: string };
type ForkAudience = {
  sourceId: string;
  channelId: string;
  teamId: string;
  requesterId: string;
  botId: string;
  privateName?: string;
};

function parseForkTitle(rawTitle?: string): { title: string; destination?: ForkDestination } {
  if (rawTitle !== undefined && (!rawTitle.trim() || /[\r\n]/u.test(rawTitle))) {
    throw new Error("Use a non-empty, single-line /fork title.");
  }
  if (!rawTitle || !/^--channel(?:\s|$)/u.test(rawTitle)) {
    return { title: rawTitle ?? defaultForkTitle };
  }
  const match = /^--channel\s+(\S+)(?:\s+(.*))?$/u.exec(rawTitle.trimEnd());
  const target = match?.[1];
  if (!target) throw new Error(forkDestinationUsage);
  const title = match?.[2];
  if (target.startsWith("channel:")) {
    const id = target.slice("channel:".length);
    if (!nativeId.test(id)) throw new Error(forkDestinationUsage);
    return { title: title ?? defaultForkTitle, destination: { id } };
  }
  return {
    title: title ?? defaultForkTitle,
    destination: { name: readMattermostChannelSlug(target.replace(/^~/u, "")) },
  };
}

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

async function verifyForkAudience(client: MattermostClient, audience: ForkAudience): Promise<void> {
  const { sourceId, channelId, teamId, requesterId, botId, privateName } = audience;
  const actors = { requesterId, botId };
  const [source, destination] = await Promise.all([
    fetchMattermostChannel(client, sourceId), fetchMattermostChannel(client, channelId),
  ]);
  assertMattermostTeamChannel(source, teamId, sourceId);
  assertMattermostTeamChannel(destination, teamId, channelId);
  if (hasMattermostChannelAccessPolicy(source) || hasMattermostChannelAccessPolicy(destination) ||
      destination.discoverable ||
      (destination.type === "O" && (
        source.type !== "O" || source.group_constrained || destination.group_constrained
      ))) {
    throw new Error("Mattermost could not verify the destination is restricted to the source audience.");
  }
  const [sourceMembers, targetMembers] = await Promise.all([
    listMattermostChannelAudience(client, sourceId),
    privateName === undefined
      ? listMattermostChannelAudience(client, channelId)
      : verifyMattermostPrivateChannelAudience(client, destination, { teamId, actors }, privateName),
    verifyMattermostChannelActors(client, sourceId, actors),
    verifyMattermostChannelActors(client, channelId, actors),
  ]);
  if (!targetMembers.has(requesterId) || !targetMembers.has(botId) ||
      [...targetMembers].some((userId) => !sourceMembers.has(userId))) {
    throw new Error("Mattermost fork destination membership must be contained in the source audience.");
  }
}

export async function verifyMattermostForkRecap(params: {
  client: MattermostClient;
  channelId: string;
  rootId?: string;
  scope: unknown;
}): Promise<void> {
  const { client, channelId, rootId, scope } = params;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new Error("Mattermost fork recap has invalid audience scope.");
  }
  const { sourceId, channelId: targetId, teamId, requesterId, botId, privateName, forkRootId } =
    scope as Record<string, unknown>;
  if (typeof sourceId !== "string" || !nativeId.test(sourceId) || sourceId === channelId ||
      targetId !== channelId || !nativeId.test(channelId) || !rootId || !nativeId.test(rootId) ||
      forkRootId !== rootId || typeof teamId !== "string" || !nativeId.test(teamId) ||
      typeof requesterId !== "string" || !nativeId.test(requesterId) ||
      typeof botId !== "string" || !nativeId.test(botId) || botId === requesterId ||
      (privateName !== undefined && typeof privateName !== "string")) {
    throw new Error("Mattermost fork recap does not match its verified native destination.");
  }
  const [root, bot] = await Promise.all([fetchMattermostPost(client, rootId), fetchMattermostMe(client)]);
  if (root.id !== rootId || root.channel_id !== channelId || root.root_id || root.delete_at ||
      root.user_id !== botId || bot.id !== botId) {
    throw new Error("Mattermost could not confirm the fork root and bot identity for recap delivery.");
  }
  await verifyForkAudience(client, { sourceId, channelId, teamId, requesterId, botId, privateName });
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
  let parsedTitle: ReturnType<typeof parseForkTitle>;
  try {
    parsedTitle = parseForkTitle(params.title);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : forkDestinationUsage };
  }
  const { title, destination } = parsedTitle;
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
    await verifyMattermostChannelActors(client, channelId, { requesterId: senderId, botId: bot.id }, params.signal);
    assertCurrent();
    return { channel, botId: bot.id };
  };
  let sourceState: Awaited<ReturnType<typeof verifySource>>;
  assertCurrent();
  try {
    sourceState = await verifySource();
  } catch {
    assertCurrent();
    return { ok: false, reason: "Mattermost could not verify the source thread and current channel membership." };
  }
  let placement: { audience: ForkAudience } | { teamId: string; name: string } | undefined;
  if (destination) {
    try {
      const teamId = sourceState.channel.team_id;
      if (!teamId || !nativeId.test(teamId)) {
        throw new Error("Mattermost could not verify the source team.");
      }
      const target: MattermostChannel | undefined = "id" in destination
        ? await fetchMattermostChannel(client, destination.id)
        : await findMattermostTeamChannel(client, teamId, destination.name);
      if (target) {
        assertMattermostTeamChannel(target, teamId, "id" in destination ? destination.id : target.id);
        if ("name" in destination && target.name !== destination.name) {
          throw new Error("Mattermost did not return the requested channel name.");
        }
        if (target.id !== channelId) {
          const audience = {
            sourceId: channelId, channelId: target.id, teamId, requesterId: senderId, botId: sourceState.botId,
          };
          await verifyForkAudience(client, audience);
          placement = { audience };
        }
      } else if ("name" in destination && !hasMattermostChannelAccessPolicy(sourceState.channel)) {
        placement = { teamId, name: destination.name };
      } else {
        throw new Error("Mattermost could not verify the requested channel.");
      }
    } catch {
      assertCurrent();
      return { ok: false, reason: "Mattermost could not verify the requested channel, team, or audience for this fork." };
    }
  }
  const verifyOrigin = async (teamId: string) => {
    const current = await verifySource();
    assertMattermostTeamChannel(current.channel, teamId, channelId);
    if (current.botId !== sourceState.botId || hasMattermostChannelAccessPolicy(current.channel)) {
      throw new Error("The Mattermost source channel or bot authority changed. Send a new /fork request.");
    }
  };
  let recapScope: (ForkAudience & { forkRootId: string }) | undefined;
  let creation: { sessionKey: string; result: ReturnType<PreparedFork["create"]> } | undefined;
  return {
    ok: true,
    assertCurrent,
    formatRecap: (text) => {
      const fence = literalFence(text, 3);
      return {
        text: `${fence}\n${text}\n${fence}`,
        ...(recapScope ? { channelData: { mattermost: { forkRecap: recapScope } } } : {}),
      };
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
        let audience: ForkAudience | undefined;
        if (placement) {
          if ("audience" in placement) {
            audience = placement.audience;
          } else {
            const { teamId, name } = placement;
            const actors = { requesterId: senderId, botId: sourceState.botId };
            const { channel } = await createMattermostPrivateTeamChannel(client, {
              teamId, name, actors, verifyOrigin: () => verifyOrigin(teamId),
            });
            audience = { sourceId: channelId, channelId: channel.id, teamId, ...actors, privateName: name };
          }
          await verifyOrigin(audience.teamId);
          await verifyForkAudience(client, audience);
        } else {
          await verifySource();
        }
        const destinationId = audience?.channelId ?? channelId;
        let forkRootId: string;
        try {
          const post = await createMattermostPost(client, {
            channelId: destinationId,
            message: renderedTitle,
          });
          if (!nativeId.test(post.id) || post.channel_id !== destinationId || post.root_id ||
              (audience && post.user_id !== audience.botId)) {
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
          if (audience) {
            await verifyOrigin(audience.teamId);
            await verifyForkAudience(client, audience);
          }
          assertCurrent();
          const binding = await getSessionBindingService().bind({
            targetSessionKey,
            targetKind: "session",
            placement: "current",
            conversation: {
              channel: "mattermost",
              accountId: account.accountId,
              conversationId: forkRootId,
              parentConversationId: destinationId,
            },
            assertCurrent,
          });
          assertCurrent();
          if (audience) recapScope = { ...audience, forkRootId };
          return {
            binding,
            url: `${client.baseUrl}/_redirect/pl/${forkRootId}`,
            notice: audience
              ? "The fork is in the selected Mattermost channel with a verified source-contained audience."
              : "The fork stays in the same Mattermost channel and has the same channel audience.",
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
