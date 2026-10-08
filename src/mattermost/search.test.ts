import { afterEach, describe, expect, it, vi } from "vitest";
import { mattermostPlugin } from "../channel.js";
import { searchMattermostMessages } from "./search.js";
import type { OpenClawConfig } from "./runtime-api.js";

const C = "c".repeat(26), O = "o".repeat(26), T = "t".repeat(26), U = "u".repeat(26), V = "v".repeat(26);
const pid = (n: number) => String(n).padStart(26, "a");
const cfg = (search?: boolean) => ({ channels: { mattermost: { botToken: "test-token", baseUrl: "https://mm.example", groupPolicy: "allowlist", actions: search === undefined ? {} : { search } } } }) as unknown as OpenClawConfig;
const context = { conversationReadOrigin: "delegated" as const, requesterAccountId: "default", toolContext: { currentChannelProvider: "mattermost", currentChannelId: `channel:${C}` } };
const row = (n = 1) => ({ id: pid(n), channel_id: C, user_id: U, root_id: "", message: "deployment details", create_at: 123, props: { secret: "never returned" } });
function provider(body: unknown = { order: [pid(1)], posts: { [pid(1)]: row() } }, channel: Record<string, unknown> = {}, status = 200) {
  return vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).includes("/posts/search")) return Response.json(body, { status });
    return Response.json({ id: C, type: "O", name: "engineering", team_id: T, ...channel });
  });
}
afterEach(() => vi.unstubAllGlobals());
const discover = (config: OpenClawConfig, accountId = "default") => mattermostPlugin.actions!.describeMessageTool!({ cfg: config, accountId })!.actions;
async function dispatch(config: OpenClawConfig, fetchImpl: typeof fetch, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  // Public dispatch still uses the production SSRF wrapper; mock only its transport below.
  vi.stubGlobal("fetch", fetchImpl);
  return mattermostPlugin.actions!.handleAction!({ cfg: config, action: "search", params: { query: "deployment", ...params }, accountId: "default", ...context, ...extra } as never);
}
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (original) => ({
  ...await original<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(),
  fetchWithSsrFGuard: async ({ url, init }: { url: string; init: RequestInit }) => ({ response: await globalThis.fetch(url, init), release: async () => { }, finalUrl: url }),
}));

