import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import {
  detectMattermostBlocksSupport,
  resolveMattermostButtonFormat,
} from "./capabilities.js";

function createClient(version?: string): MattermostClient {
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify({ status: "OK" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          ...(version ? { "x-version-id": version } : {}),
        },
      }),
  );
  return {
    baseUrl: `https://${version ?? "unknown"}.example.com`,
    apiBaseUrl: `https://${version ?? "unknown"}.example.com/api/v4`,
    token: "bot-token",
    request: vi.fn(),
    fetchImpl,
  };
}

describe("Mattermost interactive capability detection", () => {
  it("reads the server version header and recognizes the Blocks boundary", async () => {
    await expect(
      detectMattermostBlocksSupport(createClient("11.7.8.11.7.2.hash.false")),
    ).resolves.toBe(false);
    await expect(
      detectMattermostBlocksSupport(createClient("11.10.0.11.10.0.hash.false")),
    ).resolves.toBe(true);
    await expect(
      detectMattermostBlocksSupport(createClient("12.0.1")),
    ).resolves.toBe(true);
  });

  it("keeps the existing Blocks default when the version cannot be determined", async () => {
    await expect(
      detectMattermostBlocksSupport(createClient()),
    ).resolves.toBeUndefined();
    expect(resolveMattermostButtonFormat(undefined, undefined)).toBe("blocks");
  });

  it("honors explicit configuration ahead of detected server support", () => {
    expect(resolveMattermostButtonFormat(true, false)).toBe("blocks");
    expect(resolveMattermostButtonFormat(false, true)).toBe("legacy");
    expect(resolveMattermostButtonFormat(undefined, false)).toBe("legacy");
    expect(resolveMattermostButtonFormat(undefined, true)).toBe("blocks");
  });
});
