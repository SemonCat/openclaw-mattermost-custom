# Mattermost Server 12.0.0 compatibility

Dated server compatibility record for a separate server release artifact. The
[plugin porting audit](porting-audit-2026.10.5.md) preserves this boundary and
does not revalidate or change the server patch.

Research date: 2026-10-18. This note evaluates the maintained
`mattermost-custom` plugin and the native Mattermost dialog path against the
latest stable Mattermost release available on that date.

## Release identity and verdict

The latest stable release listed on the official Mattermost releases page is
`v12.0.0`, tag `1f5e0e9ba40da7ba0741659346e0a385a623d6a4`. The release page
reports publication at `2026-10-14T10:08:59Z`, while the official v12
changelog calls **October 16, 2026** the release day. These are different
publication/documentation timestamps, not two different server versions.

The plugin can remain on the published OpenClaw SDK contract while the
Mattermost server moves to v12.0.0. The reviewed REST routes and WebSocket
events remain available, and no mandatory endpoint migration is required for
the v12 API changes. Using the increased message length does require a plugin
change: its existing 4,000-unit default and streaming ceiling otherwise keep
replies below the new server capacity. The upgrade still needs a database migration window,
frontend-plugin review, removal of the obsolete 11.11.1 webapp patch, and a
fresh live Mattermost smoke test.

Authoritative sources:

