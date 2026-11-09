// Presentation only: the persisted message remains the complete Markdown authority.
// Leave room for the native header within Mattermost's 16,000 text budget.
export function mattermostWorkDetailsProps(message: string): Record<string, unknown> | undefined {
  if (!message.trim() || Buffer.byteLength(message, "utf8") > 15_000) return undefined;
  return { version: 1, source_message: message };
}
