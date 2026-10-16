// Standalone lifecycle regressions: actual published SDK + plugin-owned SQLite spool.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { fanInChannelIngressLifecycles } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  createMattermostInboundBufferPolicy,
  type MattermostDebounceEntry,
} from "./inbound-buffer.js";
import { createMattermostIngressQueue } from "./ingress-queue.js";
import {
  createMattermostIngressMonitor,
  type MattermostIngressLifecycle,
} from "./monitor-ingress.js";

type Options = Parameters<typeof createMattermostIngressMonitor>[0];
type Payload = Parameters<NonNullable<Options["queue"]>["enqueue"]>[1];
const monitors: ReturnType<typeof createMattermostIngressMonitor>[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(monitors.splice(0).map((m) => m.stop()));
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
async function setup(dispatch: Options["dispatch"], timeout = 5_000, pollIntervalMs = 25) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mm-lane-"));
  dirs.push(dir);
  const queue = createMattermostIngressQueue<Payload>({
    accountId: "default",
    stateDir: dir,
  });
  const start = (deliver = dispatch) => {
    const monitor = createMattermostIngressMonitor({
      accountId: "default",
      queue,
      dispatch: deliver,
      runtime: { error: vi.fn(), log: vi.fn() },
      pollIntervalMs,
      adoptionStallTimeoutMs: timeout,
      resolveThreadId: (facts) => facts.rootId,
    });
    monitors.push(monitor);
    return monitor;
  };
  return { queue, start, monitor: start() };
}
const event = (id: string, root = "thread-A", message = "hello") =>
  JSON.stringify({
    event: "posted",
    data: {
      channel_type: "O",
      post: JSON.stringify({
        id,
        root_id: root,
        channel_id: "channel",
        user_id: "user",
        message,
      }),
    },
  });

it("releases A synchronously before first await, admits same-lane settings/native B, retains A until adoption", async () => {
  const lifecycles = new Map<string, MattermostIngressLifecycle>();
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const calls: string[] = [];
  const { monitor, queue } = await setup(async (post, _payload, lifecycle) => {
    calls.push(post.id);
    lifecycles.set(post.id, lifecycle);
    if (post.id === "A") {
      lifecycle.onDeferred();
      await blocked;
    } else await lifecycle.onAdopted();
  });
  await monitor.receive(event("A", "thread-A", "pending question/input"));
  await vi.waitFor(() => expect(lifecycles.has("A")).toBe(true));
  const claim = (await queue.listClaims())[0]!;
  for (const [id, command] of [
    ["B", "/think high"],
    ["C", "/oc_skill helper"],
  ]) {
    await monitor.receive(event(id, "thread-A", command));
    await vi.waitFor(() => expect(calls).toContain(id));
  }
  expect(lifecycles.get("A")!.abortSignal.aborted).toBe(false);
  expect((await queue.listClaims()).find((row) => row.id === "A")?.claim).toEqual(claim.claim);
  lifecycles.get("A")!.onDeferredHeartbeat?.();
  lifecycles.get("A")!.onAdoptionFinalizing();
  await lifecycles.get("A")!.onAdopted();
  await lifecycles.get("A")!.onAdopted();
  finish();
  await monitor.waitForIdle();
  expect(await queue.listClaims()).toEqual([]);
  await monitor.receive(event("A"));
  await monitor.waitForIdle();
  expect(calls.filter((id) => id === "A")).toHaveLength(1);
});

it("holds dispatching siblings within each thread while allowing an independent thread", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const { monitor } = await setup(async (post, _payload, lifecycle) => {
    calls.push(post.id);
    if (post.id === "A") await blocked;
    await lifecycle.onAdopted();
  });
  await monitor.receive(event("A"));
  await vi.waitFor(() => expect(calls).toEqual(["A"]));
  await monitor.receive(event("B"));
  await monitor.receive(event("other", "thread-B"));
  await vi.waitFor(() => expect(calls).toEqual(["A", "other"]));
  release();
  await vi.waitFor(() => expect(calls).toEqual(["A", "other", "B"]));
  await monitor.waitForIdle();
});

