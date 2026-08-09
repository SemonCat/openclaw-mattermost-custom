import { resolveGlobalDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
// Mattermost tests cover thread participation cache plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const threadParticipationMemory = resolveGlobalDedupeCache(
  Symbol.for("openclaw.mattermostThreadParticipation"),
  { ttlMs: 7 * 24 * 60 * 60 * 1000, maxSize: 5000 },
);

let hasMattermostThreadParticipation: typeof import("./thread-participation.js").hasMattermostThreadParticipation;
let recordMattermostThreadParticipation: typeof import("./thread-participation.js").recordMattermostThreadParticipation;

describe("mattermost thread participation", () => {
  beforeEach(async () => {
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
    recordMattermostThreadParticipation("acct", "chan", "root-1");
    await expect(
      hasMattermostThreadParticipation({
        accountId: "acct",
        channelId: "chan",
        threadRootId: "root-1",
      }),
    ).resolves.toBe(true);
  });

  it("isolates participation by account, channel, and thread", async () => {
    recordMattermostThreadParticipation("acct", "chan", "root-1");
    for (const probe of [
      { accountId: "other", channelId: "chan", threadRootId: "root-1" },
      { accountId: "acct", channelId: "other", threadRootId: "root-1" },
      { accountId: "acct", channelId: "chan", threadRootId: "root-2" },
    ]) {
      await expect(hasMattermostThreadParticipation(probe)).resolves.toBe(false);
    }
  });

  it("ignores empty identifiers", async () => {
    recordMattermostThreadParticipation("", "chan", "root-1");
    await expect(
      hasMattermostThreadParticipation({
        accountId: "",
        channelId: "chan",
        threadRootId: "root-1",
      }),
    ).resolves.toBe(false);
  });

  it("forgets participation when the process-local cache is cleared", async () => {
    recordMattermostThreadParticipation("acct", "chan", "root-1");
    threadParticipationMemory.clear();
    await expect(
      hasMattermostThreadParticipation({
        accountId: "acct",
        channelId: "chan",
        threadRootId: "root-1",
      }),
    ).resolves.toBe(false);
  });
});
