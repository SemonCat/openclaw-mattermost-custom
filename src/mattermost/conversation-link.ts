// Browser-safe Mattermost launch-link construction and persisted-link validation.
export type MattermostConversationLink = { url: string; label: string };
const nativePostId = /^[a-z0-9]{26}$/u;

export function parseMattermostBaseUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || /[\s\\]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /%/u.test(url.pathname)
    )
      return undefined;
    url.pathname = url.pathname.replace(/\/+$/u, "");
    return url;
  } catch {
    return undefined;
  }
}

export function resolveMattermostConversationLink(params: {
  baseUrl?: string;
  postId?: string | null;
  threadRootId?: string | null;
}): MattermostConversationLink | undefined {
  const base = parseMattermostBaseUrl(params.baseUrl);
  // Never substitute a synthetic command/interaction MessageSid for native identity.
  const id = params.threadRootId || params.postId;
  if (!base || !id || !nativePostId.test(id)) return undefined;
  base.pathname = `${base.pathname.replace(/\/$/u, "")}/_redirect/pl/${id}`;
  return { url: base.href, label: "Mattermost" };
}

export function validateMattermostConversationLink(
  link: MattermostConversationLink | undefined,
  baseUrl: unknown,
): MattermostConversationLink | undefined {
  const base = parseMattermostBaseUrl(baseUrl);
  if (!base || !link || link.label !== "Mattermost" || typeof link.url !== "string")
    return undefined;
  const prefix = `${base.href.replace(/\/$/u, "")}/_redirect/pl/`;
  if (!link.url.startsWith(prefix) || !nativePostId.test(link.url.slice(prefix.length)))
    return undefined;
  return link;
}
