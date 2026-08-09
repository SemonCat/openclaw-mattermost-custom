// Mattermost tests cover the ack + lifecycle status-reaction turn runtime.
import { DEFAULT_TIMING } from "openclaw/plugin-sdk/channel-feedback";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import {
  createMattermostMessageReactionRuntime,
  createMattermostReactionLifecycleStore,
  type MattermostReactionLifecycleStore,
} from "./monitor-turn-reactions.js";
import type { OpenClawConfig } from "./runtime-api.js";

function createGroupMentionedGate() {
  return {
    isDirect: false,
    isGroup: true,
    canDetectMention: true,
    effectiveWasMentioned: true,
    shouldBypassMention: false,
  };
}

function createBaseParams(overrides: {
  cfg?: OpenClawConfig;
  request?: MattermostClient["request"];
  gate?: ReturnType<typeof createGroupMentionedGate>;
  postId?: string;
  sessionKey?: string;
  lifecycleStore?: MattermostReactionLifecycleStore;
}) {
  const request =
    overrides.request ?? (vi.fn(async () => ({})) as unknown as MattermostClient["request"]);
  const client: MattermostClient = {
    baseUrl: "https://mattermost.example.com",
    apiBaseUrl: "https://mattermost.example.com/api/v4",
    token: "bot-token",
    request,
    fetchImpl: fetch,
  };
  const log = vi.fn();
  return {
    cfg: overrides.cfg ?? {},
    client,
    botUserId: "bot-1",
    agentId: "main",
    accountId: "default",
    postId: overrides.postId ?? "post-1",
    sessionKey: overrides.sessionKey ?? "session-1",
    lifecycleStore: overrides.lifecycleStore ?? createMattermostReactionLifecycleStore(),
    gate: overrides.gate ?? createGroupMentionedGate(),
    log,
    request,
  };
}

