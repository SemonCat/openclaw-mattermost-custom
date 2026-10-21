import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { expect, it, vi } from "vitest";
import plugin from "./browser/index.js";

it("keeps the declared browser entry inert after 10.5 retires session origin metadata", async () => {
  const request = vi.fn();
  const subscribe = vi.fn();
  const registerAccessory = vi.fn();
  const host = {
    request,
    subscribe,
    ui: { registerAccessory },
  } as unknown as ControlUiHost;

  expect(plugin.id).toBe("mattermost-custom");
  await plugin.activate(host);

  expect(registerAccessory).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  expect(subscribe).not.toHaveBeenCalled();
});
