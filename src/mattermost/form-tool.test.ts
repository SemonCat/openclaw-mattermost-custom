import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { createMattermostFormTool, registerMattermostFormTool } from "./form-tool.js";
import { observeMattermostServerVersion } from "./text-limits.js";
import type { MattermostClient } from "./client.js";
import { createMattermostTestConfig } from "./reactions.test-helpers.js";

const form = {
  title: "Access",
  fields: [{
    id: "access", label: "Access", type: "matrix", multiple: false,
    rows: [{ value: "api", label: "API" }, { value: "web", label: "Web" }],
    columns: [{ value: "read", label: "Read" }, { value: "write", label: "Write" }],
  }],
};

function fixture() {
  const cfg = createMattermostTestConfig("forms");
  const context: OpenClawPluginToolContext = {
    runtimeConfig: cfg, messageChannel: "mattermost", nativeChannelId: "room",
    sessionKey: "agent:main:mattermost:channel:room:thread:root", requesterSenderId: "user",
    deliveryContext: { channel: "mattermost", to: "channel:room", threadId: "root" },
    assertInvocationCurrent: vi.fn(),
  };
  const rpc = vi.fn(async (method, args) => {
    if (method === "question.request") return { id: args.id, expiresAtMs: Date.now() + 60_000 };
    if (method === "question.waitAnswer") return { status: "answered", answers: { answers: { access: ["api:read", "web:write"] } } };
    if (method === "question.resolve") return { status: "cancelled" };
    throw new Error("unexpected RPC");
  });
  const send = vi.fn(async () => ({ messageId: "post", channelId: "room" }) as any);
  const createClient = vi.fn(() => ({
    baseUrl: cfg.channels!.mattermost!.baseUrl!,
    request: vi.fn(async () => {
      observeMattermostServerVersion(cfg.channels!.mattermost!.baseUrl!, "12.0.0");
      return { id: "bot" };
    }),
  }) as unknown as MattermostClient);
  const api = { config: cfg } as OpenClawPluginApi;
  return { context, rpc, send, createClient, api,
    tool: () => createMattermostFormTool(api, context, { rpc, send, createClient })! };
}

describe("mattermost_form tool", () => {
  it("registers a schema with native matrix and checkbox fields", () => {
    const registerTool = vi.fn();
    registerMattermostFormTool({ registerTool } as unknown as OpenClawPluginApi);
    expect(registerTool).toHaveBeenCalledWith(expect.any(Function), { name: "mattermost_form", optional: false });
    const f = fixture();
    expect(JSON.stringify(f.tool().parameters)).toContain("matrix");
    expect(JSON.stringify(f.tool().parameters)).toContain("multiple");
    f.context.messageChannel = "slack";
    expect(f.tool()).toBeNull();
    f.context.messageChannel = "mattermost"; delete f.context.sessionKey;
    expect(f.tool()).toBeNull();
  });

  it("waits for the same canonical question and returns structured rows in the original tool call", async () => {
    const f = fixture();
    const result = await f.tool().execute("call", form);
    expect(result.details).toMatchObject({
      status: "answered", answers: { access: { api: ["read"], web: ["write"] } },
    });
    const request = f.rpc.mock.calls[0][1];
    expect(request).toMatchObject({
      sessionKey: f.context.sessionKey, questions: [{ questionId: "access", presentation: "form", multiSelect: true }],
    });
    expect(f.send).toHaveBeenCalledWith("channel:room", "Access", expect.objectContaining({
      replyToId: "root", questionId: request.id,
      buttons: [[expect.objectContaining({ id: "ocquestionform" }), expect.objectContaining({ id: "ocquestionformweb" })]],
    }));
    expect(f.rpc.mock.calls[1]).toEqual(["question.waitAnswer", expect.objectContaining({ id: request.id }), expect.anything()]);
  });

  it("rejects model-supplied destination fields before creating or sending anything", async () => {
    const f = fixture();
    await expect(f.tool().execute("call", { ...form, channelId: "foreign" })).rejects.toThrow();
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("cancels a pending question on a failed send without retrying the post", async () => {
    const f = fixture();
    f.send.mockRejectedValue(new Error("ambiguous post"));
    const normal = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async (method, args) => method === "question.waitAnswer"
      ? { status: "pending" } : normal(method, args));
    await expect(f.tool().execute("call", form)).rejects.toThrow("ambiguous post");
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.rpc).toHaveBeenCalledWith("question.resolve", expect.objectContaining({ cancel: true }));
  });

  it("preserves an answer that wins the cancellation race", async () => {
    const f = fixture();
    f.send.mockRejectedValue(new Error("transport closed"));
    expect((await f.tool().execute("call", form)).details).toMatchObject({ status: "answered" });
    expect(f.rpc.mock.calls.some(([method]) => method === "question.resolve")).toBe(false);
  });

  it("checks cancellation and the live invocation before sending", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(f.tool().execute("call", form, controller.signal)).rejects.toThrow("cancelled");
    expect(f.rpc).not.toHaveBeenCalled();
    f.context.assertInvocationCurrent = () => { throw new Error("stale turn"); };
    await expect(f.tool().execute("call", form)).rejects.toThrow("stale turn");
    expect(f.send).not.toHaveBeenCalled();
  });

  it("returns an answer that arrives between the cancellation read and mutation", async () => {
    const f = fixture();
    f.send.mockRejectedValue(new Error("transport closed"));
    const normal = f.rpc.getMockImplementation()!;
    let reads = 0;
    f.rpc.mockImplementation(async (method, args) => {
      if (method === "question.waitAnswer" && reads++ === 0) return { status: "pending" };
      if (method === "question.resolve") throw new Error("already answered");
      return normal(method, args);
    });
    expect((await f.tool().execute("call", form)).details).toMatchObject({
      status: "answered", answers: { access: { api: ["read"], web: ["write"] } },
    });
    expect(f.rpc.mock.calls.filter(([method]) => method === "question.resolve")).toHaveLength(1);
  });

  it("retires unanswered questions when the tool deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const normal = f.rpc.getMockImplementation()!;
      f.rpc.mockImplementation(async (method, args) => {
        if (method === "question.waitAnswer") {
          vi.setSystemTime(Date.now() + 16_000);
          return { status: "pending" };
        }
        return normal(method, args);
      });
      expect((await f.tool().execute("call", { ...form, timeoutSeconds: 15 })).details)
        .toMatchObject({ status: "cancelled" });
      expect(f.rpc).toHaveBeenCalledWith("question.resolve", expect.objectContaining({ cancel: true }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels its canonical question when a running tool is aborted", async () => {
    const f = fixture();
    const controller = new AbortController();
    const normal = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async (method, args) => {
      if (method === "question.waitAnswer") {
        controller.abort(new Error("run cancelled"));
        return { status: "pending" };
      }
      return normal(method, args);
    });
    await expect(f.tool().execute("call", form, controller.signal)).rejects.toThrow("run cancelled");
    expect(f.rpc).toHaveBeenCalledWith("question.resolve", expect.objectContaining({ cancel: true }));
  });
});
