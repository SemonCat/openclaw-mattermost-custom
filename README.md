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

### Channel default model

Run these commands inside a Mattermost channel:

```text
/channel_model
/channel_model openai/gpt-5.6-terra
/channel_model default
```

The setting is stored in
`channels.modelByChannel.mattermost.<mattermost-channel-id>`. The command
preserves existing channel-header content and manages only its own first line.
After saving the setting, it clears the interactive parent channel session's
model/provider/runtime pin so newly created threads immediately use the new
channel default. Existing threads remain independent and keep their own
session-level `/model` overrides.

This package is private and is not published to npm or ClawHub. Build a
self-contained plugin artifact, then install that artifact into OpenClaw's
managed plugin directory:

```bash
mkdir -p /tmp/openclaw/mattermost-custom
npm run build
npm pack --omit=dev --pack-destination /tmp/openclaw/mattermost-custom
openclaw plugins install \
  /tmp/openclaw/mattermost-custom/openclaw-mattermost-custom-2026.9.1.tgz --force
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
- `/channel_model` for reading, setting, or resetting a channel-scoped default
  model while keeping a managed model label in the Mattermost channel header.
- Root-first slash-command names with deterministic `oc_` conflict fallbacks.
- Safe Mattermost command reconciliation without mutating foreign commands.
- Thread-aware slash-command callbacks and replies.
- Ack and lifecycle status reactions, including same-session steer correlation.
- Unknown-send reconciliation for durable text delivery, using opaque signed
  post metadata rather than matching visible message text.
- Message edit, delete, and pin actions enabled by default, plus reaction reads.
- Owner-only `/move_thread #channel` verified copy-then-delete moves without the
  licensed Mattermost move endpoint.
- Durable plan-backed task progress cards that remain after the final answer.
- The Mattermost slash-trigger length cap fix.

Mutable message-tool actions are enabled by default for this personal downstream
plugin. Each gate can still be disabled globally or per account:

```json
{
  "channels": {
    "mattermost": {
      "actions": {
        "messages": false,
        "reactions": true,
        "edit": true,
        "delete": true,
        "pins": true
      }
    }
  }
}
```

`messages` remains opt-in for channel reads, `reactions` enables add/remove/list,
and the three mutation gates can be overridden per account.

Interactive buttons use native Mattermost Blocks by default. Set
`channels.mattermost.interactions.blocks: false` to force legacy attachments.
An explicit HTTP 400 rejection falls back once to legacy attachments; transport
failures are not retried because the first post may already have been accepted.

### Unlicensed thread moves

Run the following command from the reply box inside the source thread:

```text
/move_thread #target-channel
```

The owner-only command runs directly instead of starting an agent turn, so the
source root can be deleted without also deleting an in-flight streaming/final
reply. It replaces the licensed `POST /posts/{id}/move` endpoint with the same
basic provider sequence Mattermost uses internally: re-upload attachments,
create the destination root and replies in chronological order, then delete the
source root (Mattermost deletes its replies with it).

The downstream implementation adds a stricter commit gate. Every destination
post must be readable with the expected channel, root, text, attachment ids,
and operation marker, and the source thread must still match its original
snapshot. A copy or verification failure keeps the source and removes the
known destination copy. An ambiguous source-delete result is reported as
unknown and keeps the verified destination copy; it is never deleted when that
could cause data loss.

Moves are bounded to 100 posts and 24 attachments, with each attachment using
the configured Mattermost/agent media limit (8 MiB when unset). REST-created
copies are authored by the configured bot because Mattermost overwrites
`user_id` with the authenticated API user. Original author ids, timestamps,
source post ids, and the operation id are retained in the
`openclaw_mattermost_move` post property. Text and uploaded file contents are
preserved; reactions, pins, and arbitrary source post properties are not copied.

When an agent emits a structured plan update, the plugin lazily creates one
Mattermost task card in the same channel or thread and edits that post for the
rest of the turn. Tool/reasoning streaming keeps its existing preview post, and
the final answer keeps its existing delivery path; neither reuses or deletes the
task-card post. Successful runs mark the card completed, while failed or aborted
runs retain a truthful failed or cancelled terminal state. Turns without a plan
do not create an extra post. Card API failures are isolated from final-answer
delivery and use bounded create fallback to avoid duplicate posts.

### Task-card ordering and late-plan handoff

Plan and result callbacks do not always arrive in visual order. Core can enter
result delivery before the ordered plan callback runs, and commentary can create
a visible result post before the first plan update reaches this plugin. The
task-card lifecycle therefore cannot treat "result started" or "result post
exists" as a reason to discard a late plan.

When no result post exists yet, the plan write owns the first Mattermost create
and the result waits behind it. When commentary already created the first result
post, the draft stream performs an identity handoff:

1. Flush the current commentary preview.
2. Copy its visible text into a new `turn_result` post.
3. Convert the older post into `task_progress` and keep editing it as the card.
4. Continue later tool progress and final delivery on the new result identity.

This preserves both content and chronological ordering without deleting or
reposting the durable card. If the copy is not accepted, the original post stays
the editable result identity and card creation fails without disrupting final
delivery. If Mattermost accepts the copy but returns no usable identity, the
stream stops that path rather than retrying and risking duplicate posts.

OpenClaw 2026.9.1 restart-recovery runs also reconnect channel/group session
events to the original Mattermost thread. Recovery keeps the typing indicator
alive and restores tool progress in a temporary preview post; terminal recovery
clears that preview and leaves core's durable final-answer delivery unchanged.
Ordinary (non-recovery) turns continue to use only their existing inbound-turn
callbacks, so they are not double-rendered.

Inbound WebSocket posts are persisted through a plugin-owned SQLite ingress
queue under the OpenClaw state directory before dispatch. The separate spool is
required because beta.2 reserves the host channel-ingress queue for trusted
official plugins. Uncompleted posts can still be reclaimed after a Gateway
restart, and debounce/adoption lifecycle settlement keeps retry and dead-letter
handling bounded. Thread participation remains process-local, so its seven-day
mention-bypass window resets when the Gateway restarts.

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
(`2026.9.1`), not the OpenClaw monorepo checkout. One category of tests
behaves differently from the monorepo for that reason:

- Ten suites import test-only Plugin SDK subpaths (`channel-test-helpers`,
  `plugin-test-runtime`, `test-env`, `test-state`,
  `plugin-state-test-runtime`, `plugin-test-api`, `channel-contract-testing`)
  that the published npm package intentionally does not ship (they exist only
  in the monorepo, resolved via tsconfig paths). They are excluded in
  `vitest.config.ts` and do not run in a standalone checkout.

The Mattermost ack/status integration suite uses a minimal local test-only shim
for its one debounce helper and therefore does run in the standalone checkout.

All included suites run green via `vitest run`.

## Docs

See the OpenClaw docs (`docs/channels/mattermost.md` upstream) for the shared
Mattermost configuration and the official/custom coexistence and rollback
instructions.
