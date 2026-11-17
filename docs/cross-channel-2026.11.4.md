# OpenClaw 2026.11.4 cross-channel port review

Review date: 2026-11-17. Compare immutable official commits
`847611dcaa3bf0e2783335f961dd1fd0580e4d9f` (11.3) and
`d843d6af39a42cd3c30084edbeabeece732fd93a` (11.4), against the frozen
standalone plugin candidate `1b2f1e074c7368f2eda2c65dde222a8763477e98`.

This is a source audit and recommendation, not an implementation or a release
amendment. The accepted 11.4 artifact and its pending maintained-core compiled
pairing remain unchanged. A background reader inventoried official extension
changes; the owning plugin writer traced the relevant Mattermost owners and
existing tests and performed one small, offline presentation probe.

## Recommendations

Two changes are worth a separate Mattermost task. Neither establishes a new
11.4 runtime regression or requires replacing the frozen adaptation artifact.

### 1. Migrate native approval helpers to their asynchronous public contracts

Telegram 11.4 switches its native approval capability, origin/approver target
resolution and lazy runtime adapter to the asynchronous public SDK helpers.
The portable part is the awaited account/session eligibility contract, not
Telegram's numeric topic routing or terminal notification workaround.

Mattermost still imports and uses the synchronous
`createApproverRestrictedNativeApprovalCapability`,
`createChannelNativeOriginTargetResolver` and
`createChannelApproverDmTargetResolver` in
[`src/approval-native.ts`](../src/approval-native.ts). It also uses the
synchronous lazy/runtime adapter family there and in
[`approval-handler.runtime.ts`](../src/mattermost/approval-handler.runtime.ts).

The exact official 11.4 source annotates the first three helpers as deprecated
with **final compatibility day 2026-12-31**:

