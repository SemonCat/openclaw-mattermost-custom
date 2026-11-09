# Collapsible activity in Mattermost

Investigated 2026-11-09. Scope: whether Mattermost can provide the expandable
agent activity UI shown in the user's Slack screenshot. Documentation and
local source review only; no implementation, install, restart, or live post.

## Finding

Yes. Current official Mattermost documentation defines a native
`props.mm_blocks` block with `type: "collapsible"`. Its always-visible `header`
and expandable `content` are block arrays; `collapsed: true` starts it closed.
This supports the requested hide-until-click interaction without requiring a
new custom server plugin solely for the toggle.

Source: [Mattermost Blocks, Collapsible](https://docs.mattermost.com/developers/integrate/reference/mm-blocks#collapsible).
The same reference documents submission through the create-post REST API,
webhooks, slash commands, or plugins.

The screenshot resembles Slack's agent thinking-steps presentation. Slack
documents that presentation using task-card and plan blocks with streaming
updates. This establishes a comparable product feature, not the exact payload
used by the app in the screenshot.

Source: [Slack agent design, Thinking steps](https://docs.slack.dev/concepts/agent-design/).

## Compatibility and limits

- Mattermost's `MmBlocksEnabled` feature flag controls native rendering and is
  documented as enabled by default.
- Official troubleshooting requires current web, desktop, or mobile clients.
  It explicitly documents toggling collapsible sections by their headers.
- The reference limits a post to 100 blocks including nested blocks and a
  combined 16,000 characters across text/button text. An activity log needs
  bounded retention or a separate full-history destination.
- The reviewed pages do not establish the earliest release supporting this
  specific block. Do not reuse the local button-support minimum of 11.10 as
  proof of this block's minimum version.
- No current production server/client versions or rendering were inspected.
  Persistence of a reader's expanded state across post edits, reloads, and
  device changes remains unverified.

Sources: [Blocks reference](https://docs.mattermost.com/developers/integrate/reference/mm-blocks)
and [Blocks troubleshooting](https://docs.mattermost.com/developers/integrate/reference/mm-blocks/troubleshooting).

Illustrative schema, not a live-tested payload:

```json
{
  "props": {
    "mm_blocks": [
      {
        "type": "collapsible",
        "collapsed": true,
        "header": [{"type": "text", "text": "**Work details · 2 subtasks**"}],
        "content": [
          {"type": "text", "text": "- Checking source code\n- Research agent: completed"}
        ]
      }
    ]
  }
}
```

## Existing plugin fit

Local source already persists plan steps, title, explanation, task status, and
bounded work-session labels/status/progress in `openclaw_task_progress`:
`src/mattermost/task-progress-card.ts`, in `publishLatest`.

The existing companion renders these fields fully expanded:
`companion/webapp/src/task-progress.js`, in `renderCard`. Mobile projection
currently uses a legacy attachment:
`companion/server/task_progress_mobile.go`.
Therefore, adding native blocks alone would not automatically change every
existing companion presentation; both presentation paths need an intentional
integration or fallback policy.

The existing data is sufficient for collapsible plan/subtask summaries.
It is not a complete retained tool timeline or every child assistant transcript.
Matching the screenshot's full activity list needs an additional bounded event
projection. Existing reasoning visibility and source-reply rules must continue
to govern what can be published; the UI does not provide access to otherwise
unavailable internal reasoning. Relevant local boundaries:
`src/mattermost/monitor-turn.ts`,
`src/mattermost/task-card-continuation.ts`, and
`src/mattermost/monitor-progress-continuation.ts`.

## Recommended behavior for a future implementation

Keep a compact status/count visible, with already publishable activity,
commentary summaries, tool summaries, and subtask progress behind a
default-collapsed section. Keep the final answer directly visible.

Preserve durable card/result identities, late-plan handoff, terminal status,
restart recovery, and existing source visibility rules. Do not automatically
expand a section on every progress update. Each reader's toggle should remain
local rather than editing the shared post to change all readers' views.

Before shipping, test edits while both open and closed, completion/failure,
late plans, reload/recovery, companion enabled/disabled, unsupported clients,
and official mobile behavior. Verify against a fresh authorized inbound turn;
this investigation supplies no live behavior proof.
