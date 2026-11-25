# OpenClaw 2026.11.7 cross-channel port review

Research date: 2026-11-24. The reply-session busy notice is implemented in the
follow-up candidate. The attachment feedback is a separate recommendation.

## Source baseline

| Source | Immutable identity |
| --- | --- |
| OpenClaw 2026.11.6 | `06afb10d3272cc9deaf38ca6a3b7b839d5935638` |
| OpenClaw 2026.11.7 | `e31bbf056de321127988ec5c1a36ff1b59297de0` |
| Mattermost Custom checkout HEAD | `27fcf9e05d5624ee883fa33898bef5b5cfa9f37a` |

Upstream links below pin source commits. The review concentrates on user-facing Discord, Slack, Telegram and Matrix changes plus the shared host contracts those adapters use. Verification of the implemented port is tracked with the follow-up package.

## Prioritized recommendations

### 1. P1 candidate: return a bounded notice for an exhausted reply-session initialization conflict

OpenClaw 11.7 exports `isReplySessionInitConflictError` through the public [reply-runtime SDK](https://github.com/openclaw/openclaw/blob/e31bbf056de321127988ec5c1a36ff1b59297de0/src/plugin-sdk/reply-runtime.ts#L28). The classifier recognizes the typed reply initialization error and its serialized message form in [session-init-conflict-retry.ts](https://github.com/openclaw/openclaw/blob/e31bbf056de321127988ec5c1a36ff1b59297de0/src/auto-reply/reply/session-init-conflict-retry.ts#L20). Discord uses it in [message-handler.retry.ts](https://github.com/openclaw/openclaw/blob/e31bbf056de321127988ec5c1a36ff1b59297de0/extensions/discord/src/monitor/message-handler.retry.ts#L14) to send a short “session stayed busy” final notice, suppresses that notice for `message_tool_only`, and preserves the normal failure path if notice delivery itself fails. The same release also fixes the host SQLite comparison that treated nested JSON key-order differences as session changes in [session-accessor.sqlite-entry-equality.ts](https://github.com/openclaw/openclaw/blob/e31bbf056de321127988ec5c1a36ff1b59297de0/src/config/sessions/session-accessor.sqlite-entry-equality.ts#L18); that underlying repair is host-owned and should reduce these conflicts.

The current plugin's [session-admission-retry.ts](../src/mattermost/session-admission-retry.ts#L10) matches a different error: “Session … changed/was deleted while starting work. Retry.” It retries that pre-dispatch race once, provided no visible work has begun. In [monitor-turn.ts](../src/mattermost/monitor-turn.ts#L933), the inbound run is wrapped by that helper; other errors reach the catch at [line 1197](../src/mattermost/monitor-turn.ts#L1197), which marks dispatch failure and rethrows. The ingress adapter then retries the row. Its [dead-letter callback](../src/mattermost/monitor-ingress.ts#L345) runs only after the failed-row write commits, and [monitor-dead-letter.ts](../src/mattermost/monitor-dead-letter.ts#L101) sends a generic notice at that later terminal boundary. The regression coverage confirms that transient failures remain retryable and silent, while notices follow a committed dead letter in [monitor-ingress.dead-letter.test.ts](../src/mattermost/monitor-ingress.dead-letter.test.ts#L44).

These are separate failure classes. A reply-init conflict can therefore go through durable ingress retries without an immediate busy result, even after core has exhausted its own retry attempts. This is the strongest plugin-owned user-facing candidate in this comparison.

**Smallest seam:** after the published SDK is aligned to 11.7, use its classifier around the inbound-run failure in `monitor-turn.ts`. For this exact error only, deliver one source-bound error reply using the current account, sender, thread and source-reply policy. Treat a policy-suppressed notice as settled; if notice delivery fails, retain the existing durable retry and dead-letter custody. Keep the existing one-time pre-dispatch admission retry and all other error handling unchanged. Reuse the plugin's durable delivery receipt/readback behavior so an accepted notice is not duplicated on replay.

The follow-up implementation catches the published SDK's conflict at the inbound
turn boundary and uses the existing Mattermost sender. It completes the ingress
claim on acceptance, configured silence, or an ambiguous transport outcome.
Confirmed rejection retains ingress retry. Run-start, deferred ingress and
abandoned ingress remain outside the notice path. The regression cases inject
the exhausted conflict at the host dispatch boundary and exercise the plugin's
SQLite ingress claim through delivery and replay.

### Local file delivery in Mattermost

The Mattermost delivery-format prompt follows Slack's channel-owned formatting
contract. It asks for accessible HTTPS links and explicit attachments in the
same thread. The sender also follows Telegram's local-link fallback while
retaining the original Markdown around the link. Inline absolute-path and
`file:` links keep their labels, and file autolinks render as code. Typed code
and HTTPS links retain their source text. The formatter only changes the
caption. Existing structured media fields select which files are uploaded.

### 2. P2 candidate: make failed inbound attachment hydration visible to the sender

Telegram 11.7 stops retrying an inbound update solely because attachment download failed. It uses a bounded shared media-batch budget, continues the turn with unavailable-media context, and sends a visible warning; the first-party behavior is in [delivery.resolve-media.ts](https://github.com/openclaw/openclaw/blob/e31bbf056de321127988ec5c1a36ff1b59297de0/extensions/telegram/src/bot/delivery.resolve-media.ts#L224) and [bot-handlers.inbound-pipeline.ts](https://github.com/openclaw/openclaw/blob/e31bbf056de321127988ec5c1a36ff1b59297de0/extensions/telegram/src/bot-handlers.inbound-pipeline.ts#L346), with a real-ingress regression in [telegram-ingress-coalescing.e2e.test.ts](https://github.com/openclaw/openclaw/blob/e31bbf056de321127988ec5c1a36ff1b59297de0/extensions/telegram/src/telegram-ingress-coalescing.e2e.test.ts#L184).

Mattermost already avoids the lane-stall failure mode: [monitor-resources.ts](../src/mattermost/monitor-resources.ts#L54) keeps ordered, sanitized failure facts, and [monitor-posts.ts](../src/mattermost/monitor-posts.ts#L315) continues dispatch with the unavailable attachment placeholder. Current tests describe these facts as visible “to the agent” in [monitor-resources.test.ts](../src/mattermost/monitor-resources.test.ts#L38). The inspected path does not guarantee a separate user-visible notice when a file could not be read, so users can receive a reply without an explicit indication that an attachment was unavailable.

If deterministic feedback is desired, add one short, sanitized notice at the existing authorized source-post boundary after media hydration, then continue the same turn. Preserve partial-failure counts and safe filenames; do not expose URLs or transport errors, retry the ingress row for a download failure, or start a second agent turn. This is a smaller transparency improvement than Telegram's queue fix because Mattermost already continues processing.

## Reviewed behavior with no Mattermost port identified

| Upstream behavior | Downstream comparison |
| --- | --- |
| Sender-scoped steer. The Discord extension diff adds no such queue policy. The closest shared 11.7 change preserves same-requester guidance joining a completion continuation in [Gateway chat-message injection](https://github.com/openclaw/openclaw/blob/c2676e21c881d4388b563a02ade00d51c7d4203d/src/gateway/server-methods/chat-send-message-injection.ts). | Mattermost finalizes each inbound sender as `SenderId` in [monitor-event-plan.ts](../src/mattermost/monitor-event-plan.ts#L100), and its [reaction lifecycle](../src/mattermost/monitor-turn-reactions.ts#L39) correlates posts that join one active session. Queue admission itself remains host-owned and session-scoped. Do not infer a new per-sender isolation policy from the shared same-requester continuation change; no plugin port is established. |
| Slack visible `sessions_spawn` completions preserve whether the original request was top-level or inside a thread. The helper is [resolveRequesterDeliveryThreadId](https://github.com/openclaw/openclaw/blob/e31bbf056de321127988ec5c1a36ff1b59297de0/src/agents/spawn-requester-origin.ts#L157), used by [sessions-spawn-visible.ts](https://github.com/openclaw/openclaw/blob/e31bbf056de321127988ec5c1a36ff1b59297de0/src/agents/tools/sessions-spawn-visible.ts#L640). | Mattermost carries an actual post/thread root through [monitor-context.ts](../src/mattermost/monitor-context.ts#L134) and its inbound context; a top-level post has no `root_id`, and a threaded post has its real root. Slack's special case is for a top-level timestamp reused as a reply anchor, so no equivalent Mattermost repair was found. |
| Slack Socket Mode 3.2 reconnect and shutdown handling in [provider-support.ts](https://github.com/openclaw/openclaw/blob/7c9023c65160f5e71004e4fc043d69ae0ad2e026/extensions/slack/src/monitor/provider-support.ts#L65). | Mattermost owns a separate abortable exponential-backoff loop in [reconnect.ts](../src/mattermost/reconnect.ts#L30), with coverage in [reconnect.test.ts](../src/mattermost/reconnect.test.ts#L21). Slack SDK callback-shape patches do not transfer. |
| Discord and Telegram `/think` menus now obtain read-only model-menu data through the shared native-command registry; see [commands-registry.ts](https://github.com/openclaw/openclaw/blob/e31bbf056de321127988ec5c1a36ff1b59297de0/src/auto-reply/commands-registry.ts#L397). | Mattermost dynamically registers host native commands through [native-commands.ts](../src/mattermost/native-commands.ts#L134) and delegates command behavior to core. It has no Discord/Telegram provider-side catalog loader to replace. Keep the catalog lifecycle host-owned. |
| Matrix progress streaming avoids editing a text-only preview into a final image reply, which would lose its caption/media. See [handler-reply-dispatcher.ts](https://github.com/openclaw/openclaw/blob/e31bbf056de321127988ec5c1a36ff1b59297de0/extensions/matrix/src/matrix/monitor/handler-reply-dispatcher.ts#L280). | Mattermost's [draft finalizer](../src/mattermost/monitor-draft-delivery.ts#L125) already refuses an in-place final edit for non-TTS media and routes through normal delivery; its [media-final test](../src/mattermost/monitor-draft-delivery.test.ts#L454) verifies this path. Normal delivery retains the caption in [reply-delivery.ts](../src/mattermost/reply-delivery.ts#L203). No caption port is needed. |
| Slack unauthorized button responses explicitly set `replace_original: false` in [interactions.block-actions.ts](https://github.com/openclaw/openclaw/blob/e31bbf056de321127988ec5c1a36ff1b59297de0/extensions/slack/src/monitor/events/interactions.block-actions.ts#L71). | Mattermost returns non-mutating ephemeral callback feedback and keeps the original question; [monitor-interactions.question.test.ts](../src/mattermost/monitor-interactions.question.test.ts#L263) covers policy denial. |
| Telegram callback-message fallbacks keep old controls until replacement delivery succeeds in [bot-handlers.callback-actions.ts](https://github.com/openclaw/openclaw/blob/e31bbf056de321127988ec5c1a36ff1b59297de0/extensions/telegram/src/bot-handlers.callback-actions.ts#L77). | Mattermost updates controls on the existing post and invalidates retired signed callback identities; [typed-callback.test.ts](../src/mattermost/typed-callback.test.ts#L115) covers replacement and stale-callback rejection. The Telegram media/business-message send order does not directly transfer. |

Other 11.7 fixes remain provider-specific: Matrix Element X poll event types, Discord forum-tag persistence and voice interruption policy, Telegram numeric polling-offset recovery and forwarded-message coalescing, and the Slack Socket Mode SDK 3.2 lifecycle. No equivalent user-facing Mattermost defect was established for these paths.

### Conditional probe, not a recommendation: quoted bot mentions

Matrix 11.7 strips its protocol-injected rich-reply fallback before mention detection and agent text in [handler-helpers.ts](https://github.com/openclaw/openclaw/blob/e31bbf056de321127988ec5c1a36ff1b59297de0/extensions/matrix/src/matrix/monitor/handler-helpers.ts#L16). Mattermost's current activation check scans the raw post text in [monitor-activation.ts](../src/mattermost/monitor-activation.ts#L71). This is not yet evidence of the same bug: Matrix's fallback is protocol-generated, while Mattermost quote text may be user-authored. Capture an actual Mattermost quote payload before considering any stripping; never remove arbitrary Markdown blockquotes based on the Matrix fix alone.

## Ownership and delivery boundary

This audit covers cross-channel behavior. The official Mattermost attachment
hostname policy belongs to the 11.7 compatibility update. The follow-up
packaging and deployment checks are recorded with the artifact.
