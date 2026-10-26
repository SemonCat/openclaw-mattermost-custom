# SemonCat custom Mattermost plugin

This is a maintained downstream Mattermost plugin for OpenClaw. It is a
separate plugin identity from the official bundled `mattermost` plugin:

- Plugin id: `mattermost-custom`
- Package name: `openclaw-mattermost-custom`
- Runtime channel id: `mattermost`
- Preference: `preferOver: ["mattermost"]`

The custom plugin keeps the existing `channels.mattermost` configuration key.
When it is installed and selected, OpenClaw prefers it over the bundled
official plugin and disables the lower-priority owner in the effective runtime
configuration. The two plugins may both be installed and available, but they
must not be enabled as simultaneous Mattermost channel owners.

### Channel default model

Run these commands inside a Mattermost channel:

```text
/channel_model
/channel_model openai/gpt-5.6-terra
/channel_model default
```

The setting is stored in
`channels.modelByChannel.mattermost.<mattermost-channel-id>`. The command
preserves existing channel-header content and manages only its own first line.
After saving the setting, it clears the interactive parent channel session's
model/provider/runtime pin so newly created threads immediately use the new
channel default. Existing threads remain independent and keep their own
session-level `/model` overrides.

This package is private and is not published to npm or ClawHub. Build a
self-contained plugin artifact, then install that artifact into OpenClaw's
managed plugin directory:

```bash
mkdir -p /tmp/openclaw/mattermost-custom
npm run build
npm pack --omit=dev --pack-destination /tmp/openclaw/mattermost-custom
openclaw plugins install \
  /tmp/openclaw/mattermost-custom/openclaw-mattermost-custom-2026.10.7.tgz --force
```

Do not use `plugins install --link` or add this source checkout to
`plugins.load.paths` on a live Gateway. A linked full OpenClaw checkout can
resolve Plugin SDK runtime code from the checkout instead of the installed
Gateway version, defeating the plugin boundary and allowing incompatible core
state migrations.

If the bundled plugin is explicitly enabled in the operator config, switch
owners explicitly:

```bash
openclaw plugins disable mattermost
openclaw plugins enable mattermost-custom
```

To return to the official implementation:

```bash
openclaw plugins disable mattermost-custom
openclaw plugins enable mattermost
```

No `channels.mattermost` migration is needed in either direction. Restart the
Gateway after changing plugin enablement.

## Downstream behavior

Compared with the official plugin, this build preserves:

- Automatic Mattermost 12 message limits for ordinary replies, message-tool
  delivery, streaming previews, and restart recovery.
- Model-facing hints for the active text limit and implemented interactive
  controls.
- Dynamic native slash commands from core, skills, and installed plugins.
- `/channel_model` for reading, setting, or resetting a channel-scoped default
  model while keeping a managed model label in the Mattermost channel header.
- Root-first slash-command names with deterministic `oc_` conflict fallbacks.
- Safe Mattermost command reconciliation without mutating foreign commands.
- Thread-aware slash-command callbacks and replies.
- Ack and lifecycle status reactions, including same-session steer correlation.
- Unknown-send reconciliation for durable text delivery, using opaque signed
  post metadata rather than matching visible message text.
- Message edit, delete, and pin actions enabled by default, plus reaction reads.
- Owner-only `/move_thread #channel` verified copy-then-delete moves without the
  licensed Mattermost move endpoint.
- Durable plan-backed task progress cards that remain after the final answer and
  continuously update linked child work-session progress until those subtasks settle.
- Native exec, plugin, and system-agent approval cards with canonical Gateway resolution.
- Native secret-entry dialogs that submit password fields directly to OpenClaw's protected store.
- Native `ask_user` option buttons that resolve the original Gateway question without a second agent turn.
- Native Mattermost 12 multi-select and multi-question dialogs, plus a
  `mattermost_form` tool for checkbox groups and row/column matrices.
- Durable interactive callback admission and replay across Gateway restarts.
- Bounded Mattermost thread-history recovery after Gateway restart or session reset.
- The Mattermost slash-trigger length cap fix.
- Mention-prefixed text commands such as `@bot /new`, without debounce or prose misrouting.
- Configurable mention gating for threads rooted in the receiving bot's own posts.
- Immediate recovery from transient channel/user lookup failures instead of negative caching.
- Live `messages.inbound` debounce updates without replacing the Mattermost connection.
- Native model/runtime confirmation with host validation and persisted-selection readback.
- Backlog-aware text debounce with sender/thread isolation and bounded batches.
- Explicit per-send silent delivery on servers supporting Mattermost's silent API.
- Channel/sender tool policies through the published host's shared policy pipeline.
- Up to ten ordered attachments on one post, including ordinary inbound replies.

This artifact targets the published OpenClaw `2026.10.7` SDK and requires an
OpenClaw host at least that version. Its Node contract follows that release:
`>=24.22.1 <25 || >=26.12.1`. Development checks use Node `26.12.1`; this does
not establish the runtime version of an installed Gateway.

When `messages.statusReactions.enabled` is true, received posts show the configured
acknowledgement, followed by event-driven thinking, tool, and compaction reactions.
Successful delivery leaves a completion reaction; actual dispatch or delivery
failures leave an error reaction. Terminal settlement clears the earlier reaction
trail. Elapsed silence adds no hourglass or warning markers and does not imply that
work has stalled. Steered posts follow their active owner; queued follow-ups keep
their receipt until admission and settle with their own turn. Without explicit
status-reaction enablement, posts retain the existing plain acknowledgement.
Task cards and progress previews continue to carry the detailed task state.
Source-bound run starts establish independent post ownership even when the
configured queue mode predicted steering. Hosts advertising
`queued-source-lifecycle-v1` send admitted/tool/settled reactions to the original
source posts using their own delivery and error facts; refreshed renderer
callbacks cannot promote a different waiting source. Admission retries retain
the receipt until that source runs and reaches a terminal outcome. Older hosts
retain the legacy queue callback path.