it("heartbeat extends deferred watchdog; finalizing clears it and adoption tombstones once", async () => {
  let lifecycle!: MattermostIngressLifecycle;
  const { monitor, queue } = await setup(
    (_p, _e, l) => {
      lifecycle = l;
      l.onDeferred();
    },
    900,
    60_000,
  );
  vi.useFakeTimers();
  await monitor.receive(event("A"));
  await vi.advanceTimersByTimeAsync(0);
  expect(await queue.listClaims()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(600);
  lifecycle.onDeferredHeartbeat?.();
  await vi.advanceTimersByTimeAsync(600);
  expect(lifecycle.abortSignal.aborted).toBe(false);
  expect(await queue.listClaims()).toHaveLength(1);
  const beforeLeaseRefresh = (await queue.listClaims())[0]!.claim.claimedAt;
  lifecycle.onAdoptionFinalizing();
  await vi.advanceTimersByTimeAsync(600_000);
  expect((await queue.listClaims())[0]!.claim.claimedAt).toBeGreaterThan(beforeLeaseRefresh);
  await lifecycle.onAdopted();
  await lifecycle.onAdopted();
  expect(await queue.listClaims()).toEqual([]);
});

it.each(["cancel", "fail"] as const)(
  "settles active deferred %s with durable retry facts and replays once",
  async (action) => {
    let lifecycle!: MattermostIngressLifecycle;
    const calls: string[] = [];
    const { queue, monitor } = await setup(async (post, _e, l) => {
      calls.push(post.id);
      if (calls.length === 1) {
        lifecycle = l;
        l.onDeferred();
      } else await l.onAdopted();
    });
    await monitor.receive(event("A"));
    await monitor.waitForIdle();
    const old = (await queue.listClaims())[0]!;
    // Callback runs against the active monitor, before stop or restart.
    if (action === "cancel") await lifecycle.onCancelled?.();
    else await lifecycle.onFailed?.(new Error("transient"));
    expect(await queue.listClaims()).toEqual([]);
    expect(await queue.listPending()).toMatchObject([
      {
        id: "A",
        attempts: action === "cancel" ? 0 : 1,
        ...(action === "fail" ? { lastError: "transient", lastAttemptAt: expect.any(Number) } : {}),
      },
    ]);
    expect(await queue.complete(old)).toBe(false);
    if (action === "fail") {
      // Retry delay must prevent immediate replay; disposition is not completion.
      await monitor.receive(event("B", "thread-B"));
      await monitor.waitForIdle();
      expect(calls.filter((id) => id === "A")).toHaveLength(1);
    }
    await vi.waitFor(() => expect(calls.filter((id) => id === "A")).toHaveLength(2), {
      timeout: 5_000,
    });
    await monitor.waitForIdle();
    await monitor.receive(event("A"));
    await monitor.waitForIdle();
    expect(calls.filter((id) => id === "A")).toHaveLength(2);
    expect(await queue.listPending()).toEqual([]);
  },
);

it("recovers a released deferred claim on restart and fences the old owner", async () => {
  const { queue, monitor, start } = await setup((_p, _e, l) => {
    l.onDeferred();
  });
  await monitor.receive(event("A"));
  await monitor.waitForIdle();
  const old = (await queue.listClaims())[0]!;
  await monitor.stop();
  const calls: string[] = [];
  const restarted = start(async (post, _e, l) => {
    calls.push(post.id);
    await l.onAdopted();
  });
  await vi.waitFor(() => expect(calls).toEqual(["A"]));
  await restarted.waitForIdle();
  expect(await queue.complete(old)).toBe(false);
  await restarted.receive(event("A"));
  await restarted.waitForIdle();
  expect(calls).toEqual(["A"]);
  expect(await queue.listClaims()).toEqual([]);
});

it("holds a quiet buffer for an already claimed sibling, then adopts both together", async () => {
  const batches: string[][] = [];
  const policy = createMattermostInboundBufferPolicy({
    accountId: "default",
    botUsername: "bot",
    resolveThreadId: (facts) => facts.rootId,
    isControlCommand: (text) => text.startsWith("/"),
  });
  const debouncer = createInboundDebouncer<MattermostDebounceEntry>({
    ...policy,
    debounceMs: 100,
    onFlush: (entries, createFlush) => {
      const { lifecycle, settle } = fanInChannelIngressLifecycles(
        entries.map((entry) => entry.turnAdoptionLifecycle),
      );
      return createFlush({
        lifecycle,
        dispatch: async (admission) => {
          batches.push(entries.map((entry) => entry.post.id));
          await admission.onAdopted();
          await settle();
        },
      });
    },
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const { monitor, queue } = await setup(async (post, payload, lifecycle) => {
    calls.push(post.id);
    if (post.id === "B") await blocked;
    await debouncer.enqueue({ post, payload, turnAdoptionLifecycle: lifecycle });
    return { kind: "deferred" };
  }, 5_000, 60_000);
  vi.useFakeTimers();
  try {
    await monitor.receive(event("A"));
    await vi.advanceTimersByTimeAsync(0);
    await monitor.receive(event("B"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["A", "B"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(batches).toEqual([]);
    expect((await queue.listClaims()).map((claim) => claim.id).toSorted()).toEqual(["A", "B"]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await monitor.waitForIdle();
    await debouncer.drain();
    expect(batches).toEqual([["A", "B"]]);
    expect(await queue.listClaims()).toEqual([]);
    await monitor.receive(event("A"));
    await monitor.receive(event("B"));
    await monitor.waitForIdle();
    expect(batches).toEqual([["A", "B"]]);
  } finally {
    release();
  }
});
