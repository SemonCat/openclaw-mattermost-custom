import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createMattermostIngressQueue } from "./ingress-queue.js";
import { createMattermostIngressMonitor } from "./monitor-ingress.js";

it("durably isolates post create/edit/delete revisions, deduplicates reconnect replay, and recovers pending notices", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mm-mutations-"));
  type Options = Parameters<typeof createMattermostIngressMonitor>[0];
  type Payload = Parameters<NonNullable<Options["queue"]>["enqueue"]>[1];
  const queue = createMattermostIngressQueue<Payload>({ accountId: "default", stateDir: dir });
  const delivered: string[] = [];
  const event = (kind: string, revision: number) => JSON.stringify({
    event: kind,
    data: { channel_type: "O", post: JSON.stringify({
      id: "post", channel_id: "room", user_id: "alice", root_id: "root",
      edit_at: revision, delete_at: revision, message: "updated",
    }) },
  });
  const start = () => createMattermostIngressMonitor({
    accountId: "default", queue, pollIntervalMs: 10,
    resolveThreadId: (facts) => facts.rootId,
    dispatch: async (_post, payload) => { delivered.push(`${payload.event}:${(_post.edit_at)}`); },
    runtime: { error: vi.fn(), log: vi.fn() },
  });
  let monitor = start();
  try {
    await monitor.receive(event("posted", 1));
    await monitor.receive(event("post_edited", 2));
    await monitor.receive(event("post_edited", 3));
    await monitor.receive(event("post_deleted", 4));
    await monitor.waitForIdle();
    expect(delivered).toEqual(["posted:1", "post_edited:2", "post_edited:3", "post_deleted:4"]);
    await monitor.stop();
    await queue.enqueue("post_edited:post:5", {
      version: 1, receivedAt: Date.now(), rawEvent: event("post_edited", 5),
    }, { laneKey: "channel:room:thread:root" });
    monitor = start();
    await monitor.waitForIdle();
    await monitor.receive(event("post_edited", 2));
    await monitor.receive(event("post_deleted", 4));
    await monitor.waitForIdle();
    expect(delivered).toEqual(["posted:1", "post_edited:2", "post_edited:3", "post_deleted:4", "post_edited:5"]);
  } finally {
    await monitor.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
