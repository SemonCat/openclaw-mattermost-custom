# OpenClaw 2026.11.1 cross-channel review

Review date: 2026-11-06. Scope: official channel changes between
`v2026.10.10` (`7dc3350cb9f08fcf9a0af5c4845a20d5b2f1a8be`) and
`v2026.11.1` (`4ffdd2047d192dd65554de3c8c46c0e0197c6e2a`), compared with the
current standalone Mattermost implementation.

## Recommendation

Keep the existing uncommitted DM thread fix and its tests. The other channels'
streaming, keepalive, delivery-identity and account-secret repairs either have
equivalent Mattermost behavior already or apply to a different provider/runtime
owner. They do not require another unconditional implementation port.

ClickClack's origin-scoped private-network exception is one useful hardening
candidate. It is not equivalent to the current Mattermost network opt-in and
needs a compatibility decision before changing behavior. It is described below;
this review does not silently narrow an operator's explicit network setting.

## Inventory and evidence

Enumerated every `extensions/*/openclaw.plugin.json` at the immutable target tag
and selected all 28 packages declaring channels. All 28 have changes: 120 paths,
including 45 production TypeScript paths, tests, package metadata and Matrix's
changelog. Eighteen other channel packages have production changes; Mattermost
itself is the nineteenth. Test helpers and harnesses are counted in the full
path inventory but not as production code.

The nine packages with package metadata changes only are `a2a`, `buzz`, `irc`,
`line`, `qa-channel`, `raft`, `signal`, `sms` and `whatsapp`.

Full per-channel path inventories, production patches and owning commit lists
are retained under `.artifacts/operations/cross-channel-2026.11.1/`. Those local
files are evidence, not another source checkout. No core source was changed.

| Channel | Changed paths / production paths | Actual change and Mattermost decision |
| --- | --- | --- |
| ClickClack | 4 / 1 | Guard API requests and redirects with an exception scoped to the configured origin, and recheck caller authority at dispatch. Mattermost already guards production fetches and rechecks read/sender authority. Its explicit private-network exception remains broader; consider the scoped-policy candidate below. |
| Discord | 10 / 4 | Await run-queue completion, deactivate the queue before draining debounce, stop inheriting browser-wide private-network access for CDN fetches, and normalize explicit default-account identity. Mattermost's ingress adapters await dispatch and use the SDK's durable monitor; its media policy comes from the account's explicit opt-in, not browser policy. Account and secret ownership use shared helpers. |
| Feishu | 10 / 3 | Preserve earlier assistant-message prose at tool boundaries, treat snapshots as authoritative, request ordered progress callbacks, and replace a rejected Card JSON 2.0 action container. Mattermost already preserves visible generations and final identity, accepts shorter snapshots, and requests ordered callbacks. REST/companion regressions cover these cases. Feishu card schema does not apply to Mattermost. |
| Google Chat | 9 / 4 | Represent remote attachments as links when service-account upload is unsupported; retain errors for local files. Mattermost supports native uploads, grouped attachments and existing remote URL fallback. Replacing uploads with links would remove working behavior. |
| iMessage | 8 / 3 | Explain AppleScript Automation failures and replace NUL-separated recovery keys with bounded hashes. Mattermost has no AppleScript transport; participation keys use colon-separated account/channel/thread identities, and ingress queues have their own SQLite schema. No NUL-key migration is needed. |
| Matrix | 7 / 3 | Reject malformed UTF-8 in legacy credential/sync-cache imports while retaining source files and recovery warnings. Mattermost has no corresponding legacy file importer; its doctor contract exposes config normalization only. |
| Mattermost | 2 / 1 | Restore implicit-default secret ownership. Already preserved downstream, as recorded in the main adaptation. |
| Microsoft Teams | 3 / 1 | Preserve malformed UTF-8 legacy delegated-token sources. No matching Mattermost legacy import path. |
| Nextcloud Talk | 4 / 2 | Align account listing and secret collection around complete implicit-default credentials. Mattermost's listing and secret contract already share the root base URL plus token/environment predicate. |
| Nostr | 3 / 1 | Report a failed pairing notice when no live bus exists instead of silently succeeding. Mattermost uses the shared logged pairing notifier and the normal message transport, without Nostr's optional bus lookup. |
| Reef | 4 / 2 | Preserve malformed UTF-8 identity/audit/replay files and retain migration barriers without overriding source-owned recovery warnings. No equivalent Mattermost legacy-state importer or identity barrier exists. |
| Slack | 4 / 2 | Add relay WebSocket keepalive and preserve complete top-level credentials alongside named accounts. Mattermost already has protocol ping/pong deadlines and reconnect handling, plus the maintained implicit-default secret contract. |
| Synology Chat | 8 / 3 | Confirm outbound delivery using recipient-matched provider post IDs; identityless acknowledgements remain unconfirmed. Mattermost already distinguishes accepted delivery without a usable ID, partial delivery and confirmed provider identities. Its signed reconciliation does not fabricate an ID from a target. Synology's receipt schema is provider-specific. |
| Telegram | 6 / 2 | Restore each queued request's async context at flood-gate dispatch, and retain detached webhook work through post-adoption cleanup. Mattermost has no grammY shared limiter or Telegram participant boundary; its durable ingress delivery awaits dispatch. Core's plugin background-reader repair is consumed from the host. |
| Tlon | 10 / 4 | Bound recursive Urbit rendering, handle unserializable events without pinning SSE, and reconnect stalled SSE reads while excluding slow event processing. Mattermost persists the original raw event string, validates malformed ingress, has no recursive Urbit renderer, and already has protocol keepalive. Its silent healthy connection should not gain an SSE silence timer. |
| Twitch | 5 / 3 | Normalize typed channel targets consistently and reject unsupported DM targets before default-channel fallback. Mattermost supports real DMs and explicit user/channel resolution; the Twitch rejection/fallback rule would be incorrect here. |
| X | 6 / 3 | Deduplicate normalized runtime account IDs, find authored-case account keys during admin writes, and improve token-refresh guidance. Mattermost delegates account resolution to the shared helpers and has no X guest-admin/GitHub verification service. |
| Zalo | 5 / 2 | Recover text from unsupported event types and align implicit-default secret/webhook activation. Mattermost has a different event contract, validates post text/media directly, and already maintains its own default-account ownership. |
| Zalo Personal | 3 / 1 | Preserve malformed UTF-8 legacy credentials with recoverable migration warnings. No matching Mattermost importer. |

