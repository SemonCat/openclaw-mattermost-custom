import { afterEach, expect, it, vi } from "vitest";
import type {
  ControlUiAccessory,
  ControlUiHost,
  ControlUiSession,
} from "openclaw/plugin-sdk/control-ui";
import plugin from "./browser/index.js";

// Minimal DOM implements the real public SDK component's DOM operations.
class Element {
  className = "";
  target = "";
  rel = "";
  dataset = {};
  href = "";
  textContent = "";
  parentNode: Element | null = null;
  children: Element[] = [];
  append(child: Element) {
    child.remove();
    child.parentNode = this;
    this.children.push(child);
  }
  remove() {
    if (this.parentNode)
      this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  removeAttribute(name: string) {
    if (name === "href") this.href = "";
  }
}
afterEach(() => vi.unstubAllGlobals());
const baseUrl = "https://chat.example/mm";
const source = (base = baseUrl) => ({
  url: `${base}/_redirect/pl/${"a".repeat(26)}`,
  label: "Mattermost",
});
const session = (accountId = "default", link = source(), channel = "mattermost") =>
  ({
    key: "agent:main:test",
    channel,
    accountId,
    conversationLink: link,
  }) as ControlUiSession;
async function fixture() {
  vi.stubGlobal("document", { createElement: () => new Element() });
  let accessory!: ControlUiAccessory;
  let notify!: () => void;
  const unregister = vi.fn();
  const unsubscribe = vi.fn();
  const request = vi.fn(async () => ({
    channelAccounts: {
      mattermost: [{ accountId: "default", configured: true, enabled: true, baseUrl }],
    },
  }));
  const host = {
    connection: { connected: true, canRead: true },
    request,
    subscribe: (callback: () => void) => {
      notify = callback;
      return unsubscribe;
    },
    ui: {
      registerAccessory: (value: ControlUiAccessory) => {
        accessory = value;
        return unregister;
      },
    },
  } as unknown as ControlUiHost;
  const deactivate = await plugin.activate(host);
  const controller = new AbortController();
  const container = new Element();
  const context = {
    host,
    signal: controller.signal,
    props: { session: session() },
    presented: true,
    mountDefault: () => () => {},
  };
  const handle = accessory.mount(container as unknown as HTMLElement, context)!;
  await Promise.resolve();
  return {
    host,
    request,
    container,
    context,
    handle,
    controller,
    notify: () => notify(),
    unsubscribe,
    deactivate,
    unregister,
  };
}
it("mounts real SDK link, updates/hides by provider/instance/label/path and disposes", async () => {
  const f = await fixture();
  expect(plugin.id).toBe("mattermost-custom");
  expect(f.request).toHaveBeenCalledWith("channels.status", {
    channel: "mattermost",
    probe: false,
  });
  expect(f.container.children[0]).toMatchObject({
    href: source().url,
    textContent: "Mattermost ↗",
    target: "_blank",
    rel: "noopener noreferrer",
  });
  for (const s of [
    session("default", source(), "telegram"),
    session("default", source("https://evil.example")),
    session("default", { ...source(), label: "Slack" }),
    session("default", { ...source(), url: `${source().url}?x=1` }),
    { ...session(), conversationLink: undefined },
  ]) {
    f.handle.update?.({ ...f.context, props: { session: s } });
    await Promise.resolve();
    expect(f.container.children).toHaveLength(0);
  }
  f.handle.update?.(f.context);
  await Promise.resolve();
  expect(f.container.children).toHaveLength(1);
  f.controller.abort();
  expect(f.container.children).toHaveLength(0);
  expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  f.handle.update?.(f.context);
  expect(f.container.children).toHaveLength(0);
  if (typeof f.deactivate === "function") f.deactivate();
  expect(f.unregister).toHaveBeenCalledTimes(1);
});
it("scopes exact account, refreshes on presentation resume and connection change without token-update polling", async () => {
  const f = await fixture();
  for (let i = 0; i < 5; i++) f.handle.update?.(f.context);
  expect(f.request).toHaveBeenCalledTimes(1);
  f.request.mockResolvedValue({
    channelAccounts: {
      mattermost: [
        {
          accountId: "other",
          configured: true,
          enabled: true,
          baseUrl: "https://other.example",
        },
      ],
    },
  });
  f.handle.update?.({
    ...f.context,
    props: { session: session("other", source("https://other.example")) },
  });
  await Promise.resolve();
  expect(f.container.children[0]?.href).toBe(source("https://other.example").url);
  f.handle.update?.(f.context);
  await Promise.resolve();
  expect(f.container.children).toHaveLength(0); // No default-account fallback.
  f.request.mockResolvedValue({
    channelAccounts: {
      mattermost: [
        {
          accountId: "default",
          configured: true,
          enabled: true,
          baseUrl: "https://new.example",
        },
      ],
    },
  });
  f.handle.update?.({ ...f.context, presented: false });
  f.handle.update?.(f.context);
  await Promise.resolve();
  expect(f.container.children).toHaveLength(0); // Old launch link is now a foreign instance.
  f.handle.update?.({
    ...f.context,
    props: { session: session("default", source("https://new.example")) },
  });
  expect(f.container.children).toHaveLength(1);
  f.host.connection.connected = false;
  f.notify();
  expect(f.container.children).toHaveLength(0);
  f.host.connection.connected = true;
  f.notify();
  await Promise.resolve();
  expect(f.container.children).toHaveLength(1);
  f.handle.dispose?.();
});
it("ignores stale status responses after account switch or disposal and hides denied status", async () => {
  const f = await fixture();
  let resolve!: (value: any) => void;
  f.request.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  f.handle.update?.({ ...f.context, props: { session: session("other") } });
  f.handle.update?.(f.context);
  await Promise.resolve();
  resolve({
    channelAccounts: {
      mattermost: [{ accountId: "other", configured: true, baseUrl }],
    },
  });
  await Promise.resolve();
  expect(f.container.children[0]?.href).toBe(source().url);
  f.request.mockRejectedValueOnce(new Error("scope denied"));
  f.handle.update?.({ ...f.context, presented: false });
  f.handle.update?.(f.context);
  await Promise.resolve();
  expect(f.container.children).toHaveLength(0);
  f.handle.dispose?.();
});

it.each([
  {},
  {
    channelAccounts: {
      mattermost: [{ accountId: "default", configured: false, baseUrl }],
    },
  },
  {
    channelAccounts: {
      mattermost: [{ accountId: "default", configured: true, enabled: false, baseUrl }],
    },
  },
  {
    channelAccounts: {
      mattermost: [
        { accountId: "default", configured: true, baseUrl },
        { accountId: "default", configured: true, baseUrl },
      ],
    },
  },
  {
    channelAccounts: {
      mattermost: [
        {
          accountId: "default",
          configured: true,
          baseUrl: "https://user@chat.example/mm",
        },
      ],
    },
  },
])("hides unavailable, disabled, ambiguous or unsafe account status %#", async (status) => {
  const f = await fixture();
  f.request.mockResolvedValue(status as never);
  f.handle.update?.({ ...f.context, presented: false });
  f.handle.update?.(f.context);
  await Promise.resolve();
  expect(f.container.children).toHaveLength(0);
  f.handle.dispose?.();
});
