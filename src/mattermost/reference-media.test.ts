import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveChannelGroupRequireMention } from "openclaw/plugin-sdk/channel-policy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMattermostAccount } from "./accounts.js";
import { createMattermostMonitorResources, buildMattermostInboundMediaPayload } from "./monitor-resources.js";
import { resolveMattermostReferenceMedia } from "./reference-media.js";
import { createMattermostPostHandler } from "./monitor-posts.js";
import type { MattermostPost, MattermostClient } from "./client.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { MattermostAccountConfig } from "../types.js";
import { MattermostConfigSchema } from "../config-schema-core.js";
import type { OpenClawConfig } from "./runtime-api.js";

const dispatch = vi.hoisted(() => vi.fn());
const skillCommands = vi.hoisted(() => vi.fn(() => [{ name: "review_code", skillName: "code-review" }]));
vi.mock("./monitor-turn.js", () => ({ dispatchMattermostInboundTurn: dispatch }));
vi.mock("./runtime-api.js", async original => ({ ...await original<typeof import("./runtime-api.js")>(), listSkillCommandsForAgents: skillCommands }));
vi.mock("./thread-participation.js", () => ({ hasMattermostThreadParticipation: async () => false }));
vi.mock("./permalink-hydration.js", () => ({ hydrateMattermostPermalinks: async () => "[existing attachment metadata]" }));
vi.mock("openclaw/plugin-sdk/channel-inbound", async original => ({ ...await original<typeof import("openclaw/plugin-sdk/channel-inbound")>(), resolveInboundSessionEnvelopeContext: () => ({ envelopeOptions: {} }) }));

const C = "c".repeat(26), O = "o".repeat(26), R = "r".repeat(26), P = "p".repeat(26), U = "u".repeat(26), B = "b".repeat(26);
const F = (n: number) => String(n).padStart(26, "f");
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers(); dispatch.mockReset();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function setup(config: Partial<MattermostAccountConfig> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mm-reference-")); dirs.push(dir);
  const cfg = {
    channels: {
      mattermost: {
        baseUrl: "https://mm.example", botToken: "fixture", enabled: true, groupPolicy: "open", historyLimit: 0,
        requireMention: false, ...config,
      }
    }
  } as unknown as OpenClawConfig;
  const account = resolveMattermostAccount({ cfg, accountId: "default" });
  const reference: MattermostPost = { id: R, channel_id: C, user_id: U, message: "root caption", file_ids: [F(1)] };
  const post: MattermostPost = { id: P, root_id: R, channel_id: C, user_id: U, message: "analyze this file", create_at: 123 };
  const info = new Map<string, Record<string, unknown>>();
  const request = vi.fn(async (endpoint: string, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    if (endpoint === `/posts/${R}`) return reference;
    if (endpoint === `/channels/${C}`) return { id: C, type: "O", name: "engineering" };
    if (endpoint === `/users/${U}`) return { id: U, username: "ada" };
    const match = /^\/files\/([^/]+)\/info$/.exec(endpoint);
    if (match) return { id: match[1], post_id: R, size: 4, name: "reference.txt", mime_type: "text/plain", ...info.get(match[1]) };
    throw new Error("unavailable");
  });
  const client = { baseUrl: "https://mm.example", token: "fixture", request } as unknown as MattermostClient;
  const save = vi.fn(async (options: { filePathHint?: string; maxBytes: number; requestInit?: RequestInit }) => {
    options.requestInit?.signal?.throwIfAborted();
    const target = path.join(dir, options.filePathHint!);
    await writeFile(target, "data");
    return { path: target, contentType: "text/plain", fileName: "reference.txt" };
  });
  const resources = createMattermostMonitorResources({ client, mediaMaxBytes: 8 * 1024 * 1024, accountId: "default", callbackUrl: "https://gateway.example/cb", logger: {}, saveRemoteMedia: save, mediaKindFromMime: () => "unknown" });
  const core = {
    config: { current: () => cfg }, channel: {
      activity: { record: vi.fn() }, commands: { shouldHandleTextCommands: () => true, isControlCommandMessage: () => false },
      groups: { resolveRequireMention: resolveChannelGroupRequireMention }, mentions: { buildMentionRegexes: () => [], matchesMentionPatterns: () => false },
      routing: { resolveAgentRoute: () => ({ agentId: "main", accountId: "default", sessionKey: `agent:main:mattermost:channel:${C}`, lastRoutePolicy: "session" }) },
    }
  };
  const monitor = {
    cfg, account, client, resources, core, botUserId: B, botUsername: "bot", groupPolicy: account.config.groupPolicy,
    pairing: { readAllowFromStore: async () => [] }, logVerboseMessage: vi.fn(), logDebugMessage: vi.fn(), runtime: {}
  } as unknown as MattermostMonitorContext;
  return { cfg, monitor, post, reference, request, save, info, dir, core, resolve: () => resolveMattermostReferenceMedia({ monitor, post, kind: "channel" }) };
}