The principal upstream commits are:

- `c23a6d2c4f64a61b16b13f13b8236ce96f7c9b59`: channel delivery, ownership and
  recovery repairs.
- `a3716f18d43d2f3977bceee27a15861095d5e1fa`: retrospective repairs, including
  Telegram request/adoption context and Discord queue ownership.
- `2fc8a432de7e9c86f3c0d92d55ad095d6a554526`: ClickClack guarded redirects.
- `395185cde2b994554d6ba3a60f3ca9ddcaee623f`: Discord CDN network policy.
- `05edb9b78490fe29f2610e86a0ea0bfaefea07ee`: strict UTF-8 legacy imports.
- `da02a851f7187a94b84c6a1bf1cc3bd9beb63342`: iMessage recovery cursor keys.
- `0aca39d7643382be340f7f0f0c12780058c2e8b7`: iMessage Automation guidance.

Primary sources: the pinned
[complete comparison](https://github.com/openclaw/openclaw/compare/v2026.10.10...v2026.11.1)
and the individual [channel source trees](https://github.com/openclaw/openclaw/tree/v2026.11.1/extensions).
The production patch inventory accounts for every changed channel source path,
including doctor entrypoints outside `src/`.

Shared host repairs also remain with their existing owner. The Doctor change in
`src/commands/doctor/shared/allowfrom-fallback-migration.ts` preserves explicitly
empty group allowlists and disabled policies instead of repopulating them.
Mattermost's doctor entry does not implement that shared migration, so copying
it into this plugin would duplicate host configuration policy. The host's
`src/plugins/plugin-instance-background.ts` repair gives admitted plugin work
its own read-only worker scope through cleanup; that change likewise belongs
to the installed core.

## Conditional candidate: scoped API network exceptions

Upstream ClickClack uses
`ssrfPolicyFromHttpBaseUrlAllowedOrigin(baseUrl)` in `createClickClackClient`.
The SDK evaluates that exception separately for each request URL, including
redirects. Mattermost's `createMattermostClient` and `probeMattermost` already use
`fetchWithSsrFGuard`, but use `ssrfPolicyFromPrivateNetworkOptIn`; an enabled
opt-in returns the broader `{ allowPrivateNetwork: true }` policy. Merely having
the guard does not make these policies equivalent.

A useful narrow adaptation would limit the authenticated API/probe exception to
the configured Mattermost origin when private access is enabled. The existing
opt-out must remain restrictive. Companion requests use the same client and
origin. Generic media downloads should keep their independently authorized
policy rather than inheriting an API-origin restriction.

This can affect deployments that intentionally redirect downloads or API calls
to a different private origin, including private file storage. The currently
configured installation enables private-network access, so this is an actual
compatibility decision for deployment. A safe implementation should first
establish the required origins and exercise API, probe, file-download and
companion paths. This review records the candidate without changing that
network contract.

References:
[ClickClack request owner](https://github.com/openclaw/openclaw/blob/v2026.11.1/extensions/clickclack/src/http-client.ts),
[origin policy semantics](https://github.com/openclaw/openclaw/blob/v2026.11.1/src/infra/net/ssrf.ts)
and [explicit opt-in policy](https://github.com/openclaw/openclaw/blob/v2026.11.1/src/plugin-sdk/ssrf-policy.ts).
Local counterparts are `src/mattermost/client.ts`, `src/mattermost/probe.ts`,
`src/mattermost/companion-stream.ts` and the existing probe/client policy tests.

## Existing uncommitted changes

All pre-existing changes should be retained:

| File/change | Decision and evidence |
| --- | --- |
| `src/mattermost/monitor-context.ts` | Keep. An existing DM thread must retain its root before applying the setting that controls creating new threads. The removed early return discarded a real inbound root whenever the effective DM mode was `off`. |
| `src/mattermost/monitor-event-plan.test.ts` | Keep. Assert the routed thread root, session and DM-independent parent behavior; cover default, explicit `off`, global `first`, and direct `all`. The default room fixture correctly expects no new thread because `resolveMattermostReplyToMode` defaults to `off`. |
| `src/mattermost/monitor-turn.streaming.test.ts` | Keep. The real turn/draft/SDK-dispatcher path checks both late-plan boundaries, actual Mattermost creates, card/result identity transfer and final edits. The fixture's completed symbol matches the host's `recordAgentRunTerminalOutcome` carrier rather than inferring success from delivery alone. |
| `src/mattermost/monitor.test.ts` | Keep. Preserve an existing DM root with effective mode `off`, and keep a genuinely top-level DM flat. |
| `src/mattermost/slash-http.session-admission.test.ts` | Keep. Check both flat and threaded DM retries, refreshed session versions, and the final actionable error's root. This replaces the incorrect assumption that a native slash invocation's supplied root is necessarily stray. |
| Existing README DM paragraph | Keep. It describes the corrected behavior and separates existing threads from new top-level DM threading. |

The 11.1 package/lock/identity/README adaptation and upstream review from the
preceding task should also be retained.

### Direct regression proof

With only `monitor-context.ts` temporarily restored to its committed version,
the two DM task-card lifecycle cases fail: both provider creates have an absent
`root_id` instead of the inbound thread root. The working source was restored
byte-for-byte in a `finally` block. No retained user change was discarded.

Command:

```bash
npx vitest run src/mattermost/monitor-turn.streaming.test.ts \
  -t "keeps DM task progress"
```

After restoration, all four affected suites pass: **81 tests** across
`monitor-turn.streaming`, `monitor-event-plan`, `monitor`, and
`slash-http.session-admission`. The preceding exact-source standalone gate
passed **119 suites / 1,539 tests**, the SDK build passed, and independent
autoreview found no P0–P2 issues. This audit adds documentation without changing
the tested runtime code.

## Deployment and commit order

Read-only runtime checks during this review report Gateway `2026.10.10` with
`mattermost-custom@2026.10.10` loaded from the managed plugin directory. The
bundled Mattermost owner is disabled. Core's source HEAD has advanced to
`b2538b2bce8`, but that does not establish a deployed 11.1 runtime.

Keep the reviewed changes together for the requested post-deployment commit.
The 11.1 candidate requires a verified 11.1 host, followed by the authorized
managed-artifact install/restart and a fresh inbound Mattermost smoke test.
Verify the DM thread, both late-plan boundaries, card/result post order and
identities, tool/final updates on the successor, terminal card state, native
controls and companion preview if enabled. Commit the accepted candidate after
those checks; do not use source HEAD or a resumed turn as runtime proof.

This review does not install a plugin, restart the Gateway, send Mattermost
messages, change live configuration, or create a commit ahead of deployment.
