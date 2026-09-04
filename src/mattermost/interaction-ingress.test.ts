import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMattermostIngressQueue } from "./ingress-queue.js";
import {
  buildMattermostInteractionEventId,
  createMattermostInteractionIngressMonitor,
} from "./interaction-ingress.js";
import type { MattermostValidatedInteraction } from "./interactions.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })));
});

async function createStateDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mattermost-interactions-"));
  cleanup.push(dir);
  return dir;
}

function interaction(): MattermostValidatedInteraction {
  return {
    payload: {
      user_id: "abcdefghijklmnopqrstuvwxyz",
      channel_id: "channel-1",
      post_id: "post-1",
      trigger_id: "trigger-1",
    },
    userName: "owner",
    actionId: "approve",
    actionName: "Approve",
    originalMessage: "Approval required",
    context: { action_id: "approve", decision: "allow-once" },
    post: { id: "post-1", channel_id: "channel-1", root_id: "root-1" },
  };
}

describe("Mattermost durable interaction ingress", () => {
  it("deduplicates repeated callbacks after durable admission", async () => {
    const stateDir = await createStateDir();
    const queue = createMattermostIngressQueue({
      accountId: "default",
      stateDir,
      scope: "interactions",
    });
    const dispatch = vi.fn(async () => {});
    const monitor = createMattermostInteractionIngressMonitor({
      accountId: "default",
      queue,
      dispatch,
      runtime: { error: vi.fn(), log: vi.fn() },
      pollIntervalMs: 60_000,
    });
    try {
      const releaseFirst = await monitor.admit(interaction());
      const releaseDuplicate = await monitor.admit(interaction());
      await Promise.resolve();
      expect(dispatch).not.toHaveBeenCalled();
      releaseFirst();
      releaseDuplicate();
      await monitor.waitForIdle();
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      await monitor.stop();
    }
  });

  it("replays a callback that was durably stored before restart", async () => {
    const stateDir = await createStateDir();
    const queue = createMattermostIngressQueue<{
      version: 1;
      receivedAt: number;
      interaction: MattermostValidatedInteraction;
    }>({ accountId: "default", stateDir, scope: "interactions" });
    const stored = interaction();
    const eventId = buildMattermostInteractionEventId(stored);
    await queue.enqueue(
      eventId,
      { version: 1, receivedAt: Date.now(), interaction: stored },
      { laneKey: "channel:channel-1:post:post-1" },
    );
    const dispatch = vi.fn(async () => {});
    const monitor = createMattermostInteractionIngressMonitor({
      accountId: "default",
      queue,
      dispatch,
      runtime: { error: vi.fn(), log: vi.fn() },
      pollIntervalMs: 60_000,
    });
    try {
      await monitor.waitForIdle();
      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch).toHaveBeenCalledWith(stored);
    } finally {
      await monitor.stop();
    }
  });

  it("uses stable identity independent of object key order", () => {
    const original = interaction();
    const reordered = {
      ...original,
      context: { decision: "allow-once", action_id: "approve" },
    };
    expect(buildMattermostInteractionEventId(reordered)).toBe(
      buildMattermostInteractionEventId(original),
    );
  });
});