Mutable message-tool actions and bounded search are enabled by default for this
personal downstream plugin. Each gate can still be disabled globally or per account:

```json
{
  "channels": {
    "mattermost": {
      "actions": {
        "messages": false,
        "search": false,
        "reactions": true,
        "edit": true,
        "delete": true,
        "pins": true
      }
    }
  }
}
```

`messages` remains opt-in for channel reads, `search` defaults to enabled independently,
`reactions` enables add/remove/list, and action gates can be overridden per account.

### Message length and model hints

Successful Mattermost REST responses supply `X-Version-ID`. Once a response
identifies Mattermost 12 or newer, the default per-post text limit becomes
262,144; older or not-yet-identified servers use 16,383. Normal bot authentication
hydrates this information before inbound reply planning. Later REST responses
refresh it after server upgrades or downgrades. A newly started standalone sender
can use the conservative limit until its first successful response.

The plugin measures UTF-16 code units, matching OpenClaw's chunkers, and preserves
surrogate pairs at chunk boundaries. Ordinary Chinese and ASCII characters each
use one unit; many emoji use two. This is conservative relative to the server's
Unicode character count.

`channels.mattermost.textChunkLimit` and account-level overrides remain supported.
An explicit smaller value is preserved; a larger value is clamped to the observed
server limit. Omit this setting to use automatic detection. The former 4,000-unit
default and streaming ceiling no longer apply. Separate assistant/tool activity
boundaries and explicit newline chunking still follow their existing behavior.

Model hints advertise the effective account limit, presentation buttons,
single-select menus, native `ask_user` forms, `mattermost_form`, and the host's
protected secret-entry flow.

### Native choice forms

On a verified Mattermost 12+ server, ordinary `ask_user` prompts with multiple
questions or `multiSelect: true` receive a **Fill form** button. Clicking it
opens a mobile-compatible dialog. Multi-select questions use multi-select
menus; matrices show one menu per row. Single-choice questions use dropdowns.
The original question text and optional Other input are preserved.
The **Web form** button opens Mattermost 12's native checkbox groups and
matrices instead. Multiple questions with identical choices can share a native
matrix when they do not require Other input. Existing single-choice buttons and
protected password dialogs keep their existing handling.

The mobile app has a separate renderer from the server/web client. Its reviewed
v2.44.1 renderer treats `checkbox_group` and `checkbox_matrix` as text fields,
but supports `select` with `multiselect: true`. The default form uses those
supported controls on every client rather than guessing the user's platform
from a server-to-server callback. Both layouts return identical canonical
answers. Multi-select wire values use opaque tokens, so the mobile app's
comma-separated serialization cannot split commas inside an original answer.

The form submits all question answers to the original pending Gateway question.
It does not create a second inbound agent turn. Unknown/older servers and
unavailable or unsupported questions retain the host's text/Web UI fallback.
Native checkbox groups support at most 50 options; larger canonical questions
use that fallback.

For an explicit matrix or a larger set of checkbox choices, the model can use
`mattermost_form` in the current trusted Mattermost conversation:

```json
{
  "title": "Deployment choices",
  "fields": [
    {
      "id": "checks",
      "label": "Preflight checks",
      "type": "select",
      "multiple": true,
      "options": [
        { "value": "backup", "label": "Backup" },
        { "value": "smoke", "label": "Smoke test" }
      ]
    },
    {
      "id": "access",
      "label": "Access matrix",
      "type": "matrix",
      "multiple": false,
      "rows": [
        { "value": "api", "label": "API" },
        { "value": "web", "label": "Web" }
      ],
      "columns": [
        { "value": "read", "label": "Read" },
        { "value": "write", "label": "Write" }
      ]
    }
  ]
}
```

The waiting tool returns choice arrays and structured matrix rows, for example
`{"checks":["backup","smoke"],"access":{"api":["read"],"web":["write"]}}`.
Matrix fields default to multiple choices per row; `multiple: false` uses one
choice per row. Set `optional: true` to allow an empty field or unanswered rows.
There are at most three fields, 50 choices per select, and 30 rows by 10 columns
per matrix. IDs use lowercase letters, digits and underscores, starting with a
letter. Display labels are safely shortened to the server's UTF-8 byte limit.
Forms accept ordinary choices only; credentials use the protected secret flow.

The tool is bound to the host-provided account, channel, thread and session;
its arguments cannot choose a different destination. The default wait is 90
seconds, configurable with `timeoutSeconds` from 15 to 120. The host's tool/run
deadline can end the wait earlier. Closing a dialog leaves the question pending
so it can be reopened; tool cancellation or timeout retires it. Gateway
questions are transient: a Gateway restart invalidates the question and its
waiting tool. Reopening a dialog after monitor/controller reconstruction works
while the original Gateway question still exists; no local dialog registry is
required.

Callbacks verify a signed current bot control, the clicking user's channel
access, the original session, schema and expiry before resolving. They reject
foreign, changed and stale submissions, and the Gateway arbitrates concurrent
answers. A lost resolution response is read back rather than blindly replayed.
Terminal question finalization removes the form control.

