# Current Mattermost downstream porting audit

Audit date: 2026-10-22. Supported host: exact published `openclaw@2026.10.5`;
minimum host and plugin API remain `>=2026.10.5`. Baseline:
`777a246460d1a9c9efda745b13ffa9be6c146894`. This document supersedes the current
status and candidate recommendations in the dated reports; their original
comparison evidence, validation receipts and conclusions remain historical.

## Evidence and scope

Reviewed README's full downstream contract, all five 10.1-10.5 upstream
adaptation reports, tracked cross-channel 10.1/10.4 research, the original
checkout's read-only untracked `cross-channel-port-review-2026.10.5.md`, git
history, source adapters/shims and SDK facades. The official source is the
10.5 archive at commit `1b58cb9a1b4f4353e1add63c8506db4d890962e8`, held under
`/tmp/openclaw/mattermost-2026-10-5/openclaw-2026.10.5` (called U below).
The installed SDK is the published package in the original standalone
checkout's shared `node_modules`, used read-only. No dependency is linked to a
core source checkout and no dependency versions change.

The initial complete relative-path comparison covers 244 TypeScript/build
files: 12 identical to official Mattermost, 113 adapted, and 119 downstream-only.
This is a path/content inventory, not a claim that all differences are features.
The SDK consumer map contains 98 distinct source specifiers, including types and
test-only imports; build validation separately verifies emitted runtime imports.
Both machine-readable inventories and the early `INVENTORY.md` are under
`/tmp/openclaw/mattermost-porting-audit-20261022`.

The current core runtime checkout is read-only (observed HEAD
`cf11c433f4859fb36e48e626a3411d248bcc3be1`). Newer main behavior and an upstream
refactor do not establish replacement coverage on this supported 10.5 host.
The original checkout's four dirty lifecycle files, untracked research and
`output/` remain existing read-only work, separate from this candidate.

## Removed: obsolete origin accessory and metadata

10.5's `U/src/plugin-sdk/control-ui-session-link.ts` explicitly deprecates the
header-link helper: the host no longer supplies `props.session`.
`U/ui/src/plugins/control-ui-view.runtime.ts` passes session identity only.
`U/src/config/sessions/store-entry-shape.ts:40` strips `conversationLink` before
storage or projection, and `U/packages/gateway-protocol/src/schema/sessions-row.ts`
has no field for it. The describe handler returns that projection. A search of
10.5 host `src` finds no active `ConversationLink` consumer: remaining lowercase
references reserve/strip the retired field or belong to the deprecated helper.
This establishes that retaining the metadata cannot restore the shortcut.

Removed these proven obsolete pieces:

- `browser/index.ts` and its inert activation regression in `control-ui.test.ts`.
- `openclaw.plugin.json`'s `controlUi.entry` declaration and browser-only probe,
  bundle and self-containment checks in `build-runtime.mjs`.
- `src/mattermost/conversation-link.ts`, including its browser-only persisted
  link validator, URL parser and metadata constructor, and its helper tests.
- `ConversationLink` construction in `monitor-event-plan.ts` and `slash-http.ts`,
  plus `suppressConversationLink` and its link-only author-evidence condition in
  `monitor-interactions.ts`. This condition did not authorize dispatch; callback
  authentication and admission remain unchanged.

The candidate's declared capability surface **shrinks** by removing the Control
UI entry. Plugin identity, channel ownership, tool declarations, host floor,
config and dependency versions are unchanged. No install consent, installation,
live config edit or Gateway restart is performed. Any deployment must review the
manifest difference explicitly; the prior unchanged-capability receipts apply
only to their historical artifacts.

`identity.test.ts` asserts absence of the retired manifest declaration.
`monitor-event-plan.test.ts` retains admitted-context routing coverage for rooms,
default flat DMs and explicitly threaded DMs. Callback and slash regressions
assert native thread/channel identity and absence of retired origin metadata.
Deleted pure link tests exercised only the removed helper; lifecycle, transport,
authorization and unrelated historical suites are retained.

