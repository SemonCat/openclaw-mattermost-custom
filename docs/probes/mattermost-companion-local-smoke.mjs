// Run against the disposable loopback Mattermost fixture, never production.
// Usage: node docs/probes/mattermost-companion-local-smoke.mjs <state.json> <receipt.json>
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";

const state = JSON.parse(await readFile(process.argv[2], "utf8"));
const base = `http://127.0.0.1:${Number(state.local_port)}`;
const scratch = await mkdtemp(path.join(tmpdir(), "openclaw-stream-smoke-"));
const trace = [];
const events = [];
const checks = [];
let socket;
const waitFor = async (predicate) => {
  const until = Date.now() + 10_000;
  while (!predicate()) {
    assert(Date.now() < until, "Timed out waiting for the expected real server event");
    await delay(20);
  }
};
const request = async (route, body, token = state.bot_token, method) => {
  const response = await fetch(`${base}${route}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};
const readPost = async (id) => {
  const result = await request(`/api/v4/posts/${id}`);
  assert.equal(result.status, 200);
  return result.body;
};

try {
  await symlink(path.resolve("node_modules"), path.join(scratch, "node_modules"), "dir");
  await build({
    stdin: {
      contents: [
        'export {createMattermostClient} from "./src/mattermost/client.ts";',
        'export {createMattermostDraftStream} from "./src/mattermost/draft-stream.ts";',
        'export {createMattermostTaskProgressCard} from "./src/mattermost/task-progress-card.ts";',
        'export {buildMattermostPostIdentityProps} from "./src/mattermost/post-identity.ts";',
      ].join("\n"),
      resolveDir: process.cwd(),
    },
    outfile: path.join(scratch, "channel.mjs"), bundle: true, packages: "external",
    platform: "node", format: "esm",
  });
  const {
    createMattermostClient, createMattermostDraftStream, createMattermostTaskProgressCard,
    buildMattermostPostIdentityProps,
  } = await import(pathToFileURL(path.join(scratch, "channel.mjs")).href);
  const client = createMattermostClient({
    baseUrl: base, botToken: state.bot_token,
    fetchImpl: async (input, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      trace.push({
        path: new URL(String(input)).pathname, message: body?.message,
        post_id: body?.post_id, seq: body?.seq, at: Date.now(),
      });
      return fetch(input, init);
    },
  });
  socket = new WebSocket(`${base.replace("http:", "ws:")}/api/v4/websocket`);
  socket.addEventListener("message", (event) => {
    const data = JSON.parse(String(event.data));
    events.push({ ...data, received_at: Date.now() });
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.send(JSON.stringify({
    seq: 1, action: "authentication_challenge", data: { token: state.reader_token },
  }));
  await waitFor(() => events.some((event) => event.seq_reply === 1 && event.status === "OK"));
  const props = (kind) => buildMattermostPostIdentityProps(kind, {
    accountId: "default", agentId: "main", channelId: state.channel_id,
  });
  const makeDraft = (beforeCreatePost) => createMattermostDraftStream({
    client, channelId: state.channel_id, companion: true, postProps: props("turn_result"),
    throttleMs: 1200, beforeCreatePost,
  });

  const draft = makeDraft();
  draft.updateAssistantText("durable first");
  await draft.flush();
  const id = draft.postId();
  const initial = await readPost(id);
  assert.equal(initial.type, "custom_openclaw_stream");
  await delay(300);
  draft.updateAssistantText("websocket text before REST checkpoint");
  await waitFor(() => events.some((event) =>
    event.event === "custom_openclaw-stream_update" &&
    event.data.post_id === id && event.data.message === "websocket text before REST checkpoint"));
  assert.equal((await readPost(id)).message, "durable first");
  checks.push("authenticated real WebSocket snapshot arrives before the REST checkpoint");
  const preview = await request(`/plugins/openclaw-stream/v1/posts/${id}`, undefined, state.reader_token);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.message, "websocket text before REST checkpoint");
  checks.push("authorized reconnect readback returns the latest cumulative snapshot");
  await draft.seal();
  assert.equal((await readPost(id)).message, "websocket text before REST checkpoint");
  await waitFor(() => events.some((event) =>
    event.event === "custom_openclaw-stream_update" && event.data.post_id === id && event.data.closed));
  draft.updateAssistantText("stale late callback");
  await draft.stop();
  assert.equal((await readPost(id)).message, "websocket text before REST checkpoint");
  checks.push("seal persists the preview, publishes close, and fences late callbacks");

  const identity = {
    post_id: id, channel_id: state.channel_id, root_id: "",
    generation: initial.props.openclaw_stream.generation, seq: 999, message: "forbidden",
  };
  const rawStatus = async (body, token = state.bot_token) => {
    const response = await fetch(`${base}/plugins/openclaw-stream/v1/snapshots`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await response.body?.cancel();
    return response.status;
  };
  assert.equal(await rawStatus(identity), 409);
  assert.equal(await rawStatus(identity, state.reader_token), 403);
  assert.equal(await rawStatus({ ...identity, generation: randomUUID() }), 403);
  checks.push("closed generation, ordinary reader publisher, and foreign generation are rejected");

  const privateChannel = await request("/api/v4/channels", {
    team_id: state.team_id, name: `private-${randomUUID().slice(0, 8)}`,
    display_name: "Private streaming fixture", type: "P",
  }, state.admin_token);
  assert.equal(privateChannel.status, 201);
  await request(`/api/v4/channels/${privateChannel.body.id}/members`, {
    user_id: state.bot_id,
  }, state.admin_token);
  const privateDraft = createMattermostDraftStream({
    client, channelId: privateChannel.body.id, companion: true,
    postProps: buildMattermostPostIdentityProps("turn_result", {
      accountId: "default", agentId: "main", channelId: privateChannel.body.id,
    }),
  });
  privateDraft.update("private channel preview");
  await privateDraft.flush();
  await privateDraft.stop();
  const denied = await fetch(`${base}/plugins/openclaw-stream/v1/posts/${privateDraft.postId()}`, {
    headers: { Authorization: `Bearer ${state.reader_token}` },
  });
  assert([403, 404].includes(denied.status));
  await denied.body?.cancel();
  assert(!events.some((event) =>
    event.event === "custom_openclaw-stream_update" && event.data.post_id === privateDraft.postId()));
  checks.push("nonmember receives neither private-channel snapshot readback nor its WebSocket events");

  for (const commentaryFirst of [false, true]) {
    let stream;
    const card = createMattermostTaskProgressCard({
      client, channelId: state.channel_id, postProps: props("task_progress"),
      claimResultPost: async () => stream.handoffPostIdentity(), log: () => {},
    });
    stream = makeDraft(card.settleBeforeResultPostCreate);
    card.settleBeforeResultPost();
    let oldId;
    if (commentaryFirst) {
      stream.updateAssistantText("commentary before late plan");
      await stream.flush();
      oldId = stream.postId();
    }
    await card.updatePlan({ steps: [{ step: "Inspect", status: "in_progress" }] });
    stream.update("tool progress on result");
    await stream.flush();
    stream.updateAssistantText("final answer on result");
    await stream.stop();
    await card.updatePlan({ steps: [{ step: "Inspect", status: "completed" }] });
    await card.finish({ outcome: "completed" });
    const [cardPost, resultPost] = await Promise.all([
      readPost(card.postId()), readPost(stream.postId()),
    ]);
    assert(cardPost.create_at < resultPost.create_at);
    assert.equal(cardPost.props.openclaw_mattermost.kind, "task_progress");
    assert.equal(resultPost.props.openclaw_mattermost.kind, "turn_result");
    assert(cardPost.message.includes("Task progress") && cardPost.message.includes("Completed"));
    assert.equal(resultPost.message, "final answer on result");
    if (oldId) {
      assert.equal(cardPost.id, oldId);
      const closeAt = trace.findIndex((call) => call.path.endsWith("/close") && call.post_id === oldId);
      assert(closeAt >= 0);
      assert(!trace.slice(closeAt + 1).some((call) =>
        call.path.endsWith("/snapshots") && call.post_id === oldId));
    }
    checks.push(`real task card predates result and finishes terminal (commentary first: ${commentaryFirst})`);
  }
  const receipt = {
    verified_at: new Date().toISOString(), server: "Mattermost Team Edition 12.0.1",
    scope: "Disposable isolated server; synthetic channel callbacks, no Gateway or model run",
    checks,
    trace,
    websocket_events: events.filter((event) =>
      event.event === "custom_openclaw-stream_update"),
  };
  await writeFile(process.argv[3], `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally {
  socket?.close();
  await rm(scratch, { recursive: true, force: true });
}
