# OpenClaw 2026.10.4 Mattermost adaptation

Compared the complete official `v2026.10.3` and `v2026.10.4` tag archives,
published package declarations, SDK export maps, and release notes before
editing. The official Mattermost delta changes package declarations only.
This adaptation introduces no Mattermost lifecycle implementation changes.

## Authoritative sources

| Source | Identity |
| --- | --- |
| Official `v2026.10.3` | Annotated tag `3a8c04b0832eabc4410ba7c7a30c9c27e4b5fc81`, peeled commit `59cb44796b0f1f0daa0e37af8b1495abb45d9bc1` |
| Official `v2026.10.4` | Annotated tag `f823e45687906237b140d64a64b3a6cf26207fc1`, peeled/release commit `383c124cc32ffee3f8e56f549b88da94d269a4af` |
| Official 10.3 archive SHA-256 | `f34a8bda643b4b7b358b9dcbeeeceaa7f749ffb0f49f7273fb8e725a10c8eb34` |
| Official 10.4 archive SHA-256 | `642e606964ba115f35b0a6bcebaab889b49a1e1a28641a2cdbe3cfb81ac3f412` |
| Published 10.4 registry integrity | `sha512-+FH0StZF1tlTazM7JJGY6JePeJmhFNSRByi2Q3jXPRiLO7o4dJh2xa9Vy4Dk8Cd2ic8B7Zkf5NfEaCCWUkgqnQ==` |
| Published 10.4 registry SHA-1 | `ac000cc196b31208b0108c171780a3312ea26e5e` |

GitHub published the stable release on October 16, 2026 at 00:36:19 UTC.
Its release SHA matches the peeled tag, and its npm integrity matches the
registry metadata. Full archive comparisons establish the source inventories
below, without relying on the capped GitHub compare API file list. The local
development SDK is installed from npm, never linked to a core source checkout.

Sources: [official 10.3 Mattermost](https://github.com/openclaw/openclaw/tree/v2026.10.3/extensions/mattermost),
[official 10.4 Mattermost](https://github.com/openclaw/openclaw/tree/v2026.10.4/extensions/mattermost),
[official SDK](https://github.com/openclaw/openclaw/tree/v2026.10.4/src/plugin-sdk),
[shared channels](https://github.com/openclaw/openclaw/tree/v2026.10.4/src/channels),
[published npm SDK](https://www.npmjs.com/package/openclaw/v/2026.10.4),
and [release notes](https://github.com/openclaw/openclaw/releases/tag/v2026.10.4).

## Port, preserve, and defer decisions

| Area | Decision |
| --- | --- |
| Official Mattermost | Both trees contain 150 files; only `package.json` changed. Advance version, host peer floor, plugin API floor, build version, downstream explicit minimum host, and exact development SDK to 2026.10.4. |
| Consumed SDK contracts | All 729 `src/plugin-sdk` files and 537 `src/channels` files are byte-identical. All 344 published SDK export-map entries, including targets, are identical. Validate actual emitted named bindings against the exact installed npm 10.4 package; unchanged contracts do not imply identical bundled host internals. |
| Dependency boundary | OpenClaw remains an exact development dependency and optional host peer. Its required `@openclaw/ai` dependency advances to 2026.10.4; other direct dependencies and Node engine requirements are unchanged. Keep SDK, `ws`, and `zod` external in Node output and bundle the public Control UI SDK into the browser asset. |
| Custom Mattermost behavior | Preserve dynamic/native commands, `/channel_model`, callback admission/replay, approvals, protected secret dialogs, questions/selects, reactions, threads, bounded search, and referenced attachment handling. No official source change requires a local port. |
| Streaming and task lifecycle | Preserve streaming, recovery, planless turns, both late-plan boundaries and identity handoff, accepted-without-id handling, yielded progress, and committed-provenance continuation. Do not duplicate host streaming-performance fixes in the plugin. |
| Agent launch ownership | Core's in-process `agent` dispatch drops inherited transcript writer context as well as caller tool authority (#170077). Consume the fix through the host; no downstream transcript writer or authorization workaround is introduced. |
| Gateway shutdown | Core tracks session lifecycle handler dispatches during shutdown (#170555), and bounds transcript-worker shutdown waits (#170493). Keep the plugin's existing lifecycle callbacks and recovery semantics. |
| Other host fixes | Standalone plugin startup (#171330), sleep/clock ownership recovery (#170790), equivalent session path aliases (#166462), manual compaction (#166163), Control UI reconnect behavior, and updater/Doctor fixes remain host-owned. This source adaptation does not upgrade the live Gateway. |
| Other providers | Slack (435 files) and Discord (744 files) change only package declarations. Telegram (520 files) also changes its ingress worker and test for source/package worker resolution (#154286); that provider-specific worker path is not used by Mattermost. No cross-provider implementation is transplanted. |
| Standalone diagnostics | Preserve ten monorepo-only suite exclusions and the documented TypeScript diagnostic limitations, including the non-public `SessionEntry.lastRunId` reader. No monorepo links, declaration stubs, or unrelated type cleanup are introduced. |
| Model-pin test fixtures | The store-backed model-pin cases now seed their temporary session in `beforeEach`, under the existing 60-second setup budget, and restore state in `afterEach`. Their real SDK pin and persisted-state assertions retain the existing 10-second test budget. Under local load, profiling measured about 6.1 seconds of fixture creation plus 5.8 seconds for the first pin, explaining the original combined-budget timeout. No runtime model-selection behavior changes. |

## Validation and deployment boundary

Run the identity, commands, interactions, recovery, draft-stream, task-card,
and continuation regressions against the exact published dependency, then the
full standalone `npx vitest run` and `npm run build` gates. The build checks all
emitted SDK subpaths and named bindings and verifies the browser entry is
self-contained. Pack and inspect the artifact for runtime entries, browser
asset, unchanged manifest/capabilities, external SDK imports, and absence of
bundled core or development dependencies.

Recorded local checks:

- Focused regressions: 17 files, 367 tests passed.
- Model-pin fixture correction: all 7 tests passed with the unchanged default
  test timeout; the temporary timing probe was removed.
- Full standalone gate: 96 files, 1,178 tests passed via
  `npx vitest run --reporter=verbose`, with the existing timeouts, concurrency,
  and monorepo-only exclusions unchanged.
- Build: 12 runtime entries, 260 named SDK bindings across 85 subpaths verified
  against the installed `openclaw@2026.10.4`; browser output is self-contained.
- Package: 36 files, 231,529 bytes, unchanged manifest/capabilities, external
  Node SDK imports, and no source or installed dependency files.
- Artifact SHA-256:
  `5adcdb27e928909461e06b188f5516fba12763595687c3f7e33f674d218a3a75`.

No new lifecycle regression is needed because no lifecycle implementation
changes. Source tests and artifact checks do not establish live post ordering.
Installation, owner changes, Gateway restart, and push require explicit user
authorization under this repository's instructions and are separate from this
source adaptation.

After an authorized deployment onto the 10.4 host, use **new inbound Mattermost
turns** to check a planless reply creates no task card, and planned/tool turns
leave `task_progress` older than `turn_result`. Exercise both late-plan
boundaries; tool/final updates must retain the successor result identity, and
the card must finish truthfully. Confirm yielded parents stay In progress until
real completion and committed child-settle continuations update the same card.
Check slash commands, approvals, protected secret dialogs, questions, reactions,
thread routing, restart recovery, and the Control UI origin link. Resumed turns
and historical live receipts do not satisfy fresh-inbound 10.4 acceptance.

Comparison receipts and local validation artifacts are retained under
`/tmp/openclaw/mattermost-2026-10-4`.
