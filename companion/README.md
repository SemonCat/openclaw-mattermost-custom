# OpenClaw Stream Mattermost Plugin

`openclaw-stream` is an optional Mattermost server/web plugin for low-latency
web previews and styled task progress cards. OpenClaw remains responsible for durable
post creation, checkpoint edits, final delivery, and fallback behavior.

Its source lives in `companion/` within the
`SemonCat/openclaw-mattermost-custom` Git repository and is committed and pushed
with the channel plugin. It builds a separate Mattermost plugin artifact;
the root OpenClaw npm artifact does not include it.

## Runtime behavior

- The publisher sends full text snapshots to `/plugins/openclaw-stream/v1/snapshots`.
- The plugin sends channel-scoped `custom_openclaw-stream_update` WebSocket
  events. The web app renders a snapshot only for the matching post generation.
- `/plugins/openclaw-stream/v1/close` fences the generation at stream boundaries
  and after handoff. A first close is accepted even if no preview was published.
- `/plugins/openclaw-stream/v1/posts/{post_id}` is a session-authenticated read
  endpoint for clients recovering an active snapshot.
- Mattermost's persisted `post.message` remains the fallback and authority.
  Mobile clients and clients without this web plugin continue to see REST
  checkpoints and the final persisted message.

## Task progress cards

Version 0.2.0 renders plan-backed cards with blue completion checks, an animated
current step, terminal status, subtask links, and the server's last update time.
Colors follow the Mattermost theme; narrow web layouts and reduced motion are
supported. No remote development service is required.

The channel plugin writes versioned `openclaw_task_progress` props alongside the
same durable Markdown on every card update. The companion's server hooks select
`custom_openclaw_task` only for an allowed bot with matching channel and
thread identity and matching source text. This includes an older result post
claimed by a late plan; the card/result ordering and identity handoff stay with
the channel plugin. Task cards work with either REST or companion reply transport.

The web renderer uses Markdown when structured data is missing, unsupported, or
out of sync. Exact restart-recovery terminal-heading edits are recognized so the
card cannot keep spinning after failure, cancellation, or completion. No running
indicator remains on terminal cards.

Companion 0.3.0 also provides a native attachment approximation on the official
mobile app. The app renders a theme-aware colored border, title, single-column
steps, static complete/active/pending symbols, safe HTTP(S) subtask links, and a
status/progress footer. It cannot run the web spinner, custom CSS or web animations.

The server stores the full canonical Markdown and an empty attachment slot.
Mattermost creates native attachment metadata from that slot before the companion
consumption hook runs. The hook projects only validated, allowlisted task posts
to a heading plus native attachment fields on REST reads and posted/post_edited
WebSocket events. Web clients use the projection marker to render their existing
card once. Existing cards acquire the native slot on their next update.
Foreign attachments and malformed/stale data retain their original presentation.

Projected read/write roundtrips restore the current stored checklist; stale
projection writes are rejected. Recovery restores the canonical source only
after the channel plugin admits the exact bot author and route. Generic incoming
post reads never replace visible text from forgeable presentation props.
Thread-tool and permalink context restore only posts authored by the authenticated
`/users/me` identity, with at most one self lookup per projected thread read and
visible-text fallback if that lookup fails.
Disabling the companion leaves complete Markdown with an empty attachment list,
so there is no second visible checklist.

## Configuration and limits

Set `AllowedBotIDs` to a comma-separated list of Mattermost bot user IDs. The
setting defaults to empty, which denies all snapshot publishers. The plugin
also verifies that the injected publisher identity belongs to a bot and that
the post belongs to that bot in the requested channel and thread.

Snapshots are held in bounded, process-local memory. This first version does
not replicate snapshots between Mattermost nodes or survive a plugin/server
restart. Use a single-node Mattermost deployment or sticky routing for the
preview transport; normal REST checkpoints remain the fallback in clustered
deployments.

## Build and verify

Starting at the Git repository root, enter `companion/`, install the pinned
webapp development dependency, and build the self-contained plugin archive:

```sh
cd companion
cd webapp
npm ci
npm test
npm run typecheck
cd ..
GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org go test ./server
GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org node scripts/package.mjs
```

The package script writes `companion/build/openclaw-stream-0.3.0.tar.gz`
relative to the Git repository root. It includes
Linux amd64/arm64 and macOS amd64/arm64 server binaries plus the web bundle.
Install the archive through Mattermost's normal plugin administration flow.
This checkout's build does not install or enable the plugin on a live server.

The web build and typecheck share `webapp/tsconfig.json`. It explicitly uses
ES2020 and DOM types without automatically loading ambient types from the
parent repository's development dependencies.

## Local verification

The 0.1.0 candidate passed Go server tests, 12 web tests, TypeScript checking,
and an independent Codex review through P2. The exact packaged Linux binary and
web bundle were also tested on a disposable Mattermost Team Edition 12.0.1
server and read back to confirm matching package hashes.

Real HTTP/WebSocket tests covered publisher admission, private-channel
isolation, terminal close, durable checkpointing, and both late-plan task-card
ordering cases. The actual Mattermost web client, running in Chromium, showed
Markdown previews before REST edits, restored previews after reload and
reconnect, yielded to a newer durable final without a close event, and retained
the final text through the stock renderer after disabling this plugin.

These are synthetic publisher/channel-callback tests. A production deployment
still needs a new inbound OpenClaw Gateway/model turn. Official mobile streaming
was not added or exercised. Closed-generation tombstones last five minutes in
process memory; the producer must also fence late callbacks across close,
cancellation, and post identity transfer.
