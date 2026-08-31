import { once } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import { setMattermostRuntime } from "../runtime.js";
import { sendMessageMattermost } from "./send.js";

async function withServer<T>(handler: RequestListener, run: (baseUrl: string) => Promise<T>) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function createTestRuntime(): PluginRuntime {
  return {
    logging: {
      getChildLogger: () => ({ debug: () => {}, warn: () => {}, error: () => {} }),
      shouldLogVerbose: () => false,
    },
    channel: {
      activity: { record: () => {} },
    },
  } as unknown as PluginRuntime;
}

describe("Mattermost media limits at the upload boundary", () => {
  it("rejects oversized source bytes without uploading or falling back to a text post", async () => {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "mattermost-cap-")));
    const file = path.join(directory, "attachment.txt");
    const writes: string[] = [];
    setMattermostRuntime(createTestRuntime());
    try {
      await withServer(
        (request, response) => {
          request.resume();
          request.on("end", () => {
            writes.push(request.url ?? "");
            response.writeHead(201, { "content-type": "application/json" });
            response.end(
              JSON.stringify(
                request.url === "/api/v4/files"
                  ? { file_infos: [{ id: "file-cap" }] }
                  : { id: "post-cap", channel_id: "aaaaaaaaaaaaaaaaaaaaaaaaaa" },
              ),
            );
          });
        },
        async (baseUrl) => {
          const opts = {
            cfg: {
              channels: {
                mattermost: {
                  baseUrl,
                  botToken: "fixture",
                  mediaMaxMb: 10,
                  network: { dangerouslyAllowPrivateNetwork: true },
                  accounts: { Limited: { mediaMaxMb: 1 / 1024 } },
                },
              },
            },
            accountId: "limited",
            mediaUrl: file,
            mediaLocalRoots: [directory],
          };
          await writeFile(file, "x".repeat(1536));
          await expect(
            sendMessageMattermost("channel:aaaaaaaaaaaaaaaaaaaaaaaaaa", "caption", opts),
          ).rejects.toThrow(/exceeds.*limit/i);
          expect(writes).toEqual([]);
          await writeFile(file, "x".repeat(512));
          const result = await sendMessageMattermost(
            "channel:aaaaaaaaaaaaaaaaaaaaaaaaaa",
            "caption",
            opts,
          );
          expect(result.messageId).toBe("post-cap");
          expect(writes).toEqual(["/api/v4/files", "/api/v4/posts"]);
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
