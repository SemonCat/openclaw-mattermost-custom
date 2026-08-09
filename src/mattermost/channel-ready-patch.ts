// Keep the ready-channel status patch ownership inside the plugin so the
// runtime remains compatible with hosts that predate the equivalent public
// SDK helper (`channelReadyPatch` from `openclaw/plugin-sdk/gateway-runtime`).
// `terminalDisconnect: undefined` is a required key, not an absent one: the
// gateway status store merges patches, and this key clears a previously
// retained terminal-auth verdict when the channel reconnects successfully.
export type ReadyChannelStatusPatch = {
  running: true;
  connected: true;
  lifecycle: "ready";
  lastConnectedAt: number;
  lastError: null;
  terminalDisconnect: undefined;
};

export function channelReadyPatch(): ReadyChannelStatusPatch {
  return {
    running: true,
    connected: true,
    lifecycle: "ready",
    lastConnectedAt: Date.now(),
    lastError: null,
    terminalDisconnect: undefined,
  };
}
