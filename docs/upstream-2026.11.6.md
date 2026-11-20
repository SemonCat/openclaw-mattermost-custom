# OpenClaw 2026.11.6 Mattermost adaptation

Adaptation date: 2026-11-20. This is a compatibility update against immutable
official source and the exact published `openclaw@2026.11.6` package.

## Source identities

| Source | Identity |
| --- | --- |
| Downstream preservation baseline | `8e36aeef8fa9148656645cba5173c5c1586045df` |
| Accepted downstream 11.4 runtime | `b96a8eda5f8dd9919d36c1aecb2b7f35c95934dd` |
| Official 11.4 release commit | `d843d6af39a42cd3c30084edbeabeece732fd93a` |
| Official 11.6 annotated tag object | `e780fed30f3a44ce38d61d26bc3cf8acc0b8066d` |
| Official 11.6 release commit | `06afb10d3272cc9deaf38ca6a3b7b839d5935638` |
| Published 11.6 npm SHA-1 | `1399d4ec476c2bb47ceb5e1c70d8aa6c89f22cfc` |
| Published 11.6 npm integrity | `sha512-4MGjAMv8QlVrul3ZbCu8KjM7GhXfLdLzf0IrsO5QZ8LC3oYkduqs2rZiZpPDmTRpT6kXYke/OVaWrB+YmhBHLw==` |

Primary sources: [official release](https://github.com/openclaw/openclaw/releases/tag/v2026.11.6),
[official Mattermost source](https://github.com/openclaw/openclaw/tree/06afb10d3272cc9deaf38ca6a3b7b839d5935638/extensions/mattermost),
[public SDK source](https://github.com/openclaw/openclaw/tree/06afb10d3272cc9deaf38ca6a3b7b839d5935638/src/plugin-sdk),
[published metadata](https://registry.npmjs.org/openclaw/2026.11.6),
and [database engine contract](https://github.com/openclaw/openclaw/blob/06afb10d3272cc9deaf38ca6a3b7b839d5935638/docs/reference/database-engines.md).

The core owner fetched the tag; the plugin owner reads those Git objects without
modifying core. The canonical plugin checkout remains the only plugin writer.
Build and dependency installation use an isolated source archive under
`.artifacts/operations/adapt-2026.11.6/`, with no additional Git checkout.
Canonical dependencies, dist, installed payload and existing releases are retained.

## Port decisions

| Area | Comparison and decision |
| --- | --- |
| Official Mattermost | 150 to 144 files, 98 changed paths including tests and a rename. The production comparison spans 43 paths, with extensive internal consolidation and removal of test injection options. Do not replace downstream owners wholesale. |
| Package contract | Advance artifact, exact SDK, minimum/peer host, plugin API and build versions together to 2026.11.6. Node remains `>=24.16.0 <25 || >=26.1.0`. Follow official Mattermost's `zod` update from 4.6.5 to 4.6.7. |
| Public SDK | 775 to 779 source files; 486 changed paths including tests. Published export map grows from 352 to 363 entries: 13 additions and two removals (`heartbeat-runtime`, `memory-core-host-transcript-stats`). The accepted runtime's 85 SDK subpaths remain mapped; actual packed bindings still require import validation. |
| Removed named exports | Heartbeat exports, token aliases on `reply-chunking`, and transcript replay groups were removed from some facades. The downstream runtime does not import those removed bindings. Preserve its existing public imports and validate emitted names against the installed published package. |
| Progress/native tool events | Native progress save still returns its existing revision/plan receipt. The inspected tool change removes a private injection option; the nested-tool event change is formatting only. Retain successful-save projection, callback continuity, human/new-task/incarnation fences and terminal isolation. |
| Ingress and thread delivery | The downstream already releases deferred ingress lane occupancy and uses the thread session key at shared delivery. Preserve its durable custom spool, heartbeat bridge, thread lanes and reaction ownership. |
| Approval and callbacks | Preserve all seven Async approval imports, account selection, signed bot-owned typed callback send/edit, HTTP/drain authorization, durable replay and native handler precedence. Refactored upstream HTTP helpers do not require replacing these owners. |
| Optional behavior | Upstream bot-loop/`allowBots` policies, preview scheduling/final relocation, directory Unicode matching, binary attachment rejection and pairing presentation changes are separate behavior candidates. They are not silently added to this scoped SDK adaptation. Source comparison alone is not a reproduced downstream regression. |
| Host internals | Shared channel/outbound, transcript, database admission and storage implementations remain host-owned. The core SQLite admission repair is outside this plugin checkout. |
| Dependency lock | Resolve the exact SDK/zod graph without lifecycle scripts. Preserve compatible existing leaf snapshots when their incoming ranges still accept them; retain npm's changed dependency graph and bundle layout. Reproducible isolated `npm ci` is required before accepting the lock. |

The registry and immutable source inventories, full scoped patches, lock
resolution receipts, test/build logs and final SDK contract are retained in the
operation directory. Historical cross-channel research documents remain intact.

The official SDK still requires a separate maintained-host check for the
downstream native password-dialog resolver. Published-SDK tests do not prove that
an unpatched official host implements `questionGatewayRuntime.resolveSecret`.
The pairing probe must inspect the final compiled host and verify the async
invalid-input rejection as well as every actual packed import.

## PostgreSQL support and migration boundary

Compared with 11.4's experimental Workboard-only support, official 11.6 documents
five configurable supported families on qualified PostgreSQL 16–18 runtimes:
shared `state`, `agent`, `workboard`, `logbook`, and `team-reports`. Other admitted
server majors remain experimental. Agent transcripts are plain JSON on
PostgreSQL; transcript text search requires `unaccent`, and memory search has
engine-specific extension and ranking requirements.

Existing eligible stores have an offline bidirectional port path through
`openclaw database port`, including scoped `--family` operation. Changing
`database.engine` alone does not move existing data. Legacy migrations must be
resolved on SQLite first; old shared state must be upgraded with a compatible
binary before porting. Native port, backup, admission and recovery requirements
belong to core. This adaptation executes no database port or migration and
creates no additional backup.

Mixed engine choices are supported for the five families. Daemon runtime pins,
local safety journals and other fixed-local stores do not become PostgreSQL
stores. This plugin's private ingress and interaction queues open `node:sqlite`
directly and remain local SQLite; the host's new family support does not migrate
those plugin-owned spools.

## Validation and deployment boundary

Use isolated dependencies and one worker for focused and full standalone
Vitest gates. Run production build, pack, extracted-artifact import smoke and
fresh independent exact-candidate P2 review sequentially on the coordinated
host lane. The existing ten monorepo-only suite exclusions remain unchanged.
No clean standalone TypeScript check is implied.

`.artifacts/operations/adapt-2026.11.6/RESULT.md` and
`validation-summary.json` record actual candidate, command exits, test identity,
artifact SHA-256, source preservation and host pairing status.
`compiled-sdk-contract.json` is generated from the real tarball, not inferred
from source imports. Releases belong under
`.artifacts/releases/adapt-2026.11.6/`; older artifacts are not overwritten.

No install, Gateway restart, push, live configuration/state change or outbound
message is part of artifact preparation. Fresh inbound Mattermost behavior
remains post-deployment acceptance under separate authorization.
