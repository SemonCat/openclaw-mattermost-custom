import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-id";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveMattermostAccount } from "./accounts.js";
import {
  MattermostApiError,
  createMattermostClient,
  fetchMattermostChannel,
  fetchMattermostChannelByName,
  fetchMattermostMe,
  type MattermostChannel,
  type MattermostClient,
} from "./client.js";
import type { OpenClawConfig } from "./runtime-api.js";

export const mattermostNativeId = /^[a-z0-9]{26}$/u;
const nativeChannelContext = /^(?:(?:mattermost:)?(?:channel|group):)?([a-z0-9]{26})$/iu;
const channelSlug = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const pageSize = 200;
const maxMemberPages = 10;

type ChannelMember = { channel_id: string; user_id: string };
type ChannelActors = { requesterId: string; botId: string };
type ChannelTeam = { teamId: string; actors: ChannelActors };

export function readMattermostChannelSlug(raw: string): string {
  const name = raw.trim();
  if (!channelSlug.test(name)) {
    throw new Error("Use a 1–64 character Mattermost channel slug starting with a lowercase letter or digit.");
  }
  return name;
}

export async function findMattermostTeamChannel(
  client: MattermostClient,
  teamId: string,
  name: string,
): Promise<MattermostChannel | undefined> {
  try {
    return await fetchMattermostChannelByName(client, teamId, name, true);
  } catch (error) {
    if (error instanceof MattermostApiError && error.status === 404 &&
        error.errorId === "app.channel.get_by_name.missing.app_error") {
      return undefined;
    }
    throw new Error("Mattermost could not safely look up the requested channel.", { cause: error });
  }
}

export function assertMattermostTeamChannel(channel: MattermostChannel, teamId: string, channelId: string) {
  if (channel?.id !== channelId || !mattermostNativeId.test(channel.id) ||
      channel.team_id !== teamId || channel.delete_at ||
      (channel.type !== "P" && channel.type !== "O")) {
    throw new Error("Mattermost could not verify an active channel in the current team.");
  }
}

export async function verifyMattermostChannelActors(
  client: MattermostClient,
  channelId: string,
  { requesterId, botId }: ChannelActors,
  signal?: AbortSignal,
): Promise<void> {
  await Promise.all([requesterId, botId].map(async (userId) => {
    const member = await client.request<ChannelMember>(`/channels/${channelId}/members/${userId}`, { signal });
    if (member?.channel_id !== channelId || member.user_id !== userId) {
      throw new Error("Mattermost could not verify current channel membership.");
    }
  }));
}

export async function listMattermostChannelAudience(client: MattermostClient, channelId: string): Promise<Set<string>> {
  const audience = new Set<string>();
  for (let page = 0; page < maxMemberPages; page += 1) {
    const members = await client.request<ChannelMember[]>(
      `/channels/${channelId}/members?page=${page}&per_page=${pageSize}`,
    );
    if (!Array.isArray(members) || members.length > pageSize) break;
    for (const member of members) {
      if (member?.channel_id !== channelId || !mattermostNativeId.test(member.user_id) ||
          audience.has(member.user_id)) {
        throw new Error("Mattermost returned an unverifiable channel audience.");
      }
      audience.add(member.user_id);
    }
    if (members.length < pageSize) return audience;
  }
  throw new Error("Mattermost could not verify the complete channel audience.");
}

export function hasMattermostChannelAccessPolicy(channel: MattermostChannel): boolean {
  return Boolean(
    channel.shared || channel.scheme_id || channel.policy_id || channel.policy_enforced || channel.policy_auto_add,
  );
}

async function verifyMattermostTeamActors(client: MattermostClient, { teamId, actors }: ChannelTeam) {
  await Promise.all([actors.requesterId, actors.botId].map(async (userId) => {
    const member = await client.request<{ team_id: string; user_id: string; delete_at?: number }>(
      `/teams/${teamId}/members/${userId}`,
    );
    if (member?.team_id !== teamId || member.user_id !== userId || member.delete_at) {
      throw new Error("Mattermost could not verify active team membership.");
    }
  }));
}

function assertPrivateOwnedChannel(
  channel: MattermostChannel,
  scope: ChannelTeam,
  name: string,
) {
  assertMattermostTeamChannel(channel, scope.teamId, channel?.id);
  if (channel.name !== name || channel.type !== "P" || channel.creator_id !== scope.actors.botId ||
      channel.discoverable || channel.group_constrained || hasMattermostChannelAccessPolicy(channel)) {
    throw new Error("Mattermost could not verify the private channel owner and settings.");
  }
}

export async function verifyMattermostPrivateChannelAudience(
  client: MattermostClient,
  channel: MattermostChannel,
  scope: ChannelTeam,
  name: string,
  requireRequester = true,
): Promise<Set<string>> {
  assertPrivateOwnedChannel(channel, scope, name);
  const { botId, requesterId } = scope.actors;
  const members = await listMattermostChannelAudience(client, channel.id);
  if (!members.has(botId) || (requireRequester && !members.has(requesterId)) ||
      [...members].some((userId) => userId !== botId && userId !== requesterId)) {
    throw new Error("Mattermost could not verify the bot and requester as the private channel audience.");
  }
  return members;
}