describe("createMattermostMessageReactionRuntime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("ack scope gate", () => {
    it("skips entirely for a direct message under the default group-mentions scope", async () => {
      const params = createBaseParams({
        gate: { ...createGroupMentionedGate(), isDirect: true, isGroup: false },
      });
      const runtime = createMattermostMessageReactionRuntime(params);

      runtime.queueInitialAckReactionAfterRecord();
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      expect(params.request).not.toHaveBeenCalled();
      expect(runtime.statusReactionsEnabled).toBe(false);
    });

    it("skips a group message that never mentioned the agent under the default scope", async () => {
      const params = createBaseParams({
        gate: {
          ...createGroupMentionedGate(),
          effectiveWasMentioned: false,
          shouldBypassMention: false,
        },
      });
      const runtime = createMattermostMessageReactionRuntime(params);

      runtime.queueInitialAckReactionAfterRecord();
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      expect(params.request).not.toHaveBeenCalled();
    });

    it("acks a direct message when scope is explicitly 'all'", async () => {
      const params = createBaseParams({
        cfg: { messages: { ackReactionScope: "all" } },
        gate: { ...createGroupMentionedGate(), isDirect: true, isGroup: false },
      });
      const runtime = createMattermostMessageReactionRuntime(params);

      runtime.queueInitialAckReactionAfterRecord();
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      expect(params.request).toHaveBeenCalledExactlyOnceWith("/reactions", {
        method: "POST",
        body: JSON.stringify({ user_id: "bot-1", post_id: "post-1", emoji_name: "eyes" }),
      });
    });

    it("never reacts once ackReactionScope is off, even for a mentioned group message", async () => {
      const params = createBaseParams({ cfg: { messages: { ackReactionScope: "off" } } });
      const runtime = createMattermostMessageReactionRuntime(params);

      runtime.queueInitialAckReactionAfterRecord();
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      expect(params.request).not.toHaveBeenCalled();
      expect(runtime.statusReactionsEnabled).toBe(false);
    });
  });

  describe("statusReactions.enabled default", () => {
    it("stays plain-ack only when messages.statusReactions.enabled is unset (Mattermost follows the explicit-enable default)", async () => {
      const params = createBaseParams({});
      const runtime = createMattermostMessageReactionRuntime(params);

      expect(runtime.statusReactionsEnabled).toBe(false);

      runtime.queueInitialAckReactionAfterRecord();
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      // Exactly one static ack reaction, never replaced/removed by lifecycle transitions.
      expect(params.request).toHaveBeenCalledExactlyOnceWith("/reactions", {
        method: "POST",
        body: JSON.stringify({ user_id: "bot-1", post_id: "post-1", emoji_name: "eyes" }),
      });

      await runtime.controller.setTool("bash");
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
      await runtime.finish({ dispatchError: false, anyReplyDelivered: true });
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      expect(params.request).toHaveBeenCalledTimes(1);
    });

    it("does not queue an initial ack reaction twice for the same accepted post", async () => {
      const params = createBaseParams({});
      const runtime = createMattermostMessageReactionRuntime(params);

      runtime.queueInitialAckReactionAfterRecord();
      runtime.queueInitialAckReactionAfterRecord();
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      expect(params.request).toHaveBeenCalledTimes(1);
    });
  });

  describe("lifecycle transitions", () => {
    type ReactionRequestInit = { method?: string; body?: string };

    function requestedEmojis(request: ReturnType<typeof vi.fn>) {
      return request.mock.calls.map((call) => {
        const [path, init] = call as [string, ReactionRequestInit | undefined];
        if (init?.method === "DELETE") {
          return `-${decodeURIComponent(path.split("/").at(-1) ?? "")}`;
        }
        const body = JSON.parse(init?.body ?? "{}");
        return `+${body.emoji_name}`;
      });
    }

    it("does not react when durable session recording failed before activation", async () => {
      const params = createBaseParams({
        cfg: { messages: { statusReactions: { enabled: true } } },
      });
      const runtime = createMattermostMessageReactionRuntime(params);

      await runtime.finish({ dispatchError: true, anyReplyDelivered: false });
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      expect(params.request).not.toHaveBeenCalled();
    });

    it("moves queued -> thinking -> tool -> done, replacing the prior emoji at each step", async () => {
      const params = createBaseParams({
        cfg: { messages: { statusReactions: { enabled: true } } },
      });
      const runtime = createMattermostMessageReactionRuntime(params);
      expect(runtime.statusReactionsEnabled).toBe(true);

      runtime.queueInitialAckReactionAfterRecord();
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      runtime.setThinking();
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      runtime.setTool("bash");
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      await runtime.finish({ dispatchError: false, anyReplyDelivered: true });
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      // Intermediate transitions only add; the terminal state removes every
      // previously-tracked emoji in one pass, keeping just the terminal one, which then
      // stays on the post as the turn's recorded outcome.
      expect(requestedEmojis(params.request as ReturnType<typeof vi.fn>)).toEqual([
        "+eyes", // queued
        "+brain", // thinking
        "+computer", // bash tool
        "+white_check_mark", // done
        "-eyes",
        "-brain",
        "-computer",
      ]);
    });

    it("settles on the error emoji when the dispatch fails", async () => {
      const params = createBaseParams({
        cfg: { messages: { statusReactions: { enabled: true } } },
      });
      const runtime = createMattermostMessageReactionRuntime(params);

      runtime.queueInitialAckReactionAfterRecord();
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      await runtime.finish({ dispatchError: true, anyReplyDelivered: false });
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      // The error emoji stays on the post as the turn's recorded failure outcome.
      expect(requestedEmojis(params.request as ReturnType<typeof vi.fn>)).toEqual([
        "+eyes",
        "+x",
        "-eyes",
      ]);
    });

    it("clears the queued emoji on a silent success with no visible reply", async () => {
      const params = createBaseParams({
        cfg: { messages: { statusReactions: { enabled: true } } },
      });
      const runtime = createMattermostMessageReactionRuntime(params);

      runtime.queueInitialAckReactionAfterRecord();
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      await runtime.finish({ dispatchError: false, anyReplyDelivered: false });
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      // No setDone()/setError() transition; clear() still removes the queued emoji so a
      // silently-completed turn does not strand an ack reaction on the post forever.
      expect(requestedEmojis(params.request as ReturnType<typeof vi.fn>)).toEqual([
        "+eyes",
        "-eyes",
      ]);
    });

    it("logs cleanup failures without rejecting finish()", async () => {
      const request = vi.fn(async (path: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          throw new Error("HTTP 403 Forbidden");
        }
        return {};
      });
      const params = createBaseParams({
        cfg: { messages: { statusReactions: { enabled: true } } },
        request: request as unknown as MattermostClient["request"],
      });
      const runtime = createMattermostMessageReactionRuntime(params);

      runtime.queueInitialAckReactionAfterRecord();
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      await expect(
        runtime.finish({ dispatchError: false, anyReplyDelivered: true }),
      ).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      expect(params.log).toHaveBeenCalledWith(
        expect.stringContaining("mattermost ack cleanup failed"),
      );
    });

    it("shares owner lifecycle updates with a same-session steered post", async () => {
      const lifecycleStore = createMattermostReactionLifecycleStore();
      const cfg: OpenClawConfig = {
        messages: { statusReactions: { enabled: true }, queue: { mode: "steer" } },
      };
      const ownerParams = createBaseParams({
        cfg,
        postId: "post-owner",
        sessionKey: "session-shared",
        lifecycleStore,
      });
      const joinedParams = createBaseParams({
        cfg,
        postId: "post-steered",
        sessionKey: "session-shared",
        lifecycleStore,
      });
      const owner = createMattermostMessageReactionRuntime(ownerParams);
      const joined = createMattermostMessageReactionRuntime(joinedParams);

      // Real execution order: message 2 (joined) arrives and starts settling
      // while message 1 (owner) is still actively transitioning, then message 1
      // keeps running and finishes after the steered message has already
      // returned control (no error, no visible reply of its own) — this is
      // NOT two sequential/restarted turns, it is a genuine overlap.
      owner.queueInitialAckReactionAfterRecord();
      joined.queueInitialAckReactionAfterRecord();
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
      owner.setThinking();
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      await joined.finish({ dispatchError: false, anyReplyDelivered: false });
      owner.setTool("web_search");
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
      await owner.finish({ dispatchError: false, anyReplyDelivered: true });
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      for (const params of [ownerParams, joinedParams]) {
        expect(requestedEmojis(params.request as ReturnType<typeof vi.fn>)).toEqual([
          "+eyes",
          "+brain",
          "+globe_with_meridians",
          "+white_check_mark",
          "-eyes",
          "-brain",
          "-globe_with_meridians",
        ]);
      }
    });

    it("self-settles a joined post whose own dispatch actually delivered independently", async () => {
      // A joined registration predicts steer from resolved queue config, but the effective
      // per-session mode can differ (e.g. a persisted session override). If this post's own
      // dispatch produces real evidence (its own delivery or error) rather than the silent
      // no-op a genuine steer produces, it must settle itself instead of waiting forever for
      // an owner that already finished and forgot about it.
      const lifecycleStore = createMattermostReactionLifecycleStore();
      const cfg: OpenClawConfig = {
        messages: { statusReactions: { enabled: true }, queue: { mode: "steer" } },
      };
      const ownerParams = createBaseParams({
        cfg,
        postId: "post-owner",
        sessionKey: "session-shared",
        lifecycleStore,
      });
      const joinedParams = createBaseParams({
        cfg,
        postId: "post-independent",
        sessionKey: "session-shared",
        lifecycleStore,
      });
      const owner = createMattermostMessageReactionRuntime(ownerParams);
      const joined = createMattermostMessageReactionRuntime(joinedParams);

      owner.queueInitialAckReactionAfterRecord();
      joined.queueInitialAckReactionAfterRecord();
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      // The owner's turn is still running (never calls finish()) when the mispredicted
      // "joined" post turns out to have actually delivered its own visible reply.
      await joined.finish({ dispatchError: false, anyReplyDelivered: true });
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      expect(requestedEmojis(joinedParams.request as ReturnType<typeof vi.fn>)).toEqual([
        "+eyes",
        "+white_check_mark",
        "-eyes",
      ]);

      // The owner is unaffected and still active; its own later transitions still work.
      owner.setThinking();
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
      expect(requestedEmojis(ownerParams.request as ReturnType<typeof vi.fn>).at(-1)).toBe(
        "+brain",
      );
    });
  });
});
