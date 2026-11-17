import { IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mattermostPlugin } from "../channel.js";
import { resolveMattermostPresentation } from "../normalize.js";
import { setMattermostRuntime } from "../runtime.js";
import { createMattermostClient, type MattermostPost } from "./client.js";
import { createMattermostInteractionHandler, createMattermostInteractionProcessor, generateInteractionToken, setInteractionSecret, type MattermostValidatedInteraction } from "./interactions.js";
import { buildMattermostInteractionEventId, createMattermostInteractionIngressMonitor } from "./interaction-ingress.js";
import { createMattermostIngressQueue } from "./ingress-queue.js";

const transport = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async original => ({
  ...await original<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(),
  fetchWithSsrFGuard: async ({ url, init }: { url: string; init: RequestInit }) =>
    ({ response: await transport(url, init), release: async () => {}, finalUrl: url }),
}));
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
const C = "c".repeat(26), B = "b".repeat(26), U = "u".repeat(26), P = "p".repeat(26), R = "r".repeat(26);
let sequence = 0;
const presentation = (value: string) => ({ blocks: [{
  type: "buttons", buttons: [{ label: "Review", action: { type: "callback", value } }],
}] });

async function fixture(format: "legacy" | "blocks" = "legacy", value = "/new") {
  const cfg = { channels: { mattermost: {
    botToken: "fixture", baseUrl: `https://callback${++sequence}.example`,
    groupPolicy: "open", interactions: { blocks: format === "blocks" },
  } } };
  setMattermostRuntime({
    logging: { getChildLogger: () => ({ warn: vi.fn(), debug: vi.fn() }), shouldLogVerbose: () => false },
    system: { enqueueSystemEvent: vi.fn() }, channel: { activity: { record: vi.fn() } },
  } as never);
  let post: MattermostPost;
  const writes: Record<string, any>[] = [];
  transport.mockReset().mockImplementation(async (url, init) => {
    if (String(url).endsWith("/users/me")) return Response.json({ id: B, username: "bot" });
    if (String(url).endsWith("/posts") && init?.method === "POST") {
      const body = JSON.parse(init.body as string); writes.push(body);
      post = { ...body, id: P, user_id: B, channel_id: C, root_id: R };
      return Response.json(post);
    }
    if (String(url).endsWith(`/posts/${P}/patch`) && init?.method === "PUT") {
      const body = JSON.parse(init.body as string); writes.push(body);
      post = { ...post, ...body }; return Response.json(post);
    }
    if (String(url).endsWith(`/posts/${P}`)) return Response.json(post);
    throw new Error(`unexpected provider request ${url}`);
  });
  const payload = { text: "Choose", presentation: presentation(value) };
  const prepared = await mattermostPlugin.actions!.prepareSendPayload!({
    ctx: { action: "send", params: {}, cfg }, to: `channel:${C}`, payload,
  } as never);
  const rendered = await mattermostPlugin.outbound!.renderPresentation!({
    payload: prepared, presentation: payload.presentation,
  } as never);
  await mattermostPlugin.outbound!.sendPayload!({
    cfg, to: `channel:${C}`, text: "Choose", accountId: "default", replyToId: R, payload: rendered,
  } as never);
  const client = createMattermostClient({ baseUrl: cfg.channels.mattermost.baseUrl, botToken: "fixture", fetchImpl: transport });
  const context = () => {
    const props = post.props as Record<string, any>;
    if (props.attachments) return props.attachments[0].actions[0].integration.context;
    return Object.values(props.mm_blocks_actions)[0].context;
  };
  const admitted: MattermostValidatedInteraction[] = [];
  const authorize = vi.fn(async () => ({ ok: true as const }));
  const handler = createMattermostInteractionHandler({
    client, accountId: "default", botUserId: B, authorizeButtonClick: authorize,
    admitInteraction: async interaction => { admitted.push(interaction); },
  });
  return { cfg, client, writes, context, admitted, authorize, handler, get post() { return post; } };
}

