# OpenClaw 2026.11.2 cross-channel port review

Review date: 2026-11-09. Scope: channel-plugin source changes between official
OpenClaw `v2026.11.1`
(`4ffdd2047d192dd65554de3c8c46c0e0197c6e2a`) and `v2026.11.2`
(`b556fdf457b026574bf0f1e7b4914b15f3f179ce`), compared with the maintained
standalone Mattermost plugin at the 11.2 adaptation baseline.

## Recommendation

The strongest narrow port is Telegram's cancellation of startup authentication:
Mattermost's reconnect loop observes account cancellation, but its pending
startup `/users/me` request does not receive that signal. This is an established
local gap, supported by source inspection and an in-memory probe.

Three additional patterns are useful: iMessage's outbound-owned account failure
status, Discord's refusal to resolve ambiguous aliases (adapted to Mattermost
same-name channels across teams), and LINE/Matrix's content-safe ordinary logs.
These require Mattermost-specific behavior and acceptance criteria; they are
not source files to copy wholesale.

Most 11.2 changes are reliability and diagnostics improvements rather than new
interactive features. This investigation adds documentation only. It does not
implement these candidates, alter the existing 11.2 adaptation or retained
Mattermost fixes, install a plugin, or restart the Gateway.

## Inventory

The comparison covers all 28 channel plugins: 77 changed paths in total. Eight
plugins have runtime source changes, comprising 29 production source paths;
the remaining 20 channel plugins have package metadata changes only. The
iMessage `src/test-support/runtime.ts` helper is included in its changed-path
count and excluded from production paths.

The full Git diff contains 308 changed extension paths. The manifest-filtered
inventory contains 307 of them; the remaining path is the supporting
`extensions/image-generation-core/package.json`. Non-channel changes were also
checked for transferable patterns, with representative exclusions below.

| Plugin | Changed paths / production paths | Change and Mattermost assessment |
| --- | ---: | --- |
| Discord | 10 / 6 | Improves Unicode channel-name matching, refuses ambiguous cached user aliases, and prunes expired component records. The ambiguity principle applies to Mattermost's first-match channel-name lookup across teams; its cache and component-registry implementation do not transfer directly. |
| Feishu | 4 / 1 | Refuses to run a card action when the chat type cannot be confirmed. Mattermost verifies signed callbacks, checks the original post and channel identity, and fails closed if event planning cannot resolve the channel. |
| iMessage | 9 / 6 | Persists actionable status for two AppleScript Automation failures and removes inbound message previews from verbose logs. The error codes and setup instructions are Apple-specific. The generic status pattern is conditionally useful. |
| LINE | 5 / 2 | Stops logging raw postback data and provider error bodies that may reflect message content. This is the clearest privacy pattern to review at the Mattermost HTTP error boundary. |
| Matrix | 8 / 3 | Suppresses selected SDK records containing profile or verification details, and removes an account's stored credentials on account removal. The logging pattern merits a Mattermost privacy check; its credential store is Matrix-specific. |
| Microsoft Teams | 6 / 3 | Keeps webhook route ownership stable across account configuration and reload changes. Mattermost already registers per-account interaction routes and uses the signed channel/account identity. |
| Telegram | 10 / 6 | Makes polling initialization abortable, fixes Unicode-width regex performance, and binds thread-state persistence to its owning Telegram runtime. Startup cancellation is the strongest Mattermost port candidate; the renderer and persistence implementation are provider-specific. |
| WhatsApp | 5 / 2 | Retries durable inbound messages whose LID identity mapping is not ready and pins the sender account during recovery. Mattermost inbound events already carry stable provider user IDs; the 11.2 shared queue fixes are host-owned and are consumed through the published SDK. |

The 20 channel packages with metadata-only changes are A2A, Buzz,
ClickClack, Google Chat, IRC, Mattermost, Nextcloud Talk, Nostr, QA Channel, Raft, Reef,
Signal, Slack, SMS, Synology Chat, Tlon, Twitch, X, Zalo, and Zalo Personal.

## First priority: cancel pending startup authentication

Telegram 11.2 passes the account abort signal into `bot.init(...)`. Its regression
test aborts during the dependency's initialization retry delay and verifies that
the session settles without starting ingress.

In Mattermost, `monitor.ts` passes `opts.abortSignal` to the local
`runWithReconnect` loop, but calls `fetchMattermostMe(client)` without it.
`fetchMattermostMe` requests `/users/me` without a request signal.
`reconnect.ts` directly awaits `connectFn()` and can only observe cancellation
before or after that promise settles. Cancelling an account therefore cannot
interrupt this pending authentication operation through the reconnect wrapper.
The HTTP client has request timeouts, so this is not evidence of an unlimited
hang or a measured live shutdown duration.

