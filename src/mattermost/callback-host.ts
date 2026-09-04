export function isWildcardBindHost(rawHost: string): boolean {
  const trimmed = rawHost.trim();
  if (!trimmed) {
    return false;
  }
  const host = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0" || host === "::0";
}
