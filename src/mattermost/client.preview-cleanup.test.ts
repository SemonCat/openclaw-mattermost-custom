import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMattermostClient,
  deleteMattermostPost,
  deleteMattermostPreview,
} from "./client.js";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", ...headers },
  });
const setup = (fetchImpl: typeof fetch) =>
  createMattermostClient({ baseUrl: "https://mm.example", botToken: "secret", fetchImpl });
const methods = (mock: ReturnType<typeof vi.fn<typeof fetch>>) =>
  mock.mock.calls.map(([, init]) => init?.method ?? "GET");

afterEach(() => vi.useRealTimers());

describe("owned preview cleanup", () => {
  it.each([503, "lost-response"])("confirms a committed DELETE after %s", async (failure) => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        if (failure === "lost-response") throw Object.assign(new Error("socket lost"), { code: "ECONNRESET" });
        return json({}, failure as number);
      })
      .mockResolvedValueOnce(json({}, 404));
    await expect(deleteMattermostPreview(setup(fetchImpl), "p1")).resolves.toBeUndefined();
    expect(methods(fetchImpl)).toEqual(["DELETE", "GET"]);
  });

  it.each([429, 503])("reads before retrying %s on the same identity", async (status) => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, status, { "Retry-After": "2" }))
      .mockResolvedValueOnce(json({ id: "p1" }))
      .mockResolvedValueOnce(json({ status: "OK" }));
    const result = deleteMattermostPreview(setup(fetchImpl), "p1");
    await vi.advanceTimersByTimeAsync(status === 429 ? 1999 : 249);
    expect(methods(fetchImpl)).toEqual(["DELETE", "GET"]);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(methods(fetchImpl)).toEqual(["DELETE", "GET", "DELETE"]);
    expect(fetchImpl.mock.calls.every(([url]) => String(url).endsWith("/posts/p1"))).toBe(true);
  });

  it("reads back the second ambiguous attempt without a third DELETE", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({ id: "p1" }))
      .mockRejectedValueOnce(Object.assign(new Error("socket lost"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce(json({}, 404));
    const result = expect(deleteMattermostPreview(setup(fetchImpl), "p1")).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(250);
    await result;
    expect(methods(fetchImpl)).toEqual(["DELETE", "GET", "DELETE", "GET"]);
  });

  it("reports failure when both DELETE attempts leave the post visible", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_, init) =>
      init?.method === "DELETE" ? json({}, 503) : json({ id: "p1" }));
    const checked = expect(deleteMattermostPreview(setup(fetchImpl), "p1"))
      .rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(250);
    await checked;
    expect(methods(fetchImpl)).toEqual(["DELETE", "GET", "DELETE", "GET"]);
  });

  it.each([401, 403, 404])("does not forgive an initial DELETE %s", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({}, status));
    await expect(deleteMattermostPreview(setup(fetchImpl), "p1"))
      .rejects.toMatchObject({ status });
    expect(methods(fetchImpl)).toEqual(["DELETE"]);
  });

  it.each([403, 500])("preserves uncertainty when readback fails with %s", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({}, status));
    await expect(deleteMattermostPreview(setup(fetchImpl), "p1"))
      .rejects.toMatchObject({ status: 503 });
    expect(methods(fetchImpl)).toEqual(["DELETE", "GET"]);
  });

  it("cancels before readback and during the retry delay", async () => {
    for (const abortDuringRead of [false, true]) {
      vi.useFakeTimers();
      const controller = new AbortController();
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_, init) => {
        if (!abortDuringRead) controller.abort(new Error("stop cleanup"));
        return init?.method === "DELETE" ? json({}, 503) : json({ id: "p1" });
      });
      const checked = expect(deleteMattermostPreview(setup(fetchImpl), "p1", controller.signal))
        .rejects.toThrow("stop cleanup");
      await vi.advanceTimersByTimeAsync(1);
      controller.abort(new Error("stop cleanup"));
      await checked;
      expect(methods(fetchImpl)).toEqual(abortDuringRead ? ["DELETE", "GET"] : ["DELETE"]);
      vi.useRealTimers();
    }
  });

  it("does not wait beyond the total cleanup budget", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 429, { "Retry-After": "10" }))
      .mockResolvedValueOnce(json({ id: "p1" }));
    await expect(deleteMattermostPreview(setup(fetchImpl), "p1"))
      .rejects.toMatchObject({ status: 429 });
    expect(methods(fetchImpl)).toEqual(["DELETE", "GET"]);
  });

  it("keeps ordinary message deletion single-attempt", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({}, 503));
    await expect(deleteMattermostPost(setup(fetchImpl), "p1"))
      .rejects.toMatchObject({ status: 503 });
    expect(methods(fetchImpl)).toEqual(["DELETE"]);
  });
});
