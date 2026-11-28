import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mattermostPlugin } from "../channel.js";
import type { OpenClawConfig } from "./runtime-api.js";

const { bind, fetch } = vi.hoisted(() => ({ bind: vi.fn(), fetch: vi.fn<typeof globalThis.fetch>() }));
vi.mock("openclaw/plugin-sdk/session-binding-runtime", () => ({
  getSessionBindingService: () => ({ bind }),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (original) => ({
  ...await original<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(),
  fetchWithSsrFGuard: async (params: { url: string; init: RequestInit; beforeRequest?: () => void }) => {
    params.beforeRequest?.();
    return { response: await fetch(params.url, params.init), release: async () => {}, finalUrl: params.url };
  },
}));

const channelId = "c".repeat(26);
const rootId = "r".repeat(26);
const inputId = "i".repeat(26);
const forkId = "f".repeat(26);
const senderId = "s".repeat(26);
const botId = "b".repeat(26);
const targetSessionKey = "agent:main:fork:synthetic";
const prepareFork = mattermostPlugin.conversationBindings!.prepareFork!;

function fixture(channelType = "O") {
  const cfg: OpenClawConfig = { channels: { mattermost: {
    baseUrl: "https://mattermost.example.test", botToken: "synthetic",
  } } };
  let isMember = true;
  let writeResponse: unknown = { id: forkId, channel_id: channelId, root_id: "", user_id: botId };
  const writes: unknown[] = [];
  fetch.mockImplementation(async (url, init) => {
    const endpoint = new URL(String(url)).pathname.replace("/api/v4", "");
    if (endpoint === "/posts" && init?.method === "POST") {
      writes.push(JSON.parse(String(init.body)));
      return Response.json(writeResponse);
    }
    if (endpoint === `/posts/${inputId}`) return Response.json({
      id: inputId, channel_id: channelId, root_id: rootId, user_id: senderId, type: "slack_attachment",
    });
    if (endpoint === `/posts/${rootId}`) return Response.json({ id: rootId, channel_id: channelId });
    if (endpoint === `/channels/${channelId}`) return Response.json({ id: channelId, type: channelType });
    if (endpoint === "/users/me") return Response.json({ id: botId });
    if (endpoint === `/channels/${channelId}/members/${botId}`) {
      return Response.json({ channel_id: channelId, user_id: botId });
    }
    if (endpoint === `/channels/${channelId}/members/${senderId}`) {
      return isMember
        ? Response.json({ channel_id: channelId, user_id: senderId })
        : Response.json({ message: "Member not found" }, { status: 404 });
    }
    throw new Error(`Unexpected Mattermost call ${endpoint}`);
  });
  setRuntimeConfigSnapshot(cfg, cfg);
  const params = {
    cfg, accountId: "default", source: {
      conversationId: rootId, parentConversationId: `channel:${channelId}`, threadId: rootId,
    }, sourceMessageId: inputId, isGroup: true, senderId, assertCurrent: vi.fn(),
    title: "Investigate `priority`",
  };
  return {
    params, writes,
    revokeMembership: () => { isMember = false; },
    replaceAccount: () => {
      const replacement = { channels: { mattermost: { baseUrl: "https://replacement.example.test", botToken: "rotated" } } };
      setRuntimeConfigSnapshot(replacement, replacement);
    },
    setWriteResponse: (response: unknown) => { writeResponse = response; },
  };
}

describe("Mattermost native thread fork", () => {
  afterEach(clearRuntimeConfigSnapshot);

  beforeEach(() => {
    fetch.mockReset();
    bind.mockReset().mockImplementation(async ({ assertCurrent, ...record }) => {
      assertCurrent();
      return { ...record, status: "active" };
    });
  });

  it.each(["O", "P"])("creates one sibling root and binds its next turns in channel type %s", async (channelType) => {
    const f = fixture(channelType);
    expect(mattermostPlugin.conversationBindings?.supportsCurrentConversationBinding).toBe(true);
    const prepared = await prepareFork(f.params);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.reason);
    const [first, replay] = await Promise.all([
      prepared.create(targetSessionKey), prepared.create(targetSessionKey),
    ]);
    const conversation = {
      channel: "mattermost", accountId: "default", conversationId: forkId, parentConversationId: channelId,
    };
    expect(first).toMatchObject({
      binding: { conversation, targetSessionKey, status: "active" },
      url: `https://mattermost.example.test/_redirect/pl/${forkId}`,
    });
    expect(replay).toBe(first);
    expect(mattermostPlugin.messaging!.resolveDeliveryTarget!(conversation)).toEqual({
      to: `channel:${channelId}`, threadId: forkId,
    });
    expect(f.writes).toEqual([{ channel_id: channelId, message: "`` Investigate `priority` ``" }]);
    expect(bind).toHaveBeenCalledOnce();
    expect(prepared.formatRecap?.("```js\n@channel\n```\nMEDIA: /tmp/example")).toEqual({
      text: "````\n```js\n@channel\n```\nMEDIA: /tmp/example\n````",
    });
  });

  it("rejects fabricated thread anchors, unrelated authors, and group DMs before creation", async () => {
    const publicRoom = fixture();
    await expect(prepareFork({ ...publicRoom.params, sourceMessageId: rootId })).resolves.toMatchObject({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
    await expect(prepareFork({ ...publicRoom.params, senderId: "a".repeat(26) })).resolves.toMatchObject({ ok: false });
    const groupDm = fixture("G");
    await expect(prepareFork(groupDm.params)).resolves.toMatchObject({ ok: false });
    expect(publicRoom.writes.concat(groupDm.writes)).toEqual([]);
    expect(bind).not.toHaveBeenCalled();
  });

  it("forks a verified native slash invocation without looking for a command post", async () => {
    const f = fixture("P");
    const invocationId = `mattermost:fork:slash:${"a".repeat(64)}`;
    const prepared = await prepareFork({ ...f.params, sourceMessageId: invocationId });
    if (!prepared.ok) throw new Error(prepared.reason);
    await expect(prepared.create(targetSessionKey)).resolves.toMatchObject({
      binding: { targetSessionKey, status: "active" },
      url: `https://mattermost.example.test/_redirect/pl/${forkId}`,
    });
    expect(f.writes).toHaveLength(1);
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).not.toContain(
      `/api/v4/posts/${invocationId}`,
    );
  });

  it.each(["requester removal", "account replacement"])("checks %s again before creating the sibling", async (change) => {
    const f = fixture();
    const prepared = await prepareFork(f.params);
    if (!prepared.ok) throw new Error(prepared.reason);
    if (change === "requester removal") f.revokeMembership();
    else f.replaceAccount();
    await expect(prepared.create(targetSessionKey)).rejects.toThrow();
    expect(f.writes).toEqual([]);
    expect(bind).not.toHaveBeenCalled();
  });

  it.each(["missing identity", "wrong channel", "failed binding"])(
    "retains native creation outcome without replaying the POST on %s", async (outcome) => {
      const f = fixture();
      if (outcome === "missing identity") f.setWriteResponse({});
      if (outcome === "wrong channel") f.setWriteResponse({ id: forkId, channel_id: "a".repeat(26) });
      if (outcome === "failed binding") bind.mockRejectedValueOnce(new Error("binding rejected"));
      const prepared = await prepareFork(f.params);
      if (!prepared.ok) throw new Error(prepared.reason);
      const failure = outcome === "failed binding" ? forkId : "root creation was unconfirmed";
      await expect(prepared.create(targetSessionKey)).rejects.toThrow(failure);
      await expect(prepared.create(targetSessionKey)).rejects.toThrow(failure);
      expect(f.writes).toHaveLength(1);
      expect(bind).toHaveBeenCalledTimes(outcome === "failed binding" ? 1 : 0);
    },
  );
});