export async function createMattermostPrivateTeamChannel(
  client: MattermostClient,
  scope: ChannelTeam & { name: string; verifyOrigin: () => Promise<unknown> },
): Promise<{ channel: MattermostChannel; created: boolean }> {
  const { teamId, name, actors, verifyOrigin } = scope;
  await verifyMattermostTeamActors(client, scope);
  const confirmExisting = async (channel: MattermostChannel) => {
    try {
      await verifyMattermostPrivateChannelAudience(client, channel, scope, name);
      await verifyMattermostChannelActors(client, channel.id, actors);
      await verifyOrigin();
    } catch (error) {
      throw new Error("A channel with that name already exists and is unavailable for this operation.", { cause: error });
    }
    return { channel, created: false };
  };
  const existing = await findMattermostTeamChannel(client, teamId, name);
  if (existing) return await confirmExisting(existing);

  await verifyOrigin();
  let created: MattermostChannel;
  try {
    created = await client.request<MattermostChannel>("/channels", {
      method: "POST",
      body: JSON.stringify({ name, display_name: name, team_id: teamId, type: "P" }),
    });
  } catch (error) {
    const readBack = await findMattermostTeamChannel(client, teamId, name).catch(() => undefined);
    if (readBack) return await confirmExisting(readBack);
    throw new Error("Mattermost did not confirm channel creation. Check whether the channel exists before trying again.", { cause: error });
  }

  try {
    assertPrivateOwnedChannel(created, scope, name);
    const verifyCreated = async (requireRequester: boolean) => {
      const channel = await fetchMattermostChannel(client, created.id);
      assertMattermostTeamChannel(channel, teamId, created.id);
      return await verifyMattermostPrivateChannelAudience(client, channel, scope, name, requireRequester);
    };
    const members = await verifyCreated(false);
    if (!members.has(actors.requesterId)) {
      await verifyMattermostTeamActors(client, scope);
      await verifyOrigin();
      if (!(await verifyCreated(false)).has(actors.requesterId)) {
        try {
          await client.request(`/channels/${created.id}/members`, {
            method: "POST",
            body: JSON.stringify({ user_id: actors.requesterId }),
          });
        } catch {
          await verifyCreated(true);
        }
      }
    }
    await verifyCreated(true);
    await verifyMattermostChannelActors(client, created.id, actors);
    return { channel: created, created: true };
  } catch (error) {
    throw new Error("Mattermost returned a channel creation receipt, but the private channel or requester membership could not be confirmed. Check the channel before trying again.", { cause: error });
  }
}

export async function createMattermostChannelForRequester(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  requesterAccountId?: string | null;
  requesterSenderId?: string | null;
  toolContext?: { currentChannelProvider?: string; currentChannelId?: string } | null;
  name: string;
  teamId?: string;
  assertCurrent?: () => void;
}) {
  const name = readMattermostChannelSlug(params.name);
  const requesterId = params.requesterSenderId?.trim();
  const channelId = params.toolContext?.currentChannelId?.trim().match(nativeChannelContext)?.[1];
  const readConfig = createRuntimeConfigReader(params.cfg);
  const cfg = readConfig();
  const account = resolveMattermostAccount({ cfg, accountId: params.accountId });
  if (!requesterId || !mattermostNativeId.test(requesterId) || !channelId ||
      !mattermostNativeId.test(channelId) ||
      params.toolContext?.currentChannelProvider?.trim().toLowerCase() !== "mattermost" ||
      normalizeOptionalAccountId(params.requesterAccountId) !== account.accountId ||
      !account.enabled || !account.baseUrl || !account.botToken) {
    throw new Error("Mattermost channel creation requires the trusted current Mattermost account, channel and requester.");
  }
  const client = createMattermostClient({
    baseUrl: account.baseUrl,
    botToken: account.botToken,
    allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
    assertRequestCurrent: () => {
      params.assertCurrent?.();
      if (!isDeepStrictEqual(account, resolveMattermostAccount({ cfg: readConfig(), accountId: account.accountId }))) {
        throw new Error("The Mattermost account changed. Send a new channel-create request.");
      }
    },
  });
  const [source, bot] = await Promise.all([
    fetchMattermostChannel(client, channelId), fetchMattermostMe(client),
  ]);
  if (!mattermostNativeId.test(bot.id) || requesterId === bot.id) {
    throw new Error("Mattermost could not verify distinct bot and requester identities.");
  }
  const actors = { requesterId, botId: bot.id };
  const direct = source?.type === "D";
  const teamId = direct ? params.teamId : source?.team_id;
  if (direct && !teamId) {
    throw new Error("Supply teamId to create a Mattermost channel from a direct message.");
  }
  if (!teamId || !mattermostNativeId.test(teamId) || (params.teamId !== undefined && params.teamId !== teamId)) {
    throw new Error("Mattermost requires an explicit valid team in a DM or the current team channel.");
  }
  const verifyOrigin = async () => {
    const current = await fetchMattermostChannel(client, channelId);
    if (direct) {
      if (current?.id !== channelId || current.type !== "D" || current.delete_at) {
        throw new Error("Mattermost could not verify the current direct channel.");
      }
      const members = await listMattermostChannelAudience(client, channelId);
      if (members.size !== 2 || !members.has(actors.botId) || !members.has(requesterId)) {
        throw new Error("Mattermost requires a direct channel between this bot and the requester.");
      }
    } else {
      assertMattermostTeamChannel(current, teamId, channelId);
    }
    await verifyMattermostChannelActors(client, channelId, actors);
  };
  await verifyOrigin();
  const result = await createMattermostPrivateTeamChannel(client, { teamId, actors, name, verifyOrigin });
  return { ok: true, channelId: result.channel.id, teamId, name, type: "private", created: result.created };
}
