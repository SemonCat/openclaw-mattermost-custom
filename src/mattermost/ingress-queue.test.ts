import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMattermostIngressQueue } from "./ingress-queue.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })));
});

async function stateDir(): Promise<string> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "mattermost-custom-ingress-"));
  cleanupPaths.push(created);
  return created;
}

describe("plugin-owned Mattermost ingress queue", () => {
  it("recovers an uncompleted claim after recreating the queue", async () => {
    const root = await stateDir();
    const first = createMattermostIngressQueue<{ rawEvent: string }>({
      accountId: "default",
      stateDir: root,
      now: () => 100,
    });
    await first.enqueue("post-1", { rawEvent: "event" }, { laneKey: "channel-1" });
    const claimed = await first.claim("post-1", { ownerId: "old-gateway" });
    expect(claimed?.claim.ownerId).toBe("old-gateway");

    const restarted = createMattermostIngressQueue<{ rawEvent: string }>({
      accountId: "default",
      stateDir: root,
      now: () => 200,
    });
    expect(await restarted.recoverStaleClaims({ staleMs: 0, now: 200 })).toBe(1);
    const recovered = await restarted.claim("post-1", { ownerId: "new-gateway" });
    expect(recovered).toMatchObject({
      id: "post-1",
      attempts: 1,
      laneKey: "channel-1",
      claim: { ownerId: "new-gateway" },
    });
    expect(await restarted.complete(recovered!)).toBe(true);
    expect(await restarted.enqueue("post-1", { rawEvent: "duplicate" })).toMatchObject({
      kind: "completed",
      duplicate: true,
    });
  });

  it("fences stale claim settlement by token", async () => {
    const root = await stateDir();
    const queue = createMattermostIngressQueue<{ rawEvent: string }>({
      accountId: "default",
      stateDir: root,
    });
    await queue.enqueue("post-2", { rawEvent: "event" });
    const stale = await queue.claim("post-2", { ownerId: "old-gateway" });
    expect(stale).not.toBeNull();
    await queue.recoverStaleClaims({ staleMs: 0, now: Date.now() + 1 });
    const current = await queue.claim("post-2", { ownerId: "new-gateway" });
    expect(current).not.toBeNull();

    expect(await queue.complete(stale!)).toBe(false);
    expect(await queue.complete(current!)).toBe(true);
  });
});
