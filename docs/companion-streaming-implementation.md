# Companion streaming implementation

The first implementation keeps OpenClaw's existing Mattermost channel ownership,
task cards, commands, approvals, and durable delivery. A separate Mattermost
server/web plugin supplies faster text previews. The local validation below
and the subsequent authorized production deployment have separate evidence
boundaries.

## Contract

- Mattermost plugin id: `openclaw-stream`.
- WebSocket event: `custom_openclaw-stream_update`.
- Post type: `custom_openclaw_stream`; ordinary clients retain `post.message`.
- Opt-in channel setting: `streaming.transport: "companion"`; omitted or `"rest"`
  keeps the existing transport.
- The channel uses the existing bot credential at the same Mattermost origin.
  The companion authorizes an explicitly configured bot allowlist, verifies the
  post author, channel/root, `openclaw_mattermost.kind === "turn_result"`, and
  `openclaw_stream: {version: 1, generation: "<uuid>"}`.
- `GET /plugins/openclaw-stream/v1/capabilities` returns
  `{protocol:1, post_type:"custom_openclaw_stream",
  event:"custom_openclaw-stream_update", lease_ms:15000, max_chars:262144}`.
- `POST /plugins/openclaw-stream/v1/snapshots` accepts
  `{post_id, channel_id, root_id, generation, seq, message}` and returns
  `{accepted:true}`. `root_id` is `""` for a root post. Sequence numbers are
  positive safe integers. Snapshots carry the full text.
- `POST /plugins/openclaw-stream/v1/close` accepts the same identity fields and
  `seq`, without `message`; returns `{accepted:true}`. Closing is terminal for
  that generation. Replayed identical sequence requests are idempotent; stale or
  conflicting requests are rejected.
- Events carry `{post_id, channel_id, root_id, generation, seq, message, closed,
  updated_at, expires_at}`. Timestamps use server epoch milliseconds; a newer
  durable `post.update_at` takes precedence over a preview.
  Audience is the post's channel, chosen by the server, with reliable cluster send.
- `GET /plugins/openclaw-stream/v1/posts/<post_id>` returns that event snapshot
  for authorized channel readers, or 404. State is bounded and expires; it is
  not a durable transcript or a cross-node snapshot store.
- Preview updates can run every 250 ms, while REST checkpoints retain the
  existing 1,200 ms cadence for mobile and unsupported clients.
- A preview boundary, handoff, or seal persists the latest visible text before
  closing that generation. Final delivery still uses the existing durable
  edit/readback and receipt. WebSocket acceptance is not final delivery.
- Any capability/snapshot failure switches that draft to REST. Existing accepted
  post creation failures retain their no-duplicate semantics.
- The renderer ignores foreign generations, older sequences, expired state, and
  posts that are no longer `turn_result`; on close/reconnect it reads authoritative
  state. It uses Mattermost's existing Markdown renderer.
- This slice adds no new Stop UI. Existing authorized `/stop` remains the owner.

## Tasks

1. Build the independent server/web companion in the sibling
   `mattermost-plugin-openclaw-stream` checkout.
   Acceptance: authorized snapshots render; foreign users/posts are rejected;
   sequences, expiry, close, reconnect, and bounded state have tests.
   Verify: Go tests, web tests/typecheck, and a self-contained plugin package.
2. Add the opt-in channel transport and integrate existing draft generations.
   Acceptance: omitted configuration preserves REST; working companion adds
   previews without extra posts; failure preserves delivery and mobile checkpoints.
   Verify: focused config/transport/draft tests.
3. Prove the cross-boundary lifecycle.
   Acceptance: latest preview survives boundaries and late-plan handoff; closed
   generations cannot publish again; final stays on the result identity.
   Verify: integration regressions, full standalone Vitest/build, and a local
   HTTP/WebSocket/UI experiment where available.
4. Review and document the resulting artifacts and concrete verification limits.
   Acceptance: independent review findings are resolved against real code;
   deployment instructions preserve explicit production installation permission.

The channel and companion are separate writing scopes. Root owns the contract,
security decisions, channel changes, cross-boundary tests, and final integration.

## Channel validation

- The full standalone gate passed: 112 files / 1,414 tests. A subsequent focused
  run passed all 16 companion tests, including callbacks arriving while a
  generation close is delayed.
