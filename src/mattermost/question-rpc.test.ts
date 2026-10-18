import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  options: undefined as any,
  request: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  resolveGatewayAuth: () => ({ token: "resolved-token" }),
  GatewayClient: class {
    constructor(options: unknown) { state.options = options; }
    request = state.request;
    stop = state.stop;
    start = state.start;
  },
}));
import { createMattermostQuestionRpc } from "./question-rpc.js";

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

describe("Mattermost authenticated question RPC", () => {
  it("uses only local question scope and never replays a mutation on a repeated hello", async () => {
    state.start.mockImplementation(() => {
      state.options.onHelloOk(); state.options.onHelloOk();
    });
    state.request.mockResolvedValue({ status: "answered" });
    const rpc = createMattermostQuestionRpc(() => ({ gateway: { port: 18789 } }));
    await expect(rpc("question.resolve", { id: "question" })).resolves.toEqual({ status: "answered" });
    expect(state.options).toMatchObject({
      url: "ws://127.0.0.1:18789", scopes: ["operator.questions"], deviceIdentity: null,
      sharedStateMode: "read-only", token: "resolved-token", role: "operator", mode: "backend",
    });
    expect(state.request).toHaveBeenCalledTimes(1);
    expect(state.stop).toHaveBeenCalledTimes(1);
  });

  it("rejects aborts before connecting and stops a stalled connection on abort", async () => {
    const controller = new AbortController();
    const rpc = createMattermostQuestionRpc(() => ({}));
    controller.abort(new Error("cancelled"));
    await expect(rpc("question.get", {}, { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(state.start).not.toHaveBeenCalled();
    const live = new AbortController();
    state.start.mockImplementation(() => {});
    const promise = rpc("question.get", {}, { signal: live.signal });
    live.abort(new Error("cancelled"));
    await expect(promise).rejects.toThrow("cancelled");
    expect(state.stop).toHaveBeenCalledTimes(1);
  });

  it("bounds connection time and handles synchronous start errors", async () => {
    vi.useFakeTimers();
    const rpc = createMattermostQuestionRpc(() => ({}));
    state.start.mockImplementation(() => {});
    const promise = rpc("question.get", {}, { timeoutMs: 10 });
    const rejection = expect(promise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(11);
    await rejection;
    state.start.mockImplementation(() => { throw new Error("start failure"); });
    await expect(rpc("question.get", {})).rejects.toThrow("start failure");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry a rejected mutation and closes on connection errors", async () => {
    state.start.mockImplementation(() => state.options.onHelloOk());
    state.request.mockRejectedValue(new Error("ambiguous response"));
    const rpc = createMattermostQuestionRpc(() => ({}));
    await expect(rpc("question.resolve", {})).rejects.toThrow("ambiguous response");
    expect(state.request).toHaveBeenCalledTimes(1);
    state.start.mockImplementation(() => state.options.onConnectError(new Error("denied")));
    await expect(rpc("question.get", {})).rejects.toThrow("denied");
    expect(state.stop).toHaveBeenCalledTimes(2);
  });
});
