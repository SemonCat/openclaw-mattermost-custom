// Mattermost tests cover the append-once, consume-after-ack metrics receipt.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as clientModule from "./client.js";
import type { MattermostClient } from "./client.js";
import { deliverMattermostReplyWithDraftPreview } from "./monitor-draft-delivery.js";
import { createMattermostProgressReceipt } from "./progress-receipt.js";

const updateMattermostPostSpy = vi.spyOn(clientModule, "updateMattermostPost");

function createMattermostClientMock(): MattermostClient {
  return {
    baseUrl: "https://chat.example.com",
    apiBaseUrl: "https://chat.example.com/api/v4",
    token: "token",
    request: vi.fn(async () => ({})) as MattermostClient["request"],
    fetchImpl: vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as MattermostClient["fetchImpl"],
  };
}

function createDraftStreamMock(postId: string | null | undefined = "preview-post-1") {
  return {
    flush: vi.fn(async () => {}),
    postId: vi.fn(() => postId ?? undefined),
    clear: vi.fn(async () => {}),
    discardPending: vi.fn(async () => {}),
    seal: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateMattermostPostSpy.mockResolvedValue({ id: "patched" } as never);
});

describe("createMattermostProgressReceipt", () => {
  it("appends nothing until a final payload is prepared", () => {
    const receipt = createMattermostProgressReceipt();
    expect(receipt.hasPendingReceipt()).toBe(false);
  });

  it("appends two compact receipt lines to a successful final", () => {
    let clock = 1_000;
    const receipt = createMattermostProgressReceipt({ now: () => clock });
    clock += 3_000;

    const prepared = receipt.prepareFinalPayload({ text: "All done" });

    expect(prepared.text).toBe(
      "All done\n⬆️ ? in · ⬇️ ? out · 🛠️ 0 tool calls\n⏱️ 3s · 🧠 3.0s · 🔧 0.0s",
    );
    expect(receipt.hasPendingReceipt()).toBe(true);
  });

  it("shows zero tool calls and pluralizes non-zero counts", () => {
    const zeroTools = createMattermostProgressReceipt({ now: () => 0 });
    expect(zeroTools.prepareFinalPayload({ text: "ok" }).text).toBe(
      "ok\n⬆️ ? in · ⬇️ ? out · 🛠️ 0 tool calls\n⏱️ 1s · 🧠 0.0s · 🔧 0.0s",
    );

    const oneTool = createMattermostProgressReceipt({ now: () => 0 });
    oneTool.noteToolCall("bash");
    expect(oneTool.prepareFinalPayload({ text: "ok" }).text).toBe(
      "ok\n⬆️ ? in · ⬇️ ? out · 🛠️ 1 tool call\n⏱️ 1s · 🧠 0.0s · 🔧 0.0s",
    );

    const twoTools = createMattermostProgressReceipt({ now: () => 0 });
    twoTools.noteToolCall("bash");
    twoTools.noteToolCall("read_file");
    expect(twoTools.prepareFinalPayload({ text: "ok" }).text).toBe(
      "ok\n⬆️ ? in · ⬇️ ? out · 🛠️ 2 tool calls\n⏱️ 1s · 🧠 0.0s · 🔧 0.0s",
    );
  });

  it("shows approximate TPS from matching cumulative usage", () => {
    let clock = 0;
    const receipt = createMattermostProgressReceipt({ now: () => clock });
    receipt.noteRunStart("run-1");
    receipt.noteUsage("run-1", { inputTokens: 15_500, outputTokens: 100 });
    clock = 5_000;

    expect(receipt.prepareFinalPayload({ text: "ok" }).text).toBe(
      "ok\n⬆️ 15.5k in · ⬇️ 100 out · 🛠️ 0 tool calls\n⏱️ 5s · 🧠 5.0s · 🔧 0.0s · ⚡ ≈20.0 tok/s",
    );
  });

  it("prefers cumulative agent usage over the transcript fallback", () => {
    let clock = 0;
    const receipt = createMattermostProgressReceipt({ now: () => clock });
    receipt.noteRunStart("run-1");
    receipt.noteTranscriptUsage({ inputTokens: 15_500, outputTokens: 50 });
    receipt.noteUsage("run-1", { outputTokens: 100 });
    clock = 5_000;

    expect(receipt.prepareFinalPayload({ text: "ok" }).text).toBe(
      "ok\n⬆️ 15.5k in · ⬇️ 100 out · 🛠️ 0 tool calls\n⏱️ 5s · 🧠 5.0s · 🔧 0.0s · ⚡ ≈20.0 tok/s",
    );
  });

  it("ignores usage from another run and invalid token counts", () => {
    let clock = 0;
    const receipt = createMattermostProgressReceipt({ now: () => clock });
    receipt.noteRunStart("run-1");
    receipt.noteUsage("run-2", { outputTokens: 100 });
    receipt.noteUsage("run-1", { inputTokens: Number.NaN, outputTokens: Number.NaN });
    receipt.noteUsage("run-1", { inputTokens: -1, outputTokens: -1 });
    clock = 5_000;

    expect(receipt.prepareFinalPayload({ text: "ok" }).text).toBe(
      "ok\n⬆️ ? in · ⬇️ ? out · 🛠️ 0 tool calls\n⏱️ 5s · 🧠 5.0s · 🔧 0.0s",
    );
  });

  it("deducts the union of overlapping tool intervals", () => {
    let clock = 0;
    const receipt = createMattermostProgressReceipt({ now: () => clock });
    receipt.noteRunStart("run-1");
    receipt.noteUsage("run-1", { outputTokens: 100 });

    clock = 1_000;
    receipt.noteToolCall("bash", "tool-a");
    clock = 2_000;
    receipt.noteToolCall("read", "tool-b");
    clock = 4_000;
    receipt.noteToolCallEnd("tool-a");
    clock = 5_000;
    receipt.noteToolCallEnd("tool-b");
    clock = 7_000;

    // Turn = 7s. Overlapping tools occupy the 1s..5s union (4s), leaving 3s.
    expect(receipt.prepareFinalPayload({ text: "ok" }).text).toBe(
      "ok\n⬆️ ? in · ⬇️ 100 out · 🛠️ 2 tool calls\n⏱️ 7s · 🧠 3.0s · 🔧 4.0s · ⚡ ≈33.3 tok/s",
    );
  });

  it("deducts an in-flight tool interval through finalization", () => {
    let clock = 0;
    const receipt = createMattermostProgressReceipt({ now: () => clock });
    receipt.noteRunStart("run-1");
    receipt.noteUsage("run-1", { outputTokens: 100 });
    clock = 1_000;
    receipt.noteToolCall("bash", "tool-a");
    clock = 6_000;

    expect(receipt.prepareFinalPayload({ text: "ok" }).text).toBe(
      "ok\n⬆️ ? in · ⬇️ 100 out · 🛠️ 1 tool call\n⏱️ 6s · 🧠 1.0s · 🔧 5.0s · ⚡ ≈100.0 tok/s",
    );
  });

  it("hides approximate TPS when tools consume the whole measured turn", () => {
    let clock = 0;
    const receipt = createMattermostProgressReceipt({ now: () => clock });
    receipt.noteRunStart("run-1");
    receipt.noteUsage("run-1", { outputTokens: 100 });
    receipt.noteToolCall("bash", "tool-a");
    clock = 5_000;

    expect(receipt.prepareFinalPayload({ text: "ok" }).text).toBe(
      "ok\n⬆️ ? in · ⬇️ 100 out · 🛠️ 1 tool call\n⏱️ 5s · 🧠 0.0s · 🔧 5.0s",
    );
  });

  it("caches the same approximate TPS line across a failed delivery retry", () => {
    let clock = 0;
    const receipt = createMattermostProgressReceipt({ now: () => clock });
    receipt.noteRunStart("run-1");
    receipt.noteUsage("run-1", { outputTokens: 100 });
    clock = 5_000;
    const firstAttempt = receipt.prepareFinalPayload({ text: "answer" });

    receipt.settleFinalDelivery(false);
    receipt.noteUsage("run-1", { outputTokens: 200 });
    clock = 10_000;

    expect(receipt.prepareFinalPayload({ text: "answer" }).text).toBe(firstAttempt.text);
    expect(firstAttempt.text).toContain("⚡ ≈20.0 tok/s");
  });

  it("clears run usage and tool timing when a queued followup resets the receipt", () => {
    let clock = 0;
    const receipt = createMattermostProgressReceipt({ now: () => clock });
    receipt.noteRunStart("run-1");
    receipt.noteUsage("run-1", { outputTokens: 100 });
    clock = 1_000;
    receipt.noteToolCall("bash", "tool-a");
    clock = 5_000;
    receipt.reset();
    clock = 10_000;

    expect(receipt.prepareFinalPayload({ text: "next" }).text).toBe(
      "next\n⬆️ ? in · ⬇️ ? out · 🛠️ 0 tool calls\n⏱️ 5s · 🧠 5.0s · 🔧 0.0s",
    );
  });

  it("does not append a receipt to an error payload, and leaves the tracker untouched", () => {
    const receipt = createMattermostProgressReceipt();
    receipt.noteToolCall("bash");

    const prepared = receipt.prepareFinalPayload({ text: "boom", isError: true });

    expect(prepared.text).toBe("boom");
    expect(receipt.hasPendingReceipt()).toBe(false);
  });

  it("keeps a pending receipt across a failed delivery so a retry still carries it", () => {
    const receipt = createMattermostProgressReceipt({ now: () => 0 });
    receipt.noteToolCall("bash");

    const firstAttempt = receipt.prepareFinalPayload({ text: "answer" });
    receipt.settleFinalDelivery(false);
    expect(receipt.hasPendingReceipt()).toBe(true);

    const retryAttempt = receipt.prepareFinalPayload({ text: "answer" });

    expect(retryAttempt.text).toBe(firstAttempt.text);
  });

  it("does not recompute a cached line across repeated final candidates before settlement", () => {
    const receipt = createMattermostProgressReceipt({ now: () => 0 });
    receipt.noteToolCall("bash");

    const candidateA = receipt.prepareFinalPayload({ text: "answer A" });
    receipt.noteToolCall("read_file");
    const candidateB = receipt.prepareFinalPayload({ text: "answer B" });

    // Both candidates carry the same cached receipt line, computed once — the
    // second noteToolCall (not yet consumed) must not leak into a new line.
    const lineA = candidateA.text?.split("\n").at(-1);
    const lineB = candidateB.text?.split("\n").at(-1);
    expect(lineB).toBe(lineA);
  });

  it("consumes the receipt once and suppresses later finals until a new turn is admitted", () => {
    let clock = 0;
    const receipt = createMattermostProgressReceipt({ now: () => clock });
    receipt.noteToolCall("bash");
    receipt.prepareFinalPayload({ text: "answer" });

    receipt.settleFinalDelivery(true);

    expect(receipt.hasPendingReceipt()).toBe(false);

    clock = 5_000;
    const laterFinal = receipt.prepareFinalPayload({ text: "later final" });
    expect(laterFinal.text).toBe("later final");

    receipt.reset();
    clock = 7_000;
    const nextTurn = receipt.prepareFinalPayload({ text: "next answer" });
    // Fresh tally: no leftover tool count, elapsed time restarted at admission.
    expect(nextTurn.text).toBe(
      "next answer\n⬆️ ? in · ⬇️ ? out · 🛠️ 0 tool calls\n⏱️ 2s · 🧠 2.0s · 🔧 0.0s",
    );
  });

  it("resets an unconsumed pending receipt on a queued-followup turn boundary", () => {
    let clock = 0;
    const receipt = createMattermostProgressReceipt({ now: () => clock });
    receipt.noteToolCall("bash");
    receipt.prepareFinalPayload({ text: "turn one" });
    expect(receipt.hasPendingReceipt()).toBe(true);

    receipt.reset();
    expect(receipt.hasPendingReceipt()).toBe(false);

    clock = 2_000;
    const nextTurn = receipt.prepareFinalPayload({ text: "turn two" });
    expect(nextTurn.text).toBe(
      "turn two\n⬆️ ? in · ⬇️ ? out · 🛠️ 0 tool calls\n⏱️ 2s · 🧠 2.0s · 🔧 0.0s",
    );
  });

  it("falls back to the receipt line alone when the final payload has no text", () => {
    const receipt = createMattermostProgressReceipt({ now: () => 0 });
    const prepared = receipt.prepareFinalPayload({});
    expect(prepared.text).toBe(
      "⬆️ ? in · ⬇️ ? out · 🛠️ 0 tool calls\n⏱️ 1s · 🧠 0.0s · 🔧 0.0s",
    );
  });

  it("never mutates the original payload object", () => {
    const receipt = createMattermostProgressReceipt({ now: () => 0 });
    const original = { text: "answer" };
    receipt.prepareFinalPayload(original);
    expect(original.text).toBe("answer");
  });

  it("preserves leading whitespace in the final text", () => {
    const receipt = createMattermostProgressReceipt({ now: () => 0 });
    const prepared = receipt.prepareFinalPayload({ text: "  indented answer  \n" });
    expect(prepared.text).toBe(
      "  indented answer\n⬆️ ? in · ⬇️ ? out · 🛠️ 0 tool calls\n⏱️ 1s · 🧠 0.0s · 🔧 0.0s",
    );
  });

  it("composes with the edit-in-place delivery path: attach, confirm ACK, then consume", async () => {
    const receipt = createMattermostProgressReceipt({ now: () => 0 });
    receipt.noteToolCall("bash");
    const draftStream = createDraftStreamMock();
    const deliverFinal = vi.fn();

    const prepared = receipt.prepareFinalPayload({ text: "All good" });
    expect(prepared.text).toBe(
      "All good\n⬆️ ? in · ⬇️ ? out · 🛠️ 1 tool call\n⏱️ 1s · 🧠 0.0s · 🔧 0.0s",
    );

    const result = await deliverMattermostReplyWithDraftPreview({
      payload: prepared as never,
      info: { kind: "final" },
      kind: "channel",
      client: createMattermostClientMock(),
      draftStream,
      resolvePreviewFinalText: (text) =>
        text?.trim() ? { editText: text.trim(), alreadyDelivered: false } : undefined,
      previewState: { finalizedViaPreviewPost: false },
      logVerboseMessage: vi.fn(),
      deliverPayload: deliverFinal,
    });

    expect(updateMattermostPostSpy).toHaveBeenCalledWith(expect.anything(), "preview-post-1", {
      message:
        "All good\n⬆️ ? in · ⬇️ ? out · 🛠️ 1 tool call\n⏱️ 1s · 🧠 0.0s · 🔧 0.0s",
    });
    // The in-place edit finalized the preview post directly; no separate send needed.
    expect(deliverFinal).not.toHaveBeenCalled();
    expect(result.visibleReplySent).toBe(true);

    receipt.settleFinalDelivery(result.visibleReplySent === true);
    expect(receipt.hasPendingReceipt()).toBe(false);
  });

  it("keeps the receipt pending when the edit-in-place delivery reports no visible send", async () => {
    const receipt = createMattermostProgressReceipt({ now: () => 0 });
    const draftStream = createDraftStreamMock(null);
    const deliverFinal = vi.fn();

    const prepared = receipt.prepareFinalPayload({ text: "All good" });

    const result = await deliverMattermostReplyWithDraftPreview({
      payload: prepared as never,
      info: { kind: "final" },
      kind: "channel",
      client: createMattermostClientMock(),
      draftStream,
      // No draft post to edit and deliverPayload reports a suppressed/empty send.
      resolvePreviewFinalText: () => undefined,
      previewState: { finalizedViaPreviewPost: false },
      logVerboseMessage: vi.fn(),
      deliverPayload: vi.fn(async () => ({
        outcome: "empty" as const,
        visibleReplySent: false,
        suppression: { reason: "no_visible_result" as const },
      })),
    });

    expect(result.visibleReplySent).toBe(false);
    receipt.settleFinalDelivery(result.visibleReplySent === true);
    expect(receipt.hasPendingReceipt()).toBe(true);
  });
});
