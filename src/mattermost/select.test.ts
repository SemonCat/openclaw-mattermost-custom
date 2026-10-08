import { IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mattermostPlugin } from "../channel.js";
import { resolveMattermostPresentation } from "../normalize.js";
import { setMattermostRuntime } from "../runtime.js";
import { createMattermostClient, type MattermostPost } from "./client.js";
import { createMattermostInteractionHandler, createMattermostInteractionProcessor, generateInteractionToken, type MattermostValidatedInteraction } from "./interactions.js";
import { buildMattermostInteractionEventId, createMattermostInteractionIngressMonitor } from "./interaction-ingress.js";
import { createMattermostIngressQueue } from "./ingress-queue.js";
import type { OpenClawConfig } from "./runtime-api.js";

const transport = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async original => ({
  ...await original<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(),
  fetchWithSsrFGuard: async ({ url, init }: { url: string; init: RequestInit }) => ({ response: await transport(url, init), release: async () => { }, finalUrl: url }),
}));
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); vi.restoreAllMocks(); });
const C = "c".repeat(26), B = "b".repeat(26), U = "u".repeat(26), P = "p".repeat(26), R = "r".repeat(26);
const QUESTION = "ask_0123456789abcdef0123456789abcdef";
const presentation = { blocks: [{ type: "select" as const, placeholder: "Choose environment", options: [{ label: "Staging", value: "staging" }, { label: "Production", value: "production" }] }] };
let sequence = 0;
async function sentMenu(format: "legacy" | "blocks" = "legacy", options: { question?: boolean; fail?: "400" | "network" | "missing-id"; version?: string } = {}) {
  const cfg = { channels: { mattermost: { botToken: "fixture", baseUrl: `https://mm${++sequence}.example`, groupPolicy: "open", interactions: options.version ? {} : { blocks: format === "blocks" } } } } as unknown as OpenClawConfig;
  const enqueue = vi.fn();
  setMattermostRuntime({
    logging: { getChildLogger: () => ({ warn: vi.fn(), debug: vi.fn() }), shouldLogVerbose: () => false },
    system: { enqueueSystemEvent: enqueue }, channel: { activity: { record: vi.fn() } }
  } as never);
  let post: MattermostPost | undefined;
  const creates: Record<string, unknown>[] = [];
  transport.mockReset().mockImplementation(async (url, init) => {
    if (String(url).endsWith("/system/ping")) return Response.json({}, { headers: { "X-Version-ID": options.version! } });
    if (String(url).endsWith("/posts") && init?.method === "POST") {
      const body = JSON.parse(init.body as string); creates.push(body);
      if (creates.length === 1 && options.fail === "network") throw new Error("connection reset after write");
      if (creates.length === 1 && options.fail === "missing-id") return Response.json({});
      if (creates.length === 1 && options.fail === "400") return Response.json({ message: "blocks disabled" }, { status: 400 });
      post = { id: P, user_id: B, channel_id: C, root_id: R, ...body };
      return Response.json(post);
    }
    if (String(url).endsWith(`/posts/${P}`)) return Response.json(post);
    throw new Error(`unexpected provider request ${url}`);
  });
  const payload = { text: "Choose", presentation, ...(options.question ? { channelData: { askUser: { questionId: QUESTION, optionValues: ["production", "staging"] } } } : {}) };
  const rendered = await mattermostPlugin.outbound!.renderPresentation!({ payload, presentation } as never);
  const send = () => mattermostPlugin.outbound!.sendPayload!({ cfg, to: `channel:${C}`, text: "Choose", accountId: "default", replyToId: R, payload: rendered } as never);
  const client = createMattermostClient({ baseUrl: cfg.channels!.mattermost!.baseUrl!, botToken: "fixture", fetchImpl: transport });
  const context = () => {
    const props = post!.props as Record<string, any>;
    return props.attachments ? props.attachments[0].actions[0].integration.context : props.mm_blocks_actions.select0.context;
  };
  return { cfg, client, context, creates, enqueue, send, get post() { return post!; } };
}
async function callback(handler: ReturnType<typeof createMattermostInteractionHandler>, context: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const req = new IncomingMessage(new Socket()); req.method = "POST"; req.headers = {};
  const body = JSON.stringify({ user_id: U, user_name: "ada", channel_id: C, post_id: P, context, ...extra });
  process.nextTick(() => { req.push(Buffer.from(body)); req.push(null); });
  let result = "";
  const res = { statusCode: 200, setHeader() { }, end(value: string) { result = value; } } as unknown as ServerResponse;
  await handler(req, res);
  return { status: res.statusCode, body: result };
}
function admission(fixture: Awaited<ReturnType<typeof sentMenu>>) {
  const admitted: MattermostValidatedInteraction[] = [];
  const authorize = vi.fn(async ({ payload }: { payload: { user_id: string } }) => payload.user_id === U ? { ok: true as const } : { ok: false as const, statusCode: 403 });
  const handler = createMattermostInteractionHandler({
    client: fixture.client, botUserId: B, accountId: "default", authorizeButtonClick: authorize,
    admitInteraction: async interaction => { admitted.push(interaction); }
  });
  return { admitted, handler, authorize };
}

