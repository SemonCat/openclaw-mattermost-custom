import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const effectGate = vi.hoisted(() => ({ prepare: undefined as (() => Promise<void>) | undefined }));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>();
  return {
    ...actual,
    captureEffectAuthority: () => {
      const authority = actual.captureEffectAuthority();
      const prepare = effectGate.prepare;
      return prepare ? {
        ...authority,
        initiate: async <T>(effect: () => T | Promise<T>) => {
          await prepare();
          return authority.initiate(effect);
        },
      } : authority;
    },
  };
});

import { createMattermostClient, createMattermostDirectChannelWithRetry, createMattermostPost, isRetryableError } from "./client.js";

afterEach(() => {
  effectGate.prepare = undefined;
  vi.useRealTimers();
});

describe("Mattermost 10.5 transport compatibility", () => {
  it("keeps outer provider status and permanent dispatch refusal authoritative", () => {
    expect(isRetryableError(new Error("Mattermost API 403 Forbidden", {
      cause: new Error("Mattermost API 503 Service Unavailable"),
    }))).toBe(false);
    expect(isRetryableError(new Error("request failed", {
      cause: new Error("Mattermost API 429: upstream returned Mattermost API 403 Forbidden"),
    }))).toBe(true);
    expect(isRetryableError(new PlatformMessageNotDispatchedError("sender retired", {
      cause: new Error("Mattermost API 503 Service Unavailable"), retryable: false,
    }))).toBe(false);
  });

  it.each([false, true])("rechecks sender ownership after effect preparation (retired=%s)", async (retired) => {
    const preparing = Promise.withResolvers<void>();
    const prepared = Promise.withResolvers<void>();
    const dispatched = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const caller = new AbortController();
    const failure = new Error("Mattermost sender retired");
    effectGate.prepare = async () => {
      preparing.resolve();
      await prepared.promise;
    };
    const fetchImpl = vi.fn<typeof fetch>(() => {
      dispatched.resolve();
      return response.promise;
    });
    const client = createMattermostClient({
      baseUrl: "https://mattermost.example.test", botToken: "test-token", fetchImpl,
      assertRequestCurrent: () => caller.signal.throwIfAborted(),
    });
    const sending = createMattermostPost(client, { channelId: "room", message: "hello" })
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await Promise.race([
        preparing.promise,
        dispatched.promise.then(() => { throw new Error("dispatched before effect preparation"); }),
      ]);
      expect(fetchImpl).not.toHaveBeenCalled();
      if (retired) caller.abort(failure);
      prepared.resolve();
      if (!retired) {
        await dispatched.promise;
        caller.abort(failure);
      }
      response.resolve(Response.json({ id: "post-1" }));
      const outcome = await sending;
      if (retired) {
        expect(outcome).toMatchObject({ error: { cause: failure } });
        expect("error" in outcome && outcome.error).toBeInstanceOf(PlatformMessageNotDispatchedError);
      } else {
        expect(outcome).toEqual({ value: { id: "post-1" } });
      }
      expect(fetchImpl).toHaveBeenCalledTimes(retired ? 0 : 1);
    } finally {
      prepared.resolve();
      response.resolve(Response.json({ id: "post-1" }));
      await sending;
    }
  });

  it.each([
    [400, "Invalid request: too many requests is diagnostic text"],
    [403, "Permission denied; upstream Mattermost API 503 Service Unavailable"],
    [400, "Invalid request; upstream Mattermost API 429 Too many requests"],
  ])("does not retry HTTP %s with misleading details", async (status, message) => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ message }, { status }));
    const client = createMattermostClient({ baseUrl: "https://mattermost.example.test", botToken: "test-token", fetchImpl });
    const outcome = expect(createMattermostDirectChannelWithRetry(client, ["u1", "u2"]))
      .rejects.toThrow(`Mattermost API ${status}`);
    void outcome.catch(() => {});
    await vi.runAllTimersAsync();
    await outcome;
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([400, 401, 403, 404, 429, 500, 503])("preserves HTTP %s when reading its error body fails", async (status) => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
      pull() { throw new TypeError("network error"); },
    }), { status, headers: { "content-type": "application/json" } }));
    const client = createMattermostClient({ baseUrl: "https://mattermost.example.test", botToken: "test-token", fetchImpl });
    const outcome = expect(createMattermostDirectChannelWithRetry(client, ["u1", "u2"]))
      .rejects.toThrow(`Mattermost API ${status}`);
    void outcome.catch(() => {});
    await vi.runAllTimersAsync();
    await outcome;
    expect(fetchImpl).toHaveBeenCalledTimes(status === 429 || status >= 500 ? 4 : 1);
  });
});