async function click(f: Awaited<ReturnType<typeof fixture>>, context = f.context(), extra = {}) {
  const req = new IncomingMessage(new Socket()); req.method = "POST"; req.headers = {};
  const body = JSON.stringify({ user_id: U, user_name: "ada", channel_id: C, post_id: P, context, ...extra });
  process.nextTick(() => { req.push(Buffer.from(body)); req.push(null); });
  const res = { statusCode: 200, setHeader() {}, end() {} } as unknown as ServerResponse;
  await f.handler(req, res);
  return res.statusCode;
}

describe("Mattermost agent-owned typed callbacks", () => {
  beforeAll(async () => { await import("../channel.runtime.js"); });

  it.each(["legacy", "blocks"] as const)("round-trips actual %s message-send controls as exact callback data", async format => {
    const f = await fixture(format, '/new\n資料:"quoted"');
    expect(f.context()).toMatchObject({ oc_callback: 1, callback_data: '/new\n資料:"quoted"' });
    expect(await click(f)).toBe(200);
    expect(JSON.stringify(f.admitted)).not.toMatch(/_token|integration|fixture/);
    const dispatch = vi.fn();
    await createMattermostInteractionProcessor({
      client: f.client, accountId: "default", botUserId: B, dispatchButtonClick: dispatch,
    })(f.admitted[0]);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      callbackValue: '/new\n資料:"quoted"', actionName: "Review",
      post: expect.objectContaining({ root_id: R, channel_id: C }),
    }));
    expect(f.writes).toHaveLength(1); // Keep the control valid until the durable row settles.
  });

  it.each(["legacy", "blocks"] as const)("replaces %s edit controls and rejects old HTTP and replay identities", async format => {
    const f = await fixture(format);
    const oldContext = f.context();
    await click(f);
    await mattermostPlugin.actions!.handleAction!({
      action: "edit", cfg: f.cfg, accountId: "default", conversationReadOrigin: "delegated",
      params: { to: `channel:${C}`, messageId: P, message: "Updated", presentation: presentation("pick:tomorrow") },
    } as never);
    const nextContext = f.context();
    expect(nextContext.action_id).not.toBe(oldContext.action_id);
    expect(nextContext.callback_data).toBe("pick:tomorrow");
    expect(f.post.message).toContain("Updated");
    expect(await click(f, oldContext)).toBe(403);
    const dispatch = vi.fn();
    const processor = createMattermostInteractionProcessor({ client: f.client, accountId: "default", botUserId: B, dispatchButtonClick: dispatch });
    await processor(f.admitted[0]);
    expect(dispatch).not.toHaveBeenCalled();
    await click(f, nextContext);
    await processor(f.admitted[1]);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ callbackValue: "pick:tomorrow" }));
  });

  it("deduplicates retry trigger ids and drains a stored callback once across restart", async () => {
    const f = await fixture();
    await click(f, f.context(), { trigger_id: "one" });
    await click(f, f.context(), { trigger_id: "two" });
    expect(buildMattermostInteractionEventId(f.admitted[0])).toBe(buildMattermostInteractionEventId(f.admitted[1]));
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "mm-typed-callback-")); dirs.push(stateDir);
    const queue = createMattermostIngressQueue<{ version: 1; receivedAt: number; interaction: MattermostValidatedInteraction }>({
      accountId: "default", stateDir, scope: "interactions",
    });
    for (const interaction of f.admitted) await queue.enqueue(buildMattermostInteractionEventId(interaction), {
      version: 1, receivedAt: Date.now(), interaction,
    }, { laneKey: `channel:${C}:post:${P}` });
    const dispatch = vi.fn();
    const processor = createMattermostInteractionProcessor({ client: f.client, accountId: "default", botUserId: B, dispatchButtonClick: dispatch });
    for (let restart = 0; restart < 2; restart++) {
      const drain = createMattermostInteractionIngressMonitor({ accountId: "default",
        queue: createMattermostIngressQueue({ accountId: "default", stateDir, scope: "interactions" }),
        dispatch: processor, runtime: {}, pollIntervalMs: 60_000 });
      try { await drain.waitForIdle(); } finally { await drain.stop(); }
    }
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("rejects forged, malformed, expired, foreign and retired controls", async () => {
    const f = await fixture();
    const context = f.context();
    expect(await click(f, { ...context, callback_data: "forged" })).toBe(403);
    expect(await click(f, context, { channel_id: "foreign" })).toBe(403);
    for (const patch of [{ oc_callback: 2 }, { callback_data: null }, { callback_expires: Date.now() - 1 }]) {
      const { _token, ...unsigned } = { ...context, ...patch };
      expect(await click(f, { ...unsigned, _token: generateInteractionToken(unsigned, "default") })).toBe(403);
    }
    f.post.user_id = "foreign";
    expect(await click(f, context)).toBe(403);
    f.post.user_id = B;
    f.post.props = {};
    expect(await click(f, context)).toBe(403);
    expect(f.admitted).toHaveLength(0);
  });

  it("retains native/plugin handler precedence and rechecks authorization during replay", async () => {
    const f = await fixture();
    await click(f);
    const dispatch = vi.fn();
    const claimed = vi.fn(async () => ({ ephemeral_text: "Handled" }));
    // Test a handler claim without issuing an actual ephemeral transport.
    f.client.request = vi.fn(async () => f.post) as never;
    await createMattermostInteractionProcessor({
      client: f.client, accountId: "default", botUserId: B, dispatchButtonClick: dispatch, handleInteraction: claimed,
    })(f.admitted[0]);
    expect(claimed).toHaveBeenCalledOnce();
    await createMattermostInteractionProcessor({
      client: f.client, accountId: "default", botUserId: B, dispatchButtonClick: dispatch,
      authorizeButtonClick: async () => ({ ok: false, response: {} }),
    })(f.admitted[0]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("binds HTTP and replay to the account even when accounts share a bot token", async () => {
    const f = await fixture();
    setInteractionSecret("second", "fixture");
    const dispatch = vi.fn();
    const handler = createMattermostInteractionHandler({
      client: f.client, accountId: "second", botUserId: B, dispatchButtonClick: dispatch,
    });
    expect(await click({ ...f, handler })).toBe(403);
    await click(f);
    await createMattermostInteractionProcessor({
      client: f.client, accountId: "second", botUserId: B, dispatchButtonClick: dispatch,
    })(f.admitted[0]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not promote ordinary plugin-owned callbacks or typed commands into agent controls", () => {
    expect(resolveMattermostPresentation({ text: "Plugin", presentation: presentation("plugin:secret") }).buttons).toEqual([]);
    expect(resolveMattermostPresentation({
      text: "Command", channelData: { mattermost: { typedCallbackOwner: "agent" } },
      presentation: { blocks: [{ type: "buttons", buttons: [{ label: "Run", action: { type: "command", command: "/new" } }] }] },
    }).buttons).toEqual([]);
  });

  it("does not attach agent controls to another user's post on edit", async () => {
    const f = await fixture();
    f.post.user_id = U;
    await expect(mattermostPlugin.actions!.handleAction!({
      action: "edit", cfg: f.cfg, accountId: "default", conversationReadOrigin: "delegated",
      params: { to: `channel:${C}`, messageId: P, message: "Updated", presentation: presentation("data") },
    } as never)).rejects.toThrow("authored by this bot");
    expect(f.writes).toHaveLength(1);
  });

  it("preserves controls on text-only edit and clears them on explicit empty presentation", async () => {
    const f = await fixture();
    const context = f.context();
    const edit = (params: Record<string, unknown>) => mattermostPlugin.actions!.handleAction!({
      action: "edit", cfg: f.cfg, accountId: "default", conversationReadOrigin: "delegated",
      params: { to: `channel:${C}`, messageId: P, message: "Updated", ...params },
    } as never);
    await edit({});
    expect(await click(f, context)).toBe(200);
    await edit({ presentation: { blocks: [] } });
    expect(await click(f, context)).toBe(403);
  });
});
