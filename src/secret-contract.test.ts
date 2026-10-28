import type { ResolverContext } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { describe, expect, it } from "vitest";
import { collectRuntimeConfigAssignments } from "./secret-contract.js";

const rootToken = { source: "env", provider: "default", id: "ROOT_BOT_TOKEN" } as const;
const namedToken = { source: "env", provider: "default", id: "NAMED_BOT_TOKEN" } as const;

function collect(config: ResolverContext["sourceConfig"]) {
  const sourceConfig = structuredClone(config);
  const context: ResolverContext = {
    sourceConfig,
    env: {},
    cache: {},
    warnings: [],
    warningKeys: new Set(),
    assignments: [],
  };
  collectRuntimeConfigAssignments({ config: sourceConfig, context });
  return context;
}

describe("Mattermost secret account ownership", () => {
  it("retains the implicit default account's root SecretRef after adding a named account", () => {
    const context = collect({
      channels: {
        mattermost: {
          baseUrl: "https://mattermost.example",
          botToken: rootToken,
          accounts: {
            named: { baseUrl: "https://named.example", botToken: namedToken },
          },
        },
      },
    });

    expect(context.assignments).toEqual([
      expect.objectContaining({
        path: "channels.mattermost.botToken",
        ownerId: "mattermost:default",
        ref: rootToken,
      }),
      expect.objectContaining({
        path: "channels.mattermost.accounts.named.botToken",
        ownerId: "mattermost:named",
        ref: namedToken,
      }),
    ]);
    expect(context.warnings).toEqual([]);

    context.assignments[0]!.apply("resolved-root-token");
    context.assignments[1]!.apply("resolved-named-token");
    expect(context.sourceConfig.channels?.mattermost?.botToken).toBe("resolved-root-token");
    expect(context.sourceConfig.channels?.mattermost?.accounts?.named?.botToken).toBe(
      "resolved-named-token",
    );
  });

  it("keeps root-only SecretRefs owned by the default account", () => {
    const context = collect({
      channels: { mattermost: { baseUrl: "https://mattermost.example", botToken: rootToken } },
    });
    expect(context.assignments).toEqual([
      expect.objectContaining({ path: "channels.mattermost.botToken", ownerId: "mattermost:default" }),
    ]);
    expect(context.warnings).toEqual([]);
  });

  it.each([true, false])(
    "does not synthesize a second default when the explicit default is enabled=%s",
    (enabled) => {
      const context = collect({
        channels: {
          mattermost: {
            baseUrl: "https://mattermost.example",
            botToken: rootToken,
            accounts: { default: { enabled, botToken: namedToken } },
          },
        },
      });
      expect(context.assignments.map((entry) => entry.path)).toEqual(
        enabled ? ["channels.mattermost.accounts.default.botToken"] : [],
      );
      expect(context.warnings).toContainEqual(
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: "channels.mattermost.botToken",
        }),
      );
    },
  );

  it("does not collect root or named tokens for a disabled channel", () => {
    const context = collect({
      channels: {
        mattermost: {
          enabled: false,
          baseUrl: "https://mattermost.example",
          botToken: rootToken,
          accounts: { named: { botToken: namedToken } },
        },
      },
    });
    expect(context.assignments).toEqual([]);
    expect(context.warnings.map((warning) => warning.path)).toEqual([
      "channels.mattermost.botToken",
      "channels.mattermost.accounts.named.botToken",
    ]);
  });

  it("does not activate a root token without the implicit default's root base URL", () => {
    const context = collect({
      channels: {
        mattermost: {
          botToken: rootToken,
          accounts: { named: { baseUrl: "https://named.example", botToken: namedToken } },
        },
      },
    });
    expect(context.assignments.map((entry) => entry.path)).toEqual([
      "channels.mattermost.accounts.named.botToken",
    ]);
    expect(context.warnings).toContainEqual(
      expect.objectContaining({ path: "channels.mattermost.botToken" }),
    );
  });

  it("retains root-token inheritance for an enabled named account", () => {
    const context = collect({
      channels: {
        mattermost: {
          botToken: rootToken,
          accounts: { named: { baseUrl: "https://named.example" } },
        },
      },
    });
    expect(context.assignments).toEqual([
      expect.objectContaining({ path: "channels.mattermost.botToken", ownerId: "mattermost:named" }),
    ]);
    expect(context.warnings).toEqual([]);
  });
});
