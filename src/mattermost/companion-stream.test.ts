import { afterEach, describe, expect, it, vi } from "vitest";
import { createMattermostClient } from "./client.js";
import { createMattermostCompanionStream } from "./companion-stream.js";
import { createMattermostDraftStream } from "./draft-stream.js";
import { buildMattermostPostIdentityProps } from "./post-identity.js";
import { createMattermostTaskProgressCard } from "./task-progress-card.js";

const capabilities = {
  protocol: 1,
  post_type: "custom_openclaw_stream",
  event: "custom_openclaw-stream_update",
  lease_ms: 15000,
  max_chars: 262144,
};
const props = buildMattermostPostIdentityProps("turn_result", {
  accountId: "default", agentId: "main", channelId: "channel",
});

function fixture(options: {
  capability?: unknown;
  snapshotStatus?: number;
  snapshotResponse?: () => Promise<Response>;
  closeResponse?: () => Promise<Response>;
  createResponse?: (payload: Record<string, unknown>, id: string) => unknown;
  rejectCreate?: (ordinal: number) => boolean;
} = {}) {
  const calls: Array<{ path: string; body?: Record<string, unknown>; init?: RequestInit }> = [];
  const posts = new Map<string, Record<string, unknown>>();
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ path, body, init });
    let response: unknown = {};
    let status = 200;
    if (path.endsWith("/capabilities")) response = options.capability ?? capabilities;
    else if (path.endsWith("/snapshots")) {
      if (options.snapshotResponse) return await options.snapshotResponse();
      status = options.snapshotStatus ?? 200;
      response = { accepted: true };
    } else if (path.endsWith("/close")) {
      if (options.closeResponse) return await options.closeResponse();
      response = { accepted: true };
    }
    else if (path === "/api/v4/posts") {
      if (options.rejectCreate?.(posts.size + 1)) return Response.json({}, { status: 503 });
      const id = `post-${posts.size + 1}`;
      const post = { ...body, id };
      posts.set(id, post);
      response = options.createResponse?.(post, id) ?? post;
    } else if (path.endsWith("/patch")) {
      const id = path.split("/")[4]!;
      const post = { ...posts.get(id), ...body, id };
      posts.set(id, post);
      response = post;
    } else if (path.startsWith("/api/v4/posts/")) {
      response = posts.get(path.split("/")[4]!);
    }
    return Response.json(response, { status });
  });
  const client = createMattermostClient({
    baseUrl: "https://chat.example.com", botToken: "fixture-bot-token", fetchImpl,
  });
  const createCompanion = () => createMattermostCompanionStream({
    client, channelId: "channel", postProps: props,
  });
  const createDraft = (companion = true) => createMattermostDraftStream({
    client, channelId: "channel", postProps: props, companion, throttleMs: 1200,
  });
  return { calls, posts, client, createCompanion, createDraft };
}

afterEach(() => vi.useRealTimers());