- [Mattermost releases](https://github.com/mattermost/mattermost/releases)
- [Mattermost v12.0.0 release](https://github.com/mattermost/mattermost/releases/tag/v12.0.0)
- [Mattermost v12 changelog](https://docs.mattermost.com/product-overview/mattermost-v12-changelog)
- [Important upgrade notes](https://docs.mattermost.com/administration-guide/upgrade/important-upgrade-notes)

## Optional capability adaptation

The local plugin change adds a shared text-limit policy based on the server's
`X-Version-ID` header from successful REST responses. Mattermost 12 and newer
default to 262,144 UTF-16 code units per post; older or unknown servers retain
16,383. Bot authentication normally observes the version before inbound planning.
The synchronous outbound SDK callback uses the same account/instance policy;
a cold standalone sender stays conservative until it observes a response.
Operator limits remain authoritative when smaller than the server capacity.

Inbound replies, outbound message-tool chunking, streaming previews, native
slash replies, restart recovery and terminal question edits now use this policy.
UTF-16 sizing conservatively counts astral emoji as two units and preserves
surrogate pairs. This removes artificial length splits, while separate activity
blocks and explicitly configured newline chunking retain their existing semantics.
The existing SDK JSON response budget is sufficient for full-size post receipts.

Model-facing channel hints describe the active limit and the implemented buttons,
single-select menus, `ask_user` resolution, protected credential dialogs and
native ordinary choice forms. The plugin bridges canonical multi-select and
multi-question requests into Mattermost 12 dialogs. It preserves Other input,
uses checkbox groups for multi-select, and can combine equal-choice questions
without Other input into a matrix. The new `mattermost_form` tool exposes
explicit checkbox groups and single/multiple-choice matrices, with structured
results returned to the same waiting tool call.

Forms require an explicit user button click to obtain a valid dialog trigger.
Both open and submit recheck current sender/channel access and the original
session. Signed callback state binds the user, account secret, channel, bot post,
question schema and expiry; submission reloads the signed current post control.
The full answer map resolves the original Gateway question without another
agent turn. Gateway question state is transient and does not survive a Gateway
restart. Controller reconstruction alone does not lose a still-pending binding.

The standalone plugin cannot call the official-plugin-only runtime Gateway RPC
surface. Instead it uses the published `GatewayClient` and normal shared auth
over loopback, requesting only `operator.questions`. A read-only scope probe
against the local Gateway reached `question.get` and returned the expected
not-found response for a deliberately nonexistent question ID. No question
was created or resolved by that probe. The manifest now declares the additional
`mattermost_form` tool; its changed capability surface needs explicit review
at deployment.

The server upgrade below did not install this adaptation or restart the
Gateway. The plugin was subsequently installed with explicit user authorization;
the deployment evidence and remaining fresh inbound acceptance are recorded
at the end of this document.

## Upgrade blockers and operational risks

| Area | v12 change | Required handling |
| --- | --- | --- |
| PostgreSQL | Minimum supported PostgreSQL is v15. | The reported PostgreSQL 18 baseline satisfies this requirement; still take the normal backup and rollback precautions. |
| Message columns | `VARCHAR(65535)` becomes `VARCHAR(1048576)`, raising the maximum message length from 16,383 to 262,144 characters. | Schedule the migration as a schema change, not as a no-op application restart. |
| Migration locking | The widening takes a brief `ACCESS EXCLUSIVE` lock on affected tables, including `posts`; active or idle-in-transaction sessions can delay it and block reads/writes. | Drain or inspect long-lived and idle-in-transaction sessions before applying the migration and monitor the lock window. |
| Post search | `idx_posts_message_txt` is dropped before the widened-column migration and rebuilt concurrently by a later migration. | Expect a temporary full-text post-search index gap during the migration sequence. |
| Webapp plugins | React 19 changes the frontend runtime. Unrebuilt webapp plugins may be suppressed or fail at runtime. | Rebuild or remove frontend/webapp plugins before accepting the upgraded webapp. This standalone plugin is server-side and is not affected by that frontend compatibility issue. |
| Removed settings/features | `MoveThreadsEnabled` and `AppsEnabled` are removed or ignored. OpenSearch 1.x, RHEL 7/8, `atmos/camo`, deprecated Slack import endpoints, legacy dialog date fields, and unrelated old APIs/configuration fields are also removed or changed. | Confirm that the deployment does not depend on these features. The custom plugin does not use them. |

The v12 reserved identity-property stripping applies to regular user/PAT
sessions. The plugin's bot-token post properties are not in that affected
surface.

For the current target Docker image, treat the declared healthcheck as a
separate deployment concern: the image is distroless (there is no
`/bin/sh`) and its healthcheck invokes
`/mattermost/bin/mmctl system status --local`. Validate that check against the
persisted `ServiceSettings.EnableLocalMode` value before treating a container
health result as proof of application readiness. This does not change plugin
compatibility or replace the post-upgrade API smoke test.

## Plugin endpoint and event review

The plugin uses the existing Mattermost `/api/v4` REST API and
`/api/v4/websocket` protocol for:

- users, teams, channels, direct channels, posts, thread history, files, and
  typing;
- reactions, pins, commands, post actions, dialogs, and team post search; and
- WebSocket authentication with `authentication_challenge`, plus `posted`,
  `reaction_added`, and `reaction_removed` events.

Mattermost v12 retains the routes and event names/payloads consumed by these
paths. The reviewed v12 WebSocket changes for session invalidation and
`received_group` scoping do not affect the plugin's listeners. No endpoint
removal requires a source change.

## Native secret-dialog redesign

The old custom webapp patch was written against Mattermost 11.11.1. That
version used `RECEIVED_DIALOG_ARGUMENTS` and client-side post/current-channel
lookup. Mattermost v12 replaces that path with an authoritative channel carried
by the signed trigger:

- `OpenDialogRequest` includes `channel_id`.
- The server decodes the signed trigger and overwrites `request.ChannelId`.
- Post-action triggers derive the channel from the source post.
- The v12 webapp stores `open_dialog` before trigger-id gating.
- `dialog_router` passes `data.channel_id` to the dialog adapter.
- The adapter sends that channel on dialog submit and lookup.

Official tests cover both
[`TestOpenDialogPublishesChannel`](https://github.com/mattermost/mattermost/blob/v12.0.0/server/channels/api4/integration_action_test.go)
and
[`TestDoPostActionWithCookieTriggerCarriesPostChannel`](https://github.com/mattermost/mattermost/blob/v12.0.0/server/channels/app/integration_action_test.go).
The corresponding v12 implementation is in
[`integration_action.go` model](https://github.com/mattermost/mattermost/blob/v12.0.0/server/public/model/integration_action.go),
[`integration_action.go`](https://github.com/mattermost/mattermost/blob/v12.0.0/server/channels/app/integration_action.go),
[`dialog_router/index.ts`](https://github.com/mattermost/mattermost/blob/v12.0.0/webapp/channels/src/components/dialog_router/index.ts),
[`websocket_actions.ts`](https://github.com/mattermost/mattermost/blob/v12.0.0/webapp/channels/src/actions/websocket_actions.ts),
and
[`interactive_dialog_adapter.tsx`](https://github.com/mattermost/mattermost/blob/v12.0.0/webapp/channels/src/components/dialog_router/interactive_dialog_adapter.tsx).

**Verdict:** do not carry the 11.11.1 custom client mount/patch into stock
Mattermost 12.0.0. Remove it after the upgrade and verify the native protected
secret dialog live, including submit and lookup in the originating channel.

## Local verification already completed

The standalone plugin baseline checked before the server upgrade:

- `npx vitest run`: 97 files, 1,204 tests passed.
- `npm run build`: passed.

After the local text-limit and model-hint adaptation:

- Focused limit, client, preview, question and context suites passed.
- The additional normal final-delivery, account inheritance and terminal
  question boundary tests passed.
- `npx vitest run`: 99 files, 1,222 tests passed.
- `npm run build`: passed, including the published SDK export gate.
- A self-contained package was built and its runtime files compared byte for
  byte with the verified build. The compiled channel and client entry points
  share one server-version cache. The package has not been installed.

These checks establish source and build compatibility only. They do not prove
the ordering of live Mattermost posts, WebSocket reconnect behavior, or native
dialog behavior in the upgraded server.

After the native form adaptation:

- Focused tests cover schema validation, native matrix wire encoding, Other
  answers, both attachment/Blocks controls, signed callback bindings, current
  authorization, expiry, replay, controller reconstruction, and readback after
  an ambiguous resolution.
- Delivery tests cover the real inbound/outbound send seams, one control on
  the first prompt chunk, terminal control removal, and text fallback.
- Monitor registration tests verify that native forms reach the original
  question resolver without dispatching another inbound turn. Tool tests cover
  trusted routing, structured results, timeout, abort and answer/cancel races.
- `npx vitest run`: 104 files, 1,261 tests passed.
- `npm run build`: passed; 264 named SDK exports across 85 public subpaths.
- The existing standalone TypeScript baseline still has previously documented
  SDK/type errors. The new form, dialog, RPC and monitor code has no reported
  TypeScript errors; the build remains the documented packaging gate.
- The new package's 29 runtime files were compared byte for byte with the
  verified build. The archive contains the declared `mattermost_form` tool and
  the long-message adaptation. Its SHA-256 is
  `a262e1349d4a9eb3ed7058f0fef8f39323e30050d1c1038d6559ff8d50b20db2`.
  It was subsequently installed using this exact archive; see the plugin
  deployment record below. Live dialog acceptance remains pending.

## Required post-upgrade acceptance

After the server upgrade, use a **new inbound Mattermost turn**. A resumed turn
or an earlier receipt is not a fresh acceptance test. If a later plugin change
requires an authorized plugin install and Gateway restart, repeat this check
after that deployment.

Verify:

- a planless reply creates no task card;
- planned and tool turns leave `task_progress` older than `turn_result`;
- both late-plan boundaries preserve the successor result identity for tool and
  final updates, and finalization leaves a truthful terminal card;
- slash commands, reactions, thread routing, and WebSocket reconnect work;
- protected secret dialogs open in the originating channel and resolve the
  intended pending request;
- question/select interactions resolve the original turn;
- native multi-select and multi-question forms preserve Other input, submit the
  full answer map, retire their controls and continue the waiting turn once;
- `mattermost_form` renders checkbox groups and both matrix row-selection modes,
  and its waiting tool receives structured row/column answers;
- a new reply longer than 16,383 units but within the observed 262,144-unit
  limit stays in one result post when it has no separate activity boundary; and
- the upgraded server remains connected after restart, with the custom plugin
  owning `channels.mattermost` and the bundled `mattermost` plugin disabled as
  the competing owner.

## Upgrade verification on 2026-10-18

The deployed Team Edition server was upgraded from 11.11.1 to the official
12.0.0 image, pinned to digest
`sha256:c213d4eb01c2973a3814f57dab4e0629287b92896cb2f98d27134aa62ee5c3cc`.
The PostgreSQL container was not recreated, and no OpenClaw plugin installation
or Gateway restart was needed.

Before cutover, the stopped application had a consistent custom-format
`pg_dump`, validated using `pg_restore --list`. The application/config archive
was parsed, all 11,661 live database attachment paths were covered by the
attachment archive, and backup SHA-256 hashes were recorded. The online
attachment tar reported a changing root directory while the existing health
check created temporary files; archive parsing and full database-reference
coverage were checked separately before proceeding.

Deployment adjustments:

- Removed the 11.11.1 custom client mount so that the server serves the complete
  stock 12.0 frontend and its native dialog-channel fix.
- Removed the obsolete `MoveThreadsEnabled` environment override.
- Retained `EnableLocalMode: false`. A read-only mounted static health probe
  replaces the image's local-socket healthcheck and checks the existing HTTP
  ping endpoint, including database and filestore status. Positive and negative
  probe checks passed.
- The server removed the obsolete `SqlSettings.AtRestEncryptKey` setting, as
  documented for v12. Active database, mail and file-service credentials were
  read back unchanged.

Observed results:

- Docker health is `healthy`; internal and public HTTP health checks return
  HTTP 200 with server, database and filestore status `OK`.
- Schema migration advanced from 213 to 234. The post message column is now
  `VARCHAR(1048576)`, and `idx_posts_message_txt` is valid.
- User, channel, post and file counts matched the stopped pre-upgrade baseline.
- The public login document and its main and remote-entry JavaScript assets
  return HTTP 200 with the expected content types.
- OpenClaw's bot authentication probe succeeds, and its Mattermost WebSocket
  reconnects automatically with no remaining channel error. The first
  post-upgrade observation occurred during the existing reconnect backoff after
  maintenance-time HTTP 502 responses; no reconnect code change was needed.
- The prepackaged AI and Calls plugins updated to 2.9.0 and 1.12.5. Playbooks
  2.12.1 remains unable to activate without a Professional license; the same
  license failure existed before this upgrade. Missing ffmpeg and the refused
  SMTP connection are also confirmed pre-existing conditions.
- Post-settlement server logs show successful REST activity and no new error
  entries in the observation window.

Browser automation was unavailable in this session. The HTTP asset checks do
not prove rendered UI or button/dialog behavior. Fresh inbound task-card
ordering, slash commands, questions and protected secret-dialog interactions
remain live acceptance items; none is claimed as verified by these receipts.

## Plugin deployment on 2026-10-18

The user explicitly authorized installation and deployment of the native-form
and long-message adaptation. The installed archive is
`openclaw-mattermost-custom-2026.10.4.tgz`, SHA-256
`a262e1349d4a9eb3ed7058f0fef8f39323e30050d1c1038d6559ff8d50b20db2`.
All 36 packaged files match the managed install byte for byte, including the
29 runtime files. The prior payload, config and online registry snapshot are
backed up under
`/tmp/openclaw/mattermost-custom-deploy-20261018T211116`.

The supported archive installer persisted the new package and accepted
capability surface. Compared with the prior accepted surface, the only addition
is `mattermost_form` and its corresponding tools contract; the full manifest
also differs only by this declared tool. No config-file value changed. The
installer returned nonzero because admitted plugin work did not drain within
its 60-second hot-reload budget. Readback established that installation was
saved while the previous runtime generation stayed active.

The Gateway was then restarted using
`gateway restart --wait 0 --preserve-definition`. Despite the requested
indefinite wait, the native launchd exit timeout constrained actual draining to
five seconds. Three active runs were interrupted and durably marked for restart
recovery. Their observed recovery state remains pending with no charged attempt;
successful continuation is not claimed. The startup agent database inspection
finished successfully at 21:17:24 Asia/Taipei. The generic migration warning and
archive provenance warning were already present before this deployment.

Verified after restart:

- Gateway PID changed from 45534 to 72975; service and authenticated RPC are up.
- `mattermost-custom` is loaded from its managed `dist/index.js` and registers
  both `mattermost_thread` and `mattermost_form`. The bundled `mattermost`
  plugin remains disabled, and no custom-plugin load diagnostic is reported.
- The default Ruby account is ready, running and WebSocket-connected, with no
  channel error or reconnect attempt. Its authenticated REST probe returns 200.
- A read-only public ping through the installed client reports `OK` and
  hydrates the policy to 262,144 UTF-16 units. The installed channel's model
  hints report that limit and describe native multi-select and matrix forms.
  This probe exercises the installed code in a separate process, rather than
  inspecting the live Gateway's in-memory version cache.
- The installed question RPC helper authenticates over loopback with only
  `operator.questions`. `question.get` returns the expected not-found response
  for a deliberately nonexistent ID; no question is created or resolved.

The operator's `tools.effective` inventory includes `mattermost_thread` but
omits `mattermost_form`: that inventory does not supply a requester sender ID,
which the form factory intentionally requires. Actual model exposure therefore
still needs verification in a fresh trusted inbound turn.

Deployment evidence is stored in the backup directory's `deployment.json`.
The long-message post boundary and actual human button/dialog submission still
require a fresh inbound Mattermost turn. No visible test message was sent on
the user's behalf, and no rendered UI or end-to-end form result is claimed.

## First inbound form failure and correction

The user's first fresh inbound test successfully exposed `mattermost_form` to
the model and produced the native Fill form button. Clicking at 21:29:34 and
21:29:39 Asia/Taipei returned the generic dialog-open error while the question
was still within its 120-second lifetime.

The controller incorrectly expected a REST post read to retain private action
integrations. Mattermost's `Post.StripActionIntegrations` removes legacy
integrations and invokes `StripMmBlocksActionSecrets` for Blocks. The old tests
returned the original outgoing props unchanged, concealing this boundary.
A regression that strips those fields reproduced the exact visible error for
both formats before the fix.

Form posts now carry a public, independently signed binding for the question,
channel and ordinary form schema. Its signing domain differs from the private
callback context, so the public signature cannot authorize an interaction
callback. Opening and submission still require the current bot-authored post,
an actual visible control, the original session, current sender access, matching
schema and a pending unexpired question. Terminal finalization removes the
public binding with the controls. Open failures log only a fixed stage name and
HTTP status, without exception payloads or form answers.

Validation: 104 standalone test files and 1,270 tests pass; the build verifies
264 SDK exports across 85 subpaths. The correction is packaged as
`openclaw-mattermost-custom-2026.10.4.tgz`, SHA-256
`5b2656a6e49f1fa92bfceab8aa6ecea15f8fafbbf6a4a1579f692f1bc9e0ceda`.
All 36 packaged files match the managed install; config and accepted capability
surface are unchanged. The artifact, prior payload and rollout evidence are
under `/tmp/openclaw/mattermost-form-control-fix-20261018`.

Runtime activation completed at 21:44:52 Asia/Taipei using
`plugins reload mattermost-custom --wait`: generation 3 was applied, with no
Gateway restart (PID remains 72975). After activation, the plugin is loaded,
Ruby is ready and connected, and the authenticated REST probe returns 200.
During the cutover, a stale-generation follow-up/heartbeat failed with the
plugin's reloaded/disabled guard and was not replayed; this is retained in the
deployment receipt rather than described as an entirely error-free transition.

The expired first form cannot be reused for acceptance. A newly created form
and human button/dialog submission remain required.

## Mobile choice-field compatibility

The next iPhone test opened the dialog successfully, but both checkbox groups
and matrices appeared as ordinary text inputs with a keyboard. The mobile
renderer is independent of the upgraded server/web client. Reviewed official
mobile v2.44.1 source maps unknown dialog types to `text`; its type mapping
contains neither `checkbox_group` nor `checkbox_matrix`. Its supported
`select` type does carry `multiselect: true` into the selectable component.
Multi-select submission serializes the selected option values with commas.

Primary sources:

- [Mobile v2.44.1 dialog type mapping](https://github.com/mattermost/mattermost-mobile/blob/v2.44.1/app/utils/dialog_utils.ts)
- [Mobile v2.44.1 dialog conversion and serialization](https://github.com/mattermost/mattermost-mobile/blob/v2.44.1/app/utils/dialog_conversion.ts)
- [Mobile v2.44.1 selectable form field](https://github.com/mattermost/mattermost-mobile/blob/v2.44.1/app/screens/apps_form/apps_form_field/apps_form_field.tsx)

Running the plugin's actual form output through that official type mapper
reproduces `["text", "text"]` for a checkbox group plus matrix. The compatible
layout maps the same logical form to selectable fields for the group and each
matrix row. The first two regression tests failed against the old renderer
before the adaptation.
An additional harness runs the official mobile element conversion and
submission serializer together, then passes its actual comma-joined submission
through the plugin parser. All fields retain their multi-select flag and the
original structured choice/matrix answers round-trip successfully.

**Fill form** now defaults to supported select controls on every client:
multi-select menus for multiple choices and one menu per matrix row. **Web form**
keeps the native v12 checkbox/matrix presentation. This explicit choice avoids
inferring the human client's platform from the server-to-server callback.
The mobile-compatible layout uses opaque `vN` option tokens, then validates and
restores the original choice values and matrix row encoding. Original answers
containing commas remain intact. Both layouts resolve the original pending
Gateway question with identical structured tool results.

The dialog layout is bound into signed state. Opening and submission verify the
corresponding current visible control as well as the existing public binding,
bot ownership, access, session, schema and expiry checks. Still-pending native
dialogs opened by the previous release retain their signed-state interpretation.
Regression coverage includes both control formats, single and multiple matrix
rows, optional rows, Other answers, duplicate/unknown/forged tokens, layout
tampering, controller recreation and current-control removal.

The user's installed mobile version is unknown. Source-backed renderer
verification and plugin tests do not replace a new human open/select/submit test
on that device after deployment.

The mobile adaptation passed 104 standalone test files and 1,279 tests, plus
the build gate validating 264 SDK exports across 85 subpaths. The self-contained
archive has SHA-256
`e58c3b4e96c713e44265bd632ba5e4df3124ecc2c83b29e308a19ac93107aa3d`.
All 36 packaged files match the managed install. The config file and accepted
capability surface are unchanged. Backups, the two official-mobile conversion
harness results and the final receipt are under
`/tmp/openclaw/mattermost-mobile-fix-20261018`.

The installer saved the payload but its 60-second replacement drain timed out.
An explicit hot reload continued waiting for the existing long-running work.
At 22:16 Asia/Taipei the user explicitly requested an immediate restart.
`gateway restart --force --preserve-definition --json` succeeded. The native
launchd definition constrained draining to five seconds; one active run was
interrupted and durably marked for restart recovery. Successful continuation of
that run is not claimed by this deployment check.

Gateway PID changed from 72975 to 26278. At 22:18:34 Ruby reconnected to
Mattermost. Subsequent readback verified that the Gateway is reachable, the
custom plugin is loaded from the managed install, both tools are registered,
and bundled Mattermost remains disabled. The Ruby account is ready, running
and connected, with no channel error or reconnect attempts; its authenticated
REST probe returns 200. The mobile fix is now active. A new human form
open/select/submit on the actual phone remains the final UI acceptance step.

## Mobile submission channel recovery, 2026-10-18

The next phone test reached selectable controls but failed on submission.
Live server records at 22:30:52 and 22:31:07 Asia/Taipei show empty-channel
`GetChannel` failures with HTTP 404 before the request reached OpenClaw.
A recent iOS session reports Mobile 2.45.0. Its reviewed submit action
unconditionally replaces `channel_id` with `getCurrentChannelId`, including
an empty result; its dialog adapter ignores the authoritative source channel
that Mattermost 12 publishes. A source-backed reproduction confirms that
selected values validate and serialize correctly while this routing loss
prevents callback delivery. The exact phone field-error sequence remains
unverified independently.

The user authorized slimming and deploying a server compatibility fix. The
deployed fix applies only to `openclaw_question_form_v1`. On dialog open, the
server appends the already signed trigger to the callback URL, which the
legacy mobile client preserves. On submit, the existing Mattermost signature
verifier checks that trigger with a five-minute routing lifetime, and the
authenticated session must match its user. The server restores the trigger's
source channel and then executes its existing channel and team permission
checks. Before forwarding, it removes the extra URL parameter while preserving
the original query bytes. OpenClaw still validates the original signed state,
post, schema, session, current access and shorter question expiry. There is no
new signing format or additional credential.

The production change consists of two call sites and a 59-line URL helper.
The self-contained Linux/amd64 binary was built with Go 1.26.7 and CGO disabled,
then layered onto the exact existing official 12.0.0 image. The frontend,
plugin installation and runtime environment are inherited from that image.
The active image is
`mattermost/mattermost-team-edition:12.0.0-openclaw-mobile-c18b2033`.
Its patch SHA-256 is
`c18b2033ae92f0407d345e11bd17e1e317f12c2cd699bea917068908203aa38d`;
the installed binary SHA-256 is
`f9bc4d8168019b353e60d78301f04a7d77d767e90ad4f17aec68a74c86e7cc66`.

Verification includes the real public-model trigger tests, nine API-handler
cases using the actual model, 39 plugin form/controller regressions, and
13 HTTP checks against the built candidate in an isolated Mattermost instance
with a disposable PostgreSQL database. The latter exercised a real post action,
dialog WebSocket event, empty/wrong-channel submission, exact answer forwarding,
user mismatch, trigger tampering, unrelated legacy dialogs and revoked channel
access. No fixture users or posts were created in production. Disposable
containers, database and credential files were removed afterward.

The final cutover passed at 23:19:34 Asia/Taipei. Production binary readback
matches the tested artifact, container health is healthy, and three public
HTTP/database probes passed. Config semantic diff is empty. Preserve the
separately updated `MaximumPayloadSizeBytes: 2097152` and the pre-existing
`MM_SERVICESETTINGS_ENABLELOCALMODE=true` override; the file's LocalMode value
remains false. PostgreSQL did not restart. Gateway PID 26278 and its config
are unchanged; Ruby is running, connected and ready with REST 200, the custom
plugin loaded, both tools registered and bundled Mattermost disabled.

Two earlier cutovers automatically rolled back because the deployment verifier
first compared environment ordering and then assumed `sha256sum` existed in the
minimal image. The verifier now compares environment key/value pairs and hashes
the binary through host-side `docker cp` streaming. That readback was proven
against an unstarted candidate before the successful cutover. The four startup
error signatures also occur on the original image: Playbooks licensing
(install/activation), optional ffmpeg transcription support, and the existing
SMTP connection test.

The source patch, image context, deployment script, rollback metadata and
receipts are retained in LXC113 under
`/opt/mattermost/releases/mobile-dialog-20261018`; private pre-change backups
are under `/opt/mattermost/backups/mobile-dialog-20261018`. Rollback changes
only the image tag and recreates Mattermost, preserving current config and
database. This server patch is a separate release artifact; it is not part of
the OpenClaw plugin package and must be considered on future server upgrades.
A fresh phone test must open a new **Fill form** dialog: already-open dialogs
do not contain the new signed routing context.
