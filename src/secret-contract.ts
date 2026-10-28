// Mattermost plugin module implements secret contract behavior.
import { hasConfiguredAccountValue } from "openclaw/plugin-sdk/account-helpers";
import {
  collectSimpleChannelFieldAssignments,
  createChannelSecretContract,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const channelSecrets = createChannelSecretContract({
  channelKey: "mattermost",
  account: ["botToken"],
  channel: ["botToken"],
  // Keep secret ownership aligned with the implicit default in accounts.ts.
  hasImplicitDefaultAccount: ({ channel, context }) =>
    Boolean(
      typeof channel.baseUrl === "string" &&
      channel.baseUrl.trim() &&
      (hasConfiguredAccountValue(channel.botToken) || context.env.MATTERMOST_BOT_TOKEN?.trim()),
    ),
  collect(params) {
    collectSimpleChannelFieldAssignments({
      ...params,
      field: "botToken",
      topInactiveReason: "no enabled account inherits this top-level Mattermost botToken.",
      accountInactiveReason: "Mattermost account is disabled.",
    });
  },
});

export const { secretTargetRegistryEntries, collectRuntimeConfigAssignments } = channelSecrets;
