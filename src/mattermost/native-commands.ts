// Mattermost plugin module dynamically enumerates OpenClaw's native command set for Mattermost.
import {
  listNativeCommandSpecsForConfig,
  listProviderPluginCommandSpecs,
  listSkillCommandsForAgents,
  type CommandArgDefinition,
  type OpenClawConfig,
  type RuntimeEnv,
} from "./runtime-api.js";
import type { MattermostCommandSpec } from "./slash-commands.js";

const MATTERMOST_PROVIDER = "mattermost";
const TRIGGER_FALLBACK_PREFIX = "oc_";
// Mattermost's model.Command trigger length cap (server/public/model/command.go).
const MAX_TRIGGER_LENGTH = 128;

/**
 * Mattermost's own built-in slash command triggers. These are served by the server's internal
 * `commandProviders` registry (and the bundled Calls plugin), so they never show up in
 * `GET /commands` (that endpoint only lists team-registered custom commands) — root-first
 * native command naming must consult this static table directly to avoid the server rejecting
 * the registration outright. Source: mattermost/mattermost server/channels/app/slashcommands/*.go
 * (each file's `Trigger:`/const definition) plus the Calls plugin's reserved `/call` trigger.
 */
export const MATTERMOST_BUILTIN_COMMAND_TRIGGERS: ReadonlySet<string> = new Set([
  "away",
  "call",
  "code",
  "collapse",
  "dnd",
  "echo",
  "exportlink",
  "expand",
  "groupmsg",
  "header",
  "help",
  "invite",
  "invite_people",
  "join",
  "kick",
  "leave",
  "logout",
  "marketplace",
  "me",
  "mobile-logs",
  "msg",
  "mute",
  "offline",
  "online",
  "open",
  "purpose",
  "remove",
  "rename",
  "search",
  "secure-connection",
  "settings",
  "share-channel",
  "shortcuts",
  "shrug",
  "status",
  "test",
]);

/** Mattermost trigger regex is `^[A-Za-z0-9_./-]+$`, and triggers are lowercased server-side. */
export function sanitizeMattermostCommandTrigger(name: string): string {
  const lowered = name.trim().toLowerCase();
  const cleaned = lowered.replace(/[^a-z0-9_./-]+/g, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "cmd").slice(0, MAX_TRIGGER_LENGTH);
}

function buildFallbackTrigger(rootTrigger: string): string {
  const availableRootLength = MAX_TRIGGER_LENGTH - TRIGGER_FALLBACK_PREFIX.length;
  return `${TRIGGER_FALLBACK_PREFIX}${rootTrigger.slice(0, availableRootLength)}`;
}

function formatAutoCompleteHint(args?: CommandArgDefinition[]): string | undefined {
  if (!args?.length) {
    return undefined;
  }
  const rendered = args.map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`)).join(" ");
  return rendered || undefined;
}

function toMattermostCommandSpec(params: {
  name: string;
  description: string;
  autoCompleteHint?: string;
}): MattermostCommandSpec {
  const rootTrigger = sanitizeMattermostCommandTrigger(params.name);
  const fallbackTrigger = buildFallbackTrigger(rootTrigger);
  const trigger = MATTERMOST_BUILTIN_COMMAND_TRIGGERS.has(rootTrigger)
    ? fallbackTrigger
    : rootTrigger;
  return {
    trigger,
    fallbackTrigger,
    originalName: params.name,
    description: params.description,
    autoComplete: true,
    autoCompleteHint: params.autoCompleteHint,
  };
}

/**
 * Dynamically enumerates every config-enabled native OpenClaw command for Mattermost: core and
 * skill commands via the shared native-command registry, plus plugin-contributed commands,
 * deduplicated the same way sibling channels (Discord/Telegram/Slack) already compose their
 * native command sets — a plugin command never overrides a core or skill command with the same
 * name. Root-first naming and the deterministic `oc_` fallback are resolved per spec; per-team,
 * per-foreign-collision fallback selection happens later in `registerSlashCommands`.
 */
export function buildMattermostNativeCommandSpecs(params: {
  cfg: OpenClawConfig;
  nativeSkills: boolean;
  runtime: RuntimeEnv;
}): MattermostCommandSpec[] {
  const skillCommands = params.nativeSkills
    ? (() => {
        try {
          return listSkillCommandsForAgents({ cfg: params.cfg });
        } catch (err) {
          params.runtime.error?.(`mattermost: failed to list skill commands: ${String(err)}`);
          return undefined;
        }
      })()
    : undefined;

  const coreAndSkillSpecs = listNativeCommandSpecsForConfig(params.cfg, {
    skillCommands,
    provider: MATTERMOST_PROVIDER,
  });

  const seenNames = new Set<string>();
  const specs: MattermostCommandSpec[] = [];
  for (const spec of coreAndSkillSpecs) {
    const name = spec.name.trim();
    if (!name || seenNames.has(name)) {
      continue;
    }
    seenNames.add(name);
    specs.push(
      toMattermostCommandSpec({
        name,
        description: spec.description,
        autoCompleteHint: formatAutoCompleteHint(spec.args),
      }),
    );
  }

  for (const pluginSpec of listProviderPluginCommandSpecs(MATTERMOST_PROVIDER)) {
    const name = pluginSpec.name.trim();
    if (!name) {
      continue;
    }
    if (seenNames.has(name)) {
      params.runtime.log?.(
        `mattermost: plugin command /${name} collides with a core or skill command; keeping the built-in`,
      );
      continue;
    }
    seenNames.add(name);
    specs.push(toMattermostCommandSpec({ name, description: pluginSpec.description }));
  }

  return specs;
}
