// Use only with a disposable Mattermost fixture and a separately installed Playwright.
// PLAYWRIGHT_MODULE=/path/to/playwright MATTERMOST_TEST_URL=http://localhost:18065 \
// node this-file.cjs /private/test-state.json /private/browser-receipt.json
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const base = process.env.MATTERMOST_TEST_URL || "http://localhost:18065";
  assert(["localhost", "127.0.0.1"].includes(new URL(base).hostname), "Loopback test fixture required");
  const receiptPath = process.argv[3];
  const directory = path.dirname(receiptPath);
  const checks = [];
  const errors = [];
  const api = async (route, body, token = state.bot_token, method) => {
    const response = await fetch(base + route, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert(response.ok, `${route}: HTTP ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  const browser = await chromium.launch({
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1365, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem("__landingPageSeen__", "true"));
    const page = await context.newPage();
    let hellos = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
      if (typeof payload === "string" && JSON.parse(payload).event === "hello") hellos++;
    }));
    await page.goto(`${base}/login`);
    await page.getByRole("textbox", { name: "Email or Username" }).fill("probereader");
    await page.locator("input[type=password]").fill(state.reader_password);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await page.waitForURL("**/channels/**");
    const priorHello = hellos;
    await page.goto(`${base}/stream-probe/channels/town-square`);
    const deadline = Date.now() + 10_000;
    while (hellos <= priorHello) {
      assert(Date.now() < deadline, "Authenticated web client WebSocket did not connect");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await page.waitForFunction(() => !!window.OpenClawStreamState);
    const dismiss = page.getByText(/No thanks/);
    try {
      await dismiss.waitFor({ state: "visible", timeout: 3000 });
      await dismiss.click();
      await dismiss.waitFor({ state: "hidden" });
    } catch (error) {
      if (error.name !== "TimeoutError" || await dismiss.isVisible()) throw error;
    }
    const nonce = randomUUID().slice(0, 8);
    const durable = `Durable checkpoint ${nonce}`;
    const preview = `WebSocket preview before REST ${nonce}`;
    const resumed = `Reconnected preview ${nonce}`;
    const final = `Final saved result ${nonce}`;
    const generation = randomUUID();
    const post = await api("/api/v4/posts", {
      channel_id: state.channel_id, message: `**${durable}**`, type: "custom_openclaw_stream",
      props: {
        openclaw_stream: { version: 1, generation },
        openclaw_mattermost: {
          version: 1, kind: "turn_result", accountId: "default",
          agentId: "main", channelId: state.channel_id,
        },
      },
    });
    await page.getByText(durable, { exact: true }).waitFor();
    const identity = { post_id: post.id, channel_id: state.channel_id, root_id: "", generation };
    await api("/plugins/openclaw-stream/v1/snapshots", {
      ...identity, seq: 1, message: `**${preview}**\n\n\`native markdown\``,
    });
    await page.getByText(preview, { exact: true }).waitFor();
    assert.equal((await api(`/api/v4/posts/${post.id}`)).message, `**${durable}**`);
    assert.equal(await page.locator("strong").filter({ hasText: preview }).count(), 1);
    checks.push("real web renderer shows WS-only text and native Markdown before any durable edit");
    await page.waitForTimeout(750);
    await page.screenshot({ path: path.join(directory, "stream-preview-desktop.png") });
    await page.reload();
    await page.getByText(preview, { exact: true }).waitFor();
    checks.push("page reload reconstructs the active preview through authorized readback");
    await context.setOffline(true);
    await api("/plugins/openclaw-stream/v1/snapshots", {
      ...identity, seq: 2, message: `**${resumed}**`,
    });
    await context.setOffline(false);
    await page.getByText(resumed, { exact: true }).waitFor({ timeout: 12_000 });
    assert.equal((await api(`/api/v4/posts/${post.id}`)).message, `**${durable}**`);
    checks.push("reconnecting after an offline snapshot restores newer preview text without a REST edit");
    await page.setViewportSize({ width: 415, height: 900 });
    await page.getByText(resumed, { exact: true }).waitFor();
    await page.waitForTimeout(750);
    await page.screenshot({ path: path.join(directory, "stream-preview-narrow-web.png") });
    checks.push("narrow web viewport renders the active preview");
    await api(`/api/v4/posts/${post.id}/patch`, { message: `**${final}**` }, state.bot_token, "PUT");
    await page.getByText(final, { exact: true }).waitFor();
    assert.equal(await page.getByText(resumed, { exact: true }).count(), 0);
    checks.push("a newer durable edit replaces the active snapshot even without a close event");
    await api("/plugins/openclaw-stream/v1/close", { ...identity, seq: 3 });
    await page.getByText(final, { exact: true }).waitFor();
    await page.screenshot({ path: path.join(directory, "stream-final.png") });
    await api("/api/v4/plugins/openclaw-stream/disable", {}, state.admin_token);
    await page.reload();
    await page.getByText(final, { exact: true }).waitFor();
    await page.waitForFunction(() => !window.OpenClawStreamState);
    checks.push("disabling the companion preserves durable text through the stock renderer");
    await api("/api/v4/plugins/openclaw-stream/enable", {}, state.admin_token);
    assert.equal(errors.length, 0, JSON.stringify(errors));
    const receipt = {
      verified_at: new Date().toISOString(), server: "Mattermost Team Edition 12.0.1",
      chromium: browser.version(),
      scope: "Disposable isolated server; synthetic publisher, real Mattermost web UI",
      post_id: post.id, checks, page_errors: errors,
    };
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
