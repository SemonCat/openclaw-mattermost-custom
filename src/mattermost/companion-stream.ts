import { randomUUID } from "node:crypto";
import { createDraftStreamLoop } from "openclaw/plugin-sdk/channel-outbound";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { z } from "zod";
import { createMattermostPost, type MattermostClient } from "./client.js";

const PLUGIN_PATH = "/plugins/openclaw-stream/v1";
const REQUEST_TIMEOUT_MS = 1500;
const POST_TYPE = "custom_openclaw_stream";
const CapabilitiesSchema = z.object({
  protocol: z.literal(1),
  post_type: z.literal(POST_TYPE),
  event: z.literal("custom_openclaw-stream_update"),
  lease_ms: z.literal(15000),
  max_chars: z.literal(262144),
});
const AcceptedSchema = z.object({ accepted: z.literal(true) });

export function createMattermostCompanionStream(params: {
  client: MattermostClient;
  channelId: string;
  rootId?: string;
  postProps?: Record<string, unknown>;
  resolvePostProps?: () => Record<string, unknown> | undefined;
  warn?: (message: string) => void;
}) {
  type Entry = {
    generation: string;
    seq: number;
    frozen: boolean;
    closed: boolean;
    publishedText?: string;
    loop: ReturnType<typeof createDraftStreamLoop>;
  };
  const entries = new Map<string, Entry>();
  let disabled = false;
  let capability: Promise<boolean> | undefined;
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    const response = await params.client.fetchImpl(`${params.client.baseUrl}${PLUGIN_PATH}${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${params.client.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`companion HTTP ${response.status}`);
    }
    const bytes = await readResponseWithLimit(response, 16 * 1024, {
      onOverflow: () => new Error("Companion response exceeded its size limit"),
    });
    return JSON.parse(new TextDecoder().decode(bytes));
  };
  const available = () =>
    (capability ??= request("/capabilities")
      .then((value) => CapabilitiesSchema.safeParse(value).success)
      .catch(() => false)
      .then((supported) => {
        disabled = !supported;
        if (!supported) params.warn?.("mattermost companion unavailable; using REST previews");
        return supported;
      }));
  const identity = (postId: string, entry: Entry) => ({
    post_id: postId,
    channel_id: params.channelId,
    root_id: params.rootId ?? "",
    generation: entry.generation,
    seq: ++entry.seq,
  });
  const closeEntry = async (postId: string, entry: Entry) => {
    if (entry.closed) return;
    entry.closed = true;
    try {
      AcceptedSchema.parse(await request("/close", identity(postId, entry)));
    } catch {
      // The renderer also yields to newer persisted edits and expires its lease.
      params.warn?.("mattermost companion close unavailable; retaining REST delivery");
    }
  };

  return {
    async createPost(message: string) {
      const supported = !disabled && (await available()) && !disabled;
      const generation = supported ? randomUUID() : undefined;
      const post = await createMattermostPost(params.client, {
        channelId: params.channelId,
        rootId: params.rootId,
        message,
        ...(generation ? { type: POST_TYPE } : {}),
        props: generation || params.resolvePostProps
          ? {
              ...params.postProps,
              ...params.resolvePostProps?.(),
              ...(generation ? { openclaw_stream: { version: 1, generation } } : {}),
            }
          : params.postProps,
      });
      if (generation) {
        const entry: Entry = {
          generation,
          seq: 0,
          frozen: false,
          closed: false,
          loop: createDraftStreamLoop({
            throttleMs: 250,
            coalesceInFlight: true,
            isStopped: () => entry.frozen || disabled,
            sendOrEditStreamMessage: async (text: string) => {
              if (text === entry.publishedText) return true;
              try {
                AcceptedSchema.parse(
                  await request("/snapshots", { ...identity(post.id, entry), message: text }),
                );
                entry.publishedText = text;
                return true;
              } catch {
                disabled = true;
                entry.frozen = true;
                entry.loop.stop();
                params.warn?.("mattermost companion snapshot unavailable; using REST previews");
                await closeEntry(post.id, entry);
                return false;
              }
            },
          }),
        };
        entries.set(post.id, entry);
      }
      return post;
    },
    update(postId: string, text: string) {
      const entry = entries.get(postId);
      if (entry && !entry.frozen && !disabled) entry.loop.update(text);
    },
    async freeze(postId: string): Promise<boolean> {
      const entry = entries.get(postId);
      if (!entry || entry.closed) return false;
      entry.frozen = true;
      entry.loop.stop();
      await entry.loop.waitForInFlight();
      return true;
    },
    async close(postId: string) {
      const entry = entries.get(postId);
      if (!entry) return;
      entry.frozen = true;
      entry.loop.stop();
      await entry.loop.waitForInFlight();
      await closeEntry(postId, entry);
    },
  };
}