### Live links retained

These have independent consumers and are still useful:

| Contract | Source and consumer |
| --- | --- |
| Search result post permalink | `search.ts` builds `/_redirect/pl/<postId>` in returned tool details. |
| Same-instance source permalink reading | `thread-context.ts:collectMattermostPermalinkReferences` and `permalink-hydration.ts:hydrateMattermostPermalinks` authorize and hydrate referenced posts, including configured subpaths/aliases. |
| Referenced attachment content | `reference-media.ts` downloads authorized native/referenced media via the trusted media saver. |
| Task child work-session links | `task-progress-card.ts` validates `workSessions[].url` and renders `session.url`; it does not use retired origin metadata. |
| Native thread reply routing | `monitor-context.ts`, `monitor-event-plan.ts`, `monitor-interactions.ts`, `slash-http.ts` keep native post/root/session identity. Synthetic interaction/slash IDs remain distinct. |

Restoring a Control UI launch shortcut requires a separately designed durable
origin source. It is a deferred feature, not a cleanup or replacement RPC.

## Retained inventory

"Still unique" means a downstream provider contract remains necessary; a shared
SDK primitive alone does not implement it. "Upstream/shared-SDK owned" means the
host supplies the primitive while the plugin retains the required adapter.

| Port family | Classification | Evidence / retained contract |
| --- | --- | --- |
| v12 limits and model hints | Still unique | `text-limits.ts`, `capabilities.ts`, `channel.ts`, `send.ts`, `draft-stream.ts`: auto 262,144/16,383 limits, smaller overrides and surrogate-safe chunking. Official 10.5 `src/channel.ts` still declares 4,000. |
| Native/mobile forms | Still unique | `form-schema.ts`, `form-tool.ts`, `question-dialog.ts`, `question-rpc.ts`: mobile selects, native checkbox/matrix layout, signed controls, canonical answers and scoped authenticated loopback Gateway access. |
| Dynamic/root-first slash commands | Still unique | `native-commands.ts`, `slash-commands.ts`, `slash-http.ts`: command discovery, foreign-command protection, trigger cap and thread-aware callbacks. |
| Channel model defaults | Still unique | `channel-model-command.ts`, `channel-model-transition.ts`, `model-session-pin.ts`: managed header line, persisted model default, interactive parent pin clearing. |
| Model/runtime confirmation | Still unique | `model-picker.ts`, `monitor-model-picker.ts`: explicit runtime selection, fresh host validation and persisted readback; implemented in `f8ea1526ccb`, superseding the earlier research TODO. |
| Group instructions/skills | Still unique | `group-context.ts`, `config-schema-core.ts`: account/exact-room/wildcard instructions and skill filtering. Skill filters do not implement general tool policy. |
| Native skill invocation adapter | Still unique SDK migration adapter | `native-commands.ts:isMattermostNativeSkillAllowed`: 10.5 `command-auth-native` still exports discovery but not the removed invocation resolver. Keep the local matcher and its alias tests. |
| Reactions and activation | Still unique | `ack-reactions.ts`, `monitor-turn-reactions.ts`, `monitor-reactions.ts`, `monitor-activation.ts`, `monitor-posts.ts`: event-driven status, steer correlation, mention-prefixed commands and configured bot-root thread gating. Preserve the base's reaction restoration. |
| Approval/secret/question controls | Still unique | `approval-*`, `exec-approvals.ts`, `secret-dialog.ts`, `question-finalization.ts`, `interactions.ts`: signed current controls, stable owner identities, canonical resolution, terminal controls and protected secrets. |
| Native presentation controls | Still unique | `normalize.ts`, `button-delivery.ts`, `capabilities.ts`: Blocks version detection, single-select mapping, explicit-400 legacy fallback and no ambiguous replay. |
| Callback admission/replay | Still unique over shared SDK | `interaction-ingress.ts`, `interactions.ts`, `ingress-queue.ts`: durable authenticated callbacks and independent per-post lanes. |
| Durable ingress and backlog debounce | Still unique over shared SDK | `ingress-queue.ts`, `monitor-ingress.ts`, `inbound-buffer.ts`, `monitor-posts.ts`: plugin SQLite custody, release without completion, sender/thread isolation, 12-post/50,000-character bounds, live delay refresh and the SDK five-window deadline. |
| Unknown/partial delivery | Still unique | `client.ts`, `send.ts`, `reply-delivery.ts`, `monitor-draft-delivery.ts`: signed metadata reconciliation, accepted-without-id handling, sender/effect fencing and partial receipts; keep upstream's accumulator refactor out. |
| Durable task lifecycle | Still unique | `task-progress-card.ts`, `draft-stream.ts`, `task-card-continuation.ts`, `monitor-progress-continuation.ts`, `post-identity.ts`: no card without a plan, both late-plan boundaries, older card/successor result identities, yielded parent state, proven child continuations and host-adopted custody. |
| Thread/restart recovery | Still unique | `monitor-thread-backfill.ts`, `restart-recovery-progress.ts`, `thread-participation.ts`: bounded history, preview and task/result recovery, terminal truth and persisted mention participation. |
| Reads/search/media/moves | Still unique | `read.ts`, `search.ts`, `thread-tool.ts`, `thread-context.ts`, `reference-media.ts`, `thread-move-command.ts`: bounded authorized reads, search/default gates, media scopes and verified copy-then-delete moves. |
| Async envelope / 10.5 transport fixes | Upstream/shared-SDK owned adaptation | `monitor-posts.ts:resolveInboundSessionEnvelopeContextAsync`, `reply-delivery.ts`, `client.ts`: await worker envelope reads, preserve outer HTTP status through body failures and enforce effect/ownership boundaries. These are current fixes, not obsolete workarounds. |
| SDK facades and artifact entries | Upstream/shared-SDK owned | Root `runtime-api.ts`, nested `src/runtime-api.ts`, `src/mattermost/runtime-api.ts`, `channel-*-api.ts`, `*-contract-api.ts`, `gateway-auth-api.ts`, `policy-api.ts`, `slash-route-api.ts`: keep lazy/bootstrap seams and externally exposed legacy helpers. The `buildPreparedModelsProviderData` alias remains a valid 10.5 mapping. |
| Doctor/setup/callback paths | Upstream/shared-SDK owned adapters | `doctor-contract.ts`, setup modules, `gateway-auth-bypass.ts`, `callback-host.ts`, `slash-state.ts`: old stored configuration and legacy callback paths still need normalization/discovery; preserve custom default path and account inheritance. |
| Standalone SDK boundary | Still required | `src/test-support/*`, `vitest.config.ts`, `build-runtime.mjs`: keep local test-only shim, ten monorepo-only exclusions, timeouts/concurrency and emitted named SDK export validation. |