The plugin uses the published SDK's authenticated loopback `GatewayClient` with
only `operator.questions` scope. It does not use the official-plugin-only
`runtime.gateway` permission or create device credentials. Gateway shared
token/password authentication must resolve in the active runtime environment;
TLS uses normal certificate validation. Native dialogs need a user click's
short-lived trigger, so the model cannot open a modal without the button click.
The manifest adds `mattermost_form` to the declared tool capability surface;
deployment must review that capability change explicitly.

Set `channels.mattermost.requireMentionInBotThreads: false` to accept unmentioned
follow-ups in threads whose root post was sent by the receiving bot. Set it to
`true` to require explicit activation there even after the bot has participated.
Omitting it preserves the existing mention and participation behavior.

Account settings override the channel-wide value. For an individual channel,
`groups.<channelId>.requireMentionInBotThreads` overrides
`groups["*"].requireMentionInBotThreads`, then the account value. Unavailable,
deleted, cross-channel, or non-root posts retain the existing mention behavior;
sender and channel access restrictions still apply.

### Ingress and conversation links

Deferred Mattermost ingress releases its lane so later input in that channel/thread
can reach core while the earlier claim remains in the durable SQLite spool. Release
is not completion: existing heartbeat, adoption, cancellation, retry and restart
recovery still own the earlier input. Core decides follow-up/steer ordering.

When inbound debounce is enabled, a quiet text buffer checks the durable lane backlog
before flushing. Compatible input from the same sender/channel/thread can join the
batch; commands, system posts, attachments, other senders and other threads do not
extend it. Batches stop at 12 posts or 50,000 text characters. The published SDK's
maximum wait (five debounce windows) still applies even if the backlog reader stalls
or input keeps arriving. This does not enable debounce when its configured delay is zero.

OpenClaw 10.5 retires `conversationLink` from session storage and Gateway session
rows, and passes only session identity to Control UI header accessories.
`sessions.describe` cannot recover the former first-session launch link.
The Web UI Mattermost origin shortcut is therefore unavailable on this build.
The obsolete browser entry, manifest declaration, and unused inbound origin
metadata have been removed. This reduces the candidate's declared Control UI
capability surface; deployment must review that manifest change explicitly.
Restoring the shortcut requires a separately designed durable origin source.
Search result permalinks, authorized source-link hydration, native thread routing,
and task-card child session links keep their existing purpose and behavior.

### Channel instructions and skill availability

Configure trusted instructions and available skills by stable Mattermost channel
ID, using the same effective account `groups` map as mention gating:

```json
{
  "channels": {
    "mattermost": {
      "groups": {
        "*": { "systemPrompt": "Explain assumptions before proposing changes." },
        "cccccccccccccccccccccccccc": {
          "systemPrompt": "Use this channel for engineering support.",
          "skills": ["code-review"]
        },
        "ssssssssssssssssssssssssss": { "skills": [] }
      }
    }
  }
}
```

Each exact-channel field inherits its omitted value from `groups["*"]`. An
account without its own `groups` inherits the channel-wide map; an account that
defines `groups` replaces that map, then applies its own exact/wildcard rules.
Omitted `skills` preserves core behavior; `skills: []` makes no skills available.
Use canonical skill names, rather than slash-command aliases. Native named skill
commands and `/skill <name-or-alias>` check this filter before starting work.
Ordinary native commands remain available under their existing authorization.

Configured instructions and skill filters follow inbound posts, native slash
turns, and generic interaction turns through their normal channel/thread route.
Reaction session events retain that route; reactions do not gain a new independent
agent-turn trigger. DMs receive neither group field. Channel headers, purposes,
quoted posts, and menu values do not become configured instructions.

**A skill filter is not a security sandbox.** It controls skill availability and
named skill invocation, not tool permissions or what an agent can accomplish
using other tools. Existing sender and command authorization still applies.

### Channel and sender tool policies

The same effective account `groups` map also accepts the SDK's `tools` and
`toolsBySender` fields:

```json
{
  "channels": {
    "mattermost": {
      "groups": {
        "*": { "tools": { "deny": ["exec"] } },
        "cccccccccccccccccccccccccc": {
          "tools": { "allow": ["read", "write"] },
          "toolsBySender": {
            "id:uuuuuuuuuuuuuuuuuuuuuuuuuu": { "allow": ["read"] }
          }
        }
      }
    }
  }
}
```

Use stable Mattermost IDs with `id:` or `channel:mattermost:` keys. The shared
resolver prefers channel-qualified IDs, then IDs, then other typed identities,
then `"*"`. It checks sender policy before the same entry's `tools`, then falls
back to the wildcard entry when no exact policy exists. An exact `tools: {}`
is an explicit empty policy and stops that fallback. An empty allow list does
not mean deny-all; use explicit `deny` rules for restrictions. These policies
remain inside the host's global, agent, and runtime tool restrictions: a channel
allow cannot restore a globally denied tool.

Accounts inherit or replace the groups map using the published SDK's account
rules. A nonempty account map replaces the channel-wide map. With multiple
accounts an explicit empty account map also replaces it; the SDK preserves its
legacy empty-map inheritance for a single configured account. Omitted policy
fields preserve host behavior. Null policy objects and invalid field types are
rejected. The shared schema still accepts legacy untyped sender keys, but the
runtime resolver rejects them and requests `openclaw doctor --fix`; use typed
keys in new configuration. Scheduled/internal sender-independent selection uses
the host's `senderPolicyMode: "never"`. Skills remain a separate filter.

