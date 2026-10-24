# Cross-channel features worth adapting to Mattermost

Research date: 2026-10-20. Compare the official OpenClaw `v2026.10.5`
Slack, Telegram and Discord implementations against this standalone plugin's
working tree, including the pending 10.5 adaptation. This is source research,
not a live deployment assessment.

## Recommended scope

| Priority | Candidate | Benefit | Relative implementation size |
| --- | --- | --- | --- |
| 1 | Explicit silent delivery | Quiet cron reports and intermediate progress | Small to medium |
| 2 | Per-channel/per-sender tool policy | Give reporting and development rooms different tool access | Medium |
| 3 | Edit/delete event awareness | Tell the agent when source material changes | Medium |
| 4 | Multiple attachments in one Mattermost post | Keep a report and its files together | Medium |
| 5 | Complete thread-to-work-session binding | Continue a specific agent/ACP task inside its thread | Large |
| Useful follow-up | Top-level room history recovery | Restore recent room context after restart | Medium |
| Useful follow-up | Explicit file download action | Let the agent retrieve a selected older attachment | Medium |
| Later | Richer native message layouts | Structured summaries with sections, context and separators | Medium |
| Optional | Persistent multi-user polls | Team voting rather than a requester clarification | Large |

These sizes are design judgments, not time estimates. Each candidate needs its
own bounded implementation and tests before shipping.

## 1. Explicit silent delivery

Telegram passes a caller's `silent` option to `disable_notification` when
sending text, media and polls:

- [Outbound adapter](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/telegram/src/outbound-adapter.ts).
- [Text sender](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/telegram/src/send-message-text.ts).
- [Media sender](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/telegram/src/send-message.ts).
- [Poll sender](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/telegram/src/send-special.ts).

Mattermost already has the native server operation needed for the same idea.
The pinned 12.0.0 REST handler parses `?silent=true`; the app authorizes
integration authors and sets the notification policy. Client-supplied
notification props are sanitized, so arbitrary props are not the right API:

