import { afterEach, describe, expect, it, vi } from "vitest";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  createMattermostClient, createMattermostPost, MattermostApiError,
  resolveMattermostRateLimitDelay, updateMattermostPost,
} from "./client.js";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
function setup(fetchImpl: typeof fetch, timeoutMs?: number) {
  return createMattermostClient({ baseUrl: "https://mm.example", botToken: "secret", fetchImpl, timeoutMs });
}
afterEach(() => vi.useRealTimers());

describe("bounded safe REST throttling", () => {
  it("parses provider seconds/reset duration and strict HTTP dates", () => {
    expect(resolveMattermostRateLimitDelay(new Headers({ "Retry-After": "2" }))).toBe(2000);
    expect(resolveMattermostRateLimitDelay(new Headers({ "X-RateLimit-Reset": "3" }))).toBe(3000);
    expect(resolveMattermostRateLimitDelay(new Headers({ "Retry-After": "Thu, 08 Oct 2026 00:00:02 GMT" }), Date.parse("2026-10-08T00:00:00Z"))).toBe(2000);
    for (const raw of ["-1", "1.5", "NaN", "1e1", "31", "999999999999", "tomorrow", "Thu, 99 Oct 2026 00:00:02 GMT"]) {
      expect(resolveMattermostRateLimitDelay(new Headers({ "Retry-After": raw, "X-RateLimit-Reset": "0" }))).toBeUndefined();
    }
  });
  it("retries reads and updates on the same post, releasing throttled bodies", async () => {
    let released = false;
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel() { released = true; } }), { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(json({ id: "p1" }));
    await expect(updateMattermostPost(setup(fetchImpl), "p1", { message: "done" })).resolves.toEqual({ id: "p1" });
    expect(released).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(["https://mm.example/api/v4/posts/p1/patch", "https://mm.example/api/v4/posts/p1/patch"]);
    expect(fetchImpl.mock.calls[0][1]?.body).toBe(fetchImpl.mock.calls[1][1]?.body);
  });
  it("honors the provider delay and stops at three attempts", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => json({}, 429, { "Retry-After": "2" }));
    const result = setup(fetchImpl).request("/users/me");
    const checked = expect(result).rejects.toBeInstanceOf(MattermostApiError);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2001);
    await checked;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("refuses invalid, missing and delays outside the remaining total budget", async () => {
    for (const headers of [{}, { "Retry-After": "invalid" }, { "Retry-After": "31" }, { "Retry-After": "1" }]) {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => json({}, 429, headers));
      await expect(setup(fetchImpl, 1000).request("/users/me")).rejects.toMatchObject({ status: 429 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(600);
      return json({}, 429, { "Retry-After": "1" });
    });
    await expect(setup(fetchImpl, 1500).request("/users/me")).rejects.toMatchObject({ status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("aborts while waiting without taking ownership of the caller signal", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => json({}, 429, { "Retry-After": "2" }));
    const controller = new AbortController();
    const result = setup(fetchImpl).request("/users/me", { signal: controller.signal });
    const checked = expect(result).rejects.toThrow("stop");
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new Error("stop"));
    await checked;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("never retries authentication, server or network failures", async () => {
    for (const status of [401, 403, 500, 503]) {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => json({ message: "secret" }, status));
      await expect(setup(fetchImpl).request("/users/me")).rejects.toMatchObject({ status });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("network failed"));
    await expect(setup(fetchImpl).request("/users/me")).rejects.toThrow("network failed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("never replays creates on rejection, ambiguity or accepted missing identity", async () => {
    for (const response of [json({}, 429, { "Retry-After": "0" }), json({}, 500), json({})]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
      const error = await createMattermostPost(setup(fetchImpl), { channelId: "c1", message: "hello" }).catch(e => e);
      expect(error).toBeInstanceOf(Error);
      if (response.ok) expect(isChannelPartialDeliveryError(error)).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection reset"));
    await expect(createMattermostPost(setup(fetchImpl), { channelId: "c1", message: "hello" })).rejects.toThrow("connection reset");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
