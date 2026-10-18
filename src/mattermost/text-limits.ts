export const MATTERMOST_LEGACY_TEXT_LIMIT = 16_383;
export const MATTERMOST_V12_TEXT_LIMIT = 262_144;

const serverLimits = new Map<string, number>();

function serverKey(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/api\/v4$/i, "");
}

/** Refresh from normal REST responses, including after a server upgrade or downgrade. */
export function observeMattermostServerVersion(baseUrl: string, version: string | null): void {
  if (version === null) {
    return;
  }
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[.-]|$)/u.exec(version.trim());
  const major = match ? Number(match[1]) : NaN;
  const limit =
    Number.isSafeInteger(major) && major >= 12
      ? MATTERMOST_V12_TEXT_LIMIT
      : MATTERMOST_LEGACY_TEXT_LIMIT;
  const key = serverKey(baseUrl);
  serverLimits.delete(key);
  serverLimits.set(key, limit);
  if (serverLimits.size > 64) {
    serverLimits.delete(serverLimits.keys().next().value!);
  }
}

export function resolveMattermostTextLimit(params: {
  baseUrl?: string;
  textChunkLimit?: number;
}): number {
  const serverLimit = params.baseUrl
    ? serverLimits.get(serverKey(params.baseUrl)) ?? MATTERMOST_LEGACY_TEXT_LIMIT
    : MATTERMOST_LEGACY_TEXT_LIMIT;
  const configured = params.textChunkLimit;
  return typeof configured === "number" && Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, serverLimit)
    : serverLimit;
}
