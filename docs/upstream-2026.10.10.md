# OpenClaw 2026.10.10 Mattermost adaptation

Adaptation date: 2026-11-03. Compare the complete official 10.9 and 10.10
source trees at the plugin boundaries, then validate against the exact published
`openclaw@2026.10.10` dependency in this standalone checkout. This work does not
install either Mattermost artifact or upgrade/restart the running Gateway.

## Source identities

| Source | Identity |
| --- | --- |
| Official 10.9 tag | Annotated tag `88a19e0d8677804d8ec98e30a3a3a3a9308ebee0`, peeled commit `8b18b5578f66eab1501cba4cef2310d88bfb9a41` |
| Official 10.10 tag | Annotated tag `6eef4472c85436c7deb8563248827d7f6d29df67`, peeled commit `7dc3350cb9f08fcf9a0af5c4845a20d5b2f1a8be` |
| Official 10.10 archive SHA-256 | `041a5d6f03b8d3cecb046aad52def05ea2036e0b671ab25350d12a6703ea6cd4` |
| Published 10.10 npm integrity | `sha512-9HZhzq/Yck3uH3M/iYP7szqoF5JXpXfz0+orhBOKalSH+dj0IC9uWPECkR1vH4lMCytxpHjJKHh9efXRYMJl6w==` |
| Published 10.10 npm SHA-1 | `e028be0a237a467d61dc87860d6062720df8160b` |

The 10.9 baseline is the immutable official Git tag in the canonical core
repository, read without modifying that checkout. The 10.10 baseline is the
complete official tag archive. Inventories compare every path and content in
each listed scope, including tests, without a capped compare-API file list.
Registry metadata, tag identities, source patches, inventories and validation
logs are retained locally under `.artifacts/operations/adapt-2026.10.10/`.