describe("lazy authorized referenced attachment content", () => {
  it.each([undefined, {}, { enabled: true }])("defaults on for referenceMedia=%s and materializes content", async (referenceMedia) => {
    const fixture = await setup(referenceMedia === undefined ? {} : { referenceMedia });
    expect(await fixture.resolve()).toHaveLength(1);
    expect(fixture.request.mock.calls.map(call => call[0])).toEqual([`/posts/${R}`, `/files/${F(1)}/info`]);
    expect(fixture.save).toHaveBeenCalledOnce();
  });
  it.each([
    { referenceMedia: { enabled: false } },
    { permalinkHydration: { enabled: false } },
    { referenceMedia: { enabled: true }, permalinkHydration: { enabled: false } },
  ])("retains the no-fetch/no-save kill switch for %s", async (config) => {
    const fixture = await setup(config);
    expect(await fixture.resolve()).toEqual([]);
    expect(fixture.request).not.toHaveBeenCalled(); expect(fixture.save).not.toHaveBeenCalled();
  });
  it.each([true, false, undefined])("preserves named account overrides and empty-field inheritance with root enabled=%s", async (enabled) => {
    const fixture = await setup(enabled === undefined ? {} : { referenceMedia: { enabled } });
    const accounts: Record<string, MattermostAccountConfig> = {
      off: { referenceMedia: { enabled: false } },
      on: { referenceMedia: { enabled: true } },
      inherited: {},
      empty: { referenceMedia: {} },
    };
    Object.assign(fixture.cfg.channels!.mattermost!, { accounts });
    for (const accountId of Object.keys(accounts)) {
      fixture.monitor.account.accountId = accountId;
      fixture.request.mockClear(); fixture.save.mockClear();
      const effectiveEnabled = accounts[accountId].referenceMedia?.enabled ?? enabled ?? true;
      const account = resolveMattermostAccount({ cfg: fixture.cfg, accountId });
      expect(account.config.referenceMedia?.enabled ?? true).toBe(effectiveEnabled);
      if (effectiveEnabled) {
        expect(await fixture.resolve()).toHaveLength(1);
        expect(fixture.save).toHaveBeenCalledOnce();
      } else {
        expect(await fixture.resolve()).toEqual([]);
        expect(fixture.request).not.toHaveBeenCalled(); expect(fixture.save).not.toHaveBeenCalled();
      }
    }
  });
  it("inherits the global permalink hydration kill switch for a named account with reference media enabled", async () => {
    const fixture = await setup({ permalinkHydration: { enabled: false } });
    Object.assign(fixture.cfg.channels!.mattermost!, { accounts: { work: { referenceMedia: { enabled: true } } } });
    fixture.monitor.account.accountId = "work";
    expect(await fixture.resolve()).toEqual([]);
    expect(fixture.request).not.toHaveBeenCalled(); expect(fixture.save).not.toHaveBeenCalled();
  });
  it("validates reference media settings", () => {
    expect(MattermostConfigSchema.safeParse({ referenceMedia: { enabled: true }, accounts: { off: { referenceMedia: { enabled: false } } } }).success).toBe(true);
    expect(MattermostConfigSchema.safeParse({ referenceMedia: { enabled: null } }).success).toBe(false);
  });
  it("materializes an attachment root for a fresh text-only inbound reply with actual paths/facts", async () => {
    const fixture = await setup();
    await createMattermostPostHandler(fixture.monitor)(fixture.post, { data: { sender_name: "ada" } });
    expect(dispatch).toHaveBeenCalledOnce();
    const context = dispatch.mock.calls[0][1].ctxPayload;
    expect(context.MediaPath).toBe(path.join(fixture.dir, F(1)));
    expect(context.MediaPaths).toEqual([path.join(fixture.dir, F(1))]);
    expect(context.media).toHaveLength(1);
    expect(context.BodyForAgent).toContain("[existing attachment metadata]");
    expect(context.CommandBody).toBe("analyze this file");
    expect(context.MessageThreadId).toBe(R);
    expect((await stat(context.MediaPath)).size).toBe(4);
  });
  it("uses only one explicit same-instance permalink and deduplicates current files", async () => {
    const fixture = await setup();
    fixture.post.root_id = undefined;
    fixture.post.message = `analyze https://mm.example/_redirect/pl/${R} https://other.example/pl/${O}`;
    fixture.reference.file_ids = [F(1), F(1), F(2)]; fixture.post.file_ids = [F(1)];
    const media = await fixture.resolve();
    expect(media).toHaveLength(1);
    expect(fixture.save.mock.calls[0][0].filePathHint).toBe(F(2));
    expect(await buildMattermostInboundMediaPayload(media)).toMatchObject({ MediaPath: path.join(fixture.dir, F(2)), media: [expect.objectContaining({ contentType: "text/plain" })] });
  });
  it("does not fetch files for foreign/private-channel, denied sender, deleted or mismatched references", async () => {
    for (const change of [{ channel_id: O }, { id: O }, { delete_at: 1 }, { root_id: O }, { file_ids: ["invalid"] }]) {
      const fixture = await setup(); Object.assign(fixture.reference, change);
      expect(await fixture.resolve()).toEqual([]);
      expect(fixture.save).not.toHaveBeenCalled();
      expect(fixture.request.mock.calls.map(call => call[0])).toEqual([`/posts/${R}`]);
    }
    const fixture = await setup({ groupPolicy: "allowlist", groupAllowFrom: [B], contextVisibility: "all" });
    expect(await fixture.resolve()).toEqual([]);
    expect(fixture.save).not.toHaveBeenCalled();
    expect(fixture.request.mock.calls.map(call => call[0])).toEqual([`/posts/${R}`]);
    fixture.post.root_id = undefined; fixture.post.message = `https://foreign.example/pl/${R}`;
    fixture.request.mockClear();
    expect(await fixture.resolve()).toEqual([]); expect(fixture.request).not.toHaveBeenCalled();
  });
  it("skips unavailable/deleted files and mismatched provider file ownership while preserving text", async () => {
    const fixture = await setup();
    fixture.info.set(F(1), { post_id: O });
    expect(await fixture.resolve()).toEqual([]); expect(fixture.save).not.toHaveBeenCalled();
    fixture.info.clear(); fixture.save.mockRejectedValue(new Error("file deleted or forbidden"));
    await createMattermostPostHandler(fixture.monitor)(fixture.post, { data: { sender_name: "ada" } });
    expect(dispatch.mock.calls[0][1].ctxPayload.BodyForAgent).toContain("analyze this file");
    expect(dispatch.mock.calls[0][1].ctxPayload.MediaPath).toBeUndefined();
  });
  it("caps file count and grants at most the aggregate configured byte budget across failures", async () => {
    const fixture = await setup({ mediaMaxMb: 8 / (1024 * 1024) });
    fixture.reference.file_ids = Array.from({ length: 8 }, (_, n) => F(n));
    fixture.save.mockRejectedValueOnce(new Error("overflow or ambiguous transfer"));
    expect(await fixture.resolve()).toHaveLength(1);
    expect(fixture.save).toHaveBeenCalledTimes(2);
    expect(fixture.save.mock.calls.reduce((sum, [options]) => sum + options.maxBytes, 0)).toBe(8);
    const countFixture = await setup(); countFixture.reference.file_ids = Array.from({ length: 8 }, (_, n) => F(n));
    expect(await countFixture.resolve()).toHaveLength(4); expect(countFixture.save).toHaveBeenCalledTimes(4);
  });
  it("rejects understated size overflow and does not refund its allowance", async () => {
    const fixture = await setup({ mediaMaxMb: 5 / (1024 * 1024) });
    fixture.reference.file_ids = [F(1), F(2)]; fixture.info.set(F(1), { size: 1 });
    fixture.save.mockImplementationOnce(async () => {
      const target = path.join(fixture.dir, "oversized"); await writeFile(target, "too big");
      return { path: target, contentType: "text/plain", fileName: "reference.txt" };
    });
    expect(await fixture.resolve()).toEqual([]);
    expect(fixture.save).toHaveBeenCalledOnce();
    expect(fixture.save.mock.calls[0][0].maxBytes).toBe(1);
    // Real saver enforces maxBytes; if it rejects, the next file can spend only the remaining four.
    fixture.save.mockClear().mockRejectedValueOnce(new Error("overflow"));
    await fixture.resolve();
    expect(fixture.save.mock.calls.reduce((sum, [options]) => sum + options.maxBytes, 0)).toBe(5);
  });
  it("bounds elapsed time and aborts a hanging transfer without later downloads", async () => {
    vi.useFakeTimers();
    const fixture = await setup(); fixture.reference.file_ids = [F(1), F(2)];
    fixture.save.mockImplementationOnce(async options => new Promise((_resolve, reject) => options.requestInit!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    const result = fixture.resolve();
    await vi.waitFor(() => expect(fixture.save).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toEqual([]); expect(fixture.save).toHaveBeenCalledOnce();
    const aborted = await setup(); const controller = new AbortController(); controller.abort(); aborted.monitor.abortSignal = controller.signal;
    expect(await aborted.resolve()).toEqual([]); expect(aborted.request).not.toHaveBeenCalled();
    expect(aborted.save).not.toHaveBeenCalled();
  });
  it("blocks WS /skill aliases before dispatch or attachment side effects and keeps configured prompts", async () => {
    const fixture = await setup({ groups: { [C]: { skills: [], systemPrompt: "Engineering instructions" } } });
    fixture.post.message = "@bot /skill CODE_REVIEW file";
    await createMattermostPostHandler(fixture.monitor)(fixture.post, { data: { sender_name: "ada" } });
    expect(dispatch).not.toHaveBeenCalled(); expect(fixture.save).not.toHaveBeenCalled(); expect(fixture.core.channel.activity.record).not.toHaveBeenCalled();
    fixture.post.message = "@bot /status";
    await createMattermostPostHandler(fixture.monitor)(fixture.post, { data: { sender_name: "ada" } });
    expect(dispatch.mock.calls[0][1].ctxPayload.GroupSystemPrompt).toBe("Engineering instructions");
  });
});
