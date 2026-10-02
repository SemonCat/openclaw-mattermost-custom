import type { MattermostClient } from "./client.js";

const MATTERMOST_BLOCKS_MINIMUM_VERSION = [11, 10, 0] as const;
const MATTERMOST_CAPABILITY_PROBE_TIMEOUT_MS = 5_000;

const blocksSupportCache = new Map<string, boolean | undefined>();
const blocksSupportPending = new Map<string, Promise<boolean | undefined>>();

function parseMattermostVersion(
  version: string,
): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version.trim());
  if (!match) {
    return undefined;
  }
  const parsed = match.slice(1, 4).map(Number);
  if (parsed.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    return undefined;
  }
  return parsed as [number, number, number];
}

function compareVersion(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

async function probeMattermostBlocksSupport(
  client: MattermostClient,
): Promise<boolean | undefined> {
  let response: Response | undefined;
  try {
    const headers = new Headers();
    if (client.token) {
      headers.set("Authorization", `Bearer ${client.token}`);
    }
    response = await client.fetchImpl(`${client.apiBaseUrl}/system/ping`, {
      headers,
      timeoutMs: MATTERMOST_CAPABILITY_PROBE_TIMEOUT_MS,
    });
    if (!response.ok) {
      return undefined;
    }
    const version = response.headers.get("x-version-id");
    const parsed = version ? parseMattermostVersion(version) : undefined;
    return parsed
      ? compareVersion(parsed, MATTERMOST_BLOCKS_MINIMUM_VERSION) >= 0
      : undefined;
  } catch {
    // Capability probing must never prevent an otherwise valid message send.
    return undefined;
  } finally {
    try {
      await response?.body?.cancel();
    } catch {
      // The response headers are sufficient; body cleanup is best effort.
    }
  }
}

export async function detectMattermostBlocksSupport(
  client: MattermostClient,
): Promise<boolean | undefined> {
  const cacheKey = client.baseUrl;
  if (!cacheKey) {
    return await probeMattermostBlocksSupport(client);
  }
  if (blocksSupportCache.has(cacheKey)) {
    return blocksSupportCache.get(cacheKey);
  }
  const pending = blocksSupportPending.get(cacheKey);
  if (pending) {
    return await pending;
  }
  const probe = probeMattermostBlocksSupport(client).then((result) => {
    blocksSupportCache.set(cacheKey, result);
    return result;
  });
  blocksSupportPending.set(cacheKey, probe);
  try {
    return await probe;
  } finally {
    blocksSupportPending.delete(cacheKey);
  }
}

export function resolveMattermostButtonFormat(
  configuredBlocks: boolean | undefined,
  detectedBlocksSupport: boolean | undefined,
): "blocks" | "legacy" {
  if (configuredBlocks !== undefined) {
    return configuredBlocks ? "blocks" : "legacy";
  }
  return detectedBlocksSupport === false ? "legacy" : "blocks";
}
