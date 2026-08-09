// Mattermost plugin module implements setup entry behavior.
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { mattermostSetupPlugin } from "./channel-plugin-api.js";

export default defineSetupPluginEntry(mattermostSetupPlugin);