An in-memory probe used a deferred `connectFn` promise, aborted the account,
and checked settlement after microtasks. The reconnect task remained pending
until the deferred promise was explicitly resolved. The probe used no network
requests or live account and changed no source.

Proposed port: propagate the monitor's cancellation signal into the startup
`/users/me` request, using the HTTP client's existing signal support. Preserve
authentication retries when the account remains active.

Future acceptance criteria:

1. Cancelling during the pending startup request or its rate-limit wait settles
   the monitor and cancels the underlying operation.
2. Cancellation starts no interaction routes, slash-command setup, durable
   ingress worker, or WebSocket afterward.
3. Ordinary transient authentication failure still retries and can recover.
4. A cancelled account produces no late recovery/status callbacks.

Local evidence: `src/mattermost/monitor.ts`,
`src/mattermost/client.ts` (`fetchMattermostMe` and request signal handling), and
`src/mattermost/reconnect.ts`. Upstream sources:
[Telegram polling initialization](https://github.com/openclaw/openclaw/blob/b556fdf457b026574bf0f1e7b4914b15f3f179ce/extensions/telegram/src/polling-session.ts)
and [its cancellation regression test](https://github.com/openclaw/openclaw/blob/b556fdf457b026574bf0f1e7b4914b15f3f179ce/extensions/telegram/src/polling-session.test.ts).

## Conditional candidate: reject ambiguous named channel targets

Discord 11.2 preserves ambiguity in cached user aliases instead of choosing an
unsafe fallback. Mattermost has a different but analogous routing gap:
`resolveChannelIdByName` in `src/mattermost/send.ts` queries the bot's teams,
returns the first matching channel, and caches it under server/token plus name.
If two teams contain `#ops`, team iteration order determines which one wins.
This is established by static inspection, not a live misdelivery reproduction.

A Mattermost adaptation could detect multiple matches and require the existing
explicit `channel:ID` target. Unique name matches and direct IDs should retain
their current behavior. This changes an existing routing expectation and should
be treated as a deliberate compatibility decision, not silently bundled into
the SDK version adaptation.

Future acceptance should cover two teams with the same channel name (no post
sent and no first-match cache entry), a unique name, direct channel IDs,
account-separated caches, and non-404 lookup failures. Team-order changes must
not change the selected destination. Ambiguity checks must not introduce
unbounded persistent cache state.

Upstream sources:
[Discord alias cache](https://github.com/openclaw/openclaw/blob/b556fdf457b026574bf0f1e7b4914b15f3f179ce/extensions/discord/src/directory-cache.ts)
and [channel resolution](https://github.com/openclaw/openclaw/blob/b556fdf457b026574bf0f1e7b4914b15f3f179ce/extensions/discord/src/resolve-channels.ts).

## Candidate: content-safe HTTP error diagnostics

LINE 11.2 removes a helper that logged provider response bodies after rejected
message sends, and no longer logs raw postback content. Matrix 11.2 similarly
filters known SDK records whose arguments contain profile or verification
details. These are narrowly scoped fixes: they retain useful operational
signals while avoiding known content-bearing fields.

Mattermost already bounds error-body reads and redacts the active Authorization
credential in `readMattermostError` in `src/mattermost/client.ts`. It still
places the returned provider detail in `MattermostApiError`; message-delivery
error handlers can log `String(err)`. A provider response could echo submitted
text, so the credential redaction alone does not protect message content. No
Mattermost-specific reflected-message reproduction was found in this review,
so treat this as a targeted hardening candidate rather than a confirmed leak.

A focused port should use content-safe structured summaries at ordinary logging
boundaries while keeping status, retry facts, delivery-acceptance evidence, and
useful sanitized exception details. Review content-writing requests first.
Non-content API failures can also carry useful diagnostics. The host's existing
opt-in WebSocket diagnostic capture is a separate mechanism and is not grounds
to remove all payload capture.

Acceptance criteria for such a change:

1. A synthetic rejected post response that echoes a unique private message does
   not expose that text in plugin logs or surfaced diagnostics.
2. The active bot token remains redacted from text, JSON, and truncated response
   bodies.
3. HTTP status, rate-limit handling, accepted-send uncertainty, and
   unknown-send reconciliation retain their existing behavior.
4. Non-content API errors keep their bounded, useful diagnostic detail.

Local evidence: `src/mattermost/client.ts`,
`src/mattermost/client.error-redaction.test.ts`, `src/mattermost/monitor.ts`,
`src/mattermost/monitor-resources.ts`, and
`src/mattermost/monitor-interactions.ts`. Upstream sources:
[LINE send handling](https://github.com/openclaw/openclaw/blob/v2026.11.2/extensions/line/src/send.ts),
[LINE inbound postbacks](https://github.com/openclaw/openclaw/blob/v2026.11.2/extensions/line/src/bot-handlers.ts),
[Matrix SDK logging](https://github.com/openclaw/openclaw/blob/v2026.11.2/extensions/matrix/src/matrix/client/logging.ts)
and [Matrix logger](https://github.com/openclaw/openclaw/blob/v2026.11.2/extensions/matrix/src/matrix/sdk/logger.ts).

## Conditional candidate: persistent outbound failure status

iMessage 11.2 translates two known Automation failures into operator guidance,
publishes the failure through channel account status, and clears that message
only after a confirmed successful send. The general pattern could help when a
Mattermost outbound failure is persistent and not visible through connection
health alone.

Mattermost currently publishes REST-authentication and WebSocket recovery
errors through its status sink. It also gives users per-turn delivery status
reactions. A new persistent outbound status should therefore be limited to
clearly classified, actionable errors such as confirmed authentication or
permission failures. A channel-specific 403 must not be presented as a
whole-account authentication failure or a disconnected WebSocket.
Generic transient send errors would duplicate per-turn
signals and risk leaving stale account status. Status clearing must not erase a
separate active connection error.

If operators request this improvement, acceptance should prove account
isolation, status persistence for classified failures, clearing after a
confirmed successful send by the same account, and preservation of unrelated
WebSocket health errors. Partial delivery and provider-accepted sends without a
usable post ID must retain truthful delivery semantics and must not clear the
warning as if success had been confirmed. No status feature was ported in this review.

Local evidence: `src/mattermost/monitor.ts`,
`src/mattermost/monitor-websocket.ts`, and
`src/mattermost/monitor-turn-reactions.ts`,
`src/mattermost/no-visible-reply-diagnostic.ts`, and `src/channel.ts`. Upstream sources:
[iMessage error normalization](https://github.com/openclaw/openclaw/blob/v2026.11.2/extensions/imessage/src/process-diagnostics.ts),
[iMessage send status](https://github.com/openclaw/openclaw/blob/v2026.11.2/extensions/imessage/src/send-status.ts)
and [iMessage send handling](https://github.com/openclaw/openclaw/blob/v2026.11.2/extensions/imessage/src/send.ts).

## Changes not to port

- Feishu's callback must infer whether a chat is a group or direct conversation.
  Mattermost callback processing validates the signed channel, reloads the
  source post, and asks its event planner for trusted channel details before
  dispatch.
- Discord's component registry expires individual controls. Mattermost's
  per-account signing/URL maps are not that registry, and host questions already
  validate expiration. Durable task cards should not gain arbitrary expiry.
- Matrix's persisted-credential removal has no matching Mattermost-owned
  credential store. Clearing in-memory callback maps on stop is possible
  maintenance, but this review established no behavior defect that warrants
  ranking it as a port.
- Telegram's persistence owner is needed because its thread-binding adapter can
  be called by another plugin instance. Mattermost does not use that Telegram
  adapter or its process-global runtime persistence.
- WhatsApp's LID retry handles identities that are temporarily unmapped by the
  provider. Mattermost posts include the stable Mattermost user ID used by
  durable ingress and authorization.
- Teams' `/api/messages` handoff is a provider-specific webhook alias problem.
  Mattermost's interaction callbacks have account-scoped routes and signed
  account/channel context.
- Telegram's Unicode regex optimization addresses its custom monospace-grid
  renderer. Mattermost does not use that renderer.

Shared host changes remain with OpenClaw core. In particular, the 11.2 retry
admission and default-sender identity fixes are consumed through the published
SDK and core queue; duplicating them in this plugin would create a second owner
for host delivery policy.

Representative non-channel changes include active-memory's 4,000-character
recall budget, memory-core's `limit` alias, bounded redaction work in
diagnostics-otel, failed-initialization cache recovery in code-mode-quickjs and
apple-fm, and browser navigation constraints. These belong to their memory,
telemetry, runtime, or browser owners. They do not justify adding corresponding
subsystems to the Mattermost channel.

The previously reviewed ClickClack origin-scoped network-policy idea remains a
conditional candidate from 11.1, not a new 11.2 feature. Any later adaptation
must preserve the meaning of Mattermost's explicit private-network opt-in.

## Sources and retained evidence

Primary source: [official 11.1 to 11.2 comparison](https://github.com/openclaw/openclaw/compare/v2026.11.1...v2026.11.2)
and the [official 11.2 extension trees](https://github.com/openclaw/openclaw/tree/v2026.11.2/extensions).
The exact path inventory and patches reviewed are retained under
`.artifacts/operations/cross-channel-2026.11.2/`.
The inventory totals were cross-checked against the immutable Git diff.
This documentation-only follow-up does not rerun the completed 11.2 build and
test gate. The acceptance criteria above describe future ports, not tests or
behavior shipped by this investigation.
