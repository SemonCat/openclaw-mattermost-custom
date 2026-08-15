import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getSessionEntry,
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./runtime-api.js";
import {
  pinMattermostExplicitDefaultModelSelection,
  rewriteMattermostPinnedModelReply,
} from "./model-session-pin.js";

const modelsData = {
  byProvider: new Map<string, Set<string>>([
    ["openai", new Set(["gpt-5.6-sol"])],
    ["opencode-go", new Set(["deepseek-v4-flash"])],
  ]),
  providers: ["openai", "opencode-go"],
  resolvedDefault: {
    provider: "openai",
    model: "gpt-5.6-sol",
  },
  modelNames: new Map<string, string>(),
};

describe("Mattermost explicit default-model pin", () => {
  it.each(["/model openai/gpt-5.6-sol", "/model openai-sol"])(
    "pins an explicitly named global default to the targeted thread session: %s",
    async (commandText) => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-model-pin-"));
      try {
        const storePath = path.join(testDir, "agents", "{agentId}", "sessions", "sessions.json");
        const resolvedStorePath = path.join(
          testDir,
          "agents",
          "main",
          "sessions",
          "sessions.json",
        );
        const sessionKey = "agent:main:mattermost:channel:chan-1:thread:root-1";
        await upsertSessionEntry({
          agentId: "main",
          storePath: resolvedStorePath,
          sessionKey,
          entry: {
            chatType: "channel",
            delivery: normalizeSessionDeliveryState({ context: { channel: "chan-1" } }),
            model: "deepseek-v4-flash",
            modelProvider: "opencode-go",
            sessionId: "thread-session",
            updatedAt: 1,
          },
        });
        const cfg: OpenClawConfig = {
          session: { store: storePath },
          agents: {
            defaults: {
              model: "openai/gpt-5.6-sol",
              models: { "openai/gpt-5.6-sol": { alias: "openai-sol" } },
            },
          },
          channels: {
            modelByChannel: {
              mattermost: { "chan-1": "opencode-go/deepseek-v4-flash" },
            },
          },
        };

        const result = await pinMattermostExplicitDefaultModelSelection({
          agentId: "main",
          cfg,
          commandText,
          modelsData,
          sessionKey,
        });

        expect(result).toEqual({ pinned: true, modelRef: "openai/gpt-5.6-sol" });
        expect(
          getSessionEntry({
            agentId: "main",
            readConsistency: "latest",
            sessionKey,
            storePath: resolvedStorePath,
          }),
        ).toMatchObject({
          liveModelSwitchPending: true,
          modelOverride: "gpt-5.6-sol",
          modelOverrideRouteResolution: "resolved",
          modelOverrideSource: "user",
          providerOverride: "openai",
        });
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    },
  );

  it("leaves explicit reset commands and non-default selections to OpenClaw core", async () => {
    const cfg = {} as OpenClawConfig;

    await expect(
      pinMattermostExplicitDefaultModelSelection({
        agentId: "main",
        cfg,
        commandText: "/model default",
        modelsData,
        sessionKey: "agent:main:mattermost:channel:chan-1:thread:root-1",
      }),
    ).resolves.toEqual({ pinned: false });
    await expect(
      pinMattermostExplicitDefaultModelSelection({
        agentId: "main",
        cfg,
        commandText: "/model opencode-go/deepseek-v4-flash",
        modelsData,
        sessionKey: "agent:main:mattermost:channel:chan-1:thread:root-1",
      }),
    ).resolves.toEqual({ pinned: false });
  });

  it("rewrites the misleading reset acknowledgement after pinning", () => {
    expect(
      rewriteMattermostPinnedModelReply(
        "Model reset to default (openai-sol (openai/gpt-5.6-sol)). Runtime set to codex for this session.",
        "openai/gpt-5.6-sol",
      ),
    ).toBe(
      "Model set to openai/gpt-5.6-sol for this session. Runtime set to codex for this session.",
    );
  });
});
