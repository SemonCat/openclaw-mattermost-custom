import { resolveGlobalDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
// Mattermost tests cover thread participation cache plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeState = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("../runtime.js", () => ({
  getOptionalMattermostRuntime: () => runtimeState.current,
}));

const threadParticipationMemory = resolveGlobalDedupeCache(
  Symbol.for("openclaw.mattermostThreadParticipation"),
  { ttlMs: 7 * 24 * 60 * 60 * 1000, maxSize: 5000 },
);

let hasMattermostThreadParticipation: typeof import("./thread-participation.js").hasMattermostThreadParticipation;
let recordMattermostThreadParticipation: typeof import("./thread-participation.js").recordMattermostThreadParticipation;

describe("mattermost thread participation", () => {
  beforeEach(async () => {
    runtimeState.current = undefined;
    threadParticipationMemory.clear();
    vi.resetModules();
    ({ hasMattermostThreadParticipation, recordMattermostThreadParticipation } =
      await import("./thread-participation.js"));
  });

  afterEach(() => {
    threadParticipationMemory.clear();
    vi.restoreAllMocks();
  });

  it("remembers a thread the bot replied in", async () => {
    await recordMattermostThreadParticipation("acct", "chan", "root-1");
    await expect(
      hasMattermostThreadParticipation({
        accountId: "acct",
        channelId: "chan",
        threadRootId: "root-1",
      }),
    ).resolves.toBe(true);
  });

  it("isolates participation by account, channel, and thread", async () => {
    await recordMattermostThreadParticipation("acct", "chan", "root-1");
    for (const probe of [
      { accountId: "other", channelId: "chan", threadRootId: "root-1" },
      { accountId: "acct", channelId: "other", threadRootId: "root-1" },
      { accountId: "acct", channelId: "chan", threadRootId: "root-2" },
    ]) {
      await expect(hasMattermostThreadParticipation(probe)).resolves.toBe(false);
    }
  });

  it("ignores empty identifiers", async () => {
    await recordMattermostThreadParticipation("", "chan", "root-1");
    await expect(
      hasMattermostThreadParticipation({
        accountId: "",
        channelId: "chan",
        threadRootId: "root-1",
      }),
    ).resolves.toBe(false);
  });

  it("forgets participation when the process-local cache is cleared", async () => {
    await recordMattermostThreadParticipation("acct", "chan", "root-1");
    threadParticipationMemory.clear();
    await expect(
      hasMattermostThreadParticipation({
        accountId: "acct",
        channelId: "chan",
        threadRootId: "root-1",
      }),
    ).resolves.toBe(false);
  });

  it("recovers participation through the asynchronous V2 store after memory is lost", async () => {
    const records = new Map<string, { repliedAt: number }>();
    const store = {
      register: vi.fn(async (key: string, value: { repliedAt: number }) => {
        records.set(key, value);
      }),
      lookup: vi.fn(async (key: string) => records.get(key)),
    };
    const openKeyedStoreV2 = vi.fn(() => store);
    runtimeState.current = { state: { openKeyedStoreV2 } };
    await recordMattermostThreadParticipation("acct", "chan", "root-1");
    threadParticipationMemory.clear();
    vi.resetModules();
    const reloaded = await import("./thread-participation.js");

    await expect(reloaded.hasMattermostThreadParticipation({
      accountId: "acct", channelId: "chan", threadRootId: "root-1",
    })).resolves.toBe(true);
    expect(openKeyedStoreV2).toHaveBeenCalledWith(expect.objectContaining({
      namespace: "mattermost.thread-participation",
      defaultTtlMs: 7 * 24 * 60 * 60 * 1000,
    }));
    expect(store.lookup).toHaveBeenCalledWith("acct:chan:root-1");
  });
});
