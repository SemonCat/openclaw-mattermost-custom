# Styled Mattermost task cards

The optional companion 0.2.0 adds a web/desktop presentation for the existing
durable task card: a bold title, blue completion checks, a rotating current step,
pending steps, terminal status, subtask links, and the last server update time.
The layout follows Mattermost's theme and wraps on narrow web viewports. Reduced
motion disables rotation.

## Ownership and compatibility

The channel plugin still owns plan updates, creation order, late-plan identity
handoff, completion, failure, cancellation, and continuation. Every successful
write stores the existing Markdown and `props.openclaw_task_progress` together.
The presentation payload contains only already-visible labels, status, progress,
and URLs, not internal session keys or run IDs.

The companion's server hooks select `custom_openclaw_task` for posts authored by
an allowlisted bot with matching `task_progress` identity, channel/thread, schema
version, and source Markdown. A patch cannot set a post's type through the REST
PostPatch schema; the update hook enables a late plan to promote an older result
post without creating or reordering posts. The custom type stays within the
server's 26-character database limit.

The web renderer validates the structured payload. Empty arrays may round-trip
through Mattermost's Go plugin RPC as `null`; both represent an empty list.
Unsupported or out-of-sync payloads use the native Markdown renderer. An exact
restart-recovery edit of an in-progress heading to a terminal heading overrides
the structured status. All terminal states suppress running indicators.

The plain Markdown remains persisted for unsupported clients and when the
companion is disabled. Companion 0.3.0 adds a native attachment approximation
using the official mobile app's existing renderer; no custom app, signing or
distribution project is needed. It does not change reply transport settings,
add remote development infrastructure, or enable a production installation.

## Official mobile attachment presentation

Validated tasks store an empty `props.attachments` slot alongside the canonical
Markdown. Mattermost 12.0.1 `getEmbedForPost` detects the key's presence and emits
`message_attachment` metadata, even for an empty list. This occurs before
`MessagesWillBeConsumed`, which cannot replace metadata: the server restores the
original metadata after the hook. The hook therefore changes only the consumed
body and props, projecting the exact task status heading plus one native
attachment with full-width fields. Both REST reads and posted/post_edited
WebSocket broadcasts pass through this hook. No platform or User-Agent guess
is required. Pre-existing cards gain the empty slot on their next update.

The native card uses the app's theme colors (`primary`, `success`, `danger`,
`default`), static complete/active/pending symbols, a title, status/progress
footer and sanitized HTTP(S) child links. It wraps in a single column. The
official app cannot run the web CSS or rotating indicator; active steps use a
static triangle. Terminal states suppress all running symbols and labels.
Plain labels are escaped before entering attachment Markdown.

An `openclaw_task_mobile` marker binds the visible heading to the canonical
source. The web renderer validates that marker and renders its existing card
once. The update hook restores an exact projected roundtrip only against the
current stored source and unchanged task identity/payload; a stale projection
is rejected. Explicit full-text edits remain authoritative. Restart recovery
restores the source only after exact bot-author and route admission in
`post-identity.ts`, so unfinished steps still produce Incomplete on successful
recovery settlement. Generic client reads, humans and foreign bots do not gain
authority from forgeable type/props.
Thread-tool and permalink context use at most one `/users/me` lookup when a thread
contains projected candidates and restore only that authenticated author's posts,
before applying the existing character budget. Lookup failure preserves visible
text. No global identity cache or automatic backfill behavior is changed.

Malformed, oversized, stale or foreign data is never projected, preserving the
complete visible Markdown. Nil arrays are accepted; missing required step/label
fields and null scalar fields are rejected. Foreign attachments are preserved.
With the companion disabled, the database's full Markdown and empty attachment
list render a single checklist.

Renderer evidence targets the cached official v2.45.0 source, including the
legacy MessageAttachment path and the mmBlocksEnabled attachment translation.
Source/component probes are not physical iPhone or simulator testing. A fresh
inbound turn on the installed official app remains a parent-owned live check
after separately authorized installation.

## Validation

The source regression suites cover structured/Markdown synchronization, stable
post identity, late-plan claiming, terminal states, nil-array serialization,
invalid-data fallback, executable-link rejection, and renderer registration.
The companion server tests cover allowlist and route admission and both standard
and streaming result-post handoffs.

Run the standalone channel gate from the repository root:

```sh
npx vitest run src/mattermost/task-progress-presentation.test.ts
npx vitest run
npm run build
```

Run companion checks and packaging from `companion/`:

```sh
npm --prefix webapp test
npm --prefix webapp run typecheck
GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org go test ./server
GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org node scripts/package.mjs
```

The replayable browser probe is
`docs/probes/mattermost-task-card-web-smoke.cjs`. It accepts a private disposable
fixture state file and writes credential-free receipts and screenshots. It
checks real Mattermost rendering, updates, reload, narrow layout, reduced motion,
restart terminal reconciliation, dark theme, late-plan promotion, stale-content
fallback, and companion-disabled Markdown. Its fixture must be isolated from
production. The existing `mattermost-companion-local-smoke.mjs` also checks real
HTTP/WebSocket behavior and both late-plan ordering boundaries using the actual
channel source with synthetic callbacks.

Installing the two candidate artifacts on a live Gateway/Mattermost server,
restarting the Gateway, and checking a fresh inbound model turn remain separate
operator-authorized steps. A disposable publisher test is not fresh inbound
production lifecycle evidence.
