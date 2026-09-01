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

## Task progress card invariants

- Treat callback start order, callback completion order, and Mattermost post
  creation order as different things. A structured plan can arrive after core
  entered result delivery or after commentary already created a result post.
- Never suppress a valid late plan merely because result delivery started or a
  result identity already exists.
- Keep the durable task card above the streaming/final result. If commentary
  already owns the first post, flush it, create a successor result post with the
  preserved visible text, then transfer the older post identity to the task
  card. Later tool progress and the final answer must continue on the successor.
- Distinguish an unaccepted copy failure from a provider-accepted delivery that
  lacks a usable post id. On an unaccepted failure, keep the original result
  identity safe to edit. On an accepted-without-id failure, stop that delivery
  path and do not retry into duplicate visible posts.
- Turns without a plan must not create a card. Completed, failed, and cancelled
  turns must leave a truthful terminal card without blocking final delivery.

## Delegated maintenance

When using Herdr for this repository, reuse an existing running session with an
exact matching checkout or focused workspace, and prefer its idle maintenance
agent. Create a workspace in that same session only when reuse is impossible.
Do not create a Ruby-only session for ordinary maintenance, and never stop or
delete a reused user-visible session.

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

For task-card ordering changes, cover both late-plan boundaries:

1. Result delivery started, but no Mattermost result post exists yet.
2. Commentary already created a visible result post before the plan arrived.

Assert the Mattermost API call sequence and identity ownership, not only a
successful `progress_card` callback. A live smoke test must confirm that the
`task_progress` post predates the `turn_result` post, tool/final updates remain
on the result identity, and finalization leaves the card terminal. A turn resumed
after a Gateway restart is not a fresh inbound lifecycle test; use the next new
inbound turn.

Before pushing a non-trivial code change, run autoreview against the exact
commit or branch diff and verify every finding against the real code. If an
accepted finding changes code, rerun the affected tests and autoreview. A clean
review does not replace the live behavior proof above.

## Packaging and deployment

- Build and pack a self-contained artifact; do not use `plugins install --link`
  on a live Gateway.
- Installation, plugin-owner changes, Gateway restarts, and pushes require
  explicit user authorization.
- Treat a nonzero install result as unknown until the managed install tree,
  install record, config diff, and payload are read back. Before accepting a
  capability consent gate, prove that the candidate and currently accepted
  capability surfaces are identical; never accept a changed surface implicitly.
- Before restarting, inspect active sessions and long-running work. Afterward,
  verify the Gateway, plugin load state, Mattermost connectivity, installed
  payload, and config diff.

## Upstream sync

The official implementation lives in the OpenClaw monorepo under
`extensions/mattermost`. Review upstream changes first, then port the equivalent
source changes into this repository instead of copying monorepo-only build or
test infrastructure.
