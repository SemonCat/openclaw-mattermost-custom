// Mattermost tests cover slash commands plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import {
  MATTERMOST_SLASH_POST_METHOD,
  parseSlashCommandPayload,
  registerSlashCommands,
  resolveCallbackUrl,
  resolveCommandText,
  resolveSlashCommandConfig,
  type MattermostCommandSpec,
} from "./slash-commands.js";

describe("slash-commands", () => {
  async function registerSingleStatusCommand(
    requestImpl: (path: string, init?: RequestInit) => Promise<unknown>,
    description = "status",
  ) {
    const client: MattermostClient = {
      baseUrl: "https://chat.example.com",
      apiBaseUrl: "https://chat.example.com/api/v4",
      token: "bot-token",
      request: async <T>(path: string, init?: RequestInit) => (await requestImpl(path, init)) as T,
      fetchImpl: vi.fn<typeof fetch>(),
    };
    return registerSlashCommands({
      client,
      teamId: "team-1",
      creatorUserId: "bot-user",
      callbackUrl: "http://gateway/callback",
      commands: [
        {
          trigger: "oc_status",
          description,
          autoComplete: true,
        },
      ],
    });
  }

  it("parses application/x-www-form-urlencoded payloads", () => {
    const payload = parseSlashCommandPayload(
      "token=t1&team_id=team&channel_id=ch1&user_id=u1&command=%2Foc_status&text=now",
      "application/x-www-form-urlencoded",
    );
    expect(payload).toEqual({
      token: "t1",
      team_id: "team",
      team_domain: undefined,
      channel_id: "ch1",
      channel_name: undefined,
      user_id: "u1",
      user_name: undefined,
      command: "/oc_status",
      text: "now",
      trigger_id: undefined,
      response_url: undefined,
    });
  });

  it("parses application/json payloads", () => {
    const payload = parseSlashCommandPayload(
      JSON.stringify({
        token: "t2",
        team_id: "team",
        channel_id: "ch2",
        user_id: "u2",
        command: "/oc_model",
        text: "gpt-5",
      }),
      "application/json; charset=utf-8",
    );
    expect(payload).toEqual({
      token: "t2",
      team_id: "team",
      team_domain: undefined,
      channel_id: "ch2",
      channel_name: undefined,
      user_id: "u2",
      user_name: undefined,
      command: "/oc_model",
      text: "gpt-5",
      trigger_id: undefined,
      response_url: undefined,
    });
  });

  it("returns null for malformed payloads missing required fields", () => {
    const payload = parseSlashCommandPayload(
      JSON.stringify({ token: "t3", command: "/oc_help" }),
      "application/json",
    );
    expect(payload).toBeNull();
  });

  it("resolves command text with trigger map fallback", () => {
    const triggerMap = new Map<string, string>([["oc_status", "status"]]);
    expect(resolveCommandText("oc_status", "   ", triggerMap)).toBe("/status");
    expect(resolveCommandText("oc_status", " now ", triggerMap)).toBe("/status now");
    expect(resolveCommandText("oc_models", " openai ", undefined)).toBe("/models openai");
    expect(resolveCommandText("oc_help", "", undefined)).toBe("/help");
  });

  it("resolves command text for a root-named trigger via the trigger map", () => {
    const triggerMap = new Map<string, string>([["queue", "queue"]]);
    expect(resolveCommandText("queue", " collect drop:summarize ", triggerMap)).toBe(
      "/queue collect drop:summarize",
    );
  });

  it("parses the root_id thread field when present", () => {
    const payload = parseSlashCommandPayload(
      "token=t1&team_id=team&channel_id=ch1&user_id=u1&command=%2Fstop&text=&root_id=root-post-1",
      "application/x-www-form-urlencoded",
    );
    expect(payload?.root_id).toBe("root-post-1");

    const jsonPayload = parseSlashCommandPayload(
      JSON.stringify({
        token: "t1",
        team_id: "team",
        channel_id: "ch1",
        user_id: "u1",
        command: "/stop",
        text: "",
        root_id: "root-post-1",
      }),
      "application/json",
    );
    expect(jsonPayload?.root_id).toBe("root-post-1");
  });

  it("normalizes callback path in slash config", () => {
    const config = resolveSlashCommandConfig({ callbackPath: "api/channels/mattermost/command" });
    expect(config.callbackPath).toBe("/api/channels/mattermost/command");
  });

  it("defaults to a callback path outside the Gateway-protected API namespace", () => {
    const config = resolveSlashCommandConfig();
    expect(config.callbackPath).toBe("/mattermost/command");
  });

  it("falls back to localhost callback URL for wildcard bind hosts", () => {
    const config = resolveSlashCommandConfig();
    const callbackUrl = resolveCallbackUrl({
      config,
      gatewayPort: 18789,
      gatewayHost: "0.0.0.0",
    });
    expect(callbackUrl).toBe("http://localhost:18789/mattermost/command");
  });

  it("reuses existing command when trigger already points to callback URL", async () => {
    const request = vi.fn(async (path: string) => {
      if (path.startsWith("/commands?team_id=")) {
        return [
          {
            id: "cmd-1",
            token: "tok-1",
            team_id: "team-1",
            creator_id: "bot-user",
            trigger: "oc_status",
            method: "P",
            url: "http://gateway/callback",
            auto_complete: true,
          },
        ];
      }
      throw new Error(`unexpected request path: ${path}`);
    });
    const result = await registerSingleStatusCommand(request);

    expect(result).toHaveLength(1);
    const firstCommand = result[0];
    if (!firstCommand) {
      throw new Error("expected Mattermost slash command result");
    }
    expect(firstCommand.managed).toBe(false);
    expect(firstCommand.id).toBe("cmd-1");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("fetches the authoritative token when a reused command's list entry omits it", async () => {
    const request = vi.fn(async (path: string) => {
      if (path.startsWith("/commands?team_id=")) {
        return [
          {
            id: "cmd-1",
            token: "",
            team_id: "team-1",
            creator_id: "bot-user",
            trigger: "oc_status",
            method: "P",
            url: "http://gateway/callback",
            auto_complete: true,
          },
        ];
      }
      if (path === "/commands/cmd-1") {
        return {
          id: "cmd-1",
          token: "tok-authoritative",
          team_id: "team-1",
          creator_id: "bot-user",
          trigger: "oc_status",
          method: "P",
          url: "http://gateway/callback",
          auto_complete: true,
        };
      }
      throw new Error(`unexpected request path: ${path}`);
    });
    const result = await registerSingleStatusCommand(request);

    expect(result).toEqual([
      {
        id: "cmd-1",
        trigger: "oc_status",
        teamId: "team-1",
        token: "tok-authoritative",
        url: "http://gateway/callback",
        managed: false,
      },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("fails registration when the authoritative token lookup fails", async () => {
    const request = vi.fn(async (path: string) => {
      if (path.startsWith("/commands?team_id=")) {
        return [
          {
            id: "cmd-1",
            token: "",
            team_id: "team-1",
            creator_id: "bot-user",
            trigger: "oc_status",
            method: "P",
            url: "http://gateway/callback",
            auto_complete: true,
          },
        ];
      }
      if (path === "/commands/cmd-1") {
        throw new Error("boom");
      }
      throw new Error(`unexpected request path: ${path}`);
    });
    await expect(registerSingleStatusCommand(request)).rejects.toThrow(
      "failed to fetch authoritative token for reused command /oc_status",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("truncates command descriptions to Mattermost's UTF-8 byte limit", async () => {
    const description = `${"x".repeat(127)}😀 trailing`;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/commands?team_id=")) {
        return [];
      }
      if (path === "/commands" && init?.method === "POST") {
        const body = JSON.parse(typeof init.body === "string" ? init.body : "{}");
        expect(body.description).toBe("x".repeat(127));
        expect(body.auto_complete_desc).toBe("x".repeat(127));
        expect(Buffer.byteLength(body.description, "utf8")).toBeLessThanOrEqual(128);
        return {
          id: "cmd-1",
          token: "tok-1",
          team_id: "team-1",
          creator_id: "bot-user",
          trigger: "oc_status",
          method: MATTERMOST_SLASH_POST_METHOD,
          url: "http://gateway/callback",
          auto_complete: true,
        };
      }
      throw new Error(`unexpected request path: ${path}`);
    });

    const result = await registerSingleStatusCommand(request, description);

    expect(result).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("skips foreign command trigger collisions instead of mutating non-owned commands", async () => {
    const request = vi.fn(async (path: string, init?: { method?: string }) => {
      if (path.startsWith("/commands?team_id=")) {
        return [
          {
            id: "cmd-foreign-1",
            token: "tok-foreign-1",
            team_id: "team-1",
            creator_id: "another-bot-user",
            trigger: "oc_status",
            method: "P",
            url: "http://foreign/callback",
            auto_complete: true,
          },
        ];
      }
      if (init?.method === "POST" || init?.method === "PUT" || init?.method === "DELETE") {
        throw new Error("should not mutate foreign commands");
      }
      throw new Error(`unexpected request path: ${path}`);
    });
    const result = await registerSingleStatusCommand(request);

    expect(result).toHaveLength(0);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("updates owned commands when callback method drifts from POST", async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/commands?team_id=")) {
        return [
          {
            id: "cmd-1",
            token: "tok-old",
            team_id: "team-1",
            creator_id: "bot-user",
            trigger: "oc_status",
            method: "G",
            url: "http://gateway/callback",
            auto_complete: true,
          },
        ];
      }
      if (path === "/commands/cmd-1" && init?.method === "PUT") {
        expect(JSON.parse(typeof init.body === "string" ? init.body : "{}")).toEqual({
          id: "cmd-1",
          team_id: "team-1",
          trigger: "oc_status",
          method: MATTERMOST_SLASH_POST_METHOD,
          url: "http://gateway/callback",
          description: "status",
          auto_complete: true,
          auto_complete_desc: "status",
          auto_complete_hint: undefined,
        });
        return {
          id: "cmd-1",
          token: "tok-updated",
          team_id: "team-1",
          creator_id: "bot-user",
          trigger: "oc_status",
          method: MATTERMOST_SLASH_POST_METHOD,
          url: "http://gateway/callback",
          auto_complete: true,
        };
      }
      throw new Error(`unexpected request path: ${path}`);
    });
    const result = await registerSingleStatusCommand(request);

    expect(result).toEqual([
      {
        id: "cmd-1",
        trigger: "oc_status",
        teamId: "team-1",
        token: "tok-updated",
        url: "http://gateway/callback",
        managed: false,
      },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("aborts a rate-limited update without deleting or recreating the command", async () => {
    const mutationMethods: string[] = [];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/commands?team_id=")) {
        return [
          {
            id: "cmd-1",
            token: "tok-old",
            team_id: "team-1",
            creator_id: "bot-user",
            trigger: "oc_status",
            method: "G",
            url: "http://gateway/callback",
            auto_complete: true,
          },
        ];
      }
      if (init?.method) {
        mutationMethods.push(init.method);
      }
      if (path === "/commands/cmd-1" && init?.method === "PUT") {
        throw new Error("Mattermost API 429 Too Many Requests");
      }
      throw new Error(`unexpected request path: ${path}`);
    });

    await expect(registerSingleStatusCommand(request)).rejects.toThrow(
      "Mattermost API 429 Too Many Requests",
    );
    expect(mutationMethods).toEqual(["PUT"]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  function buildClient(
    requestImpl: (path: string, init?: RequestInit) => Promise<unknown>,
  ): MattermostClient {
    return {
      baseUrl: "https://chat.example.com",
      apiBaseUrl: "https://chat.example.com/api/v4",
      token: "bot-token",
      request: async <T>(path: string, init?: RequestInit) => (await requestImpl(path, init)) as T,
      fetchImpl: vi.fn<typeof fetch>(),
    };
  }

  it("falls back to the oc_-prefixed trigger when the root trigger is owned by a foreign command", async () => {
    const spec: MattermostCommandSpec = {
      trigger: "model",
      fallbackTrigger: "oc_model",
      originalName: "model",
      description: "View or change the current model",
      autoComplete: true,
    };
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/commands?team_id=")) {
        return [
          {
            id: "cmd-foreign",
            token: "tok-foreign",
            team_id: "team-1",
            creator_id: "another-bot-user",
            trigger: "model",
            method: "P",
            url: "http://foreign/callback",
            auto_complete: true,
          },
        ];
      }
      if (path === "/commands" && init?.method === "POST") {
        const body = JSON.parse(typeof init.body === "string" ? init.body : "{}");
        expect(body.trigger).toBe("oc_model");
        return {
          id: "cmd-fallback",
          token: "tok-fallback",
          team_id: "team-1",
          creator_id: "bot-user",
          trigger: "oc_model",
          method: MATTERMOST_SLASH_POST_METHOD,
          url: "http://gateway/callback",
          auto_complete: true,
        };
      }
      throw new Error(`unexpected request path: ${path}`);
    });

    const result = await registerSlashCommands({
      client: buildClient(request),
      teamId: "team-1",
      creatorUserId: "bot-user",
      callbackUrl: "http://gateway/callback",
      commands: [spec],
    });

    expect(result).toEqual([
      {
        id: "cmd-fallback",
        trigger: "oc_model",
        teamId: "team-1",
        token: "tok-fallback",
        url: "http://gateway/callback",
        managed: true,
      },
    ]);
  });

  it("skips a command entirely when both the root and fallback trigger are foreign-owned", async () => {
    const spec: MattermostCommandSpec = {
      trigger: "model",
      fallbackTrigger: "oc_model",
      originalName: "model",
      description: "View or change the current model",
      autoComplete: true,
    };
    const request = vi.fn(async (path: string, init?: { method?: string }) => {
      if (path.startsWith("/commands?team_id=")) {
        return [
          {
            id: "cmd-foreign-1",
            token: "tok-foreign-1",
            team_id: "team-1",
            creator_id: "another-bot-user",
            trigger: "model",
            method: "P",
            url: "http://foreign/callback",
            auto_complete: true,
          },
          {
            id: "cmd-foreign-2",
            token: "tok-foreign-2",
            team_id: "team-1",
            creator_id: "another-bot-user",
            trigger: "oc_model",
            method: "P",
            url: "http://foreign/callback",
            auto_complete: true,
          },
        ];
      }
      if (init?.method === "POST" || init?.method === "PUT" || init?.method === "DELETE") {
        throw new Error("should not mutate foreign commands");
      }
      throw new Error(`unexpected request path: ${path}`);
    });

    const result = await registerSlashCommands({
      client: buildClient(request),
      teamId: "team-1",
      creatorUserId: "bot-user",
      callbackUrl: "http://gateway/callback",
      commands: [spec],
    });

    expect(result).toHaveLength(0);
  });

  it("removes a stale bot-owned command that is no longer part of the desired trigger set", async () => {
    const spec: MattermostCommandSpec = {
      trigger: "model",
      fallbackTrigger: "oc_model",
      originalName: "model",
      description: "View or change the current model",
      autoComplete: true,
    };
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/commands?team_id=")) {
        return [
          {
            id: "cmd-legacy",
            token: "tok-legacy",
            team_id: "team-1",
            creator_id: "bot-user",
            trigger: "oc_model",
            method: "P",
            url: "http://gateway/callback",
            auto_complete: true,
          },
        ];
      }
      if (path === "/commands" && init?.method === "POST") {
        return {
          id: "cmd-root",
          token: "tok-root",
          team_id: "team-1",
          creator_id: "bot-user",
          trigger: "model",
          method: MATTERMOST_SLASH_POST_METHOD,
          url: "http://gateway/callback",
          auto_complete: true,
        };
      }
      if (path === "/commands/cmd-legacy" && init?.method === "DELETE") {
        return {};
      }
      throw new Error(`unexpected request path: ${path}`);
    });

    const result = await registerSlashCommands({
      client: buildClient(request),
      teamId: "team-1",
      creatorUserId: "bot-user",
      callbackUrl: "http://gateway/callback",
      commands: [spec],
    });

    expect(result).toEqual([
      {
        id: "cmd-root",
        trigger: "model",
        teamId: "team-1",
        token: "tok-root",
        url: "http://gateway/callback",
        managed: true,
      },
    ]);
    expect(request).toHaveBeenCalledWith("/commands/cmd-legacy", { method: "DELETE" });
  });

  it("never deletes owned commands when the desired command list is unexpectedly empty", async () => {
    const request = vi.fn(async (path: string, init?: { method?: string }) => {
      if (path.startsWith("/commands?team_id=")) {
        return [
          {
            id: "cmd-1",
            token: "tok-1",
            team_id: "team-1",
            creator_id: "bot-user",
            trigger: "model",
            method: "P",
            url: "http://gateway/callback",
            auto_complete: true,
          },
        ];
      }
      if (init?.method === "DELETE") {
        throw new Error("should not delete owned commands when the desired set is empty");
      }
      throw new Error(`unexpected request path: ${path}`);
    });

    const result = await registerSlashCommands({
      client: buildClient(request),
      teamId: "team-1",
      creatorUserId: "bot-user",
      callbackUrl: "http://gateway/callback",
      commands: [],
    });

    expect(result).toHaveLength(0);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
