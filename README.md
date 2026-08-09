# SemonCat custom Mattermost plugin

This is a maintained downstream Mattermost plugin for OpenClaw. It is a
separate plugin identity from the official bundled `mattermost` plugin:

- Plugin id: `mattermost-custom`
- Package name: `openclaw-mattermost-custom`
- Runtime channel id: `mattermost`
- Preference: `preferOver: ["mattermost"]`

The custom plugin keeps the existing `channels.mattermost` configuration key.
When it is installed and selected, OpenClaw prefers it over the bundled
official plugin and disables the lower-priority owner in the effective runtime
configuration. The two plugins may both be installed and available, but they
must not be enabled as simultaneous Mattermost channel owners.

This package is private and is not published to npm or ClawHub. Build a
self-contained plugin artifact, then install that artifact into OpenClaw's
managed plugin directory:

```bash
mkdir -p /tmp/openclaw/mattermost-custom
npm run build
npm pack --omit=dev --pack-destination /tmp/openclaw/mattermost-custom
openclaw plugins install \
  /tmp/openclaw/mattermost-custom/openclaw-mattermost-custom-2026.7.2.tgz --force
```

Do not use `plugins install --link` or add this source checkout to
`plugins.load.paths` on a live Gateway. A linked full OpenClaw checkout can
resolve Plugin SDK runtime code from the checkout instead of the installed
Gateway version, defeating the plugin boundary and allowing incompatible core
state migrations.

If the bundled plugin is explicitly enabled in the operator config, switch
owners explicitly:

```bash
openclaw plugins disable mattermost
openclaw plugins enable mattermost-custom
```

To return to the official implementation:

```bash
openclaw plugins disable mattermost-custom
openclaw plugins enable mattermost
```

No `channels.mattermost` migration is needed in either direction. Restart the
Gateway after changing plugin enablement.

## Downstream behavior

Compared with the official plugin, this build preserves:

- Dynamic native slash commands from core, skills, and installed plugins.
- Root-first slash-command names with deterministic `oc_` conflict fallbacks.
- Safe Mattermost command reconciliation without mutating foreign commands.
- Thread-aware slash-command callbacks and replies.
- Ack and lifecycle status reactions, including same-session steer correlation.
- The Mattermost slash-trigger length cap fix.

Because this is a private external plugin rather than an OpenClaw-trusted official
installation, inbound WebSocket posts are dispatched directly and are not replayed
from OpenClaw's privileged durable ingress queue after a Gateway restart.

## Package build

The package build bundles plugin-owned TypeScript only. OpenClaw Plugin SDK,
`ws`, and `zod` imports remain external and resolve from the installed host or
the plugin's declared runtime dependencies. This keeps OpenClaw core code and
state migrations out of the plugin artifact.

Build before installing or packing the plugin:

```bash
npm run build
npm pack --omit=dev
```

## Upstream sync

This repository is a standalone plugin repo, not an OpenClaw monorepo fork.
The official bundled Mattermost plugin lives upstream in the OpenClaw
monorepo at `extensions/mattermost`. When syncing Mattermost fixes from
upstream, review the official change first, then apply the equivalent source
changes in this repo's `src/`. Recheck the downstream command, callback,
reaction, and trigger-cap behavior when upstream touches the corresponding
files.

From this standalone checkout, the focused proof is:

```bash
npm run build
vitest run
```

`npm run build` produces the plugin runtime under `dist/` (tsdown bundle with
OpenClaw Plugin SDK, `ws`, and `zod` kept external); `vitest run` covers the
shared Mattermost contract tests and the downstream behavior tests.

### Test status against the published npm SDK

This repo builds and tests against the published `openclaw` npm package
(`>=2026.7.2-beta.7`), not the OpenClaw monorepo checkout. Two categories of
tests behave differently from the monorepo for that reason:

- Thirteen suites import test-only Plugin SDK subpaths (`channel-test-helpers`,
  `plugin-test-runtime`, `test-env`, `test-state`,
  `plugin-state-test-runtime`, `plugin-test-api`, `channel-contract-testing`)
  that the published npm package intentionally does not ship (they exist only
  in the monorepo, resolved via tsconfig paths). They are excluded in
  `vitest.config.ts` and do not run in a standalone checkout.
- Two tests assert monorepo-HEAD SDK behavior that the published npm SDK does
  not have yet: `src/channel.test.ts` expects select command options to render
  as `` `label: \`command\`` `` (upstream `src/interactive/payload.ts`), and
  `src/mattermost/monitor-draft-delivery.test.ts` expects a draft-preview
  supplement retry driven by the SDK finalizable draft lifecycle. Both are
  known red against `2026.7.2-beta.7`; re-check them when a newer `openclaw`
  npm release catches up to the monorepo HEAD behavior.

All other suites run green via `vitest run`.

## Docs

See the OpenClaw docs (`docs/channels/mattermost.md` upstream) for the shared
Mattermost configuration and the official/custom coexistence and rollback
instructions.
