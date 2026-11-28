import { afterEach, describe, expect, it, vi } from "vitest";
import { mattermostPlugin } from "../channel.js";
import type { OpenClawConfig } from "./runtime-api.js";

const fetch = vi.hoisted(() => vi.fn<typeof globalThis.fetch>());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (original) => ({
  ...await original<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(),
  fetchWithSsrFGuard: async (params: { url: string; init: RequestInit; beforeRequest?: () => void }) => {
    params.beforeRequest?.();
    return { response: await fetch(params.url, params.init), release: async () => {}, finalUrl: params.url };
  },
}));

const sourceId = "c".repeat(26);
const roomId = "r".repeat(26);
const senderId = "s".repeat(26);
const botId = "b".repeat(26);
const otherId = "o".repeat(26);
const teamId = "t".repeat(26);
const cfg: OpenClawConfig = {
  channels: { mattermost: { baseUrl: "https://mattermost.example.test", botToken: "synthetic" } },
};
const actions = mattermostPlugin.actions!;

function fixture(options: {
  name?: string;
  direct?: boolean;
  senderIsTeamMember?: boolean;
  lookupStatus?: number;
  creationRace?: "already-member" | "not-member" | "other-owner" | "unconfirmed";
  loseMembershipResponse?: boolean;
} = {}) {
  const created = { id: roomId, team_id: teamId, name: options.name ?? "discussion", type: "P", creator_id: botId };
  const channelMembers = new Set([botId, senderId]);
  const newMembers = new Set([botId]);
  const writes: Array<[string, unknown]> = [];
  let found = false;
  const notFound = () => Response.json(
    { id: "app.channel.get_by_name.missing.app_error" }, { status: 404 },
  );
  fetch.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const endpoint = url.pathname.replace("/api/v4", "");
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      writes.push([endpoint, body]);
      if (endpoint === "/channels") {
        if (options.creationRace) {
          if (options.creationRace === "unconfirmed") {
            return Response.json({ id: "app.channel.create_channel.internal_error" }, { status: 500 });
          }
          found = true;
          if (options.creationRace === "already-member") newMembers.add(senderId);
          if (options.creationRace === "other-owner") created.creator_id = otherId;
          return Response.json({ id: "store.sql_channel.save_channel.exists.app_error" }, { status: 400 });
        }
        found = true;
        return Response.json(created, { status: 201 });
      }
      if (endpoint === `/channels/${roomId}/members`) {
        newMembers.add(body.user_id);
        if (options.loseMembershipResponse) {
          return Response.json({ id: "app.channel.add_member.error" }, { status: 500 });
        }
        return Response.json({ channel_id: roomId, user_id: body.user_id }, { status: 201 });
      }
    }
    if (endpoint === "/users/me") return Response.json({ id: botId });
    if (endpoint === `/channels/${sourceId}`) {
      return Response.json({
        id: sourceId, team_id: options.direct ? "" : teamId, type: options.direct ? "D" : "O",
      });
    }
    if (endpoint === `/channels/${roomId}` && found) return Response.json(created);
    if (endpoint === `/teams/${teamId}/channels/name/${created.name}`) {
      expect(url.searchParams.get("include_deleted")).toBe("true");
      if (options.lookupStatus) return Response.json({ id: "other.error" }, { status: options.lookupStatus });
      return found ? Response.json(created) : notFound();
    }
    if (endpoint === `/teams/${teamId}/members/${botId}` ||
        (endpoint === `/teams/${teamId}/members/${senderId}` && options.senderIsTeamMember !== false)) {
      return Response.json({ team_id: teamId, user_id: endpoint.split("/").at(-1), delete_at: 0 });
    }
    for (const [id, members] of [[sourceId, channelMembers], [roomId, newMembers]] as const) {
      if (endpoint === `/channels/${id}/members`) {
        return Response.json([...members].map((user_id) => ({ channel_id: id, user_id })));
      }
      if (endpoint.startsWith(`/channels/${id}/members/`)) {
        const userId = endpoint.split("/").at(-1)!;
        return members.has(userId) ? Response.json({ channel_id: id, user_id: userId }) : notFound();
      }
    }
    return notFound();
  });
  return { writes, created, newMembers, channelMembers, showExisting: () => { found = true; } };
}

