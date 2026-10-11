import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

// Keep replacement-plugin callbacks outside the Gateway's protected /api namespace.
const DEFAULT_SLASH_CALLBACK_PATH = "/mattermost/command";

export function normalizeCallbackPath(value: unknown): string {
  const path = normalizeOptionalString(value) ?? DEFAULT_SLASH_CALLBACK_PATH;
  return path.startsWith("/") ? path : `/${path}`;
}

/** Registration and the pre-plugin auth artifact must discover the same routes. */
export function collectMattermostCallbackPaths(config: unknown): string[] {
  const base = asOptionalRecord(config);
  const paths = new Set<string>();
  for (const account of [base, ...Object.values(asOptionalRecord(base?.accounts) ?? {})]) {
    const commands = asOptionalRecord(asOptionalRecord(account)?.commands);
    paths.add(normalizeCallbackPath(commands?.callbackPath));
    const callbackUrl = normalizeOptionalString(commands?.callbackUrl);
    if (callbackUrl) {
      try {
        const path = new URL(callbackUrl).pathname;
        if (path) {
          paths.add(path);
        }
      } catch {
        // Keep the configured path; registration diagnoses malformed URLs.
      }
    }
  }
  return [...paths];
}

export function isWildcardBindHost(rawHost: string): boolean {
  const trimmed = rawHost.trim();
  if (!trimmed) {
    return false;
  }
  const host = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0" || host === "::0";
}