### Inbound attachment size limit

Each directly attached inbound file, including a video, uses the effective
`channels.mattermost.mediaMaxMb` limit. An account's
`channels.mattermost.accounts.<accountId>.mediaMaxMb` overrides the channel
setting; accounts without an override inherit it. If neither is set,
`agents.defaults.mediaMaxMb` applies, with an 8 MiB fallback when all are unset.
The unit is MiB (1,048,576 bytes).

For an explicit per-file ceiling of 1 GiB:

```json
{
  "channels": {
    "mattermost": {
      "mediaMaxMb": 1024
    }
  }
}
```

This raises the download/staging ceiling; it does not guarantee that a model
can read a video or that its context and media-processing limits accept the
file. Mattermost server and proxy upload limits still apply. Oversize inbound
files retain their ordered metadata slots, and the agent-facing notice identifies
the attachment position and effective byte limit; successfully downloaded
siblings remain available. Other download failures retain the generic
unavailable notice.

Referenced attachment hydration keeps its separate aggregate cap of at most
8 MiB and its existing file/time bounds, even when direct attachments allow
1024 MiB. Outbound grouped-send budgets keep their existing behavior.

### Silent sends and grouped attachments

Message sends accept the host's per-send `silent: true` option. Outbound text,
media and payload adapters carry it to `POST /posts?silent=true`; omitted or false
keeps normal delivery. There is no account-wide silent default. Approval,
question, and other interactive delivery remains normal unless that individual
send explicitly requests silence. Mattermost 12 documents that silent posts stay
visible and emit WebSocket events, while suppressing notifications and unread/
mention increments. Only integration authors may request it; a human/PAT sender
can receive HTTP 403. The plugin reports that rejection without retrying as a
normal notification.

For one post with multiple files, pass `mediaUrls` or `attachments` entries with
supported media/path fields. Ordinary inbound reply collections use the same
grouped sender. All authorized files upload in order before one post receives
their ordered `file_ids`. The limit is ten files, with a combined byte budget
of the smaller of the effective media limit and 20 MiB (20 MiB when no explicit
limit exists). Single-file behavior retains its existing SDK limit and remote
URL fallback. Grouped sends fail before post creation when any upload fails;
they never silently create a partial attachment post. Local-root, SSRF,
cancellation, and current sender checks apply between awaited operations.

The first post carries the attachments, the first permitted Markdown text
chunk, and supported presentation controls. Text overflow follows as text-only
posts using the effective server/account limit and configured streaming chunk
mode. Receipts preserve every known post identity, including when a later
chunk fails. An accepted create with an unreadable/missing identity stops
delivery without a blind create retry or deleting accepted attachments.
Failed preparation can leave uploaded, unattached files: the verified provider
file API has no standalone delete route, so cleanup remains server-managed.
No cleanup REST endpoint or plugin capability was added.

Signed delivery markers describe the actual post count when a single durable
intent expands into caption overflow. For an already counted multi-payload
intent that expands locally, markers are omitted rather than signing an
incorrect batch count. Media unknown-send reconciliation remains unsupported;
accepted receipts and accepted-without-ID failures keep their existing meaning.

### Native model and runtime picker

`/model` and `/models` browse the host's available models. Selecting a model opens
a confirmation view with the runtimes the host advertises for that exact model.
Choosing a runtime applies the model/runtime pair to the routed session. Browsing
does not mutate either setting, and only the user who opened the signed picker can
confirm it. Direct `/oc_model <provider/model> --runtime <runtime>` commands remain
available.

Every confirmation rebuilds the session-aware catalog, checks that the model/runtime
pair is still available, and delegates validation and persistence to the host.
The confirmation reads back the persisted selection and reports a mismatch instead
of claiming success when a newer update won. Explicit selections of the global
default still retain their Mattermost session pin and selected runtime.

An authoritative empty runtime list offers no apply button. If the host does not
supply runtime choices for a model, the view offers a model-only confirmation;
the host retains responsibility for validating the current runtime.

### Bounded message search

The `search` message action is enabled by default. Set
`channels.mattermost.actions.search: false` to disable it. Search does not require
or enable `actions.messages`, which remains `false` by default.
Per-account action settings override the channel-wide value; discovery advertises
search when an enabled account permits it, and dispatch checks the selected account.
Omitted per-account action fields inherit the channel-wide setting, including
when the account has an empty `actions` object.

Example action arguments (the target can be omitted when the tool supplies the
current Mattermost channel):

```json
{
  "action": "search",
  "channel": "mattermost",
  "target": "channel:cccccccccccccccccccccccccc",
  "query": "deployment rollback",
  "limit": 20,
  "senderId": "uuuuuuuuuuuuuuuuuuuuuuuuuu"
}
```

The installed host restricts agent search from this standalone plugin to the
exact current conversation/account. Direct operator/provider calls still undergo
the existing read authorization; provider bot membership alone grants no delegated
read authority. Search requires one team-backed channel and never offers team-wide,
cross-DM, or delegated cross-private-channel search.

Queries accept 1–200 characters of letters, numbers, and spaces. Operators such as
`in:`, `from:`, `OR`, `AND`, and `NOT` are rejected; the plugin constructs the
channel-name scope internally. The optional stable `senderId` filter is local to
the response. `limit` defaults to 20 and accepts 1–50. Results contain post and
thread IDs, safe snippets, timestamps when available, and same-instance permalinks,
without raw post properties. Snippets are capped at 500 characters each and 12,000
characters in total.

