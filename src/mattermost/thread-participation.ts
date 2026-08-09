// Mattermost plugin module implements thread participation cache behavior.
import { resolveGlobalDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";

/**
 * Cache of Mattermost threads the bot has replied in. Lets the bot auto-respond
 * to thread follow-ups without a re-mention after its first visible reply.
 */

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_ENTRIES = 5000;

/**
 * Keep thread participation shared across bundled chunks so thread auto-reply
 * gating does not diverge between the inbound-gate and reply-dispatch paths.
 */
const MATTERMOST_THREAD_PARTICIPATION_KEY = Symbol.for("openclaw.mattermostThreadParticipation");
const threadParticipation = resolveGlobalDedupeCache(MATTERMOST_THREAD_PARTICIPATION_KEY, {
  ttlMs: TTL_MS,
  maxSize: MAX_ENTRIES,
});

function makeKey(accountId: string, channelId: string, threadRootId: string): string {
  return `${accountId}:${channelId}:${threadRootId}`;
}

export function recordMattermostThreadParticipation(
  accountId: string,
  channelId: string,
  threadRootId: string,
): void {
  if (!accountId || !channelId || !threadRootId) {
    return;
  }
  threadParticipation.check(makeKey(accountId, channelId, threadRootId));
}

export async function hasMattermostThreadParticipation(params: {
  accountId: string;
  channelId: string;
  threadRootId: string;
}): Promise<boolean> {
  if (!params.accountId || !params.channelId || !params.threadRootId) {
    return false;
  }
  return threadParticipation.peek(makeKey(params.accountId, params.channelId, params.threadRootId));
}
