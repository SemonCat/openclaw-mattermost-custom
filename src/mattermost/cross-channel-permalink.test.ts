import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { resolveMattermostAccount } from "./accounts.js";
import { createMattermostClient } from "./client.js";
import { createMattermostPostedPermalinkBinding, MATTERMOST_PERMALINK_BINDING } from "./permalink-access.js";
import { hydrateMattermostPermalinks } from "./permalink-hydration.js";
import { createMattermostTestConfig, requestUrl } from "./reactions.test-helpers.js";
import { createMattermostThreadTool } from "./thread-tool.js";

const current = "s".repeat(26);
const target = "r".repeat(26);
const sender = "u".repeat(26);
const bot = "b".repeat(26);
const member = "m".repeat(26);
const other = "o".repeat(26);
const root = "t".repeat(26);
const linked = "p".repeat(26);
const file = "f".repeat(26);
const team = "a".repeat(26);

function fixture(options: {
  currentType?: string;
  targetType?: string;
  targetTeam?: string;
  targetConstrained?: boolean;
  currentMembers?: string[];
  targetMembers?: string[];
  malformedMembers?: boolean;
  deletedPost?: boolean;
  deletedChannel?: boolean;
  fileOwner?: string;
} = {}) {
  const cfg = createMattermostTestConfig("cross-channel-permalink");
  const account = resolveMattermostAccount({ cfg });
  const baseUrl = account.baseUrl!;
  const url = `${baseUrl}/team/pl/${linked}`;
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const request = new URL(requestUrl(input));
    const path = request.pathname.replace("/api/v4", "");
    if (path === `/posts/${linked}`) {
      return Response.json({
        id: linked, root_id: root, channel_id: target, user_id: sender,
        message: "the linked ruby reply", file_ids: [file],
        delete_at: options.deletedPost ? 1234 : 0,
      });
    }
    if (path === `/channels/${current}`) {
      return Response.json({ id: current, type: options.currentType ?? "P", name: "sure", team_id: team });
    }
    if (path === `/channels/${target}`) {
      return Response.json({
        id: target, type: options.targetType ?? "P", name: "ruby", team_id: options.targetTeam ?? team,
        group_constrained: options.targetConstrained, delete_at: options.deletedChannel ? 1234 : 0,
      });
    }
    if (path === "/users/me") return Response.json({ id: bot, is_bot: true });
    if (path === "/users/ids") return Response.json([{ id: sender, username: "requester" }]);
    if (path === `/files/${file}/info`) {
      return Response.json({
        id: file, post_id: options.fileOwner ?? linked, name: "ruby.pdf", mime_type: "application/pdf", size: 6,
      });
    }
    for (const [channelId, members] of [
      [current, options.currentMembers ?? [sender, bot, member]],
      [target, options.targetMembers ?? [sender, bot, member, other]],
    ] as const) {
      if (path === `/channels/${channelId}/members`) {
        expect(request.searchParams.get("per_page")).toBe("100");
        const offset = Number(request.searchParams.get("page")) * 100;
        return Response.json(members.slice(offset, offset + 100).map((user_id) => ({
          channel_id: options.malformedMembers ? other : channelId, user_id,
        })));
      }
    }
    throw new Error(`Unexpected fixture request: ${path}`);
  });
  const client = createMattermostClient({ baseUrl, botToken: "synthetic", fetchImpl });
  const binding = createMattermostPostedPermalinkBinding({ account, currentChannelId: current, requesterId: sender }, url);
  const context: OpenClawPluginToolContext = {
    runtimeConfig: cfg, messageChannel: "mattermost", nativeChannelId: current,
    requesterSenderId: sender, agentAccountId: account.accountId,
    toolBindings: { [MATTERMOST_PERMALINK_BINDING]: binding },
  };
  return {
    url, fetchImpl, binding,
    hydrate: (overrides: Partial<Parameters<typeof hydrateMattermostPermalinks>[0]> & { requesterId?: string } = {}) => {
      const params = { cfg, account, client, currentChannelId: current, text: url, requesterId: sender, ...overrides };
      return hydrateMattermostPermalinks(params);
    },
    read: (input = url, overrides: Partial<OpenClawPluginToolContext> = {}) =>
      createMattermostThreadTool({ config: cfg } as OpenClawPluginApi, { ...context, ...overrides }, {
        createClient: () => client,
      })!.execute("synthetic", { url_or_post_id: input }),
  };
}