No SDK facade was deleted merely because the official plugin narrowed its own
barrels or a symbol has no local consumer: artifact entries and root legacy
exports remain externally exposed. One stale comment in
`src/mattermost/runtime-api.ts` claimed legacy map-helper exports that this
nested facade no longer has; remove that comment only. Remaining oversized-file
TODOs are maintenance work, not expired migration notes. Doctor/config aliases,
legacy Blocks payloads, persisted ingress rows and legacy recovered task-card
recognition retain actual compatibility consumers.

The build guard now resolves the `node_modules` parent before examining the
`openclaw` child, supporting a worktree that borrows an installed dependency
tree. It still requires the child package itself to be a real installed folder,
checks the exact package name/version, checks all exported SDK subpaths, and
loads each emitted named binding. A source-linked `openclaw` child is rejected.

### SDK migration facade check

The complete imported-subpath scan is saved as `sdk-deprecation-audit.json` in
the external receipts. It distinguishes deprecated whole facades from individual
legacy exports inside a current facade.

`doctor-contract.ts` now imports `defineChannelAliasMigration` directly from
`runtime-doctor-migrations`. U `src/plugin-sdk/runtime-doctor.ts:2` labels the
old facade package-only compatibility and explicitly requires current source to
use the migration facade. Both exact installed 10.5 subpaths export the same
function object; a separate binding proof and the doctor normalization tests
cover this one-line migration. No configuration repair behavior is removed.

