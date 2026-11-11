# OpenClaw 2026.11.3 Mattermost adaptation

Adaptation date: 2026-11-11. Review the complete official 11.2 and 11.3
source trees at the plugin boundaries, and validate the maintained downstream
against the exact published `openclaw@2026.11.3` dependency.

## Source identities

| Source | Identity |
| --- | --- |
| Downstream preservation baseline | `017c97b5750` (`fix(mattermost): retain earlier pending work on progress cards`) |
| Official 11.2 commit | `b556fdf457b026574bf0f1e7b4914b15f3f179ce` |
| Official 11.3 tag | Annotated tag `6350a4b2df561e442a0b0bc8cfece83778ce3e1d`, peeled commit `847611dcaa3bf0e2783335f961dd1fd0580e4d9f` |
| Published 11.3 npm integrity | `sha512-FBq/q0TCaoA2b7qfdV0q81fHhI6RBB1zAQfJQREc1u2TlK5khVgCUsAlXskLWthyVqRz5PWEj+oOmfYgK58dHg==` |
| Published 11.3 npm SHA-1 | `d7db24ae086448184e328ff69a39cbea3e43d4b6` |

The target tag and peeled commit match the official remote. Comparisons use
immutable Git objects in the canonical core checkout, without changing that
checkout. Development and packaging use the published npm SDK, without a
linked core dependency. The isolated packaging directory is an archive build
intermediate inside this repository, not an additional Git checkout.