One provider response is read. Both its full posts record and order list are
capped at 1,000 entries; every source row is validated before any filtering or
output limiting. Malformed or foreign-channel rows reject the whole response,
including rows outside the requested output window. `sourceCount` counts the
full validated posts record, `orderedCount` counts its order list, `eligibleCount`
counts ordered posts after deleted/sender filtering, and `outputCount` counts
returned snippets. `truncated` reports local result/text truncation.
`completeness` is always `"unknown"`: Mattermost SQL ignores pagination controls,
and provider caps and index freshness are unknown. API/index errors are reported
as errors, rather than represented as an empty successful search.

### Referenced attachment content

Admitted inbound turns materialize attachment content from one same-channel
reference by default. To keep referenced files metadata-only, set:

```json
{
  "channels": {
    "mattermost": {
      "referenceMedia": { "enabled": false }
    }
  }
}
```

Accounts inherit this setting, including when `referenceMedia` is empty or its
`enabled` field is omitted. Set `accounts.<accountId>.referenceMedia.enabled`
to `false` to disable it for that account, or `true` to override a global opt-out.
Omitting the configuration object or `enabled` field defaults to enabled when
no global setting is inherited. Disabling
`permalinkHydration.enabled` also disables reference media. The plugin chooses
one explicit same-instance post permalink/preview reference, otherwise the native
thread root. It checks post identity, channel, deletion state, file ownership when
available, and sender visibility before fetching files. A reference in another
channel is never downloaded, including private channels and DMs.

Downloads deduplicate current-post files and stop at four referenced files, ten
seconds total, or an aggregate budget capped at 8 MiB and reduced by the configured
Mattermost/agent media limit. Each attempted transfer reserves its validated file
size (one byte for a zero-size declaration); failed transfers do not refund their
allowance, and saved files must fit it. Cancellation skips supplemental media.
The existing trusted media saver and private-network opt-in apply. Deleted, denied,
or unavailable files preserve text/metadata context. Ordinary history/tool reads
do not download attachments, and supplemental content does not classify commands.

### REST throttling recovery

Idempotent reads, scoped search, and post updates can retry explicit HTTP 429
rejections, with at most three attempts and a total budget of the shorter of the
request timeout and 30 seconds. The plugin strictly validates provider
`Retry-After` seconds/HTTP dates or Mattermost `X-RateLimit-Reset` duration seconds.
Missing, invalid, excessive, or over-budget delays fail without an early retry;
waiting can be aborted. Updates keep the original post identity.
Authentication failures, server/network errors, creates, uploads, deletes, and
commands do not gain REST replay. Existing create reconciliation remains
authoritative for ambiguous sends and accepted responses without a usable post ID.

Interactive buttons automatically use native Mattermost Blocks on Mattermost
11.10 and newer, based on the server's `X-Version-ID` response header. Older
servers use legacy interactive attachments because they may accept `mm_blocks`
props without rendering them. Set `channels.mattermost.interactions.blocks` to
`true` or `false` to override detection. If the version cannot be determined,
the existing Blocks default is preserved. An explicit HTTP 400 rejection falls
back once to legacy attachments; transport failures are not retried because the
first post may already have been accepted.

SDK single-select presentations use the same detection/override/fallback rules:
legacy attachment `select` menus on older servers and Blocks `static_select` on
supported servers. Menus support 1–25 distinct SDK value choices (values up to
200 characters, labels up to 100), including canonical question option mappings.
Unsupported typed actions, mixed menus, and invalid menus fall back to presentation
text. For example, a reply presentation can contain:

```json
{
  "blocks": [{
    "type": "select",
    "placeholder": "Choose environment",
    "options": [
      { "label": "Staging", "value": "staging" },
      { "label": "Production", "value": "production" }
    ]
  }]
}
```

Selections are checked against the current signed, bot-authored post control and
existing user/channel authorization. Controls expire after 24 hours. Different
choices have different durable identities; retrying the same choice replays once.
Generic values become descriptive agent input, including values resembling slash
commands or callback namespaces. They do not execute privileged commands.
Question menus resolve the original Gateway question and retire the control after
an answer; terminal clicks and replay cannot create an extra agent turn.

Native approval cards enable automatically when a stable 26-character
Mattermost user id is available in `execApprovals.approvers`, `allowFrom`, or
`commands.ownerAllowFrom`. They default to the originating Mattermost
conversation; routing can be changed per account:

```json
{
  "channels": {
    "mattermost": {
      "execApprovals": {
        "enabled": "auto",
        "approvers": ["abcdefghijklmnopqrstuvwxyz"],
        "target": "channel"
      }
    }
  }
}
```

Approval decisions use typed, HMAC-signed callback context and the canonical
Gateway approval service, so first-answer-wins state remains authoritative.
Mutable usernames are deliberately ignored for privileged approval decisions.
Pending cards are edited in place when resolved, expired, or cancelled.

Secret requests originating in Mattermost include an **Enter credential** button. It opens a
Mattermost password dialog for the requested secret. The submitted value is handled synchronously
by the authenticated plugin callback route and sent through OpenClaw's store-bound secret-question
resolver; it is never posted to the conversation or written to the durable interaction queue. Only
stable Mattermost users accepted by the approval/owner allowlist may open or submit the dialog. The
Web UI link remains available for reviewing host restrictions and as a fallback.

