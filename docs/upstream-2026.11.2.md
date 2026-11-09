# OpenClaw 2026.11.2 Mattermost adaptation

Adaptation date: 2026-11-09. Compare the complete official 11.1 and 11.2
trees at the plugin boundaries, then validate against the exact published
`openclaw@2026.11.2` dependency in this standalone checkout.

## Source identities

| Source | Identity |
| --- | --- |
| Downstream preservation baseline | `a51f3cecb677ae8ab6c044849ead3a41742aae72` |
| Official 11.1 commit | `4ffdd2047d192dd65554de3c8c46c0e0197c6e2a` |
| Official 11.2 tag | Annotated tag `cb19dfeab966999c69dfaf97e21a87570a884da9`, peeled commit `b556fdf457b026574bf0f1e7b4914b15f3f179ce` |
| Published 11.2 npm integrity | `sha512-SgBml4WLp8V1DdAYkrTPLzVdA/iYo3iuHCtm4788GjaG83QZdd1VeOTlue0HBJGdn3SbFE06b6uPs+AM5ShMgg==` |
| Published 11.2 npm SHA-1 | `4185b164092d40a2b49d5630808031a0b28632de` |

The target tag and peeled commit were verified against the official remote.
The baseline was read from immutable Git objects in the canonical core
checkout; the target was read from the official source archive at the pinned
commit. The core checkout and its unrelated local changes were left untouched.
Extracted source is comparison/build evidence, not another Git checkout.
The development SDK is an npm installation, not a linked core tree.