describe("posted same-instance cross-private permalink", () => {
  it("hydrates only the linked post into a private source whose audience is contained in the target", async () => {
    const { hydrate, fetchImpl } = fixture();
    const result = await hydrate();
    expect(result).toContain("the linked ruby reply");
    expect(result).toContain("ruby.pdf");
    expect(fetchImpl.mock.calls.map(([input]) => requestUrl(input))).not.toContainEqual(
      expect.stringMatching(/\/thread\?|\/api\/v4\/files\/[^/]+$/u),
    );
  });

  it("reads the linked post and metadata through the tool with host-bound posted URL evidence", async () => {
    const { read } = fixture();
    await expect(read()).resolves.toMatchObject({
      details: {
        untrusted: true, requestedPostId: linked, channel: { id: target },
        posts: [{ id: linked, attachments: [{ id: file, name: "ruby.pdf" }] }],
      },
    });
  });

  it("denies a raw post ID, an unbound URL and preview-only input", async () => {
    const { read, hydrate, binding, url } = fixture();
    await expect(read(linked)).rejects.toThrow(/target is not/u);
    await expect(read(undefined, { toolBindings: undefined })).rejects.toThrow(/target is not/u);
    await expect(read(undefined, { nativeChannelId: undefined, deliveryContext: { to: `channel:${current}` } })).rejects.toThrow(/target is not/u);
    await expect(read(undefined, { requesterSenderId: other })).rejects.toThrow(/target is not/u);
    await expect(read(undefined, { agentAccountId: undefined })).rejects.toThrow(/target is not/u);
    await expect(read(undefined, {
      toolBindings: { [MATTERMOST_PERMALINK_BINDING]: { ...binding, signature: "0".repeat(64) } },
    })).rejects.toThrow(/target is not/u);
    await expect(read(`${url}/unrelated`)).rejects.toThrow(/target is not/u);
    await expect(hydrate({ text: "only metadata", props: { previewed_post: linked } })).resolves.toBe("");
    await expect(hydrate({ text: `${url}/unrelated` })).resolves.toBe("");
    await expect(hydrate({ requesterId: undefined })).resolves.toBe("");
  });

  it.each([
    { currentMembers: [sender, bot, other], targetMembers: [sender, bot, member] },
    { targetMembers: [bot, member] },
    { targetMembers: [sender, member] },
    { currentMembers: [bot, member] },
    { currentType: "O" },
    { currentType: "D" },
    { currentType: "G" },
    { targetType: "D" },
    { targetType: "G" },
    { targetTeam: other },
    { currentType: "O", targetType: "O", targetConstrained: true },
    { malformedMembers: true },
    { deletedPost: true },
    { deletedChannel: true },
  ])("denies the linked post when the current audience or native evidence cannot be verified (%j)", async (options) => {
    const { read, hydrate, fetchImpl } = fixture(options);
    await expect(hydrate()).resolves.toBe("");
    await expect(read()).rejects.toThrow(/target is not/u);
    expect(fetchImpl.mock.calls.map(([input]) => requestUrl(input))).not.toContainEqual(
      expect.stringMatching(/\/thread\?|\/files\//u),
    );
  });

  it.each(["P", "O"])("reads a same-team unconfigured public post from source type %s", async (currentType) => {
    const { read } = fixture({ currentType, targetType: "O" });
    await expect(read()).resolves.toMatchObject({
      details: { channel: { id: target, type: "O" }, posts: [{ id: linked }] },
    });
  });

  it("rejects a non-contained member on a later page and a membership list that exceeds the bound", async () => {
    const members = Array.from({ length: 120 }, (_, index) => `x${index.toString().padStart(25, "0")}`);
    const laterPage = fixture({
      currentMembers: [sender, bot, ...members, other], targetMembers: [sender, bot, ...members],
    });
    await expect(laterPage.read()).rejects.toThrow(/target is not/u);
    const capped = fixture({
      targetMembers: [sender, bot, member, ...Array.from({ length: 497 }, (_, index) => `x${index.toString().padStart(25, "0")}`)],
    });
    await expect(capped.read()).rejects.toThrow(/target is not/u);
  });

  it("ignores metadata identifying a different post", async () => {
    const { read } = fixture({ fileOwner: root });
    const result = await read();
    expect(result.details).toMatchObject({ posts: [{ id: linked }] });
    expect(result.content).not.toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("ruby.pdf") }),
    ]);
  });
});
