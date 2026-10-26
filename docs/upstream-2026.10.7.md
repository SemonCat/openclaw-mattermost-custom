# OpenClaw 2026.10.7 Mattermost adaptation

Adaptation date: 2026-10-26. Compared the complete official `v2026.10.6`
and `v2026.10.7` tag archives before editing, then installed the exact published
`openclaw@2026.10.7` development SDK. No Mattermost lifecycle implementation
changes are needed.

## Source identities

| Source | Identity |
| --- | --- |
| Official 10.6 tag | Annotated tag `3494baecba2366a89fa703158a2c2b5c9edcd6ba`, peeled commit `fe06181dc5ecc01cf8904abbfc26925925efefbc` |
| Official 10.7 tag | Annotated tag `5c101ce5a0637df375c5f6ae49d44d0d27cc26b1`, peeled commit `157d8c2bc3ea2fa183afdc11088e69690bf8e64e` |
| Official 10.6 archive SHA-256 | `83ce75653d1e3dae4bb6f1b4cb1024a305dd29c8aa673c6bd3c825b3cfa4cd5a` |
| Official 10.7 archive SHA-256 | `9ca3b4bcd31b4d93721b8cf01e4c0cc7745d6025bf0bd1c0f87bca8a199dadb1` |
| Published 10.7 npm integrity | `sha512-iiZO+kFFBgQvxm17wn3Sc/MSC/GQu01PubAFVNA2Nn736HOHUbR0ra7a9NeW9wpjq3kDkSJ1RB7dTP+qVJFXig==` |
| Published 10.7 npm SHA-1 | `7aaaa1b0a91f79ce2f17236b09869c25f579e209` |

The registry records npm publication at `2026-10-24T07:36:46.919Z`; the version
is not an October 7 release date. Archive inventories compare full relative
paths and bytes, including tests, without using a capped compare-API file list.

Primary sources:
[official comparison](https://github.com/openclaw/openclaw/compare/v2026.10.6...v2026.10.7),
[Mattermost](https://github.com/openclaw/openclaw/tree/v2026.10.7/extensions/mattermost),
[SDK](https://github.com/openclaw/openclaw/tree/v2026.10.7/src/plugin-sdk),
[channel layer](https://github.com/openclaw/openclaw/tree/v2026.10.7/src/channels),
[outbound layer](https://github.com/openclaw/openclaw/tree/v2026.10.7/src/infra/outbound),
[session source](https://github.com/openclaw/openclaw/tree/v2026.10.7/src/config/sessions),
[release notes](https://github.com/openclaw/openclaw/blob/v2026.10.7/CHANGELOG/2026.10.7.md),
and [published package](https://www.npmjs.com/package/openclaw/v/2026.10.7).

## Comparison and decisions

| Area | Evidence and decision |
| --- | --- |
| Official Mattermost | Both trees have 145 files; only `package.json` changes version, host peer, plugin API and build metadata. Advance the downstream artifact version, exact development SDK, optional host peer, explicit minimum host, plugin API and build metadata together to 2026.10.7. |
| Public SDK | All 749 source files are byte-identical. All 345 SDK export-map entries and their targets are unchanged. Validate actual emitted named bindings against the exact installed npm dependency rather than inferring runtime compatibility from that comparison alone. |
| Shared channel and outbound layers | All 523 channel files and all 262 outbound files are byte-identical. Preserve existing adapter, ingress, delivery receipt, silent-send and media-group behavior. |
| Session storage | Nine of 1,001 files change. They add recovery safe-tool provenance, skip empty transcript archives while retaining concurrent-append fences, scope SQLite candidate discovery by agent, and strengthen reader/maintenance tests. These changes belong to the host; do not copy storage or migrations into the plugin. |
| Host release behavior | Recovery replay, child-completion context limits, Codex preview refresh, update activation, database continuity and external-plugin loading fixes remain host-owned. This source adaptation does not upgrade the running host. |
| Dependencies | Node remains `>=24.22.1 <25 || >=26.12.1`. npm updates OpenClaw's `@openclaw/ai` to 2026.10.7, `@openclaw/fs-safe` to 0.26.0 and its optional platform packages. Its dependency graph also refreshes `hono` and `ip-address`. All remain development dependencies; the plugin's runtime `zod` dependency is unchanged. |
| Downstream behavior | Preserve commands, callbacks, approvals, protected secret dialogs, choice forms, reactions, thread routing, tool policies, long messages, ordered attachment collections, silent delivery, streaming, restart recovery and task-card continuation. No runtime lifecycle source changes require new lifecycle tests. |
| Known standalone limitations | Keep the ten existing monorepo-only suite exclusions. `tsc --noEmit` remains a diagnostic with preexisting declaration gaps and the documented non-public `SessionEntry.lastRunId` reader; no declaration stubs, casts or host links are added. |
| Documentation | Update current packaging and test contracts to 10.7, including stale 10.5 statements, and retain earlier adaptation documents as historical records. |

## Validation and deployment boundary

Development checks use Node `26.12.1` and npm `11.20.0`. The focused gate covers
version identity, both late-plan lifecycle boundaries, task-card continuation,
source-bound reactions, grouped and silent sends, outbound media adapters and
Gateway question forms. The full standalone gate and build retain their existing
timeouts, concurrency and exclusions.

The self-contained package must retain external SDK imports, unchanged plugin
identity and capability manifest, and include neither OpenClaw core nor installed
development dependencies.

Recorded local checks:

- Focused regressions: 13 files and 210 tests passed.
- Full standalone `npx vitest run`: 111 files and 1,391 tests passed with the
  existing ten monorepo-only suite exclusions unchanged.
- `npm run build`: 12 standalone runtime entries across 28 emitted files;
  264 named SDK exports across 84 subpaths verified against the installed
  `openclaw@2026.10.7`.
- `npm pack --omit=dev --ignore-scripts` after the successful build: 35 files,
  250,957 compressed bytes, 772,940 unpacked bytes. Read back the archive to
  verify entrypoints, version, unchanged capability manifest, external SDK
  imports and absence of source, test files and installed dependencies.
- Artifact SHA-256:
  `231a351c1c7b4ee0014bafdf0545db0708381591ffd083e341fe05801d97a981`.

Source-comparison inventories, registry/archive receipts, test/build logs and
the package artifact are retained outside the repository under
`/tmp/openclaw/mattermost-adapt-2026.10.7/`.

Installation, plugin-owner changes, Gateway restarts and pushes require explicit
authorization under this repository's instructions and are outside this source
adaptation. No live Mattermost post ordering or installed-host compatibility is
claimed from source checks.

After an authorized deployment onto a 10.7 host, verify Gateway health, plugin
load state, Mattermost connectivity, managed payload and config diff. Use fresh
inbound turns to check planless delivery, both late-plan boundaries, task-card
ordering and terminal states, yielded continuations, commands, questions,
reactions, attachment groups and recovery. A resumed pre-restart turn is not
fresh inbound lifecycle evidence.
