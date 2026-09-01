# AGENTS.md

This repository is the maintained standalone downstream Mattermost plugin for
OpenClaw. Keep changes scoped to that plugin boundary.

## Repository contract

- Plugin id: `mattermost-custom`
- Package name: `openclaw-mattermost-custom`
- Runtime channel id: `mattermost`
- The custom plugin preserves the existing `channels.mattermost` config key and
  must not run as a simultaneous channel owner with the bundled `mattermost`
  plugin.
- The repository builds against the published OpenClaw SDK. Do not assume that
  test-only monorepo subpaths are available here.

## Working rules

- Read `README.md` before changing packaging, installation, channel ownership,
  restart recovery, task progress cards, or upstream-sync behavior.
- Prefer the smallest fix at the owning Mattermost boundary. Preserve existing
  command, callback, reaction, thread, streaming, and recovery behavior unless
  the task explicitly changes it.
- Keep tests beside the behavior they cover. For lifecycle bugs, add a
  regression test that reproduces the real event and post ordering.
- Do not edit `dist/`, `dist-runtime/`, `node_modules/`, coverage output, or
  packed `.tgz` artifacts. They are generated or installed dependencies.
- Do not add secrets, local agent identity, user-profile, or memory files to the
  repository.
- Preserve unrelated user changes and untracked files.

## Validation

Use the narrowest relevant test first, then run the full standalone gate before
shipping a non-trivial code change:

```bash
npx vitest run path/to/file.test.ts
npx vitest run
npm run build
```

The standalone Vitest configuration intentionally excludes suites that require
test-only OpenClaw monorepo SDK subpaths. Do not bypass that boundary by linking
the live Gateway to a full OpenClaw source checkout.

For user-visible Mattermost lifecycle changes, source tests are necessary but
not sufficient. After an explicitly authorized install and Gateway restart,
verify the behavior with a new inbound Mattermost turn and inspect the resulting
post identities and order.

## Packaging and deployment

- Build and pack a self-contained artifact; do not use `plugins install --link`
  on a live Gateway.
- Installation, plugin-owner changes, Gateway restarts, and pushes require
  explicit user authorization.
- Before restarting, inspect active sessions and long-running work. Afterward,
  verify the Gateway, plugin load state, Mattermost connectivity, installed
  payload, and config diff.

## Upstream sync

The official implementation lives in the OpenClaw monorepo under
`extensions/mattermost`. Review upstream changes first, then port the equivalent
source changes into this repository instead of copying monorepo-only build or
test infrastructure.
