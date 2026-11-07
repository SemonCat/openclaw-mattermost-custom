# OpenClaw 2026.11.1 Mattermost adaptation

Adaptation date: 2026-11-06. Compare the complete official 10.10 and 11.1
trees at the plugin boundaries, then validate against the exact published
`openclaw@2026.11.1` dependency in this standalone checkout.

## Source identities

| Source | Identity |
| --- | --- |
| Official 10.10 tag | Annotated tag `6eef4472c85436c7deb8563248827d7f6d29df67`, peeled commit `7dc3350cb9f08fcf9a0af5c4845a20d5b2f1a8be` |
| Official 11.1 tag | Annotated tag `08d4ded27a1de5af3b60734f7673d4cb594efe78`, peeled commit `4ffdd2047d192dd65554de3c8c46c0e0197c6e2a` |
| Published 11.1 npm integrity | `sha512-2pSbt/taBKM/ofPXsiOEmVefgUdVHYRZOmcWNDyx67WUfeGFXqtfqLvtwYOiH4NcLolDSLMUgsno2oYhTVXptw==` |
| Published 11.1 npm SHA-1 | `f518f4d7aa615e97f5bcc67934a5518567d1b971` |

The target tag and peeled commit were verified against the official remote.
Both source trees were read from immutable Git objects in the canonical core
checkout without changing that checkout. Inventories compare every path in each
scope, including tests. The installed development package is a real npm
installation, with lockfile integrity matching registry metadata.

Primary sources:
[official comparison](https://github.com/openclaw/openclaw/compare/v2026.10.10...v2026.11.1),
[Mattermost source](https://github.com/openclaw/openclaw/tree/v2026.11.1/extensions/mattermost),
[public SDK](https://github.com/openclaw/openclaw/tree/v2026.11.1/src/plugin-sdk),
[release notes](https://github.com/openclaw/openclaw/blob/v2026.11.1/CHANGELOG/2026.11.1.md)
and [published package](https://www.npmjs.com/package/openclaw/v/2026.11.1).

Registry metadata, source patches, inventories and validation logs are retained
locally under `.artifacts/operations/adapt-2026.11.1/`. Release artifacts remain
under `.artifacts/releases/`.

## Comparison and port decisions

| Area | Evidence and decision |
| --- | --- |
| Official Mattermost | 149 files in both versions; two paths differ: package metadata and `secret-contract.ts`. Advance downstream version contracts. The implicit-default secret fix is already present downstream; preserve it without another implementation change. |
| Public SDK | 773 files in both versions; six paths differ. The published SDK export map retains the same 349 entries and targets. Provider/video and memory-indexing additions are unrelated to this channel. Legacy JSON migration gains strict UTF-8 rejection; that implementation remains host-owned. |
| Shared channels | 530 files in both versions; five paths differ. Runtime-recovery retries now track real failures and backoff with the live queue owner. Both downstream ingress monitors already use the public `createChannelIngressMonitor`; consume the host implementation rather than copying it. |
| Outbound | All 271 files are unchanged. Preserve downstream delivery receipts, silent previews, grouped attachments, unknown-send reconciliation, final placement and task-card identity handoff. |
| Native footer | All eight files under `src/auto-reply/usage-bar` are unchanged. Rendering remains host-owned. |
| Plugin background work | Core now gives admitted plugin background work its own read-only worker scope and retains it through cleanup. Gateway reload admission also shares its async carrier. These fixes belong to the host loader and runtime; no new plugin wrapper or capability is needed. |
| Package contracts | Advance artifact, exact development SDK, peer/minimum host, plugin API and build metadata together to 2026.11.1. Node remains `>=24.16.0 <25 || >=26.1.0`; validation uses Node 26.12.1. Runtime `zod` remains 4.6.5. |
| Companion | No companion source, protocol or independent artifact changes are needed for this adaptation. |

The workspace already contained uncommitted DM thread-routing and regression
test changes when this adaptation began. They are preserved and included in the
standalone validation and candidate artifact; they are not an upstream 11.1 port.
The adaptation itself adds no Mattermost lifecycle implementation change.
The subsequent [cross-channel review](cross-channel-2026.11.1.md) inventories
all official channel deltas, records the conditional network-policy candidate,
and verifies why the existing DM changes should be retained for the
post-deployment commit.

## Maintained core extension

The published 11.1 `question-gateway-runtime` still exports `resolveOption` and
`registerChannelDelivery` but does not expose `questionGatewayRuntime.resolveSecret`.
Native password dialogs continue to depend on the maintained core extension
documented in the [10.10 adaptation](upstream-2026.10.10.md). The unavailable
guard remains in place. Passing source tests with an injected resolver does not
prove that an unpatched npm host can resolve native secret dialogs.

## PostgreSQL support check

Compared with 10.10, `docs/reference/database-engines.md`,
`src/infra/database-engine` and the database CLI are unchanged. PostgreSQL
remains experimental, and Workboard is the only supported store. Agent/session
data, transcripts and shared state remain on SQLite. Generated PostgreSQL DDL
does not establish runtime support or a migration path for those stores.

The supported existing-data path is the offline
`openclaw database port --to postgres --dry-run`, followed by
`openclaw database port --to postgres`; a reverse port uses `--to sqlite`.
The command requires stopped owners, ports registered existing Workboard stores,
and retains exact recovery captures. Changing `database.engine` alone does not
move existing data. Native Windows port remains unsupported.

Mattermost's plugin-owned `ingress.sqlite` and `interactions.sqlite` queues use
`node:sqlite` directly and are not part of Workboard porting. This adaptation
does not change engines, run a migration, or create state/config backups.

References:
[11.1 database contract](https://github.com/openclaw/openclaw/blob/v2026.11.1/docs/reference/database-engines.md)
and [Workboard port worker](https://github.com/openclaw/openclaw/blob/v2026.11.1/src/infra/database-engine/port-command.worker.ts).

## Validation and deployment boundary

The focused gate covers package identity/version alignment, existing secret
ownership, ingress lanes and admission, durable interactive callbacks,
task-card plans, streaming and slash-session admission: nine suites and 59 tests
pass against the published 11.1 dependency.

The runtime build produces 12 standalone entries across 28 emitted JavaScript
files and verifies 270 named SDK exports across 85 public subpaths. It does not
bundle OpenClaw core or accept a linked source checkout as its SDK.

The full standalone gate is `npx vitest run`, with the ten existing
monorepo-only exclusions and existing concurrency/timeouts. The self-contained
artifact contains 35 files; its runtime entrypoints match the verified build,
its capability manifest is unchanged, and it excludes source tests, development
dependencies and companion sources. The TypeScript diagnostic remains outside
the passing standalone gate because of existing declaration gaps and non-public
session-field usage.

Installation, owner changes, Gateway restart, production configuration, push
and outbound Mattermost messages require separate explicit authorization.
After an authorized install/restart, verify a fresh inbound turn, task-card/result
post identities and order, terminal card state, native controls, thread routing
and companion previews. Source checks and a resumed turn do not establish live
behavior.
