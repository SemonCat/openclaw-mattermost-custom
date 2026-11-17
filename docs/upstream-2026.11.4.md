# OpenClaw 2026.11.4 Mattermost adaptation

Adaptation date: 2026-11-17. Compare immutable official 11.3 and 11.4 Git
objects and validate against the exact published `openclaw@2026.11.4` SDK.

## Source identities

| Source | Identity |
| --- | --- |
| Downstream preservation baseline | `8d9596b24a070e6d324e3d9782f7ef99a30ee09f` |
| Official 11.3 commit | `847611dcaa3bf0e2783335f961dd1fd0580e4d9f` |
| Official 11.4 release commit | `d843d6af39a42cd3c30084edbeabeece732fd93a` |
| Published 11.4 npm SHA-1 | `71eeeac4e4b95a0d2bb6c80fb1e0463ac7ec79b9` |
| Published 11.4 npm integrity | `sha512-kSMzBc0fIWrW4DqneFEXL9FRboCZCQV22Edm6iFPqRaBexUeZp9huWNPVWLXmuSAQRezorPfrABkODqq65NOmw==` |

Primary sources: [official release](https://github.com/openclaw/openclaw/releases/tag/v2026.11.4),
[Mattermost comparison](https://github.com/openclaw/openclaw/compare/v2026.11.3...v2026.11.4),
[SDK source](https://github.com/openclaw/openclaw/tree/v2026.11.4/src/plugin-sdk),
and [database contract](https://github.com/openclaw/openclaw/blob/v2026.11.4/docs/reference/database-engines.md).

The core owner fetched the official tag. This plugin work reads its Git objects
without writing the core checkout. Build inputs and dependencies use an isolated
source archive under `.artifacts/operations/adapt-2026.11.4/`, not another Git
checkout. Existing canonical dist, dependencies, installed payload and prior
release artifacts are preserved.

## Port decisions

| Area | Comparison and decision |
| --- | --- |
| Official Mattermost | 150 files in each release. Only `package.json` changes artifact, peer, plugin API and build versions. No runtime source or test port is required. |
| Public SDK source | 774 to 775 files; six changed paths. Additive exec policy export, memory session streaming, canonical transcript replay groups and provider model helper changes remain host-owned. |
| Public package exports | 352 entries in each release, identical mappings. Validate the actual emitted imports and named exports against the published SDK and provide the packed contract for maintained-core probing. |
| Shared channel runtime | 530 to 531 files, ten changed paths. Direct-send custody defers uncertainty notices while the send is active; durable handoff compares admitted configuration; startup waits for database admission. Consume host implementations. |
| Shared outbound runtime | 271 to 272 files, eight changed paths. Failed queued sends hand off uncertainty notice debt by intent; successful source replies mirror delivered payloads without duplicate generic rows. No plugin-owned replacement is needed. |
| Progress and continuation | The seven inspected transcript/nested-tool/progress-tool/continuation owners and eight usage-footer files are unchanged. Preserve all downstream card, yield, final-delivery and footer boundaries. |
| Package contract | Advance artifact, exact development SDK, peer/minimum host, plugin API and build metadata to 2026.11.4. Node remains `>=24.16.0 <25 || >=26.1.0`; runtime `zod` remains 4.6.5. |
| Dependency lock | Follow exact upstream `openclaw`/`@openclaw/ai` 11.4 and `@openclaw/fs-safe` 0.26.7 plus its platform family. Preserve compatible unrelated transitive snapshots rather than accepting incidental registry drift. |
| Downstream preservation | Retain the entire `8d9596b` baseline, including directory connection identity, permalink punctuation bounds, native progress projection after automatic wakes, human/new-task/incarnation fences, commands, forms, reactions, late-plan ordering, recovery and companion behavior. |

Scoped source inventories, patches, lock comparisons, npm metadata, validation
logs, fresh review and source/artifact hashes are retained in the operation
directory. Historical `docs/cross-channel-2026.11.3.md` is unrelated untracked
research and is not part of this candidate.

Official 11.4 still does not expose `questionGatewayRuntime.resolveSecret`.
Native password dialogs continue to require the maintained host extension,
with the plugin's existing guarded optional resolver. Tests against the
published dependency do not establish that an unpatched official host has
that extension. The final maintained host must independently probe that
asynchronous contract.

## PostgreSQL support

PostgreSQL remains experimental. **Workboard is still the only supported
store**; agent/session state, transcripts, shared state and other stores remain
on SQLite. Generated PostgreSQL DDL is not runtime support or an existing-data
migration path for those stores. Mattermost's plugin-owned ingress and
interaction queues also remain SQLite and are outside Workboard porting.

11.4 changes database durability and recovery behavior, not the supported store
set: PostgreSQL writes now inherit the server's `synchronous_commit` setting
instead of forcing `off`. The default `on` provides crash durability; opting
into `off` can lose recently acknowledged writes. Active PostgreSQL connection
environment references, including custom names, are filtered from inherited
host-command/sandbox environments. Resumed ports re-check owner admission after
copy verification and retain a verified target when admission refuses it.
Native field validation also rejects PostgreSQL-incompatible JSON values.

Existing Workboard data still uses the offline
`openclaw database port --to postgres --dry-run` followed by
`openclaw database port --to postgres`, with stopped owners and the command's
required recovery captures. Reverse port uses `--to sqlite`. Changing
`database.engine` alone does not move data. Native Windows port remains
unsupported. CLI registration and Doctor database-port wiring are unchanged
from 11.3. This adaptation performs no engine switch, migration or backup.

## Validation and deployment

Run identity and affected boundary tests first, then the full standalone
Vitest gate with `--maxWorkers=1` against the exact published SDK. Build and
pack sequentially in the isolated archive. Check every packed file against
the build, import the extracted plugin/setup/runtime entries, inventory actual
SDK imports, and obtain a fresh independent review of the exact candidate.
Existing monorepo-only suite exclusions remain intact; no full clean TypeScript
check is claimed.

`RESULT.md` and `validation-summary.json` under the operation directory bind
the final commit, actual tarball/hash, test counts, review, source preservation
and remaining host acceptance. The new release belongs under
`.artifacts/releases/adapt-2026.11.4/`; prior releases remain unchanged.

Installation, Gateway restart, configuration/payload changes, push and outbound
messages require deployment authorization. A prepared artifact does not prove
live 11.4 behavior. Fresh inbound card/result ordering, terminal state, controls
and channel connectivity remain post-deployment acceptance; historical retired
card owners are not reconstructed by this upgrade.
