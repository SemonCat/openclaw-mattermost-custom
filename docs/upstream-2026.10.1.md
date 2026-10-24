# OpenClaw 2026.10.1 Mattermost adaptation

Historical release adaptation record. Its source identities, decisions and
validation describe that adaptation. Current retained ports and subsequent
cleanup are tracked in [the porting audit](porting-audit-2026.10.5.md).

Compared the official `v2026.9.8` and `v2026.10.1` tags and validated runtime
imports against the published `openclaw@2026.10.1` npm dependency. This review
covers the standalone Mattermost plugin; it does not install or restart a Gateway.

## Sources

- [Official 10.1 source](https://github.com/openclaw/openclaw/tree/v2026.10.1/extensions/mattermost),
  commit `e178c39e9aae3fa440735217f9aef9574f286677`.
- [Official 9.8 source](https://github.com/openclaw/openclaw/tree/v2026.9.8/extensions/mattermost),
  commit `fc23bc864e4553c2d215e479eeec47b67a0bf943`.
- [10.1 release notes](https://github.com/openclaw/openclaw/blob/v2026.10.1/CHANGELOG.md).
- [Published npm package](https://www.npmjs.com/package/openclaw/v/2026.10.1).

## Adapted and ported

| Area | Result | Owning upstream source |
| --- | --- | --- |
| Published SDK compatibility | Host, plugin API, and development dependency target 2026.10.1; the standalone build validates actual runtime exports against that exact npm dependency. The checkout already contained this version/build adaptation when this task began. | [Official package contract](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/mattermost/package.json) |
| Native skill filtering | Preserve the checkout's replacement for the removed `command-auth` invocation resolver. Discover commands through `command-auth-native`, then match named commands and `/skill` aliases locally. | [Published SDK exports](https://github.com/openclaw/openclaw/blob/v2026.10.1/package.json) |
| Slash callback paths | Port shared path normalization/discovery to registration and the pre-plugin Gateway auth artifact. Keep the downstream public `/mattermost/command` default, legacy Mattermost-only bypass filtering, account overrides, URL path discovery, and deduplication. | [Callback helpers](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/mattermost/src/mattermost/callback-host.ts), [route registration](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/mattermost/src/mattermost/slash-state.ts), [auth artifact](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/mattermost/src/gateway-auth-bypass.ts) |
| Inbound media | Pass ordered facts rather than projecting legacy parallel media fields in the plugin. Preserve failed native attachment slots and append authorized referenced attachments. The SDK finalizer supplies compatibility fields. | [Official inbound posts](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/mattermost/src/mattermost/monitor-posts.ts), [SDK migration policy](https://github.com/openclaw/openclaw/blob/v2026.10.1/docs/plugins/sdk-migration/compatibility-policy.md#media-legacy-projection) |
| Interaction signatures | Remove legacy global/default-secret registration and require `setInteractionSecret(accountId, botToken)`. Preserve upstream's single-secret fallback. Production callers were already account-scoped; regression tests cover account rotation and ambiguous multi-account signing. | [Official interactions](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/mattermost/src/mattermost/interactions.ts) |

10.1's Mattermost source changes are predominantly SDK migration and maintenance.
Its release notes do not announce a new Mattermost feature. Search, native
selects, channel instructions/skill filters, task cards, protected secret dialogs,
and durable callback replay are already implemented in this downstream plugin;
see [the existing behavior documentation](../README.md#downstream-behavior).

## Changes kept in core or deferred

The 10.1 release notes attribute completed-answer preservation, silent-reply
preview suppression, remote worker attachment delivery, and queued cancellation
lifecycle fixes to shared host code. They are candidates for validation on a
10.1 Gateway, rather than implementations to copy into this plugin. See the
[official release notes](https://github.com/openclaw/openclaw/blob/v2026.10.1/CHANGELOG.md).

The official reconnect delay, thread-backfill timeout, WebSocket capture, setup
composition, and helper simplifications do not add a new Mattermost feature.
They were not copied wholesale into the custom streaming/recovery boundaries.
See the official [reconnect](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/mattermost/src/mattermost/reconnect.ts),
[backfill](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/mattermost/src/mattermost/monitor-thread-backfill.ts),
and [draft stream](https://github.com/openclaw/openclaw/blob/v2026.10.1/extensions/mattermost/src/mattermost/draft-stream.ts).

Task-card session reads do not need the async transcript-write migration:
`core.agent.session.getSessionEntry` and `listSessionEntries` remain synchronous
row readers. There is a separate existing issue: the downstream card code reads
`entry.lastRunId`, but the public session projection removes it in both versions.
Correcting child-run correlation requires a follow-up at that owning boundary;
a type cast would not recover the missing runtime value. See the
[10.1 session projection](https://github.com/openclaw/openclaw/blob/v2026.10.1/src/config/sessions/session-entry-projection.ts)
and [9.8 projection](https://github.com/openclaw/openclaw/blob/v2026.9.8/src/config/sessions/session-entry-projection.ts).

## Validation boundary

Run the focused callback, media, interaction, and native-command suites, then
`npx vitest run` and `npm run build`. The build validates named imports and SDK
subpaths against the published dependency; it does not bundle OpenClaw core.
The ten monorepo-only suites remain excluded.

Final local verification on 2026-10-11: `npx vitest run --reporter=verbose`
passed all 91 included files and 1,094 tests. `npm run build` passed and verified
258 named SDK exports across 84 subpaths against `openclaw@2026.10.1`.
`git diff --check` also passed.

Standalone fixture repairs keep cold channel-runtime loading in search, select,
and channel test setup and inject pairing/session-store reads in authorization
and slash-config tests.
This preserves the existing per-test deadline and prevents tests from opening
the operator's default session state.

`npx tsc --noEmit` currently fails: the published SDK lacks declarations for
several runtime subpaths, and existing checkout type errors include the private
session-field reader above. No declaration stubs or monorepo links were added to
mask those errors.

The closeout command `autoreview --mode local --engine codex` passed its
TruffleHog scan but could not produce a review: the reviewer CLI's login returned
HTTP 401 (`refresh_token_invalidated`). No clean autoreview result is claimed.

Runtime behavior on the installed Gateway is not yet proven. Deployment requires
explicit authorization, followed by a new inbound Mattermost turn; a resumed
turn after restart is not sufficient lifecycle evidence.
