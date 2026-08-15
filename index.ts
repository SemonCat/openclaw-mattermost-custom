// External Mattermost plugin entrypoint. The package id stays distinct from the
// canonical Mattermost channel id so the host can select exactly one owner.
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { mattermostPlugin } from "./channel-plugin-runtime.js";
import { setMattermostRuntime } from "./runtime-api.js";
import { registerSlashCommandRoute } from "./slash-route-api.js";
import { registerMattermostChannelModelCommand } from "./src/mattermost/channel-model-command.js";
import { registerMattermostThreadTool } from "./src/mattermost/thread-tool.js";

export default defineChannelPluginEntry({
  id: "mattermost-custom",
  name: "Mattermost (SemonCat custom)",
  description:
    "SemonCat downstream Mattermost channel plugin with native commands and lifecycle reactions.",
  plugin: mattermostPlugin,
  setRuntime: setMattermostRuntime,
  registerFull(api) {
    registerMattermostChannelModelCommand(api);
    registerMattermostThreadTool(api);
    // Actual slash-command registration happens after the monitor connects and
    // knows the team id; the route itself can be wired here.
    registerSlashCommandRoute(api);
  },
});