describe("Mattermost single-select public delivery and admission", () => {
  it.each(["legacy", "blocks"] as const)("renders %s controls and admits actual callback context.selected_option", async format => {
    const fixture = await sentMenu(format); await fixture.send();
    expect(fixture.creates).toHaveLength(1);
    if (format === "legacy") expect(fixture.post.props).toMatchObject({ attachments: [{ actions: [{ type: "select", options: [{ text: "Staging", value: "staging" }, { text: "Production", value: "production" }] }] }] });
    else expect(fixture.post.props).toMatchObject({ mm_blocks: [{ type: "container", content: [{ type: "static_select", placeholder: "Choose environment" }] }] });
    const { handler, admitted } = admission(fixture);
    expect((await callback(handler, { ...fixture.context(), selected_option: "production" })).status).toBe(200);
    expect(admitted[0]).toMatchObject({ actionId: "select0", actionName: "Production", context: { oc_select: true, callback_data: "production", selected_option: "production" } });
    expect(JSON.stringify(admitted)).not.toMatch(/_token|select_choices|mm_blocks|attachments|fixture/);
    const dispatch = vi.fn(async () => { });
    await createMattermostInteractionProcessor({ client: fixture.client, botUserId: B, accountId: "default", authorizeButtonClick: () => Promise.resolve({ ok: true }), dispatchButtonClick: dispatch })(admitted[0]);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ selectedValue: "production", actionName: "Production", post: expect.objectContaining({ root_id: R }) }));
  });
  it("supports the top-level callback choice spelling without trusting it", async () => {
    const fixture = await sentMenu("blocks"); await fixture.send(); const { handler, admitted } = admission(fixture);
    expect((await callback(handler, fixture.context(), { selected_option: "staging" })).status).toBe(200);
    expect(admitted[0].context.selected_option).toBe("staging");
    expect((await callback(handler, { ...fixture.context(), selected_option: "staging" }, { selected_option: "production" })).status).toBe(403);
  });
  it("rejects forged, unknown, oversized, foreign user/post/channel and stale controls", async () => {
    const fixture = await sentMenu(); await fixture.send(); const { handler, admitted } = admission(fixture);
    for (const selected of ["unknown", "x".repeat(201), { value: "staging" }, null, undefined]) {
      expect((await callback(handler, { ...fixture.context(), selected_option: selected })).status).toBe(403);
    }
    expect((await callback(handler, { ...fixture.context(), selected_option: "staging", _token: "forged" })).status).toBe(403);
    expect((await callback(handler, { ...fixture.context(), selected_option: "staging" }, { user_id: B })).status).toBe(403);
    expect((await callback(handler, { ...fixture.context(), selected_option: "staging" }, { channel_id: "foreign" })).status).toBe(403);
    // A callback for another id may not borrow the response's post/control identity.
    transport.mockResolvedValueOnce(Response.json({ ...fixture.post, id: "foreign" }));
    expect((await callback(handler, { ...fixture.context(), selected_option: "staging" })).status).toBe(403);
    const expired = fixture.context(); expired.select_expires = Date.now() - 1;
    const { _token, ...unsigned } = expired; expired._token = generateInteractionToken(unsigned, "default");
    expect((await callback(handler, { ...expired, selected_option: "staging" })).status).toBe(403);
    expect(admitted).toHaveLength(0);
  });
  it("detects old/new provider versions and falls back only after explicit 400", async () => {
    const old = await sentMenu("blocks", { version: "11.9.0" }); await old.send(); expect(old.post.props?.attachments).toBeDefined();
    const modern = await sentMenu("legacy", { version: "11.10.0" }); await modern.send(); expect(modern.post.props?.mm_blocks).toBeDefined();
    const rejected = await sentMenu("blocks", { fail: "400" }); await rejected.send();
    expect(rejected.creates).toHaveLength(2); expect(rejected.post.props?.attachments).toBeDefined();
    for (const fail of ["network", "missing-id"] as const) {
      const fixture = await sentMenu("blocks", { fail }); await expect(fixture.send()).rejects.toThrow(); expect(fixture.creates).toHaveLength(1);
    }
  });
  it("maps a question menu choice to canonical Gateway option order", async () => {
    const fixture = await sentMenu("blocks", { question: true }); await fixture.send(); const { handler, admitted } = admission(fixture);
    await callback(handler, { ...fixture.context(), selected_option: "production" });
    expect(admitted[0].context).toMatchObject({ oc_question: true, question_id: QUESTION, option_index: 0 });
    expect(admitted[0].context).not.toHaveProperty("callback_data");
  });
  it("keeps two choices distinct and the same choice retry stable across new trigger ids and restart replay", async () => {
    const fixture = await sentMenu(); await fixture.send(); const { handler, admitted } = admission(fixture);
    for (const [selected, trigger] of [["staging", "a"], ["production", "b"], ["staging", "c"]]) await callback(handler, { ...fixture.context(), selected_option: selected }, { trigger_id: trigger });
    expect(buildMattermostInteractionEventId(admitted[0])).toBe(buildMattermostInteractionEventId(admitted[2]));
    expect(buildMattermostInteractionEventId(admitted[0])).not.toBe(buildMattermostInteractionEventId(admitted[1]));
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "mm-select-")); dirs.push(stateDir);
    const queue = createMattermostIngressQueue<{ version: 1; receivedAt: number; interaction: MattermostValidatedInteraction }>({ accountId: "default", stateDir, scope: "interactions" });
    for (const interaction of admitted) await queue.enqueue(buildMattermostInteractionEventId(interaction), { version: 1, receivedAt: Date.now(), interaction }, { laneKey: `channel:${C}:post:${P}` });
    const dispatch = vi.fn(async () => { });
    const drain = createMattermostInteractionIngressMonitor({ accountId: "default", queue, dispatch: createMattermostInteractionProcessor({ client: fixture.client, accountId: "default", botUserId: B, dispatchButtonClick: dispatch }), runtime: {}, pollIntervalMs: 60_000 });
    try { await drain.waitForIdle(); expect(dispatch).toHaveBeenCalledTimes(2); } finally { await drain.stop(); }
    const replay = createMattermostInteractionIngressMonitor({ accountId: "default", queue: createMattermostIngressQueue({ accountId: "default", stateDir, scope: "interactions" }), dispatch, runtime: {}, pollIntervalMs: 60_000 });
    try { await replay.waitForIdle(); expect(dispatch).toHaveBeenCalledTimes(2); } finally { await replay.stop(); }
    fixture.post.props = {};
    await createMattermostInteractionProcessor({ client: fixture.client, accountId: "default", botUserId: B, dispatchButtonClick: dispatch })(admitted[0]);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it("leaves unsupported typed/mixed, oversized and empty menus as fallback text", () => {
    for (const options of [[], Array.from({ length: 26 }, (_, n) => ({ label: String(n), value: String(n) })), [{ label: "Staging", value: "staging" }, { label: "Run", action: { type: "command", command: "/skill admin" } }], [{ label: "Run", action: { type: "callback", value: "plugin:privileged" } }], [{ label: "A", value: "same" }, { label: "B", value: "same" }]]) {
      const normalized = resolveMattermostPresentation({ text: "Choose", presentation: { blocks: [{ type: "select", options }] } });
      expect(normalized.buttons).toEqual([]); expect(normalized.text).toContain("Choose");
    }
  });
});