- [approval-delivery-helpers.ts, line 254](https://github.com/openclaw/openclaw/blob/d843d6af39a42cd3c30084edbeabeece732fd93a/src/plugin-sdk/approval-delivery-helpers.ts#L254): prefer the Async capability with awaited account eligibility.
- [approval-native-target-resolvers.ts, lines 112/116](https://github.com/openclaw/openclaw/blob/d843d6af39a42cd3c30084edbeabeece732fd93a/src/plugin-sdk/approval-native-target-resolvers.ts#L112): prefer the Async origin resolver for worker-owned session reads.
- [approval-native-target-resolvers.ts, line 137](https://github.com/openclaw/openclaw/blob/d843d6af39a42cd3c30084edbeabeece732fd93a/src/plugin-sdk/approval-native-target-resolvers.ts#L137): prefer the Async approver-DM resolver with awaited account eligibility.

This is a bounded, dated maintenance candidate. The synchronous exports still
exist in the published 11.4 package and the adaptation gates pass; this review
does not claim that approvals are currently broken or that 11.4 removed them.

A later implementation should migrate one complete native-approval path,
retain the current authorization rules and account/origin deduplication, and
exercise channel, DM and both delivery modes, exec/plugin/system-agent events,
rejected/disabled senders, delayed eligibility and resolved/expired updates.
It should not import Telegram topic semantics into Mattermost. Its actual new
SDK imports must be separately built, reviewed and paired before shipping.

Primary implementation: [Telegram approval-native.ts](https://github.com/openclaw/openclaw/blob/d843d6af39a42cd3c30084edbeabeece732fd93a/extensions/telegram/src/approval-native.ts).
The exact comments are also recorded in
`.artifacts/operations/cross-channel-2026.11.4/primary-source-excerpts.json`.

### 2. Add agent-owned typed callback controls to message actions

Telegram 11.4 distinguishes typed callbacks produced by message actions from
plugin-owned controls. A message-action callback unclaimed by a plugin can
reach the conversation agent as callback data. Plugin-owned or malformed
controls expire instead. A slash-prefixed callback value stays data; executing
a command requires a separate command action.

Mattermost currently **deliberately degrades typed callback actions to text**.
This is not a new 11.4 regression:

- [`src/normalize.ts`](../src/normalize.ts) handles native question actions,
  then skips other typed actions when constructing buttons.
- [`src/channel.ts`](../src/channel.ts) tells the agent explicitly that typed
  callback actions render as plain text and demonstrates legacy `value` buttons.
- [`src/channel.test.ts`](../src/channel.test.ts) contains the test
  `does not render callback action buttons that Mattermost cannot round-trip`.
- [`src/normalize.question.test.ts`](../src/normalize.question.test.ts) verifies
  unsupported typed actions remain prose.

The offline probe imported the exact final candidate's actual normalize
module against its isolated published 11.4 SDK. With otherwise identical
`Today` controls:

| Input | Actual Mattermost result |
| --- | --- |
| Legacy `value: "pick:today"` | One clickable button |
| `action: { type: "callback", value: "pick:today" }` | Text label preserved, no buttons |
| Typed callback value `/new` | Text label preserved, no buttons |
| Typed command `/new` | Command shown in text, no buttons |

Receipt: `.artifacts/operations/cross-channel-2026.11.4/typed-callback-probe.json`.
This is a useful feature/contract extension, not evidence of a disappeared
legacy button or an authorization bypass.

A port needs an end-to-end ownership contract, not merely removing the typed
action guard. The current generic button dispatch sends the human label to the
agent; menu dispatch separately preserves its selected machine value. A new
callback path must preserve the typed value as data through send/edit,
signed post context, durable admission/replay and agent dispatch. Native
question, approval, secret, model and stop controls must remain with their
existing handlers. Plugin-owned controls must not silently become agent input
when their owner disappears. New acceptance must cover send and edit, exact
value preservation, slash values without command execution, stale/malformed
controls, account/thread routing and restart replay without duplicate turns.
Command actions remain separate work.

Primary sources: [native-command-callback-data.ts](https://github.com/openclaw/openclaw/blob/d843d6af39a42cd3c30084edbeabeece732fd93a/extensions/telegram/src/native-command-callback-data.ts),
[callback router](https://github.com/openclaw/openclaw/blob/d843d6af39a42cd3c30084edbeabeece732fd93a/extensions/telegram/src/bot-handlers.callback-router.ts),
and [bot.agent-callbacks.test.ts](https://github.com/openclaw/openclaw/blob/d843d6af39a42cd3c30084edbeabeece732fd93a/extensions/telegram/src/bot.agent-callbacks.test.ts).
The latter proves an unclaimed message-action tap reaches the agent as data
and malformed or disabled controls expire. `action-runtime.test.ts` additionally
covers edit-produced controls.

## Other channel changes and Mattermost assessment

The official extensions diff has 300 changed paths. Excluding Mattermost's
single package metadata change leaves 299 paths across 166 packages; 146 are
package.json-only. Twenty other packages have changes beyond package.json.
For actual channel connectors, eight have non-package changes (37 paths),
including Matrix's changelog-only update; seven change runtime behavior.
The machine inventory and complete selected channel patch are under
`.artifacts/operations/cross-channel-2026.11.4/`.

| Channel | Official 11.4 change | Mattermost decision |
| --- | --- | --- |
| [Feishu](https://github.com/openclaw/openclaw/blob/d843d6af39a42cd3c30084edbeabeece732fd93a/extensions/feishu/src/reply-dispatcher.ts) | A block with media preserves caption/image delivery even with block streaming disabled and previews off/partial. Regression: `delivers caption and image with block streaming disabled and previews off/partial`. | No equivalent port identified. `monitor-turn.ts` excludes media from the text-only preview fast path. `monitor-draft-delivery.ts` retains media even when text was already published; existing test `still delivers media when the text is already published` verifies that boundary. `reply-delivery.ts` separately delivers media/text parts. |
| [IRC](https://github.com/openclaw/openclaw/blob/d843d6af39a42cd3c30084edbeabeece732fd93a/extensions/irc/src/inbound.ts) | An explicitly empty per-channel allowFrom list overrides broader sender lists rather than inheriting them. Regression: `honors an empty channel sender list over wildcard and account senders`. | No direct counterpart. MattermostGroupSchema in `config-schema-core.ts` explicitly omits per-room allowFrom/enabled; current sender admission is account-level through the shared ingress helper. Adding a new per-room sender policy would be a separate feature, not copying this fix. |
| [Slack](https://github.com/openclaw/openclaw/blob/d843d6af39a42cd3c30084edbeabeece732fd93a/extensions/slack/src/monitor/message-handler/dispatch-progress.ts) | Avoid accumulated-reasoning merging when non-progress tool previews are disabled. | No equivalent hot path found. Mattermost uses shared `pushReasoningProgress` only in progress mode; it checks active/canUpdateProgress/thinkingProgressEnabled before merging. Other modes display a fixed Thinking marker, not repeatedly merged reasoning text. `active` is false when previews are unavailable. |
| [Signal](https://github.com/openclaw/openclaw/blob/d843d6af39a42cd3c30084edbeabeece732fd93a/extensions/signal/src/sse-reconnect.ts) | HTTP SSE resumes with Last-Event-ID; cursor advances only after accepted event processing, including durable ingress. Empty/NUL ID and unterminated-event handling are corrected. | SSE protocol-specific. Mattermost uses authenticated WebSocket events and its own durable ingress. Accepted local ingress durability is not a server replay cursor; this review does not claim it recovers disconnected, never-received events. No compatible replay contract was established to port. |
| [WhatsApp](https://github.com/openclaw/openclaw/blob/d843d6af39a42cd3c30084edbeabeece732fd93a/extensions/whatsapp/src/auto-reply/monitor/inbound-dispatch.ts) | Durable handoff reconstructs the selected account config view and resolves text limits using accountId; unrelated registry changes preserve delivery, relevant config changes fence it. | No direct snippet port. Mattermost already supplies accountId to text-limit/chunk/table resolvers and uses fresh cfg at inbound planning. It does not define WhatsApp's per-turn durable handoff callback or root-level account promotion. Preserve shared host custody/config-admission fixes rather than creating that provider-specific snapshot. |
| [Telegram](https://github.com/openclaw/openclaw/blob/d843d6af39a42cd3c30084edbeabeece732fd93a/extensions/telegram/src/approval-handler.runtime.ts) | Approval target identity includes private topic; terminal delivery avoids duplicate origin fallback while origin cards are pending/editable. Async API and typed controls change as above. | Async API and typed callbacks are the two follow-ups. Mattermost updates a physical post by postId and has no Telegram private numeric-topic route/fallback branch; no identical topic repair identified. |
| [Tlon](https://github.com/openclaw/openclaw/blob/d843d6af39a42cd3c30084edbeabeece732fd93a/extensions/tlon/src/monitor/cites.ts) | Citation reads require explicit/discovered channel scope; recheck before authenticated request and after response. Settings updates retain approval/DM state. | Existing Mattermost permalink policy already denies other private/DM channels and permits cross-channel public reads only when configured; `thread-context.test.ts` covers both. Reference media is same-channel and sender-admitted. Mattermost pins cfg per event and restarts on relevant channel config changes, unlike Tlon's subscribed mutable settings state. No live revocation race or cross-scope read was reproduced. Request-bound revalidation remains a conditional hardening idea, not an established defect or automatic port. |
| [Matrix](https://github.com/openclaw/openclaw/blob/d843d6af39a42cd3c30084edbeabeece732fd93a/extensions/matrix/CHANGELOG.md) | Changelog plus package metadata. | No runtime port. |

Telegram also adds canonical runtime session keys to its internal message hooks.
Mattermost already uses shared inbound delivery with `observeMessageSent: true`
and supplies a route to that lifecycle, so the missing-field addition does not
copy directly. A separate note below records the normal-thread routing contract
lead rather than declaring end-to-end equivalence without a hook receipt.

### Conditional follow-up: thread session correlation in message hooks

Telegram's new hook test explicitly separates the runtime session key from the
policy session key. This is worth a focused Mattermost contract test before
deciding whether to port a correction:

- [`monitor-event-plan.ts`](../src/mattermost/monitor-event-plan.ts) derives a
  thread-aware key and writes it into `ctxPayload.SessionKey`.
- Normal inbound [`monitor-turn.ts`](../src/mattermost/monitor-turn.ts) supplies
  the base `route.sessionKey` to `resolveTurn.route`, whereas the callback path
  in [`monitor-interactions.ts`](../src/mattermost/monitor-interactions.ts)
  supplies `thread.sessionKey`.
- Official 11.4
  [turn/lifecycle.ts](https://github.com/openclaw/openclaw/blob/d843d6af39a42cd3c30084edbeabeece732fd93a/src/channels/turn/lifecycle.ts)
  retains the supplied route key as `routeSessionKey`. Its direct
  `message_sending` hook uses that key; its `message_sent` hook prefers an
  ambient group-thread context key when available, otherwise the route key.

The same lifecycle's `resolveAssembledReplyPipeline` handles unequal keys by
attaching the base route key to reply system-event context; it does not
rewrite the runner's `ctxPayload.SessionKey`. For an ordinary non-command
thread with unequal base and thread keys, the source therefore establishes a
correlation mismatch in the direct `message_sending` path. The ambient
group-thread override can affect the sent hook, so both hooks should not be
declared affected in every thread. There is no observed hook event trace or
complete threaded-inbound regression proof here.
Do not blindly replace policy/parent routing with the thread key: first prove
the ordinary inbound and callback hook keys against the runner key while
preserving parent-session recording, command-target routing and admission.
This is a source-backed verification lead, not a confirmed user-visible
incident or a change to the frozen adaptation.

Primary upstream regression:
[delivery.replies.session-key.test.ts](https://github.com/openclaw/openclaw/blob/d843d6af39a42cd3c30084edbeabeece732fd93a/extensions/telegram/src/bot/delivery.replies.session-key.test.ts).

Provider harness/startup/child ownership changes in Anthropic, AgentsAPI,
Codex, Copilot and Code Mode are host-owned. Browser document-policy, Memory
Core/Wiki rebuild/ingest, OpenShell mirror protection, diagnostics redaction and
Z.ai active-connection changes likewise are not channel implementation ports.
The 20-package non-metadata inventory includes these owners so they are not
mistaken for omitted channel fixes.

## Existing 11.3 backlog

The prior [11.3 review](cross-channel-2026.11.3.md) identified the Blocks capability
probe cache. `capabilities.ts` still keys by baseUrl and caches unknown results
indefinitely. That conditional correctness candidate remains unchanged; it is
not a new 11.4 finding. The earlier permalink punctuation issue has already
been corrected with a suffix scan and is retained in the frozen candidate.

## Evidence and boundaries

Operation directory: `.artifacts/operations/cross-channel-2026.11.4/`.

- `inventory.json`: exact changed paths and package/channel counts.
- `channel.patch`: fixed official source/test diff.
- `primary-source-excerpts.json`: exact SDK deadline and shared guard/hook references.
- `typed-callback-probe.json`: actual-source, offline synthetic input results.
- `preservation.json`: all 343 frozen tracked files and the accepted tarball
  still match their recorded hashes; prior research hash is unchanged.
- `summary.json`: recommendations, confidence and unresolved proof boundaries.

No runtime implementation, dependencies, builds, broad tests, live probes,
install/restart, Mattermost outbound messages or push were performed. New research notes
are separate and uncommitted. The existing 11.4 adaptation stays
ARTIFACT_READY_HOST_PAIRING_PENDING until the core owner supplies its final
compiled pairing receipt. This audit does not expand that release's scope.
