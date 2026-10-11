import { describe, expect, it } from "vitest";
import {
  resolveMattermostConversationLink,
  validateMattermostConversationLink,
} from "./conversation-link.js";
import { buildMattermostEventPlan } from "./monitor-event-plan.js";
import type { MattermostMonitorContext } from "./monitor-types.js";

const postId = "a".repeat(26);
const rootId = "b".repeat(26);
const baseUrl = "https://chat.example/mm/";
const url = `${baseUrl}_redirect/pl/${postId}`;

describe("Mattermost launch links", () => {
  it("preserves configured subpaths and prefers native thread identity", () => {
    expect(resolveMattermostConversationLink({ baseUrl, postId })).toEqual({
      url,
      label: "Mattermost",
    });
    expect(
      resolveMattermostConversationLink({
        baseUrl,
        postId,
        threadRootId: rootId,
      })?.url,
    ).toBe(`${baseUrl}_redirect/pl/${rootId}`);
  });
  it.each([undefined, "slash-123", `interaction:${postId}:action`, "../other", "A".repeat(26)])(
    "omits invalid or absent native source %s",
    (id) => {
      expect(resolveMattermostConversationLink({ baseUrl, postId: id })).toBeUndefined();
    },
  );
  it.each([
    "javascript:alert(1)",
    "https://chat.example/mm?token=x",
    "https://chat.example/mm#x",
    "https://chat.example/mm%2fother",
    "https://chat.example\\evil",
  ])("rejects unsafe configured base %s", (base) => {
    expect(resolveMattermostConversationLink({ baseUrl: base, postId })).toBeUndefined();
  });
  it("rejects synthetic credentials constructed with URL fields", () => {
    const configured = new URL(baseUrl);
    configured.username = "fixture-user";
    configured.password = "fixture-password";
    expect(resolveMattermostConversationLink({ baseUrl: configured.href, postId })).toBeUndefined();
    configured.username = "";
    expect(resolveMattermostConversationLink({ baseUrl: configured.href, postId })).toBeUndefined();
  });
  it("validates persisted destinations against exact configured instance/path", () => {
    const link = { url, label: "Mattermost" };
    expect(validateMattermostConversationLink(link, baseUrl)).toBe(link);
    for (const unsafe of [
      url.replace("chat.example", "evil.example"),
      `${url}?x=1`,
      `${url}#x`,
      url.replace("/mm/", "/other/"),
      url.replace("https://", "https://user@"),
      url.replace(postId, `%61${postId.slice(1)}`),
    ]) {
      expect(validateMattermostConversationLink({ ...link, url: unsafe }, baseUrl)).toBeUndefined();
    }
    expect(
      validateMattermostConversationLink({ ...link, label: "Slack" }, baseUrl),
    ).toBeUndefined();
  });
});

it.each(["O", "D"])(
  "supplies native source for admitted %s context independent of MessageSid",
  async (channelType) => {
    const monitor = {
      cfg: {},
      account: { accountId: "default", baseUrl, config: {} },
      core: {
        channel: {
          routing: {
            resolveAgentRoute: () => ({
              sessionKey: "agent:main:mattermost:channel:x",
              accountId: "default",
            }),
          },
        },
      },
      resources: { resolveChannelInfo: async () => ({ type: channelType }) },
      logVerboseMessage: () => {},
    } as unknown as MattermostMonitorContext;
    const params = {
      channelId: "channel",
      senderId: "sender",
      postId,
      dropLabel: "test",
    };
    const plan = (await buildMattermostEventPlan(monitor, params))!;
    expect(plan.finalizeContext({ MessageSid: "synthetic" }).ConversationLink).toEqual({
      url,
      label: "Mattermost",
    });
    const thread = (await buildMattermostEventPlan(monitor, {
      ...params,
      threadRootId: rootId,
    }))!;
    expect(thread.finalizeContext({}).ConversationLink?.url).toBe(
      `${baseUrl}_redirect/pl/${rootId}`,
    );
    const unverified = (await buildMattermostEventPlan(monitor, {
      ...params,
      suppressConversationLink: true,
    }))!;
    expect(
      unverified.finalizeContext({
        ConversationLink: { url: "https://evil.example", label: "Mattermost" },
      }).ConversationLink,
    ).toBeUndefined();
    const absent = (await buildMattermostEventPlan(monitor, {
      ...params,
      postId: undefined,
    }))!;
    expect(absent.finalizeContext({ MessageSid: "slash-123" }).ConversationLink).toBeUndefined();
  },
);
