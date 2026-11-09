# Collapsed work details

The channel's 2026.11.2 candidate and companion 0.4.0 present existing public work
details behind a default-collapsed disclosure. This is presentation only.
Existing audience filtering, source-reply policy and all tool/commentary/reasoning
configuration still determine what reaches the channel. No child transcript
reader or retained tool transcript is added.

## Publication and final delivery

- Plan-backed task cards retain their durable identity, truthful status and
  completion summary. Their checklist, explanation and bounded subagent summaries
  start collapsed. Turns without a plan still do not create a task card.
- Already admitted non-final draft text, enabled commentary and tool summaries
  use **Work details**. Partial replies do not require semantic phase metadata:
  the plugin waits for explicit final delivery before treating them as an answer.
- Final edits remove work props while preserving identity and stream generation.
  Reconciliation after an uncertain edit checks the requested presentation as
  well as canonical text. Identical old text cannot prove successful promotion.
- Confirmed earlier chunks of a cumulative final are promoted too. Unconfirmed
  sealed commentary retains its work presentation. If promotion of an earlier
  chunk cannot be confirmed, ordinary delivery gets the complete final text.
- Late plans retain their existing flush, successor-create, older-post handoff
  order. The card replaces the older post's work props. Results continue on the
  successor identity. Accepted-without-id failures retain the existing fence.
- Recovery restores projected text only after exact bot/route admission.
  Generic reads do not trust presentation props as authority. Retained progress
  still adopts prepared public items with the existing reasoning gate.

## Native presentation and fallback

Official documentation:

- https://docs.mattermost.com/developers/integrate/reference/mm-blocks
- https://docs.mattermost.com/developers/integrate/reference/mm-blocks/troubleshooting

The documentation defines `collapsible`, `header`, `content` and `collapsed`.
It documents `MmBlocksEnabled`, a 100-block total including nested blocks, and
16,000 combined text characters. The inspected shipped web source is Mattermost
12.0.1, immutable commit `987e57120dca630dadbcd2638064ab66a02bb81e`:

- `webapp/platform/types/src/mm_blocks.ts` contains `MmCollapsibleBlock`.
- `webapp/channels/src/components/block_renderer/layout_blocks.tsx` initializes
  reader-local `useState` from `block.collapsed`, without resetting it on edits.
- `webapp/channels/src/components/post_view/post_body_additional_content/post_body_additional_content.tsx`
  chooses Interactive Messages ahead of legacy attachments when Blocks are
  enabled, and the attachment path when the feature flag is off.

The channel keeps complete Markdown in storage. The companion projects eligible
bot-owned work posts on reads to a neutral heading, one native collapsible
containing one header text block and one content text block, and a complete
legacy attachment. Native-capable clients choose Blocks; older/disabled clients
retain the attachment. The companion web renderer displays details once.
Disabling the whole companion leaves full stored Markdown.

Work snapshots exceeding 15,000 UTF-8 bytes do not receive work props. This
conservative byte bound fits the native character budget and leaves room for
the header and stored props. It does not truncate the canonical message.
Task bodies above that bound retain the existing full structured attachment
projection without native Blocks. Normal channel post chunk limits still apply.

No new setting or callback endpoint is needed. Web toggles use native HTML
`details`/`summary`, with keyboard behavior, focus indication, theme colors and
narrow layout wrapping. They are per reader and do not write to Mattermost.
Updates preserve the DOM disclosure while mounted; reload, remount or switching
devices starts closed. Native web toggles are owned by Mattermost's renderer.

## Acceptance limits

The shipped 12.0.1 web source proves a schema and rendering boundary, not the
production server/client versions or a live rendering result. The earlier
11.10 button minimum is not used as collapsible compatibility evidence.
The mobile 2.44.1 source at commit `c6724c974462bbeacd8cfce147158833f35480c1`
also implements a local collapsible state in
`app/components/block_renderer/layout_blocks.tsx`. Official mobile and desktop
combinations have not been exercised by this task.
An unsupported mobile client must use the legacy attachment; collapse itself
cannot be claimed there without an actual client test.

Local React DOM tests cover independent readers, open and closed updates, task
terminal recovery and direct final visibility. Source tests cover API identity,
late-plan order, final classification and uncertain same-text promotion.
These do not establish fresh inbound production acceptance.

After a separately authorized install and Gateway restart, the production owner
must use a new inbound turn and inspect task/result identities and chronological
order, open/closed behavior during updates, companion and native rendering,
tool/final edits on the result, truthful terminal task status, and Blocks-disabled
and companion-disabled fallback. A resumed pre-restart turn is insufficient.
