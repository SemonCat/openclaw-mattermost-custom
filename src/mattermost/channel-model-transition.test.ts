import { describe, expect, it } from "vitest";
import {
  runMattermostChannelModelTransition,
  waitForMattermostChannelModelTransition,
} from "./channel-model-transition.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("Mattermost channel model transition", () => {
  it("waits for the active transition and rejects a concurrent update", async () => {
    const gate = deferred<string>();
    const first = runMattermostChannelModelTransition(
      { accountId: "default", channelId: "room-1", targetModel: "openai/new" },
      () => gate.promise,
    );

    await expect(
      runMattermostChannelModelTransition(
        { accountId: "default", channelId: "room-1", targetModel: "openai/other" },
        async () => "unexpected",
      ),
    ).resolves.toEqual({ status: "busy", targetModel: "openai/new" });

    let ingressReleased = false;
    const ingress = waitForMattermostChannelModelTransition({
      accountId: "default",
      channelId: "room-1",
    }).then((waited) => {
      ingressReleased = true;
      return waited;
    });
    await Promise.resolve();
    expect(ingressReleased).toBe(false);

    gate.resolve("done");
    await expect(first).resolves.toEqual({ status: "completed", value: "done" });
    await expect(ingress).resolves.toBe(true);
  });
});