- `npm run build` passed against the exact published OpenClaw 2026.10.7 package,
  validating 265 named SDK exports across 84 public subpaths.
- Independent Codex autoreview of the local candidate against
  `17ba1df96983cc7ebcdaac2d59b2d4f7083a987e` returned `scoped-clean` through P2.
  The companion has its own review boundary.
- The replayable local integration harness is
  `docs/probes/mattermost-companion-local-smoke.mjs`. It accepts an external
  disposable-fixture state file and writes a receipt without credentials.
  It uses synthetic callbacks through the real channel implementation; it
  does not exercise a Gateway/model turn.

## Companion and real-server validation

The independent source checkout is `../mattermost-plugin-openclaw-stream`.
Its `openclaw-stream` 0.1.0 package contains Linux amd64/arm64 and macOS
amd64/arm64 server binaries plus the web bundle. Go tests, 12 web tests,
TypeScript checking, package construction, and an independent Codex autoreview
through P2 passed. Both independent reviews returned `scoped-clean`.

An isolated Mattermost Team Edition 12.0.1 server ran the exact final companion
archive. The installed Linux executable and web bundle were read back and
their SHA-256 hashes matched the package. Seven HTTP/WebSocket checks proved:

- A real authenticated channel event arrives before the REST checkpoint.
- Authorized readback restores the latest cumulative snapshot.
- Sealing persists the preview, closes the stream, and fences late callbacks.
- Closed generations, ordinary-user publishing, and foreign generations fail.
- A nonmember receives neither private-channel snapshots nor their events.
- Both late-plan boundaries preserve task-card-before-result creation order,
  result identity ownership, and terminal task-card content.

`docs/probes/mattermost-companion-web-smoke.cjs` exercised the actual Mattermost
web client in Playwright 1.63.0 / Chromium 153.0.8010.12. Its six checks proved
native Markdown previews before durable edits, reload readback, reconnection
after an offline snapshot, rendering in a narrow web viewport, final-edit
precedence without a close event, and durable text through the stock renderer
after disabling the companion. There were no page errors. A narrow web
viewport is not a test of the official mobile app.

The disposable server's `SiteURL` was fixed by its Docker environment. The
browser therefore had to use that same origin; a different loopback origin
caused a genuine Mattermost WebSocket handshake rejection. The production
client and companion keep normal origin/authentication checks.

The compact, credential-free receipt is
`docs/probes/mattermost-companion-smoke-receipt.json`. Detailed local traces,
review reports, screenshots, and packages are under
`/tmp/openclaw/companion-local-20261026/`.

Artifact SHA-256:

```text
86560d5151f75354cecc1d4ceee8914a002bc0aaa9cc19782a6e802a7f38d0b2  openclaw-mattermost-custom-2026.10.7.tgz
3dd023754043ca064e6cdfdff32ba9fcdf0f4126f2a2bbcd035e7370df237f1c  openclaw-stream-0.1.0.tar.gz
```

## Acceptance boundary

On 2026-10-26, the tested artifacts were installed through an explicitly
authorized production deployment. Mattermost loaded and enabled the 0.1.0
companion; its loaded executable and served web bundle matched the package
hashes. The OpenClaw 2026.10.7 Gateway restarted successfully with
`mattermost-custom` as the sole channel owner and
`channels.mattermost.streaming.transport: "companion"`. Gateway health,
readiness, plugin loading, and Mattermost connectivity checks passed. The
channel's accepted capability surface was unchanged.

The local server tests use synthetic callbacks and a test bot. A fresh inbound
production Gateway/model turn remains pending; those tests and deployment
health checks do not establish production live-preview behavior or stock
mobile UI streaming. Use a new inbound Mattermost turn to verify task/result
post identities, live preview, terminal card, cancellation, and final readback.
A resumed turn after a restart does not meet that fresh-turn check. Recovery
and host-adopted progress remain REST-only.
Snapshots and five-minute close tombstones are process-local and bounded;
restarts clear them. Producer fencing prevents that draft from reopening a
closed generation. Single-node or sticky routing is required for dependable
snapshot readback; this slice does not provide replicated transient state.

The disposable browser, Mattermost, and database containers, their dedicated
network, and the local SSH forward were removed after evidence capture. The
temporary fixture credential file was deleted. Artifacts and credential-free
receipts remain available for review.