function create(overrides: Partial<Parameters<NonNullable<typeof actions.handleAction>>[0]> = {}) {
  return actions.handleAction!({
    cfg, action: "channel-create", channel: "mattermost", accountId: "default",
    params: { name: "discussion" }, requesterSenderId: senderId, requesterAccountId: "default",
    toolContext: { currentChannelProvider: "mattermost", currentChannelId: `channel:${sourceId}` },
    ...overrides,
  });
}

describe("Mattermost message tool channel-create", () => {
  afterEach(() => fetch.mockReset());

  it.each(["discussion", "x"])("creates private channel %s in the trusted current team and adds the requester once", async (name) => {
    const { writes } = fixture({ name });
    expect(actions.describeMessageTool!({ cfg })?.actions).toContain("channel-create");
    await expect(create({ params: { name } })).resolves.toMatchObject({
      details: { ok: true, channelId: roomId, teamId, name, created: true },
    });
    await expect(create({ params: { name } })).resolves.toMatchObject({
      details: { channelId: roomId, created: false },
    });
    expect(writes).toEqual([
      ["/channels", { name, display_name: name, type: "P", team_id: teamId }],
      [`/channels/${roomId}/members`, { user_id: senderId }],
    ]);
  });

  it("requires an explicit verified team for a two-party DM", async () => {
    const { writes } = fixture({ direct: true });
    await expect(create()).rejects.toThrow(/teamId/u);
    expect(writes).toEqual([]);
    await expect(create({ params: { name: "discussion", teamId } })).resolves.toMatchObject({
      details: { channelId: roomId, teamId, created: true },
    });
  });

  it("denies a DM with a foreign participant or a requester outside the selected team", async () => {
    const first = fixture({ direct: true });
    first.channelMembers.add(otherId);
    await expect(create({ params: { name: "discussion", teamId } })).rejects.toThrow();
    const second = fixture({ direct: true, senderIsTeamMember: false });
    await expect(create({ params: { name: "discussion", teamId } })).rejects.toThrow();
    expect([...first.writes, ...second.writes]).toEqual([]);
  });

  it("takes authority from the host and refuses a conflicting explicit team", async () => {
    const { writes } = fixture();
    await expect(create({
      requesterSenderId: undefined,
      params: { name: "discussion", requesterSenderId: senderId },
    })).rejects.toThrow();
    await expect(create({ requesterAccountId: "other" })).rejects.toThrow();
    await expect(create({ params: { name: "discussion", teamId: otherId } })).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  it("does not add itself or a requester to a room it did not positively create", async () => {
    const { writes, showExisting, created } = fixture();
    showExisting();
    await expect(create()).rejects.toThrow(/already exists/u);
    created.creator_id = otherId;
    await expect(create()).rejects.toThrow(/already exists/u);
    expect(writes).toEqual([]);
  });

  it.each([403, 404, 500])("does not create on a non-absence lookup response (%s)", async (lookupStatus) => {
    const { writes } = fixture({ lookupStatus });
    await expect(create()).rejects.toThrow(/look up/u);
    expect(writes).toEqual([]);
  });

  it("reports a racing creation only when readback proves access without adding a member", async () => {
    const { writes } = fixture({ creationRace: "already-member" });
    await expect(create()).resolves.toMatchObject({ details: { channelId: roomId, created: false } });
    expect(writes.map(([endpoint]) => endpoint)).toEqual(["/channels"]);
  });

  it.each(["other-owner", "not-member", "unconfirmed"] as const)(
    "does not add or retry when a creation response is %s",
    async (creationRace) => {
      const { writes } = fixture({ creationRace });
      await expect(create()).rejects.toThrow();
      expect(writes.map(([endpoint]) => endpoint)).toEqual(["/channels"]);
    },
  );

  it("settles an ambiguous member response by readback without repeating the membership mutation", async () => {
    const { writes } = fixture({ loseMembershipResponse: true });
    await expect(create()).resolves.toMatchObject({ details: { channelId: roomId, created: true } });
    expect(writes.map(([endpoint]) => endpoint)).toEqual(["/channels", `/channels/${roomId}/members`]);
  });
});