Validated button callbacks are stored before Mattermost receives HTTP 200.
They use a separate `interactions.sqlite` queue under the plugin state directory,
with stable action identity for deduplication and per-post lanes for ordering.
Transient drain failures retry within the normal bounded ingress policy, and
uncompleted callbacks replay after restart. HMAC tokens and full post props are
never written to the callback queue. A storage failure returns HTTP 503 so
Mattermost can retry instead of losing an acknowledged action.

### Unlicensed thread moves

Run the following command from the reply box inside the source thread:

```text
/move_thread #target-channel
```

The owner-only command runs directly instead of starting an agent turn, so the
source root can be deleted without also deleting an in-flight streaming/final
reply. It replaces the licensed `POST /posts/{id}/move` endpoint with the same
basic provider sequence Mattermost uses internally: re-upload attachments,
create the destination root and replies in chronological order, then delete the
source root (Mattermost deletes its replies with it).

The downstream implementation adds a stricter commit gate. Every destination
post must be readable with the expected channel, root, text, attachment ids,
and operation marker, and the source thread must still match its original
snapshot. A copy or verification failure keeps the source and removes the
known destination copy. An ambiguous source-delete result is reported as
unknown and keeps the verified destination copy; it is never deleted when that
could cause data loss.

Moves are bounded to 100 posts and 24 attachments, with each attachment using
the configured Mattermost/agent media limit (8 MiB when unset). REST-created
copies are authored by the configured bot because Mattermost overwrites
`user_id` with the authenticated API user. Original author ids, timestamps,
source post ids, and the operation id are retained in the
`openclaw_mattermost_move` post property. Text and uploaded file contents are
preserved; reactions, pins, and arbitrary source post properties are not copied.

When an agent emits a structured plan update, the plugin lazily creates one
Mattermost task card in the same channel or thread and edits that post for the
rest of the turn. Tool/reasoning streaming keeps its existing preview post, and
the final answer keeps its existing delivery path; neither reuses or deletes the
task-card post. Successful runs mark the card completed only when the explicit
parent checklist is complete; completed subtasks alone leave outstanding parent
steps incomplete. A native successful yielded end (`yielded`, paused liveness,
and `end_turn`, without failure or cancellation) keeps the parent In progress,
even when all children or checklist steps are complete. Yielded children remain
active until their real terminal. Failed or aborted runs retain a truthful failed or cancelled
terminal state. Turns without a plan
do not create an extra post. Card API failures are isolated from final-answer
delivery and use bounded create fallback to avoid duplicate posts.

A native automatic parent continuation can update that same card when committed
transcript provenance identifies `subagent_settle` from a child recorded by the
original task, with the exact parent session incarnation and a committed successor
run. Requester-settle wakes use this same `subagent_settle` provenance; run-id
spelling grants no authority. Only matching successful native `progress_card`
calls are applied, including explanation-only or Markdown-only updates and
revised checklists. A successful terminal with all parent steps completed leaves
that card Completed; a partial plan remains Incomplete. Continuation finalization
requires both a committed terminal assistant and its native lifecycle receipt,
so repeated yields remain In progress. Receipts arriving before committed rows
are buffered within the existing bounded continuation ownership.
Without host-adopted custody, new inbound or Web UI input retires continuation
ownership. Session reset, failure/cancellation, or account stop also retires it.
Ownership is in memory with a 24-hour absolute lifetime, at most 100 retained tasks,
and a bounded 32-row successor buffer; ordinary original-run transcript volume does
not consume that buffer. Existing cards and ownership lost on restart are not adopted,
and a continuation never creates a card for a planless turn or an accepted post with
no usable identity. Final answers keep their separate delivery path.
An unprovenanced human correction retires unadopted continuation ownership,
including during the original run: the transcript API does not prove same-run
steer adoption on user rows. Later original-run tools alone cannot establish it.

In progress streaming mode, the host may offer its `adoptProgressDraft`
capability on a waiting reply. The plugin transfers only a confirmed, bot-owned
preview alongside an existing card in the exact channel/thread and session
incarnation. The host then updates that same preview with prepared operation
names/statuses across child settlement, requester continuation, repeated yields,
and steering. The preview stays bounded to one post and retires when the host
settles its task debt; session replacement, account stop, or the bounded custody
lifetime also revoke it. Rejected adoption or an unavailable confirmation read
keeps ordinary final delivery; abort and session replacement still stop stale work.

Current host-adopted custody preserves the original card's observation across
same-session input. Each input clears previous run/tool correlation; only a fresh
trusted settle from an already-known child can authorize subsequent committed
progress and terminal receipts. Host retirement closes observation and drains an
already-proven terminal update; new human input, session replacement, account stop,
and expiry still fence queued writes. Neither activity adoption nor card observation forwards
assistant transcript prose. Continuation commentary remains subject to the
host's source-reply policy, and final answers keep their own delivery path.

### Task-card ordering and late-plan handoff

Plan and result callbacks do not always arrive in visual order. Core can enter
result delivery before the ordered plan callback runs, and commentary can create
a visible result post before the first plan update reaches this plugin. The
task-card lifecycle therefore cannot treat "result started" or "result post
exists" as a reason to discard a late plan.

When no result post exists yet, the plan write owns the first Mattermost create
and the result waits behind it. When commentary already created the first result
post, the draft stream performs an identity handoff:

1. Flush the current commentary preview.
2. Copy its visible text into a new `turn_result` post.
3. Convert the older post into `task_progress` and keep editing it as the card.
4. Continue later tool progress and final delivery on the new result identity.

