// Real SDK drain and plugin-owned SQLite: a notice follows the committed failure.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMattermostIngressQueue } from "./ingress-queue.js";
import { createMattermostIngressMonitor } from "./monitor-ingress.js";

type Options = Parameters<typeof createMattermostIngressMonitor>[0];
type Payload = Parameters<NonNullable<Options["queue"]>["enqueue"]>[1];
const dirs: string[] = [];
const monitors: ReturnType<typeof createMattermostIngressMonitor>[] = [];
afterEach(async () => {
  await Promise.all(monitors.splice(0).map(monitor => monitor.stop()));
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
const event = (kind = "posted", hasAuthor = true) => JSON.stringify({
  event: kind, data: { post: JSON.stringify({
    id: "post", channel_id: "room", ...(hasAuthor ? { user_id: "alice" } : {}),
    root_id: "root", message: "hello", edit_at: 2, delete_at: kind === "post_deleted" ? 2 : 0,
  }) },
});

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mm-dead-letter-"));
  dirs.push(dir);
  const queue = createMattermostIngressQueue<Payload>({ accountId: "default", stateDir: dir });
  const dispatch = vi.fn(async () => { throw new Error("Mattermost API 403: forbidden"); });
  const onDeadLetter = vi.fn(async () => {
    expect((await queue.listFailed()).map(row => row.id)).toEqual(["post"]);
  });
  const start = () => {
    const monitor = createMattermostIngressMonitor({
      accountId: "default", queue, dispatch, onDeadLetter,
      runtime: { log: vi.fn(), error: vi.fn() }, pollIntervalMs: 60_000,
    });
    monitors.push(monitor);
    return monitor;
  };
  return { queue, dispatch, onDeadLetter, start };
}

describe("Mattermost committed dead-letter notification", () => {
  it("notifies after commit, never replays failed input or notifies again on reconnect/restart", async () => {
    const f = await fixture();
    const monitor = f.start();
    await monitor.receive(event());
    await monitor.waitForIdle();
    expect(f.onDeadLetter).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "post", root_id: "root" }),
      expect.objectContaining({ event: "posted" }),
      expect.any(AbortSignal),
    );
    await monitor.receive(event());
    await monitor.waitForIdle();
    await monitor.stop();
    await f.start().waitForIdle();
    expect(f.onDeadLetter).toHaveBeenCalledOnce();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it.each(["post_edited", "post_deleted"])("does not notify for %s failures", async kind => {
    const f = await fixture();
    await f.start().receive(event(kind));
    await monitors.at(-1)!.waitForIdle();
    expect(f.onDeadLetter).not.toHaveBeenCalled();
  });

  it.each([
    { version: 999, receivedAt: 1, rawEvent: event() },
    { version: 1, receivedAt: 1, rawEvent: "invalid" },
    { version: 1, receivedAt: 1, rawEvent: event("posted", false) },
  ])("does not notify malformed persisted input %#", async payload => {
    const f = await fixture();
    await f.queue.enqueue("post", payload as Payload);
    await f.start().waitForIdle();
    expect(await f.queue.listFailed()).toHaveLength(1);
    expect(f.onDeadLetter).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("leaves transient failure retryable and silent", async () => {
    const f = await fixture();
    f.dispatch.mockRejectedValue(new Error("Mattermost API 503: unavailable"));
    const monitor = f.start();
    await monitor.receive(event());
    await monitor.waitForIdle();
    expect(await f.queue.listFailed()).toHaveLength(0);
    expect(await f.queue.listPending()).toHaveLength(1);
    expect(f.onDeadLetter).not.toHaveBeenCalled();
  });

  it("does not notify if the failed write no longer owns its claim", async () => {
    const f = await fixture();
    const fail = vi.spyOn(f.queue, "fail").mockResolvedValue(false);
    const monitor = f.start();
    await monitor.receive(event());
    await monitor.waitForIdle();
    expect(fail).toHaveBeenCalledOnce();
    expect(f.onDeadLetter).not.toHaveBeenCalled();
    expect(await f.queue.listFailed()).toEqual([]);
  });

  it("uses the existing retry budget and minimum age before notifying an exhausted row", async () => {
    const f = await fixture();
    const old = Date.now() - 2 * 24 * 60 * 60_000;
    await f.queue.enqueue("post", { version: 1, receivedAt: old, rawEvent: event() }, { receivedAt: old });
    for (let attempt = 0; attempt < 7; attempt++) {
      const claim = await f.queue.claim("post");
      expect(claim).not.toBeNull();
      await f.queue.release(claim!, { lastError: "previous transient failure", releasedAt: old });
    }
    f.dispatch.mockRejectedValue(new Error("Mattermost API 503: unavailable"));
    await f.start().waitForIdle();
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.onDeadLetter).toHaveBeenCalledOnce();
    expect(await f.queue.listFailed()).toEqual([
      expect.objectContaining({ id: "post", reason: "retry-limit-exceeded" }),
    ]);
  });

  it("keeps the failed tombstone when notice delivery itself fails", async () => {
    const f = await fixture();
    f.onDeadLetter.mockRejectedValue(new Error("notice transport unavailable"));
    const monitor = f.start();
    await monitor.receive(event());
    await monitor.waitForIdle();
    expect(f.onDeadLetter).toHaveBeenCalledOnce();
    expect(await f.queue.listFailed()).toHaveLength(1);
    await monitor.receive(event());
    await monitor.waitForIdle();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
});
