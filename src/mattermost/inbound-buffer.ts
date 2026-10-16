// Mattermost's buffer policy waits only for compatible, already durable lane input.
import { isRecord } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeMention } from "./monitor-helpers.js";
import type {
  MattermostIngressLaneFacts,
  MattermostIngressLifecycle,
  MattermostIngressPost,
} from "./monitor-ingress.js";
import {
  parseMattermostEventPayload,
  parseMattermostPost,
  type MattermostEventPayload,
} from "./monitor-websocket.js";

export type MattermostDebounceEntry = {
  post: MattermostIngressPost;
  payload: MattermostEventPayload;
  turnAdoptionLifecycle: MattermostIngressLifecycle;
};

const MAX_BUFFERED_POSTS = 12;
const MAX_BUFFERED_TEXT_LENGTH = 50_000;

export function createMattermostInboundBufferPolicy(params: {
  accountId: string;
  botUsername?: string;
  resolveThreadId: (facts: MattermostIngressLaneFacts) => string | undefined;
  isControlCommand: (text: string) => boolean;
}) {
  const buildKey = (entry: Pick<MattermostDebounceEntry, "post" | "payload">) => {
    const channelId =
      entry.post.channel_id ??
      entry.payload.data?.channel_id ??
      entry.payload.broadcast?.channel_id;
    if (!channelId || !entry.post.user_id) {
      return null;
    }
    const rootId = normalizeOptionalString(entry.post.root_id);
    const channelType = normalizeOptionalString(entry.payload.data?.channel_type);
    const threadId = params.resolveThreadId({
      channelId,
      postId: entry.post.id,
      ...(rootId ? { rootId } : {}),
      ...(channelType ? { channelType } : {}),
    });
    // Final-post access checks must never authorize another sender's buffered text.
    return `mattermost:${params.accountId}:${channelId}:${threadId ? `thread:${threadId}` : "channel"}:${entry.post.user_id}`;
  };
  const shouldDebounce = (entry: Pick<MattermostDebounceEntry, "post">) => {
    if (normalizeOptionalString(entry.post.type) !== undefined || entry.post.file_ids?.length) {
      return false;
    }
    const text = normalizeOptionalString(entry.post.message) ?? "";
    return Boolean(text) && !params.isControlCommand(normalizeMention(text, params.botUsername));
  };
  const canAppend = (
    entry: Pick<MattermostDebounceEntry, "post">,
    pending: readonly Pick<MattermostDebounceEntry, "post">[],
  ) =>
    pending.length < MAX_BUFFERED_POSTS &&
    pending.reduce((total, item) => total + (item.post.message?.length ?? 0), 0) +
      (entry.post.message?.length ?? 0) <=
      MAX_BUFFERED_TEXT_LENGTH;

  return {
    buildKey,
    shouldDebounce,
    canAppend,
    shouldHoldFlush: async (entries: readonly MattermostDebounceEntry[]) => {
      const last = entries.at(-1);
      if (!last || last.turnAdoptionLifecycle.abortSignal.aborted) {
        return false;
      }
      const key = buildKey(last);
      if (!key) {
        return false;
      }
      const bufferedIds = new Set(entries.map((entry) => entry.post.id));
      const backlog = (await last.turnAdoptionLifecycle.readLaneBacklog?.()) ?? [];
      return backlog.some((row) => {
        if (
          bufferedIds.has(row.id) ||
          row.channelId !== "mattermost" ||
          row.accountId !== params.accountId ||
          !isRecord(row.payload) ||
          row.payload.version !== 1 ||
          typeof row.payload.rawEvent !== "string"
        ) {
          return false;
        }
        const payload = parseMattermostEventPayload(row.payload.rawEvent);
        const post = parseMattermostPost(payload?.data?.post);
        if (payload?.event !== "posted" || !post || post.id !== row.id || !post.user_id) {
          return false;
        }
        const candidate = { post: { ...post, user_id: post.user_id }, payload };
        return buildKey(candidate) === key && shouldDebounce(candidate) && canAppend(candidate, entries);
      });
    },
  };
}
