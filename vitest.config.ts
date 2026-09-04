import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Test files that import test-only Plugin SDK subpaths the published
// `openclaw` npm package does not ship (channel-test-helpers,
// plugin-test-runtime, test-env, test-state, plugin-state-test-runtime,
// plugin-test-api, channel-contract-testing). Those subpaths exist only in
// the OpenClaw monorepo (resolved via tsconfig paths), so a standalone repo
// cannot import them; these suites are excluded instead of failing at load.
const monorepoOnlySdkTestFiles = [
  "src/channel-actions-setup-status.contract.test.ts",
  "src/channel.send-loopback.test.ts",
  "src/delivery-trace.test.ts",
  "src/mattermost/client.fetch-timeout.test.ts",
  "src/mattermost/monitor-ingress.test.ts",
  "src/mattermost/reply-delivery.test.ts",
  "src/mattermost/send.test.ts",
  "src/mattermost/target-resolution.loopback.test.ts",
  "src/outbound-delivery.test.ts",
  "src/setup.test.ts",
];

export default defineConfig({
  resolve: {
    alias: {
      "openclaw/plugin-sdk/channel-test-helpers": fileURLToPath(
        new URL("./src/test-support/channel-test-helpers.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["*.test.ts", "src/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      ...monorepoOnlySdkTestFiles,
    ],
    environment: "node",
    hookTimeout: 60_000,
    // The published SDK has a large cold import/policy graph. Bound
    // concurrency so integration tests do not exhaust their per-test timeout
    // merely waiting for CPU while preserving the 10s regression limit.
    maxWorkers: 2,
    testTimeout: 10_000,
  },
});