- [Mattermost REST create](https://github.com/mattermost/mattermost/blob/v12.0.0/server/channels/api4/post.go#L149).
- [Mattermost app policy](https://github.com/mattermost/mattermost/blob/v12.0.0/server/channels/app/post.go#L243).

Current gap: this plugin's send options do not expose silent delivery.
Suggested behavior: an explicit per-send option, defaulting to current behavior.
Allow intermediate progress or a scheduled report to opt in; keep approval and
question notification policy deliberate.

Implementation must carry the option through message-tool, payload and final
delivery paths. The current client recognizes post dispatch with an exact
`path === "/posts"` check; adding a query string without fixing that recognition
would bypass its post-specific receipt and ownership handling. Test both
ordinary and silent accepted/unknown sends. Do not silently retry a post after
an ambiguous response.

## 2. Per-channel/per-sender tool policy

Discord and Telegram implement the channel `groups.resolveToolPolicy` adapter
using the shared `resolveScopeToolsPolicy` machinery:

- [Discord group policy](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/discord/src/group-policy.ts#L97).
- [Telegram group policy](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/telegram/src/group-policy.ts#L69).

Current gap: Mattermost supports channel instructions and skill filters, but
its [group schema](../src/config-schema-core.ts) explicitly omits `tools` and
`toolsBySender`. Its group adapter in [the channel module](../src/channel.ts)
does not implement `resolveToolPolicy`. A skill filter is not a tool policy.

This would let a reporting channel allow selected read tools while a development
channel allows a different set, with stable-sender overrides where desired.
The host already falls back to a generic flat-group resolver:
[tool-policy selection](https://github.com/openclaw/openclaw/blob/v2026.10.5/src/agents/agent-tools.policy.ts#L591).
First verify whether exposing the schema fields and types is sufficient for
Mattermost's stable channel IDs. Add a plugin resolver only if its normalization
needs one; forward the complete context, including `senderPolicyMode`.
Reuse the account/exact-channel/wildcard scope rules.
Preserve the host's policy intersection so a channel rule cannot broaden a
globally denied tool. Test omitted policy, inherited defaults, explicit channel
rules, stable sender matching and restrictive combinations through real tool
selection.

## 3. Edit/delete event awareness

Slack explicitly classifies `message_changed` and `message_deleted` events
and builds a deduplicated system notice:

- [Subtype handler](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/slack/src/monitor/events/message-subtype-handlers.ts).
- [Event dispatch and authorization](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/slack/src/monitor/events/messages.ts).

Current gap: [Mattermost WebSocket handling](../src/mattermost/monitor-websocket.ts)
handles reactions and `posted`, then ignores other events. It does not forward
`post_edited` or `post_deleted` into the agent's context.

A useful first version would deliver a bounded, deduplicated notice to the
correct channel/thread session after applying the existing sender and channel
checks. Ignore this bot's own streaming/task-card edits to avoid feedback.
Decide separately whether pending history should replace edited text or remove
deleted text. Slack's notice is not evidence of a general ability to rewrite
already consumed transcripts, cancel work or rerun an answer automatically.

## 4. Multiple attachments in one post

Discord's payload delivery handles a collection of media URLs:
[outbound payload](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/discord/src/outbound-payload.ts).
The transferable idea is preserving the relationship between one answer and
several files; the exact Discord API is not portable.

Current gap: the Mattermost message-tool send explicitly rejects more than
one attachment in [the channel adapter](../src/channel.ts).
[The sender](../src/mattermost/send.ts) uploads one file and creates
`fileIds = [fileInfo.id]`. Existing reply delivery can send multiple media
items as separate sends; this proposal is specifically one Mattermost post
containing several files.

Mattermost's native post supports a `file_ids` array:
[post model](https://github.com/mattermost/mattermost/blob/v12.0.0/server/public/model/post.go).
Keep the provider's count/size limits and existing local-file/SSRF controls.
Upload all permitted files before creating the post, and explicitly define
partial-upload failure. An accepted post with an unknown identity must retain
the current no-blind-retry behavior.

## 5. Complete thread-to-work-session binding

Discord and Telegram expose channel-specific binding identity and lifecycle
adapters, rather than treating a child thread as an ordinary new session:

- [Discord binding adapter](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/discord/src/thread-bindings-channel.ts).
- [Discord registration and configured binding matching](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/discord/src/channel.ts).
- [Discord subagent delivery hooks](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/discord/subagent-hooks-api.ts).
- [Discord current/child placement adapter](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/discord/src/monitor/thread-bindings.session-adapter.ts).
- [Telegram binding identities](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/telegram/src/channel.ts#L623).
- [Slack configured conversation bindings](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/slack/src/channel.ts#L467).

Important existing support: `createChatChannelPlugin` already supplies
`supportsCurrentConversationBinding: true` by default. Mattermost uses that
factory. It would be incorrect to describe it as having no binding capability:
[SDK factory](https://github.com/openclaw/openclaw/blob/v2026.10.5/src/plugin-sdk/core.ts#L705).

The plugin still resolves a channel route and derives an ordinary thread
session in [event planning](../src/mattermost/monitor-event-plan.ts) and
[thread context](../src/mattermost/monitor-context.ts). It lacks the specialized
native root/parent normalization, configured binding matching and lifecycle
wiring demonstrated by these channels.

Suggested user experience: dedicate an existing Mattermost thread to a selected
agent/ACP work session; subsequent input and result delivery return to that
session and thread. Start with current-thread binding, then separately consider
automatic child-thread creation. Trace the complete host routing path before
promising `/focus`, ACP spawn or automatic subagent placement.

This is a larger change. Test independent threads, channel versus root identity,
account isolation, unbinding, session reset, restart restoration and idle/max-age
expiry. Reuse the published host binding service; do not copy core state or
the other platform's thread manager wholesale.

## Top-level room history recovery

Slack fetches authoritative recent history for room and thread turns, with sender
policy, context visibility, size and freshness checks:
[room history preparation](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/slack/src/monitor/message-handler/prepare-room-history.ts)
and [integration](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/slack/src/monitor/message-handler/prepare.ts).

Mattermost already recovers native thread context. However,
[post handling](../src/mattermost/monitor-posts.ts) invokes `recoverThread`
only when an effective thread root exists, and ordinary recent room history
is held in `channelHistories` in memory. This proposal adds bounded platform
history for a fresh top-level room turn after restart; it does not imply that
the durable session transcript or the ingress queue is currently lost.

Reuse `fetchMattermostChannelPosts` from [the client](../src/mattermost/client.ts).
Filter senders and visibility using the same policy as live/history input;
exclude current and debounced message IDs, bot progress/card posts and future
timestamps. Preserve session-incarnation checks and abort/timeout limits.
This is useful when people discuss a topic in a room and mention the bot later.
It is distinct from the existing thread backfill.

## Explicit file download action

Slack advertises `download-file` and verifies refreshed file metadata against
the authorized channel/thread before saving it to the media store:

- [Action discovery](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/slack/src/message-actions.ts).
- [Download and share proof](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/slack/src/actions.ts#L606).
- [Action authorization](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/slack/src/action-runtime.ts#L829).

Mattermost already downloads attachments from the current or referenced input.
Its [thread tool](../src/mattermost/thread-tool.ts) returns file metadata, while
the message-action adapter does not expose an explicit file-download action.
An agent that discovers an older file through a thread read or search cannot
use that action to retrieve the file on demand.

The client already has `fetchMattermostFileInfo` and `downloadMattermostFile`.
Add a narrow action that proves the file belongs to a post in the authorized
channel, applies existing read scope and media limits, and saves through the
trusted media store. A file ID alone must not grant access to another channel.
This is a smaller extension than designing a new media retrieval subsystem.

## Later: richer native message layouts

The existing Mattermost presentation declaration supports buttons, selects and
context, while divider is false. [Presentation normalization](../src/normalize.ts)
renders the presentation fallback text and maps choice controls to native
actions. This is already useful interactive support.

Slack explicitly advertises separators, charts and tables:
[presentation capabilities](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/slack/src/presentation.ts).
The remaining opportunity is structured native layout: sections, fields,
headers, separators, images or a compact report card with actions. Slack Block
Kit and Discord component/container rendering are useful design references;
their provider-specific payloads cannot be copied into Mattermost.

Preserve readable text fallback and the existing server-version detection.
Verify mobile rendering separately from web rendering. Never advertise a
capability to the model until the adapter actually renders and routes it.
This is a lower priority than delivering correct content and session ownership.

## Optional: persistent multi-user polls

Telegram has a real poll sender plus durable origin/answer routing, including
restrictions on anonymous polls and group membership:
[poll sender and registry handling](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/telegram/src/send-special.ts).
Discord exposes canonical poll delivery as well:
[action discovery](https://github.com/openclaw/openclaw/blob/v2026.10.5/extensions/discord/src/channel-actions.ts).

Mattermost's [form tool](../src/mattermost/form-tool.ts) currently asks an
ordinary requester question through the host question service. It waits at most
120 seconds and explicitly documents invalidation across Gateway restart.
That is a different contract from a multi-user vote that remains open for hours.

Only build polls if team voting is desired. A Mattermost adaptation would need
an available poll provider or plugin-owned controls and durable poll/vote state,
voter authorization, duplicate/change-vote rules, close/expiry behavior and
restart recovery. Existing select/matrix controls can supply UI pieces; they do
not provide the lifecycle by themselves.

## Features already covered or unsuitable for direct copying

This plugin already has model hints, server-aware long-message limits,
buttons/selects, multi-select/matrix dialogs, canonical question resolution,
approvals and protected secret entry, bounded search/thread reads, edit/delete,
pin/reaction actions, thread backfill, referenced attachments, streaming,
task progress cards and restart recovery. See [README](../README.md) and
[the channel adapter](../src/channel.ts). Compare behavior before proposing
another implementation of these features.

Slack-only assistant API streams, Telegram topic/sticker/voice-note transports,
and Discord guild roles/voice/components are platform contracts. Adapt a useful
interaction pattern where Mattermost has an equivalent; do not copy the
platform-specific payload or its assumptions.

No runtime code, configuration, capability declaration, server, deployment,
service restart or external message was changed during this research.