Primary sources:
[official comparison](https://github.com/openclaw/openclaw/compare/v2026.10.9...v2026.10.10),
[Mattermost source](https://github.com/openclaw/openclaw/tree/v2026.10.10/extensions/mattermost),
[public SDK](https://github.com/openclaw/openclaw/tree/v2026.10.10/src/plugin-sdk),
[release notes](https://github.com/openclaw/openclaw/blob/v2026.10.10/CHANGELOG/2026.10.10.md)
and [published package](https://www.npmjs.com/package/openclaw/v/2026.10.10).

## Comparison and port decisions

| Area | Evidence and decision |
| --- | --- |
| Official Mattermost | 145 files in 10.9, 149 in 10.10; 58 paths differ. Port the applicable behavior into downstream source, preserving custom channel identity, commands, forms, runtime selection, task cards and companion streaming. Do not copy monorepo build/test infrastructure. |
| Public SDK | 749 files become 773; 230 paths differ. Published SDK export entries increase from 345 to 349: remove `path-existence-runtime`, add `cli-state-owner`, `codex-client-version-runtime`, `database-engine-runtime`, `database-engine-worker-runtime` and `gateway-ingress`. The removed subpath is not imported by this plugin. Validate real emitted bindings against the npm dependency. |
| Shared channels | 523 files become 530; 148 paths differ. Retain host ownership of access decisions, async session storage, policy, delivery and lifecycle authority. The released ingress adapter continues forwarding managed calls to the bound host runtime. |
| Outbound | 262 files become 271; 113 paths differ. Use the host's public delivery/lifecycle contracts. `createLivePreviewLifecycle` itself is unchanged between these tags. Retain downstream readback, accepted-without-ID handling, receipts, silent delivery and grouped attachments. |
| Package contracts | Advance artifact, exact development SDK, peer/minimum host, plugin API and build metadata together to 2026.10.10. Node follows the published host: `>=24.16.0 <25 || >=26.1.0`. Checks run on Node 26.12.1. Runtime `zod` remains 4.6.5. Lockfile changes include the host's refreshed development-only dependency graph. |
| Final placement | Add the official bounded `after` read with `skipFetchThreads=true`. If a newer non-system post follows the preview in its conversation, decline the final edit; the SDK creates a fresh final before deleting the preview. A root preview checks the channel timeline, including replies. Another thread does not move a threaded final. Read failures retain in-place delivery. |
| Preview pacing | `coalesceInFlight: true` and the slow-write throttle regression already exist downstream. Preserve them, companion transport and the late-plan card/result identity handoff. |
| Async model/session reads | Port `getSessionEntryAsync` and `resolveStoredModelOverrideAsync` through model/runtime display, native slash picker and callback reads. Migrate downstream explicit-default model-pin readback too, preserving ambiguous-write verification and runtime confirmation. Include the explicit routed agent ID. |
| Async skill catalog | Await `prepareSkillCommandsForAgents` before slash registration and channel skill-filter checks, including admission retries. Preserve root-first names, collision fallback, canonical skill/alias matching and ordinary command handling. Failed preparation cannot authorize a filtered invocation. |
| Picker transcripts | Record accepted initial slash-picker replies, callback view updates and downstream selection notices with `recordDeliveredCommandExchange`. Keep the routed thread session and captured session incarnation, and record only after provider delivery/update succeeds. Host transcript failures do not authorize a resend. |
| Persistent participation | Open `openKeyedStoreV2`; the existing dedupe cache already awaits register/lookup. Preserve the seven-day TTL, namespace, account/channel/thread isolation and memory fallback. |
| Pairing queue | Use an explicit queue-full notice when slash/model-picker pairing returns no code. Keep the existing inbound post path, which only sends a code when a request was created. |
| Inbound diagnostics | Port the removal of message preview prose from verbose logs; keep sender route, post ID and length. |
| Button prompt contract | Set `customInlineButtonHint` and advertise the supported value-based presentation example. This suppresses the host's generic typed-callback example, which the Mattermost renderer degrades to plain text. Keep downstream question, form and secret-entry guidance. Test the advertised JSON through the message action. |
| Secret contract | Retain the custom 10.8 implicit-default predicate. The new generic `account-inheritance` helper would remove the explicit root-credential/default-account ownership rule. Existing SecretRef ownership regressions remain authoritative. |
| Recovery guards | Port async reads without upstream's removal of downstream session rotation, cancellation, deadline, authorization and bounded page checks. Retain existing cache and WebSocket ownership guards instead of copying simplifications. |
| Optional refactors | Do not copy interaction-dispatch extraction, slash response/body helper reshaping, setup callback shortening, cache timestamp simplification or UI wording-only changes. Optional ingress context/thread parameters have no new supplied caller data in this port. |
| Native footer | Eight files remain; three differ, including million-token formatting in `translator.ts`. Rendering remains host-owned. Do not introduce a plugin footer formatter or change live template configuration. |
| Core maintenance | Database/PostgreSQL lifecycle, backup/redaction, updater, runtime/protocol, streaming parser, subagent continuation/recovery, terminal escaping and service fixes belong to core. New SDK exports do not justify copying core or granting new plugin capabilities. |
| Companion | The independent server/web artifact has no source or protocol changes for this adaptation and remains outside the root npm artifact. |

The newer-post check is bounded to 200 returned posts. A very busy channel can
hide a same-thread post beyond that page, and another post can arrive between
the read and final edit. This matches the official best-effort placement
contract; it is not a transactional timeline lock.

## Maintained core extension

Importing the exact published 10.10 `question-gateway-runtime` confirms that
`resolveOption` and `registerChannelDelivery` exist, while
`questionGatewayRuntime.resolveSecret` is absent. The existing native password
dialog depends on that maintained core extension and retains its unavailable
guard. Source tests inject the resolver; a passing standalone gate does not
prove that an unpatched npm host can resolve native secret dialogs.

The core adaptation owner is porting that extension independently. Its exact
expected contract and verification boundary are handed off through
`.artifacts/operations/adapt-2026.10.10/CORE-HANDOFF.md`. This plugin workstream
does not read live core build output as 10.10 evidence or change core files.

## Validation and deployment boundary

Run focused regressions first, then the full standalone `npx vitest run` and
`npm run build` gates. Keep the ten monorepo-only exclusions and existing test
timeouts/concurrency. Focused coverage exercises:

- Actual preview create/read/edit-or-create/delete ordering, final identity,
  thread scope, system posts, empty results and failed order reads.
- Asynchronous session identity admission, cancellation during revalidation,
  session rotation and bounded room/thread history recovery.
- Prepared remote skills, aliases, denied channel skill filters, command
  conflicts and session-admission retry.
- Model/runtime confirmation, persisted-selection verification, explicit
  default pin readback and command transcript recording after delivery.
- V2 participation persistence after memory/module state is lost.
- Full pairing-queue handling and retained SecretRef ownership.

Build and inspect the self-contained artifact under `.artifacts/releases/`.
Check package/version metadata, runtime entrypoints and unchanged capability
manifest, and exclude core, development dependencies, test/config files and
companion sources. Run independent autoreview on the exact working diff and
verify findings against the code.

The root TypeScript diagnostic remains outside the passing standalone gate;
published declaration gaps and existing non-public session-field usage are not
resolved by this port.

Installation, channel-owner changes, production configuration, Gateway restart,
push and outbound Mattermost messages are outside this source adaptation.
After a separately authorized install/restart, use a fresh inbound turn to
verify card/result post order and identity, terminal card state, newer-post
final placement, native controls, persisted participation and companion
previews. A resumed turn or source-only checks do not establish that live proof.