The broad `media-runtime` and `plugin-runtime` barrels remain active in 10.5,
despite advisory deprecation. They still supply live media roots, media types,
and the hook runner; they are deferred import-narrowing candidates, not no-op
ports. The hook-runner import is in protected `monitor-turn.ts`; no edit is
needed for this cleanup. Deprecated synchronous session-read APIs similarly
require async caller changes and remain separate work. Deprecated individual
exports such as old WhatsApp feedback policy or setup state-migration bridges
are not used merely because their enclosing subpath is imported. Existing
exposed legacy history exports retain their compatibility consumers.

## Deferred candidates and historical-only work

| Candidate / evidence | Current decision |
| --- | --- |
| Silent sends (`send.ts`, `client.ts`) | No per-send option today. A future query parameter must preserve exact post-dispatch recognition, ambiguous-send handling and notification intent. |
| Per-room/per-sender tool policy (`config-schema-core.ts`, `channel.ts`) | SDK scope policy exists, but the schema omits tool fields. Requires real host policy selection/intersection proof; not part of cleanup. |
| Edit/delete event awareness (`monitor-websocket.ts`) | Existing mutable message actions are distinct from inbound event notices. New event routing/deduplication requires separate design. |
| Multiple attachments per post (`channel.ts`, `send.ts`) | Existing ordinary replies can send media separately; a single multi-file post requires bounded upload/partial-failure semantics. |
| Persistent thread/work-session bindings (`monitor-event-plan.ts`, `monitor-context.ts`) | Factory U `src/plugin-sdk/core.ts:724` already defaults `supportsCurrentConversationBinding: true`. Specialized placement, restoration and lifecycle adapters remain a larger candidate. |
| Top-level room history (`monitor-posts.ts`) | Native thread backfill exists; room history is in memory. Additional authoritative history recovery is separate work. |
| Explicit old-file download action (`thread-tool.ts`, `reference-media.ts`) | Automatic referenced media already exists (`093b0ee`, default enabled by `f6e34ef`). An explicit authorized retrieval tool remains deferred. |
| Rich layouts and multi-user polls (`normalize.ts`, `form-tool.ts`) | Existing forms resolve transient requester questions, not durable team voting. Rendering/storage/auth extensions are outside this audit. |
| Child run correlation (`monitor-turn.ts:lastRunId`) | Existing public-session projection limitation remains documented. No cast or protected lifecycle edit is introduced. |
| Upstream reconnect/backfill/setup/model/reaction/draft helper rewrites | Refactors alone do not replace downstream behavior or justify broad source copying. |
| Host session workers, transcript ownership, stop/steer, streaming and recovery fixes | Consume from supported host. Their implementation/deployment belongs to core. |

The dated 10.1-10.5 reports and cross-channel 10.1/10.4 reports are historical
evidence with pointers here. The dated Mattermost 12 compatibility report covers
a separate server/mobile-routing artifact; this audit does not retire or change
that patch. The original untracked 10.5 research remains read-only.

## Verification and limitations

Focused tests cover retired manifest/metadata absence, native routing and the
independent live permalink/child-card consumers. The full standalone test suite
and `npm run build` are required before source freeze. Exact commands, results,
dependency-guard proof, final diff and file hashes are saved outside the checkout
under `/tmp/openclaw/mattermost-porting-audit-20261022`.

Source tests do not establish live behavior. No install, capability consent,
config/owner change, restart, server/core edit, commit or push is performed.
No live Mattermost/UI acceptance is claimed. Parent owns independent closeout
review dispatch/acceptance; this implementation worker does not launch a reviewer.
The known standalone TypeScript diagnostic limits and non-public `lastRunId`
reader remain; build/export success is not a clean TypeScript check.