This preserves both content and chronological ordering without deleting or
reposting the durable card. If the copy is not accepted, the original post stays
the editable result identity and card creation fails without disrupting final
delivery. If Mattermost accepts the copy but returns no usable identity, the
stream stops that path rather than retrying and risking duplicate posts.

### Optional companion WebSocket previews

The default preview transport remains REST. To add faster web previews, build
the `openclaw-stream` server/web plugin from [companion/](companion/README.md)
in this repository and install its separate Mattermost artifact on Mattermost
12+. Configure its **Allowed Mattermost bot IDs** with the channel bot's user ID
and enable the plugin. The companion source shares this Git repository but is
not included in the root OpenClaw npm artifact. Then opt in on OpenClaw:

```json
{
  "channels": {
    "mattermost": {
      "streaming": {
        "transport": "companion"
      }
    }
  }
}
```

Account-level `streaming.transport` overrides are also supported. This option
selects the preview transport; existing streaming mode and source-reply policy
still determine which text may be shown. The implementation needs no core
patch or new credential: authenticated requests use the existing Mattermost bot
token at the configured server origin.

Web previews carry cumulative text at a 250 ms minimum interval. The normal
1,200 ms REST checkpoints remain for mobile, unsupported clients, and durable
delivery. Missing/incompatible capabilities or a rejected snapshot switch that
draft back to REST. WebSocket acceptance never counts as final delivery; the
existing persistent edit, readback, and delivery receipt still own completion.
Boundaries, finalization, and late-plan identity handoff close the old generation
and preserve its text. The existing authorized `/stop` remains the cancellation
entry point.

The companion does not add the Agents plugin's native mobile streaming UI.
Restart recovery and host-adopted progress continuation continue through their
existing REST path. Transient snapshots are bounded, expire, and are local to a
Mattermost server process; reconnect readback is best effort in a multi-node
deployment. A durable post edit takes precedence over older preview state.

Set `transport` to `"rest"` (or remove it) to roll back. Existing posts retain
their durable message body when the companion is disabled or removed. Changes
to production installations, allowlists, Gateway configuration, and restarts
require explicit operator authorization. The implementation contract and local
verification are recorded in
[the companion implementation notes](docs/companion-streaming-implementation.md).

OpenClaw 2026.9.4 restart-recovery runs also reconnect channel/group session
events to the original Mattermost thread. Recovery keeps the typing indicator
alive and restores tool progress in a temporary preview post; terminal recovery
clears that preview and leaves core's durable final-answer delivery unchanged.
Ordinary typing and tool previews continue to use their existing inbound-turn
callbacks, so they are not double-rendered.

Inbound WebSocket posts are persisted through a plugin-owned SQLite ingress
queue under the OpenClaw state directory before dispatch. The separate spool is
required because beta.2 reserves the host channel-ingress queue for trusted
official plugins. Uncompleted posts can still be reclaimed after a Gateway
restart, and debounce/adoption lifecycle settlement keeps retry and dead-letter
handling bounded. The seven-day thread-participation mention-bypass window is
persisted across Gateway restarts.

## Package build

The package build bundles plugin-owned TypeScript only. OpenClaw Plugin SDK,
`ws`, and `zod` imports remain external and resolve from the installed host or
the plugin's declared runtime dependencies. This keeps OpenClaw core code and
state migrations out of the plugin artifact.

This release targets the published OpenClaw `2026.10.7` SDK and requires host
and plugin API `>=2026.10.7`. Earlier hosts are not covered by this build's
compatibility checks. The build verifies every emitted SDK subpath and named
binding against the exact dev dependency in this checkout's `node_modules`;
linked host checkouts and Gateway host overrides are not used.

Build before installing or packing the plugin:

```bash
npm run build
npm pack --omit=dev
```

## Upstream sync

This repository is a standalone plugin repo, not an OpenClaw monorepo fork.
The official bundled Mattermost plugin lives upstream in the OpenClaw
monorepo at `extensions/mattermost`. When syncing Mattermost fixes from
upstream, review the official change first, then apply the equivalent source
changes in this repo's `src/`. Recheck the downstream command, callback,
reaction, and trigger-cap behavior when upstream touches the corresponding
files.

### OpenClaw 2026.10.7 adaptation

The official Mattermost 10.6-to-10.7 delta changes package declarations only.
This build advances the package version, exact published development SDK,
minimum host, plugin API and build metadata together to 2026.10.7. The public
SDK export map, SDK source, shared channel source and outbound source are
unchanged. The build validates emitted SDK subpaths and named bindings against
the exact installed npm dependency.

The SDK adaptation itself introduces no Mattermost lifecycle changes. The
separate opt-in companion transport described above adds WebSocket previews.
Existing
commands, callbacks, reactions, forms, attachment collections, silent delivery,
streaming, task cards and recovery behavior are preserved. Session recovery,
database continuity and update activation fixes remain host-owned. Source
comparison, validation and deployment boundaries are recorded in
[the 10.7 upstream review](docs/upstream-2026.10.7.md).

### Previous OpenClaw 2026.10.6 adaptation

The 10.6 build added explicit silent delivery, group/sender tool policies and
ordered attachment collections on one post. Their implementation and verification
boundaries are recorded in [the 10.6 adaptation](docs/upstream-2026.10.6.md).
Those downstream behaviors remain part of this build.

### Previous OpenClaw 2026.10.5 adaptation

