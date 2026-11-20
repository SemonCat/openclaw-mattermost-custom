// Keep real policy, activation and HTTP request owners; replace network and state sinks.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveGlobalDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setMattermostRuntime } from "../runtime.js";
import { resolveMattermostAccount } from "./accounts.js";
import { createMattermostClient, type MattermostPost } from "./client.js";
import { createMattermostDeadLetterNotifier } from "./monitor-dead-letter.js";
import { createMattermostIngressQueue } from "./ingress-queue.js";
import { createMattermostIngressMonitor } from "./monitor-ingress.js";
import type { MattermostIngressPost } from "./monitor-ingress.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { recordMattermostThreadParticipation } from "./thread-participation.js";

const wire = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  beforeDispatch: vi.fn<(url: string) => void>(),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async original => ({
  ...await original<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(),
  fetchWithSsrFGuard: async (params: {
    url: string; init: RequestInit; beforeRequest?: () => void;
  }) => {
    wire.beforeDispatch(params.url);
    params.beforeRequest?.();
    return { response: await wire.fetch(params.url, params.init), release: async () => {}, finalUrl: params.url };
  },
}));
const participation = resolveGlobalDedupeCache(Symbol.for("openclaw.mattermostThreadParticipation"), {
  ttlMs: 7 * 24 * 60 * 60 * 1000, maxSize: 5000,
});
afterEach(() => {
  participation.clear();
  vi.restoreAllMocks();
});
let sequence = 0;
function fixture(kind: "D" | "O" = "D") {
  let cfg: OpenClawConfig = { channels: { mattermost: {
    baseUrl: `https://notice${++sequence}.example`, botToken: "fixture",
    dmPolicy: "open", allowFrom: ["*"], groupPolicy: "open", requireMention: false,
  } } };
  const post: MattermostIngressPost = {
    id: "post", user_id: "alice", channel_id: `room-${sequence}`,
    root_id: kind === "D" ? "" : `root-${sequence}`, message: "hello",
  };
  const currentPost: MattermostPost = { ...post };
  const writes: Record<string, unknown>[] = [];
  const abort = new AbortController();
  const readAllowFromStore = vi.fn(async () => [] as string[]);
  const upsertPairingRequest = vi.fn();
  const dispatch = vi.fn();
  const getSessionEntry = vi.fn();
  wire.beforeDispatch.mockReset();
  wire.fetch.mockReset().mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "POST") {
      writes.push(JSON.parse(init.body as string));
      return Response.json({ id: "notice", channel_id: post.channel_id });
    }
    if (path.endsWith("/posts/post")) return Response.json(currentPost);
    if (path.endsWith(`/posts/${post.root_id}`)) return Response.json({
      id: post.root_id, channel_id: post.channel_id, user_id: "bot",
    });
    if (path.endsWith(`/channels/${post.channel_id}`)) return Response.json({
      id: post.channel_id, type: kind,
    });
    if (path.endsWith("/users/alice")) return Response.json({ id: "alice", username: "ada" });
    throw new Error(`unexpected notice transport ${path}`);
  });
  const core = {
    config: { current: () => cfg },
    state: { openKeyedStoreV2: () => ({ lookup: async () => undefined, register: async () => {} }) },
    logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    channel: {
      commands: {
        shouldHandleTextCommands: () => false,
        isControlCommandMessage: () => false,
      },
      mentions: { buildMentionRegexes: () => [], matchesMentionPatterns: () => false },
      groups: { resolveRequireMention: ({ requireMentionOverride }: { requireMentionOverride?: boolean }) => requireMentionOverride ?? true },
      routing: { resolveAgentRoute: () => ({
        agentId: "main", accountId: "default", sessionKey: "agent:main:mattermost:fixture",
      }) },
      inbound: { dispatch },
    },
    agent: { session: { getSessionEntry } },
  };
  setMattermostRuntime(core as never);
  const monitor = {
    cfg, core, account: resolveMattermostAccount({ cfg }), botUserId: "bot", botUsername: "helper",
    client: createMattermostClient({ baseUrl: cfg.channels!.mattermost!.baseUrl!, botToken: "fixture" }),
    pairing: { readAllowFromStore, upsertPairingRequest },
    groupPolicy: "open", logVerboseMessage: vi.fn(), statusSink: vi.fn(),
    abortSignal: abort.signal,
  } as unknown as MattermostMonitorContext;
  const notify = createMattermostDeadLetterNotifier(monitor);
  return {
    post, currentPost, writes, abort, monitor, readAllowFromStore, upsertPairingRequest,
    dispatch, getSessionEntry,
    cfg: () => cfg,
    setCfg: (next: OpenClawConfig) => { cfg = next; },
    notify: (signal = new AbortController().signal) => notify(post, { event: "posted" }, signal),
  };
}

