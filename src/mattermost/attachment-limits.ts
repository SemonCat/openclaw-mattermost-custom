// Mattermost's model.PostFileidsMaxRunes is 300. Ten 26-character IDs
// serialize to 291 runes; eleven exceed the provider's post validation limit.
export const MATTERMOST_MAX_ATTACHMENTS = 10;
export const MATTERMOST_GROUPED_MEDIA_MAX_BYTES = 20 * 1024 * 1024;

export function assertMattermostAttachmentCount(urls: readonly string[]): void {
  if (urls.length > MATTERMOST_MAX_ATTACHMENTS) {
    throw new Error(`Mattermost supports at most ${MATTERMOST_MAX_ATTACHMENTS} attachments per post`);
  }
}