Primary sources:
[official comparison](https://github.com/openclaw/openclaw/compare/v2026.11.1...v2026.11.2),
[Mattermost source](https://github.com/openclaw/openclaw/tree/v2026.11.2/extensions/mattermost),
[public SDK](https://github.com/openclaw/openclaw/tree/v2026.11.2/src/plugin-sdk),
[release notes](https://github.com/openclaw/openclaw/blob/v2026.11.2/CHANGELOG/2026.11.2.md)
and [published package](https://www.npmjs.com/package/openclaw/v/2026.11.2).

Registry metadata, source patches, complete scoped inventories, validation logs
and artifact verification are retained under
`.artifacts/operations/adapt-2026.11.2/`. Release artifacts remain under
`.artifacts/releases/`.

## Comparison and preservation decisions

| Area | Evidence and decision |
| --- | --- |
| Official Mattermost | 149 files in both versions; only `package.json` differs. Advance downstream version contracts without replacing plugin source. |
| Public SDK | 773 files in both versions; only `media-generation-runtime.ts` differs, adding `resolveGeneratedImageDownloadMaxBytes`. This plugin does not consume that media-generation helper. Both installed npm packages expose the same 351 export-map entries and targets. |
| Shared channels | 530 files in both versions; three paths differ. Session-start conflicts now honor both retry-count and minimum-age gates. Both downstream ingress adapters already use the public `createChannelIngressMonitor`; consume the host fix. The remaining change is a Telegram contract-test helper. |
| Outbound | 271 files in both versions; five paths differ. Core resolves the default sender account before durable queue admission so retries keep that identity after configuration changes. This belongs to the host queue and plugin bootstrap; retain downstream delivery receipts, silent previews, attachments and identity handoff. |
| Native footer | All eight files under `src/auto-reply/usage-bar` are unchanged. Rendering remains host-owned. |
| Package contracts | Advance artifact, exact development SDK, peer/minimum host, plugin API and build metadata together to 2026.11.2. Node remains `>=24.16.0 <25 || >=26.1.0`; runtime `zod` remains 4.6.5. |
| Downstream runtime | Preserve every production source file at the downstream baseline, including commands, callbacks, reactions, late-plan post ordering, DM threads, restart recovery and native controls. No Mattermost lifecycle implementation change is needed for 11.2. |
| Post-11.1 fixes | Preserve terminal task-card settlement and stale Stop-control retirement (`a9d51268e1f`), removal of standalone preview Stop buttons (`3867190cd15`), and retirement of transient tool-progress previews (`f7c4c942117`). |
| Companion | Preserve deleted-post preview-cache cleanup (`a51f3cecb67`) and existing companion source/protocol. The host adaptation does not require a new companion artifact. |

The existing regression suites exercise both late-plan boundaries, actual
Mattermost API post order, successor result ownership, terminal task-card state,
preview cleanup, DM routing and durable callback admission. Companion's own
tests cover deleted-post cleanup.

## Maintained core extension

The published 11.2 `questionGatewayRuntime` retains `resolveOption` and
`registerChannelDelivery` but does not expose `resolveSecret`. Native password
dialogs therefore still use the guarded optional resolver supplied by the
maintained core extension documented in the
[10.10 adaptation](upstream-2026.10.10.md).
An injected test resolver does not prove support on an unpatched npm host.
Preserve the unavailable guard and the maintained core extension when preparing
the corresponding 11.2 host.

## PostgreSQL support check

Compared with 11.1, `docs/reference/database-engines.md`, all 44 files under
`src/infra/database-engine`, the database CLI registration and database-port
Doctor command are unchanged. PostgreSQL remains experimental, and Workboard
is the only supported store. Agent/session data, transcripts and shared state
remain on SQLite. Generated PostgreSQL DDL does not establish runtime support
or an existing-data migration path for those stores.

The supported existing-data path remains the offline
`openclaw database port --to postgres --dry-run`, followed by
`openclaw database port --to postgres`; reverse port uses `--to sqlite`.
The command requires stopped owners, ports registered existing Workboard stores
and retains exact recovery captures. Changing `database.engine` alone does not
move existing data. Native Windows port remains unsupported.

Mattermost's plugin-owned `ingress.sqlite` and `interactions.sqlite` queues use
`node:sqlite` directly and are outside Workboard porting. This adaptation does
not change engines, migrate data or create state/config backups.

References:
[11.2 database contract](https://github.com/openclaw/openclaw/blob/v2026.11.2/docs/reference/database-engines.md)
and [port worker](https://github.com/openclaw/openclaw/blob/v2026.11.2/src/infra/database-engine/port-command.worker.ts).

## Validation and deployment boundary

The focused gate passes 11 suites / 195 tests. Companion's independent build
and test command passes all 32 tests. The complete standalone
`npx vitest run` gate passes all 119 suites / 1,600 tests against the published
11.2 dependency. Validation uses Node 26.12.1 and npm 12.2.1. A byte comparison
confirms that all 274
tracked files under `src/` and `companion/`, plus the plugin entrypoint,
manifest, setup entry and build/test configuration, match preservation baseline
`a51f3cecb677ae8ab6c044849ead3a41742aae72`.

The isolated candidate is a Git source archive with the adaptation files
overlaid, with its own `npm ci`, cache, temporary directory and OpenClaw
home/state paths. Its production build passes: 12 runtime entries across 28
emitted JavaScript files, with 270 named SDK exports verified across 85 public
subpaths against the real published 11.2 dependency. Root and isolated lockfiles
match; changed lockfile packages are limited to the root contract, `openclaw`
and its matching `@openclaw/ai`.

The self-contained artifact is
`.artifacts/releases/openclaw-mattermost-custom-2026.11.2.tgz`, SHA-256
`cad69766462285e59cca85ab5c15fa9a31565bda63aaa7fe53988f5bed494947`.
All 35 packed files match the isolated build; package metadata and non-generated
payloads match the working source. The capability manifest is unchanged.
The artifact excludes source tests, development dependencies and companion
sources. Source hashes and the pre-adaptation commit record the correspondence
without claiming that the candidate has already been committed or deployed.

The standalone gate retains the ten existing monorepo-only exclusions and
existing concurrency/timeouts. TypeScript checking remains a separate
diagnostic outside that gate because of the existing published declaration
gaps and non-public session-field usage described in the README.

To switch after service authorization, first prepare a verified 11.2 host with
its maintained extensions, then follow the README's managed-artifact install
procedure using this package. Check active work before restarting and preserve
the single `mattermost-custom` channel owner. Read back the install payload,
record and configuration before accepting installation success or consent.

Installation, plugin-owner changes, Gateway restart, production configuration,
push and outbound Mattermost messages require separate explicit authorization.
The prepared artifact does not establish live 11.2 behavior. After an authorized
host/plugin install and restart, use a fresh inbound turn to verify card/result
post identities and order, terminal card state, preview retirement, native
controls, DM routing and companion deleted-post cleanup.