describe("Mattermost terminal ingress notices", () => {
  it("projects a committed real drain failure to the original provider thread exactly once in this drain", async () => {
    const f = fixture();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mm-terminal-notice-"));
    type Options = Parameters<typeof createMattermostIngressMonitor>[0];
    type Payload = Parameters<NonNullable<Options["queue"]>["enqueue"]>[1];
    const queue = createMattermostIngressQueue<Payload>({ accountId: "default", stateDir });
    const dispatch = vi.fn(async () => { throw new Error("Mattermost API 403: denied"); });
    const notifier = createMattermostDeadLetterNotifier(f.monitor);
    const monitor = createMattermostIngressMonitor({
      accountId: "default", queue, dispatch, runtime: { log: vi.fn(), error: vi.fn() },
      pollIntervalMs: 60_000,
      onDeadLetter: async (post, payload, signal) => {
        expect((await queue.listFailed()).map(row => row.id)).toEqual(["post"]);
        await notifier(post, payload, signal);
      },
    });
    const rawEvent = JSON.stringify({ event: "posted", data: { post: JSON.stringify(f.post) } });
    try {
      await monitor.receive(rawEvent);
      await monitor.waitForIdle();
      expect(f.writes).toHaveLength(1);
      expect(f.writes[0]).toMatchObject({ channel_id: f.post.channel_id, root_id: f.post.id });
      await monitor.receive(rawEvent);
      await monitor.waitForIdle();
      expect(dispatch).toHaveBeenCalledOnce();
      expect(f.writes).toHaveLength(1);
      expect(f.dispatch).not.toHaveBeenCalled();
    } finally {
      await monitor.stop();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it.each(["D", "O"] as const)("sends a static silent %s reply in the original thread without starting a turn", async kind => {
    const f = fixture(kind);
    await f.notify();
    expect(f.writes).toEqual([{
      channel_id: f.post.channel_id, root_id: f.post.root_id || f.post.id,
      message: "⚠️ Couldn't process this message. Automatic retries have stopped. Please try again.",
    }]);
    const postRequest = wire.fetch.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(String(postRequest[0])).toContain("/posts?silent=true");
    expect(postRequest[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.getSessionEntry).not.toHaveBeenCalled();
    expect(f.upsertPairingRequest).not.toHaveBeenCalled();
  });

  it.each(["disabled", "removed", "transport", "other-account", "sender-denied", "pairing", "source-reply"])(
    "suppresses a notice under current %s policy", async reason => {
      const f = fixture();
      const config = structuredClone(f.cfg());
      if (reason === "disabled") config.channels!.mattermost!.enabled = false;
      if (reason === "removed") delete config.channels!.mattermost;
      if (reason === "transport") config.channels!.mattermost!.botToken = "replacement";
      if (reason === "other-account") {
        config.channels!.mattermost = { accounts: { other: { baseUrl: "https://other.example", botToken: "fixture" } } };
      }
      if (reason === "sender-denied") {
        config.channels!.mattermost!.dmPolicy = "allowlist";
        config.channels!.mattermost!.allowFrom = ["someone"];
      }
      if (reason === "pairing") {
        config.channels!.mattermost!.dmPolicy = "pairing";
        config.channels!.mattermost!.allowFrom = [];
      }
      if (reason === "source-reply") config.messages = { visibleReplies: "message_tool" };
      f.setCfg(config);
      await f.notify();
      expect(f.writes).toEqual([]);
      expect(f.upsertPairingRequest).not.toHaveBeenCalled();
    },
  );

  it.each(["self", "system", "deleted", "foreign-channel", "foreign-sender", "moved-thread"])(
    "ignores %s input without notifying", async reason => {
      const f = fixture();
      if (reason === "self") f.post.user_id = "bot";
      if (reason === "system") f.post.type = "system_join_channel";
      if (reason === "deleted") f.currentPost.delete_at = 1;
      if (reason === "foreign-channel") f.currentPost.channel_id = "other";
      if (reason === "foreign-sender") f.currentPost.user_id = "other";
      if (reason === "moved-thread") f.currentPost.root_id = "other";
      await f.notify();
      expect(f.writes).toEqual([]);
    },
  );

  it.each(["denied", "missing-mention", "onchar-missing"])("preserves group %s admission", async reason => {
    const f = fixture("O");
    const cfg = structuredClone(f.cfg());
    cfg.channels!.mattermost!.requireMention = true;
    if (reason === "denied") cfg.channels!.mattermost!.groupPolicy = "disabled";
    if (reason === "onchar-missing") cfg.channels!.mattermost!.chatmode = "onchar";
    f.setCfg(cfg);
    await f.notify();
    expect(f.writes).toEqual([]);
  });

  it("uses current mention policy and retains the existing engaged-thread rule", async () => {
    const f = fixture("O");
    const cfg = structuredClone(f.cfg());
    cfg.channels!.mattermost!.requireMention = true;
    f.setCfg(cfg);
    f.currentPost.message = "@helper help";
    await f.notify();
    expect(f.writes).toHaveLength(1);
    f.currentPost.message = "follow-up";
    await recordMattermostThreadParticipation("default", f.post.channel_id!, f.post.root_id!);
    await f.notify();
    expect(f.writes).toHaveLength(2);
    f.setCfg({ ...cfg, channels: { mattermost: { ...cfg.channels!.mattermost, requireMentionInBotThreads: true } } });
    await f.notify();
    expect(f.writes).toHaveLength(2);
  });

  it("fences a policy replacement while pairing authorization is suspended", async () => {
    const f = fixture();
    const config = structuredClone(f.cfg());
    config.channels!.mattermost!.dmPolicy = "pairing";
    config.channels!.mattermost!.allowFrom = [];
    f.setCfg(config);
    f.readAllowFromStore.mockImplementation(async () => {
      f.setCfg({ channels: { mattermost: { enabled: false } } });
      return ["alice"];
    });
    await expect(f.notify()).rejects.toThrow("policy changed");
    expect(f.writes).toEqual([]);
  });

  it("rechecks after DNS/transport queueing before the actual POST", async () => {
    const f = fixture();
    wire.beforeDispatch.mockImplementation(url => {
      if (url.includes("/posts?silent=true")) f.setCfg({ channels: { mattermost: { enabled: false } } });
    });
    await expect(f.notify()).rejects.toThrow("policy changed");
    expect(f.writes).toEqual([]);
  });

  it("does not retry a rate-limited read after policy replacement", async () => {
    const f = fixture();
    wire.fetch.mockImplementationOnce(async () => {
      f.setCfg({ channels: { mattermost: { enabled: false } } });
      return new Response("", { status: 429, headers: { "retry-after": "0" } });
    });
    await expect(f.notify()).rejects.toThrow("policy changed");
    expect(wire.fetch).toHaveBeenCalledOnce();
    expect(f.writes).toEqual([]);
  });

  it.each(["notice", "monitor"])("honors %s cancellation before any transport", async owner => {
    const f = fixture();
    const controller = owner === "monitor" ? f.abort : new AbortController();
    controller.abort(new Error("cancelled notice"));
    await expect(f.notify(controller.signal)).rejects.toThrow("cancelled notice");
    expect(wire.fetch).not.toHaveBeenCalled();
  });
});