Primary sources:
[official comparison](https://github.com/openclaw/openclaw/compare/v2026.11.2...v2026.11.3),
[Mattermost source](https://github.com/openclaw/openclaw/tree/v2026.11.3/extensions/mattermost),
[public SDK](https://github.com/openclaw/openclaw/tree/v2026.11.3/src/plugin-sdk),
[release notes](https://github.com/openclaw/openclaw/blob/v2026.11.3/CHANGELOG/2026.11.3.md)
and [published package](https://www.npmjs.com/package/openclaw/v/2026.11.3).

Scoped source inventories, patches, npm metadata, validation logs, independent
review and package acceptance are retained under
`.artifacts/operations/adapt-2026.11.3/`. `RESULT.md` and
`validation-summary.json` record the final outcome and source/artifact hashes;
release artifacts remain under `.artifacts/releases/`.

## Comparison and preservation decisions

| Area | Evidence and decision |
| --- | --- |
| Official Mattermost | 149 files become 150; package contracts, directory client identity and its new transport regression differ. Port the runtime fix and adapt the real-transport test to standalone Node APIs. |
| Directory identity | Deduplicate by normalized server URL, normalized token and effective private-network opt-in, rather than token alone. Keep explicit account-scoped lookups and the downstream SDK opt-in helper. Identical connections share a lookup; another server or policy retains its own client. |
| Public SDK | 773 files become 774; six paths differ, covering memory-host session access, transcript statistics and provider model token defaults. These require no additional Mattermost source port. |
| Shared channel/outbound | All 530 shared channel files and 271 outbound files are unchanged. Preserve downstream admission, receipts, silent previews, attachments and post ownership. |
| Native footer | All eight files under `src/auto-reply/usage-bar` are unchanged. Rendering stays host-owned. |
| Host child/result behavior | Private child-result filtering, cancelled-child handoffs and visible tool failures are host fixes. Consume the host implementation; retain downstream task-card ownership and continuation guards. |
| Package contracts | Advance artifact, exact development SDK, peer/minimum host, plugin API and build metadata together to 2026.11.3. Node remains `>=24.16.0 <25 || >=26.1.0`; runtime `zod` remains 4.6.5. Lock changes are limited to the root contract, `openclaw` and matching `@openclaw/ai`. |
| Downstream preservation | Retain baseline commands, callbacks, reactions, task cards, late-plan result handoff, DM threads, recovery, controls and companion behavior. In particular preserve unified plan/child cards (`d7af8bbd145`), clean session yields (`1e9bd0b8daa`) and earlier pending-work adoption (`017c97b5750`). |
| Companion | No companion source or protocol change is required. Its artifact remains independently versioned. |

The transport regression uses real loopback HTTP servers and the actual
Mattermost client, account resolution and SSRF guard. It covers both values of
the first account's network opt-in, two servers sharing a token, and a trailing
slash variant that normalizes to the same connection. It checks the exact
server, authorization and path sequence. Existing directory tests retain
account scoping, failed-account handling, channel kinds and peer pagination.

## Maintained core extension

Official 11.3 still omits `questionGatewayRuntime.resolveSecret`. Native
password dialogs retain the guarded optional resolver provided by the
maintained core extension described in the
[10.10 adaptation](upstream-2026.10.10.md). Published-SDK tests with an injected
resolver do not prove that an unpatched npm host supports that extension.
A compatible maintained host must retain it when preparing deployment.

## PostgreSQL support check

Compared with 11.2, `docs/reference/database-engines.md`, all 44 database-engine
files, the database CLI registration and database-port Doctor command are
unchanged. PostgreSQL remains experimental, and Workboard remains the only
supported store. Agent/session data, transcripts and shared state remain on
SQLite; generated PostgreSQL DDL does not establish runtime support or an
existing-data migration path for those stores.

The supported existing-data path remains the offline
`openclaw database port --to postgres --dry-run`, followed by
`openclaw database port --to postgres`; reverse port uses `--to sqlite`.
The command requires stopped owners, ports registered existing Workboard stores
and retains exact recovery captures. Changing `database.engine` alone does not
move existing data. Native Windows port remains unsupported.

Mattermost's plugin-owned `ingress.sqlite` and `interactions.sqlite` queues use
`node:sqlite` directly and remain outside Workboard porting. This adaptation
changes no engines, migrates no data and creates no state/config backups.

References:
[11.3 database contract](https://github.com/openclaw/openclaw/blob/v2026.11.3/docs/reference/database-engines.md)
and [port worker](https://github.com/openclaw/openclaw/blob/v2026.11.3/src/infra/database-engine/port-command.worker.ts).

## Validation and deployment boundary

The standalone acceptance commands are the focused directory/identity tests,
complete `npx vitest run --maxWorkers=1` gate, isolated `npm run build`, and
self-contained `npm pack --omit=dev`. One worker is a command-level resource
limit for this shared host; the existing Vitest exclusions and timeouts are
unchanged. TypeScript remains a separate diagnostic outside the standalone gate
because of the existing published declaration gaps and type errors documented
in the README. No test-only monorepo SDK subpath is introduced.

The production candidate uses an archived baseline plus the exact adaptation
files, independent dependencies, npm cache, temporary directory and OpenClaw
home/state paths. The build verifies emitted SDK subpaths and named imports
against the real published 11.3 SDK. `compiled-sdk-contract.json` records the
actual packed imports for the maintained host's final compiled import probe.
Package acceptance checks the entire file inventory against the isolated
build, source correspondence, dependency contracts and unchanged capability
manifest. It excludes tests, development dependencies and companion source.

To switch after service authorization, prepare a verified maintained 11.3 host,
then follow the README's managed-artifact install procedure with
`.artifacts/releases/openclaw-mattermost-custom-2026.11.3.tgz`. Inspect active
work before restarting, preserve the single `mattermost-custom` owner, and read
back the managed install payload, install record and configuration before
accepting installation success or capability consent.

Installation, plugin-owner changes, Gateway restart, production configuration,
push and outbound Mattermost messages require separate explicit authorization.
A prepared artifact does not prove live 11.3 behavior. After an authorized host
and plugin install/restart, use a fresh inbound turn to verify card/result post
identities and order, terminal/yielded card state, child continuation, preview
retirement, native controls, DM routing and companion cleanup. A resumed turn
is not that fresh inbound proof.