describe("public bounded Mattermost search", () => {
  it("requires its own opt-in gate in discovery and dispatch", async () => {
    expect(mattermostPlugin.actions!.supportsAction!({ action: "search" })).toBe(true);
    for (const config of [cfg(), cfg(false)]) {
      expect(discover(config)).not.toContain("search");
      const fetchImpl = provider();
      await expect(dispatch(config, fetchImpl)).rejects.toThrow("search is disabled");
      expect(fetchImpl).not.toHaveBeenCalled();
    }
    expect(discover(cfg(true))).toContain("search");
    expect(discover(cfg(true))).not.toContain("read");
  });
  it("uses selected account gates and preserves per-field root action inheritance", async () => {
    const config = cfg(true);
    Object.assign(config.channels!.mattermost!, { accounts: { off: { actions: { search: false } }, work: { actions: { messages: false } } } });
    expect(discover(config, "off")).not.toContain("search");
    expect(discover(config, "work")).toContain("search");
    const fetchImpl = provider();
    await expect(dispatch(config, fetchImpl, {}, { accountId: "off" })).rejects.toThrow("search is disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(dispatch(config, fetchImpl, {}, { accountId: "work", requesterAccountId: "work" })).resolves.toMatchObject({ details: { messages: [{ id: pid(1) }] } });
  });
  it("dispatches an authorized current channel query using channel NAME and required AND body", async () => {
    const fetchImpl = provider();
    const result = await dispatch(cfg(true), fetchImpl, { senderId: U });
    expect(result.details).toMatchObject({ channelId: C, messages: [{ id: pid(1), snippet: "deployment details", threadId: pid(1), permalink: `https://mm.example/_redirect/pl/${pid(1)}` }], truncated: false, completeness: "unknown" });
    expect(JSON.stringify(result)).not.toContain("never returned");
    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe(`https://mm.example/api/v4/teams/${T}/posts/search`);
    expect(JSON.parse(init!.body as string)).toEqual({ terms: "deployment in:engineering", is_or_search: false, include_deleted_channels: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("rejects injected operators and invalid budgets before provider access", async () => {
    for (const params of [{ query: "" }, { query: "in:other" }, { query: "from:owner" }, { query: "x OR y" }, { query: "-in:other" }, { query: "x".repeat(201) }, { limit: 51 }, { limit: Infinity }, { senderId: "owner" }]) {
      const fetchImpl = provider();
      await expect(dispatch(cfg(true), fetchImpl, params)).rejects.toThrow();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
  it("denies delegation/account switching and private/DM crossreads before search", async () => {
    for (const extra of [{ requesterAccountId: "other" }, { toolContext: { currentChannelProvider: "slack" } }]) {
      const fetchImpl = provider();
      await expect(dispatch(cfg(true), fetchImpl, { target: `channel:${C}` }, extra)).rejects.toThrow("delegated reads require");
      expect(fetchImpl).not.toHaveBeenCalled();
    }
    for (const type of ["D", "P", "O"]) {
      const fetchImpl = provider(undefined, { id: O, type });
      await expect(dispatch(cfg(true), fetchImpl, { target: `channel:${O}` })).rejects.toThrow("not allowed");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
    const config = cfg(true);
    Object.assign(config.channels!.mattermost!, { groups: { [O]: { requireMention: false } } });
    const fetchImpl = provider({ order: [], posts: {} }, { id: O });
    await expect(dispatch(config, fetchImpl, { target: `channel:${O}` })).resolves.toMatchObject({ details: { messages: [], completeness: "unknown" } });
  });
  it("rejects every malformed or foreign row, including off-window and unordered rows", async () => {
    for (const posts of [
      { [pid(1)]: { ...row(), message: 42 } },
      { [pid(1)]: row(), [pid(2)]: { ...row(2), channel_id: O, message: "foreign secret" } },
      { [pid(1)]: row(), [pid(2)]: { ...row(2), user_id: null } },
      { [pid(1)]: { ...row(), id: pid(2) } },
    ]) {
      const fetchImpl = provider({ order: [pid(1)], posts });
      await expect(dispatch(cfg(true), fetchImpl, { limit: 1, senderId: V })).rejects.toThrow("Unexpected Mattermost search response");
    }
    for (const order of [[pid(1), pid(1)], [pid(2)]]) {
      await expect(dispatch(cfg(true), provider({ order, posts: { [pid(1)]: row() } }))).rejects.toThrow("Unexpected Mattermost search response");
    }
  });
  it("bounds results and text locally even when provider ignores pagination", async () => {
    const posts = Object.fromEntries(Array.from({ length: 60 }, (_, n) => [pid(n), { ...row(n), message: "x".repeat(700) }]));
    const fetchImpl = provider({ order: Object.keys(posts), posts });
    const result = await dispatch(cfg(true), fetchImpl, { limit: 50 });
    const details = result.details as { messages: { snippet: string }[]; truncated: boolean; completeness: string };
    expect(details.messages).toHaveLength(24);
    expect(details.messages.reduce((sum, m) => sum + m.snippet.length, 0)).toBe(12000);
    expect(details.truncated).toBe(true);
    expect(details.completeness).toBe("unknown");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.details).toMatchObject({ sourceCount: 60, orderedCount: 60, eligibleCount: 60, outputCount: 24 });
  });
  it("counts every validated source row before deleted/sender filtering and rejects oversized source maps", async () => {
    const posts = { [pid(1)]: row(), [pid(2)]: { ...row(2), delete_at: 1 }, [pid(3)]: { ...row(3), user_id: V }, [pid(4)]: row(4) };
    const result = await dispatch(cfg(true), provider({ order: [pid(1), pid(2), pid(3)], posts }), { senderId: U });
    expect(result.details).toMatchObject({ sourceCount: 4, orderedCount: 3, eligibleCount: 1, outputCount: 1, completeness: "unknown" });
    const oversized = Object.fromEntries(Array.from({ length: 1001 }, (_, n) => [pid(n), row(n)]));
    await expect(dispatch(cfg(true), provider({ order: [pid(1)], posts: oversized }))).rejects.toThrow("Unexpected Mattermost search response");
    await expect(dispatch(cfg(true), provider({ order: Object.keys(oversized), posts: oversized }))).rejects.toThrow("Unexpected Mattermost search response");
  });
  it("preserves index/API failures as errors, not empty matches", async () => {
    await expect(dispatch(cfg(true), provider({ message: "Search index unavailable" }, {}, 503))).rejects.toThrow("Search index unavailable");
  });
});