describe("Mattermost companion transport", () => {
  it("keeps omitted transport entirely on the original REST path", async () => {
    const f = fixture();
    const draft = f.createDraft(false);
    draft.update("first");
    await draft.flush();
    draft.update("second");
    await draft.stop();
    expect(f.calls.map((c) => c.path)).toEqual([
      "/api/v4/posts", "/api/v4/posts/post-1/patch",
    ]);
    expect(f.posts.get("post-1")?.type).toBeUndefined();
  });

  it.each([{}, { ...capabilities, protocol: 2 }, { ...capabilities, event: "foreign" }])(
    "falls back before creating a post when capabilities are incompatible: %j", async (capability) => {
      const f = fixture({ capability });
      const draft = f.createDraft();
      draft.update("answer");
      await draft.stop();
      expect(f.posts.size).toBe(1);
      expect(f.posts.get("post-1")?.type).toBeUndefined();
      expect(f.calls.filter((c) => c.path.includes("/plugins/"))).toHaveLength(1);
    },
  );

  it("uses the same origin/bot and independent post generations with increasing sequences", async () => {
    const f = fixture();
    const companion = f.createCompanion();
    const first = await companion.createPost("first");
    companion.update(first.id, "snapshot");
    expect(await companion.freeze(first.id)).toBe(true);
    await companion.close(first.id);
    companion.update(first.id, "late");
    const second = await companion.createPost("second");
    companion.update(second.id, "another");
    await companion.freeze(second.id);
    await companion.close(second.id);
    const pluginCalls = f.calls.filter((c) => c.path.includes("/plugins/"));
    expect(pluginCalls.every((c) =>
      new Headers(c.init?.headers).get("Authorization") === "Bearer fixture-bot-token",
    )).toBe(true);
    expect(pluginCalls.every((c) => c.init?.redirect === "error")).toBe(true);
    expect(pluginCalls.every((c) => c.init?.signal instanceof AbortSignal)).toBe(true);
    expect(pluginCalls.filter((c) => c.path.endsWith("/capabilities"))).toHaveLength(1);
    expect(pluginCalls.filter((c) => c.body).map((c) => [c.body?.post_id, c.body?.seq])).toEqual([
      ["post-1", 1], ["post-1", 2], ["post-2", 1], ["post-2", 2],
    ]);
    const one = first.props?.openclaw_stream as { generation: string };
    const two = second.props?.openclaw_stream as { generation: string };
    expect(one.generation).not.toBe(two.generation);
    expect(first.type).toBe("custom_openclaw_stream");
    expect(first.props?.openclaw_mattermost).toEqual(props.openclaw_mattermost);
  });

  it("publishes between REST checkpoints, then checkpoints before close without another post", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const draft = f.createDraft();
    draft.updateAssistantText("first");
    await draft.flush();
    await vi.advanceTimersByTimeAsync(300);
    draft.updateAssistantText("newest preview");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls.some((c) => c.path.endsWith("/snapshots") && c.body?.message === "newest preview")).toBe(true);
    expect(f.posts.get("post-1")?.message).toBe("first");
    await draft.seal();
    expect(f.posts.get("post-1")?.message).toBe("newest preview");
    expect(f.calls.at(-2)?.path).toBe("/api/v4/posts/post-1/patch");
    expect(f.calls.at(-1)?.path).toBe("/plugins/openclaw-stream/v1/close");
    const callCount = f.calls.length;
    draft.update("late tail");
    await vi.advanceTimersByTimeAsync(2000);
    await draft.stop();
    expect(f.calls).toHaveLength(callCount);
    expect(f.posts.size).toBe(1);
  });

  it("preserves the 1200ms REST cadence while the companion runs at 250ms", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const draft = f.createDraft();
    draft.update("first");
    await draft.flush();
    for (let i = 1; i <= 4; i++) {
      await vi.advanceTimersByTimeAsync(250);
      draft.update(`part ${i}`);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(f.calls.filter((c) => c.path.endsWith("/patch"))).toHaveLength(0);
    expect(f.calls.filter((c) => c.path.endsWith("/snapshots")).length).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(f.posts.get("post-1")?.message).toBe("part 4");
    await draft.stop();
  });

  it("retains REST delivery and creates no duplicate when snapshot publication fails", async () => {
    const f = fixture({ snapshotStatus: 503 });
    const draft = f.createDraft();
    draft.update("partial");
    await draft.flush();
    draft.update("final");
    await draft.stop();
    expect(f.posts.size).toBe(1);
    expect(f.posts.get("post-1")?.message).toBe("final");
    expect(f.calls.filter((c) => c.path.endsWith("/snapshots"))).toHaveLength(1);
    expect(f.calls.some((c) => c.path.endsWith("/close"))).toBe(true);
  });

  it("waits for an accepted in-flight snapshot before close and discards queued tails", async () => {
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { release = resolve; });
    const f = fixture({ snapshotResponse: () => response });
    const companion = f.createCompanion();
    const post = await companion.createPost("durable");
    companion.update(post.id, "in-flight");
    companion.update(post.id, "queued");
    const close = companion.close(post.id);
    expect(f.calls.some((c) => c.path.endsWith("/close"))).toBe(false);
    release(Response.json({ accepted: true }));
    await close;
    companion.update(post.id, "late");
    expect(f.calls.filter((c) => c.path.endsWith("/snapshots"))).toHaveLength(1);
    expect(f.calls.at(-1)?.path).toBe("/plugins/openclaw-stream/v1/close");
  });

  it("closes the old generation before handoff and routes later snapshots to the successor", async () => {
    const f = fixture();
    const draft = f.createDraft();
    draft.updateAssistantText("commentary");
    await draft.flush();
    expect(await draft.handoffPostIdentity()).toBe("post-1");
    expect(draft.postId()).toBe("post-2");
    const oldClose = f.calls.findIndex((c) => c.path.endsWith("/close") && c.body?.post_id === "post-1");
    const creates = f.calls.flatMap((c, i) => c.path === "/api/v4/posts" ? [i] : []);
    expect(oldClose).toBeGreaterThan(-1);
    expect(f.calls.slice(oldClose + 1).some((c) => c.path === "/api/v4/posts")).toBe(true);
    draft.updateAssistantText("answer");
    await draft.stop();
    expect(f.posts.get("post-1")?.message).toBe("commentary");
    expect(f.posts.get("post-2")?.message).toBe("answer");
    expect(f.calls.slice(oldClose + 1).some((c) => c.path.endsWith("/snapshots") && c.body?.post_id === "post-1")).toBe(false);
    expect(creates[1]).toBeGreaterThan(oldClose);
  });

  it("keeps accepted-without-id creation failures terminal even with companion enabled", async () => {
    const f = fixture({ createResponse: () => ({ message: "accepted without identity" }) });
    const draft = f.createDraft();
    draft.update("answer");
    await expect(draft.flush()).rejects.toThrow("post id");
    await expect(draft.stop()).rejects.toThrow("post id");
    expect(f.posts.size).toBe(1);
    expect(f.calls.filter((c) => c.path.endsWith("/snapshots"))).toHaveLength(0);
  });

  it("creates a late plan before the first companion result even after delivery started", async () => {
    const f = fixture();
    const card = createMattermostTaskProgressCard({
      client: f.client, channelId: "channel", log: vi.fn(),
    });
    const draft = createMattermostDraftStream({
      client: f.client, channelId: "channel", companion: true, postProps: props,
      beforeCreatePost: card.settleBeforeResultPostCreate,
    });
    expect(card.settleBeforeResultPost()).toBeUndefined();
    const plan = card.updatePlan({ steps: [{ step: "Inspect", status: "in_progress" }] });
    draft.update("tool progress");
    await Promise.all([plan, draft.flush()]);
    await draft.stop();
    await card.finish({ outcome: "completed" });
    expect(card.postId()).toBe("post-1");
    expect(draft.postId()).toBe("post-2");
    const creates = f.calls.filter((c) => c.path === "/api/v4/posts");
    expect(creates.map((c) => c.body?.message)).toEqual([
      expect.stringContaining("Task progress"), "tool progress",
    ]);
    expect(creates[0]?.body?.type).toBeUndefined();
    expect(creates[1]?.body?.type).toBe(capabilities.post_type);
    expect(f.calls.filter((c) => c.path.endsWith("/snapshots"))
      .every((c) => c.body?.post_id === "post-2")).toBe(true);
  });

  it("closes commentary before card conversion and keeps later tool/final updates on its successor", async () => {
    const f = fixture();
    let draft!: ReturnType<typeof createMattermostDraftStream>;
    const card = createMattermostTaskProgressCard({
      client: f.client, channelId: "channel", log: vi.fn(),
      postProps: buildMattermostPostIdentityProps("task_progress", {
        accountId: "default", agentId: "main", channelId: "channel",
      }),
      claimResultPost: () => draft.handoffPostIdentity(),
    });
    draft = createMattermostDraftStream({
      client: f.client, channelId: "channel", companion: true, postProps: props,
      beforeCreatePost: card.settleBeforeResultPostCreate,
    });
    draft.updateAssistantText("commentary before plan");
    await draft.flush();
    await card.updatePlan({ steps: [{ step: "Inspect", status: "in_progress" }] });
    draft.update("later tool progress");
    await draft.flush();
    draft.updateAssistantText("final answer");
    await draft.stop();
    await card.updatePlan({ steps: [{ step: "Inspect", status: "completed" }] });
    await card.finish({ outcome: "completed" });
    expect(card.postId()).toBe("post-1");
    expect(draft.postId()).toBe("post-2");
    const sequence = f.calls.filter((c) => c.path !== "/plugins/openclaw-stream/v1/capabilities");
    const closeIndex = sequence.findIndex((c) =>
      c.path.endsWith("/close") && c.body?.post_id === "post-1");
    const successorIndex = sequence.findIndex((c, i) =>
      i > 0 && c.path === "/api/v4/posts");
    const conversionIndex = sequence.findIndex((c) =>
      c.path === "/api/v4/posts/post-1/patch");
    expect(closeIndex).toBeGreaterThan(-1);
    expect(successorIndex).toBeGreaterThan(closeIndex);
    expect(conversionIndex).toBeGreaterThan(successorIndex);
    expect(sequence.slice(closeIndex + 1).filter((c) => c.path.endsWith("/snapshots"))
      .every((c) => c.body?.post_id === "post-2")).toBe(true);
    expect(f.posts.get("post-1")?.message).toContain("Task progress · Completed");
    expect(f.posts.get("post-2")?.message).toBe("final answer");
    expect(f.posts.get("post-1")?.props).not.toHaveProperty("openclaw_stream");
    expect(f.posts.size).toBe(2);
  });

  it("retains the original editable result when the successor create is unaccepted", async () => {
    const f = fixture({ rejectCreate: (ordinal) => ordinal === 2 });
    const draft = f.createDraft();
    draft.update("commentary");
    await draft.flush();
    expect(await draft.handoffPostIdentity()).toBeUndefined();
    expect(draft.postId()).toBe("post-1");
    draft.update("final answer");
    await draft.stop();
    expect(f.posts.size).toBe(1);
    expect(f.posts.get("post-1")?.message).toBe("final answer");
    const close = f.calls.findIndex((c) => c.path.endsWith("/close"));
    expect(f.calls.slice(close + 1).some((c) => c.path.endsWith("/snapshots"))).toBe(false);
  });

  it("preserves lossless block chunks and starts a separate generation for the next block", async () => {
    const f = fixture();
    const draft = createMattermostDraftStream({
      client: f.client, channelId: "channel", postProps: props, companion: true,
      maxChars: 40, chunkText: (text) => text.match(/.{1,40}/g) ?? [],
    });
    const block = "a".repeat(80);
    draft.updateAssistantText(block);
    await draft.flush();
    await draft.forceNewMessage();
    draft.updateAssistantText("next block");
    await draft.stop();
    expect([...f.posts.values()].map((post) => post.message)).toEqual([
      "a".repeat(40), "a".repeat(40), "next block",
    ]);
    expect(draft.resolveFinalText(`${block}\nnext block`).kind).toBe("remaining");
    const close = f.calls.findIndex((c) =>
      c.path.endsWith("/close") && c.body?.post_id === "post-1");
    expect(f.calls.slice(close + 1).some((c) =>
      c.path.endsWith("/snapshots") && c.body?.post_id === "post-1")).toBe(false);
  });

  it("routes callbacks arriving during a delayed close to the successor before handing away the old id", async () => {
    let release!: (response: Response) => void;
    const pendingClose = new Promise<Response>((resolve) => { release = resolve; });
    let closeCount = 0;
    const f = fixture({
      closeResponse: () => ++closeCount === 1
        ? pendingClose : Promise.resolve(Response.json({ accepted: true })),
    });
    const draft = f.createDraft();
    draft.updateAssistantText("commentary");
    await draft.flush();
    const handoff = draft.handoffPostIdentity();
    await vi.waitFor(() => expect(f.calls.some((c) => c.path.endsWith("/close"))).toBe(true));
    draft.updateAssistantText("arrived during close");
    const flush = draft.flush();
    release(Response.json({ accepted: true }));
    expect(await handoff).toBe("post-1");
    await flush;
    await draft.stop();
    expect(f.posts.get("post-1")?.message).toBe("commentary");
    expect(f.posts.get("post-2")?.message).toBe("arrived during close");
    expect(f.calls.some((c) =>
      c.path === "/api/v4/posts/post-1/patch" && c.body?.message === "arrived during close")).toBe(false);
  });
});