That build targets the exact published 10.5 SDK and advances the package,
minimum host and plugin API contracts together. It ports the official
asynchronous inbound session-envelope read, outer HTTP status precedence for
DM retries, error-body failure handling, and effect-authority fencing for
custom transports. Permanent rejections are not retried because their details
mention transient errors; a dispatched post remains accepted if its sender
retires while its response is in flight.

The Control UI origin shortcut is unavailable because the host retires
`conversationLink` from session storage and Gateway rows as well as removing
`props.session`. The subsequent porting audit removes the inert browser entry
and unused metadata plumbing.
Existing long-message limits, forms, commands, task cards and recovery behavior
are preserved. The source comparison, decisions and validation are recorded in
[the historical 10.5 upstream review](docs/upstream-2026.10.5.md); the current
port inventory and cleanup decisions are in
[the downstream porting audit](docs/porting-audit-2026.10.5.md).

### Previous OpenClaw 2026.10.4 adaptation

The official Mattermost 10.3-to-10.4 delta changes package declarations only.
This build updates the exact published development SDK, minimum host, plugin API,
and build version to 2026.10.4. The official SDK and shared channel source trees
and the published SDK export map are unchanged; the build validates emitted SDK
subpaths and named bindings against the installed exact npm 10.4 dependency.

No Mattermost lifecycle implementation changes are introduced. Custom commands,
callbacks, approvals, protected secret dialogs, questions, reactions, threads,
streaming, recovery, late-plan ordering, yielded progress, and provenance-based
parent continuation retain their existing behavior. Gateway startup/shutdown,
transcript ownership, streaming performance, and update fixes belong to the host.
The source comparison and post-deployment acceptance checks are recorded in
[the 10.4 upstream review](docs/upstream-2026.10.4.md).

### Previous OpenClaw 2026.10.3 adaptation

The official Mattermost 10.2-to-10.3 delta changes package declarations only.
This build updates the exact published development SDK, minimum host, plugin API,
and build version to 2026.10.3. The official SDK and shared channel source trees
and the published SDK export map are unchanged; the build validates emitted SDK
subpaths and named bindings against the installed exact npm 10.3 dependency.

No Mattermost lifecycle implementation changes are introduced. Custom commands,
callbacks, approvals, protected secret dialogs, questions, reactions, threads,
streaming, recovery, late-plan ordering, yielded progress, and provenance-based
parent continuation retain their existing behavior. Core-owned fixes and the
remaining fresh-inbound post-deployment acceptance are recorded in
[the 10.3 upstream review](docs/upstream-2026.10.3.md).

### Previous OpenClaw 2026.10.2 adaptation

The official Mattermost 10.1-to-10.2 delta changed package version contracts
only. That adaptation updated the exact development SDK, minimum host, plugin API,
and build version to 2026.10.2. The public SDK export map and SDK source are
unchanged between those releases; its build checked every emitted SDK
subpath and named binding against the published 10.2 package.

No Mattermost lifecycle implementation changes were introduced. Existing
commands, callbacks, recovery, planless turns, late-plan ordering, yielded task
cards, and provenance-based parent continuation retain their current behavior.
The source identities, carried behavior, core-owned changes, deferred work,
and required post-deployment smoke checks are recorded in
[the 10.2 upstream review](docs/upstream-2026.10.2.md).

### Previous OpenClaw 2026.10.1 adaptation

This build replaces the removed `command-auth` SDK invocation helper with local
skill-invocation matching while retaining host-owned command discovery. It also
ports the official plugin's shared callback-path discovery, canonical ordered
inbound media facts, and account-scoped interaction-secret registration.

Callback registration and the legacy Gateway auth-bypass artifact now use the
same path discovery. The custom public default remains `/mattermost/command`.
Inbound attachment facts preserve failed-file positions and referenced media;
the host owns compatibility-field projection. Interaction secrets are registered
per account, with no global default secret shared across multiple accounts.

The source comparison, existing features, core-owned improvements, and deferred
items are recorded in [the upstream review](docs/upstream-2026.10.1.md).

From this standalone checkout, the focused proof is:

```bash
npm run build
vitest run
```

`npm run build` produces the plugin runtime under `dist/` (tsdown bundle with
OpenClaw Plugin SDK, `ws`, and `zod` kept external); `vitest run` covers the
shared Mattermost contract tests and the downstream behavior tests.

### Test status against the published npm SDK

This repo builds and tests against the published `openclaw` npm package
(`2026.10.7`), not the OpenClaw monorepo checkout. One category of tests
behaves differently from the monorepo for that reason:

- Ten suites import test-only Plugin SDK subpaths (`channel-test-helpers`,
  `plugin-test-runtime`, `test-env`, `test-state`,
  `plugin-state-test-runtime`, `plugin-test-api`, `channel-contract-testing`)
  that the published npm package intentionally does not ship (they exist only
  in the monorepo, resolved via tsconfig paths). They are excluded in
  `vitest.config.ts` and do not run in a standalone checkout.

The Mattermost ack/status integration suite uses a minimal local test-only shim
for its one debounce helper and therefore does run in the standalone checkout.

All included suites run green via `vitest run`.

`npx tsc --noEmit` is an additional diagnostic, not a passing standalone gate:
the published SDK omits declarations for several exported runtime subpaths, and
this checkout also has existing type errors, including a task-card reader of
the non-public `SessionEntry.lastRunId`. The runtime build checks actual SDK
exports; tests and build success do not imply a clean TypeScript check.

## Docs

See the OpenClaw docs (`docs/channels/mattermost.md` upstream) for the shared
Mattermost configuration and the official/custom coexistence and rollback
instructions.
