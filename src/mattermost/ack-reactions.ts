// Mattermost plugin module resolves ack/status reaction emoji names and the reaction transport adapter.
import type {
  StatusReactionAdapter,
  StatusReactionEmojis,
} from "openclaw/plugin-sdk/channel-feedback";
import type { MattermostClient } from "./client.js";
import { createMattermostReactionMutation, deleteMattermostReactionMutation } from "./reactions.js";

const MATTERMOST_EMOJI_NAME_PATTERN = /^[a-zA-Z0-9_+-]{1,64}$/;
const MATTERMOST_EMOJI_NAME_BY_GLYPH: Readonly<Record<string, string>> = Object.freeze({
  "👀": "eyes",
  "👍": "+1",
  "👎": "-1",
  "✅": "white_check_mark",
  "❤": "heart",
  "🎉": "tada",
  "🔥": "fire",
  "👏": "clap",
  "🚀": "rocket",
});

/** Mattermost reaction endpoints accept emoji names, not raw Unicode glyphs. */
export function resolveMattermostReactionEmojiName(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const candidate =
    trimmed.length > 2 && trimmed.startsWith(":") && trimmed.endsWith(":")
      ? trimmed.slice(1, -1)
      : trimmed;
  const withoutVariationSelector = candidate.replace(/[\uFE0E\uFE0F]/g, "");
  return (
    MATTERMOST_EMOJI_NAME_BY_GLYPH[withoutVariationSelector] ??
    (MATTERMOST_EMOJI_NAME_PATTERN.test(candidate) ? candidate : null)
  );
}

/** Mattermost-safe names for the shared lifecycle controller's Unicode defaults. */
export const MATTERMOST_STATUS_REACTION_EMOJIS: StatusReactionEmojis = {
  thinking: "brain",
  tool: "hammer_and_wrench",
  coding: "computer",
  web: "globe_with_meridians",
  deploy: "flight_departure",
  build: "building_construction",
  concierge: "information_desk_person",
  done: "white_check_mark",
  error: "x",
  stallSoft: "hourglass_flowing_sand",
  stallHard: "warning",
  compacting: "compression",
};

/** Reuses the authenticated monitor client for the post currently being dispatched. */
export function createMattermostStatusReactionAdapter(params: {
  client: MattermostClient;
  botUserId: string;
  postId: string;
}): StatusReactionAdapter {
  return {
    setReaction: async (emoji) => {
      await createMattermostReactionMutation(params.client, {
        userId: params.botUserId,
        postId: params.postId,
        emojiName: emoji,
      });
    },
    removeReaction: async (emoji) => {
      await deleteMattermostReactionMutation(params.client, {
        userId: params.botUserId,
        postId: params.postId,
        emojiName: emoji,
      });
    },
  };
}
