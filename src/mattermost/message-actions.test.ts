import { describe, expect, it, vi } from "vitest";
import { createMattermostTestConfig, requestUrl } from "./reactions.test-helpers.js";
import {
  deleteMattermostMessageAction,
  editMattermostMessageAction,
  listMattermostMessageReactionsAction,
  listMattermostPinnedMessagesAction,
  setMattermostMessagePinnedAction,
} from "./message-actions.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    statusText: status >= 400 ? "Error" : "OK",
    headers: { "content-type": "application/json" },
  });
}

describe("Mattermost message actions", () => {
  it.each([false, true])("renders local links during edit and preserves code and HTTPS (presentation %s)", async (presentation) => {
    const cfg = createMattermostTestConfig("edit-local-links");
    cfg.channels!.mattermost!.interactions = { blocks: false };
    const literal = "`[Literal](file:///tmp/example)`";
    const text = `[Report](</tmp/my report.json>) [File](file:///tmp/file) [PR](https://example.com/pr) ${literal}`;
    const expected = `Report File [PR](https://example.com/pr) ${literal}${presentation ? "\n\n- Open" : ""}`;
    const existing = {
      id: "POST1", channel_id: "CHAN1", user_id: "BOT1", file_ids: ["FILE1"],
      props: { attachments: [{ previous: true }], other: true },
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/users/me")) return jsonResponse({ id: "BOT1" });
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        expect(body.message).toBe(expected);
        expect(body).not.toHaveProperty("file_ids");
        if (presentation) {
          expect(body.props).toMatchObject({ other: true, attachments: expect.any(Array) });
          expect(body.props.attachments).not.toContainEqual({ previous: true });
        } else {
          expect(body).not.toHaveProperty("props");
        }
        return jsonResponse({ ...existing, ...body });
      }
      expect(url).toMatch(/\/posts\/POST1$/u);
      return jsonResponse(existing);
    });
    await expect(editMattermostMessageAction({
      cfg, postId: "POST1", message: text, authorizedTarget: "channel:CHAN1",
      conversationReadOrigin: "delegated", fetchImpl,
      presentation: presentation ? { blocks: [{
        type: "buttons", buttons: [{ label: "Open", action: { type: "callback", value: "open" } }],
      }] } : undefined,
    })).resolves.toMatchObject({ message: expected, file_ids: ["FILE1"] });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });

  it("edits an authorized post through the normal post identity", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      calls.push({
        url,
        method: init?.method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (init?.method === "PUT") {
        return jsonResponse({ id: "POST1", channel_id: "CHAN1", message: "updated" });
      }
      return jsonResponse({ id: "POST1", channel_id: "CHAN1", message: "old" });
    });

    await expect(
      editMattermostMessageAction({
        cfg: createMattermostTestConfig("edit-action"),
        postId: "POST1",
        message: "updated",
        authorizedTarget: "channel:CHAN1",
        conversationReadOrigin: "delegated",
        fetchImpl,
      }),
    ).resolves.toMatchObject({ id: "POST1", message: "updated" });
    expect(calls.map((call) => [call.url.split("/api/v4")[1], call.method])).toEqual([
      ["/posts/POST1", undefined],
      ["/posts/POST1/patch", "PUT"],
    ]);
    expect(calls[1]?.body).toEqual({ id: "POST1", message: "updated" });
  });

  it("rejects a delegated cross-conversation mutation before the write", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/v4/posts/POST1")) {
        return jsonResponse({ id: "POST1", channel_id: "OTHER" });
      }
      throw new Error(`unexpected write: ${url}`);
    });

    await expect(
      deleteMattermostMessageAction({
        cfg: createMattermostTestConfig("delete-auth"),
        postId: "POST1",
        authorizedTarget: "channel:CHAN1",
        conversationReadOrigin: "delegated",
        fetchImpl,
      }),
    ).rejects.toThrow("different conversation");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("lists reactions only after binding the post to the authorized channel", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/v4/posts/POST1")) {
        return jsonResponse({ id: "POST1", channel_id: "CHAN1" });
      }
      if (url.endsWith("/api/v4/posts/POST1/reactions")) {
        return jsonResponse([
          { user_id: "USER1", post_id: "POST1", emoji_name: "thumbsup", create_at: 10 },
        ]);
      }
      throw new Error(`unexpected url: ${url}`);
    });

    await expect(
      listMattermostMessageReactionsAction({
        cfg: createMattermostTestConfig("reaction-list"),
        postId: "POST1",
        authorizedTarget: "channel:CHAN1",
        conversationReadOrigin: "delegated",
        fetchImpl,
      }),
    ).resolves.toEqual([
      { user_id: "USER1", post_id: "POST1", emoji_name: "thumbsup", create_at: 10 },
    ]);
  });

  it.each([
    [true, "/posts/POST1/pin"],
    [false, "/posts/POST1/unpin"],
  ])("sets pinned=%s through the provider endpoint", async (pinned, expectedPath) => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/v4/posts/POST1")) {
        return jsonResponse({ id: "POST1", channel_id: "CHAN1" });
      }
      expect(url).toContain(`/api/v4${expectedPath}`);
      expect(init?.method).toBe("POST");
      return jsonResponse({ status: "OK" });
    });

    await expect(
      setMattermostMessagePinnedAction({
        cfg: createMattermostTestConfig(`pin-${String(pinned)}`),
        postId: "POST1",
        pinned,
        authorizedTarget: "channel:CHAN1",
        conversationReadOrigin: "delegated",
        fetchImpl,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("lists pinned posts only for the delegated authorized channel", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      expect(url).toContain("/api/v4/channels/CHAN1/pinned");
      return jsonResponse({
        order: ["POST2", "POST1"],
        posts: {
          POST1: { id: "POST1", channel_id: "CHAN1", message: "one" },
          POST2: { id: "POST2", channel_id: "CHAN1", message: "two" },
        },
      });
    });

    await expect(
      listMattermostPinnedMessagesAction({
        cfg: createMattermostTestConfig("pin-list"),
        channelId: "CHAN1",
        authorizedTarget: "channel:CHAN1",
        conversationReadOrigin: "delegated",
        fetchImpl,
      }),
    ).resolves.toMatchObject([{ id: "POST2" }, { id: "POST1" }]);
  });

  it("rejects delegated pinned reads for a different channel without provider access", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      listMattermostPinnedMessagesAction({
        cfg: createMattermostTestConfig("pin-list-auth"),
        channelId: "OTHER",
        authorizedTarget: "channel:CHAN1",
        conversationReadOrigin: "delegated",
        fetchImpl,
      }),
    ).rejects.toThrow("authorized channel target");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
