# OpenClaw 2026.10.5 Mattermost adaptation

Research date: 2026-10-20. Compared the complete official 10.4 and 10.5
archives, the published npm manifests, consumed SDK facades, and release notes.
The standalone development dependency is the exact published npm package,
without a source checkout or Gateway override.

## Source identities

| Source | Identity |
| --- | --- |
| Official 10.4 | Annotated tag `f823e45687906237b140d64a64b3a6cf26207fc1`, commit `383c124cc32ffee3f8e56f549b88da94d269a4af` |
| Official 10.5 | Annotated tag `9171d0a427738902efd811c648325cf54116743c`, commit `1b58cb9a1b4f4353e1add63c8506db4d890962e8` |
| 10.4 archive SHA-256 | `642e606964ba115f35b0a6bcebaab889b49a1e1a28641a2cdbe3cfb81ac3f412` |
| 10.5 archive SHA-256 | `3cf2be171ca4de3017df060ab2311107c4bfc6b308102c9c41d1e9b806a990c7` |
| Published 10.5 integrity | `sha512-9rCuXMweqVKZIK3KBtGcLzesz9G6+FmQ30lvwomRhmcNWDcOtlBoqdLbPditoJMuTP55jPqXpt1AA0L8tSzFHg==` |

The stable GitHub release was published on 2026-10-18 at 21:47:25 UTC
(2026-10-19 at 05:47:25 Asia/Taipei). Its release SHA and integrity match the
tag and npm metadata.

Sources:
[official release](https://github.com/openclaw/openclaw/releases/tag/v2026.10.5),
[pinned changelog](https://github.com/openclaw/openclaw/blob/v2026.10.5/CHANGELOG/2026.10.5.md),
[10.4 Mattermost](https://github.com/openclaw/openclaw/tree/v2026.10.4/extensions/mattermost),
[10.5 Mattermost](https://github.com/openclaw/openclaw/tree/v2026.10.5/extensions/mattermost),
[SDK](https://github.com/openclaw/openclaw/tree/v2026.10.5/src/plugin-sdk),
and [published package](https://www.npmjs.com/package/openclaw/v/2026.10.5).

## Comparison and decisions

| Area | Evidence and handling |
| --- | --- |
| Official Mattermost | 150 files become 145, with 52 changed paths including deletions. Review the complete delta; port behavioral corrections without replacing downstream modules with upstream refactors. |
| SDK and shared channels | 729 SDK files become 747, with 204 changed paths. Shared channel files change from 537 to 523, with 221 changed paths. Sixteen SDK facades imported by this plugin changed. The 346 package export-map entries and targets are unchanged, but named APIs and their host behavior still require verification. |
| Version contracts | Advance artifact version, exact development SDK, optional host peer, minimum host, plugin API and build version together to 2026.10.5. Regenerate the dependency lock through npm. Node engine requirements are unchanged; updated host dependencies remain development dependencies of this plugin. |
| Inbound session envelope | Port `resolveInboundSessionEnvelopeContextAsync` and await it before constructing the inbound context. The host reads the previous session timestamp in its worker rather than synchronously on the Gateway thread. Update test substitutes at this exact boundary without weakening ingress, reactions or event-order assertions. |
| DM retry policy | Prefer the first outer Mattermost API status over nested status text, network words and rate-limit phrases. Explicit 400/403 refusals remain permanent even if details mention 429/503; 429 and 5xx remain retryable. Preserve non-retryable `PlatformMessageNotDispatchedError` handling. |
| Failed HTTP error-body reads | Keep the HTTP status when bounded diagnostic-body reading fails, using a fixed fallback diagnostic. A broken body must not turn a permanent HTTP refusal into a retryable transport error. |
| Custom transport initiation | Capture SDK effect authority and initiate custom fetch inside it. Recheck read authority, sender ownership and abort immediately after preparation and before dispatch. Retiring a sender before dispatch prevents sending; retirement after dispatch does not erase an accepted receipt. The normal transport retains the SDK SSRF boundary. |
| Header origin link | 10.5 passes `BoardGetParams` identity only to session-header accessories. It also removes `conversationLink` from canonical session storage and the Gateway row schema. The deprecated helper cannot render; `sessions.describe` cannot recover the retired field. Disable this shortcut and keep the declared browser entry inert, without new RPCs, storage or capabilities. Existing inbound metadata is retained but is not persisted/projected by 10.5. |
| Upstream refactors | Type inference, removed wrappers, inlined diagnostics/model-picker/reaction helpers, reconnect option simplification, optional disabled previews, and the new delivery accumulator do not require equivalent rewrites. Retain tested downstream behavior and explicit partial/accepted delivery handling. Sealed draft prefixes are already trimmed when recorded, so upstream's redundant read-time trim removal has no additional effect here. |
| Host-owned work | Session worker preparation, transcript ownership, stop/steer, delivery adapters, native model commit validation, reload recovery, and other core fixes are consumed through the published host. Do not copy core implementations or migrations into this plugin. |

The Control UI contract is documented in the
[public SDK](https://github.com/openclaw/openclaw/blob/v2026.10.5/src/plugin-sdk/control-ui.ts),
[deprecated helper](https://github.com/openclaw/openclaw/blob/v2026.10.5/src/plugin-sdk/control-ui-session-link.ts),
and [identity-only host renderer](https://github.com/openclaw/openclaw/blob/v2026.10.5/ui/src/plugins/control-ui-view.runtime.ts).
The retirement is explicit in the
[canonical session projection](https://github.com/openclaw/openclaw/blob/v2026.10.5/src/config/sessions/store-entry-shape.ts)
and [Gateway row schema](https://github.com/openclaw/openclaw/blob/v2026.10.5/packages/gateway-protocol/src/schema/sessions-row.ts).
The [`sessions.describe` handler](https://github.com/openclaw/openclaw/blob/v2026.10.5/src/gateway/server-methods/sessions-read-by-key.ts)
returns that projected row. Restoring the original first-session launch link,
including flat sessions, requires a separately designed durable origin source.

## Preserved downstream behavior

Keep Mattermost 12 automatic 262,144-unit limits, smaller configured limits,
mobile-compatible/native choice forms, signed current controls and canonical
question resolution. Preserve commands, approvals, protected secrets, reactions,
threading, ingress buffering, recovery, task-card ordering, late-plan identity
handoff, yielded progress and provenance-based continuation.

The manifest and declared tools are unchanged. The independently deployed
Mattermost mobile-routing server patch remains a separate release artifact
described in the [server compatibility record](mattermost-server-12-compatibility-2026-10-18.md).
This adaptation does not modify the server or its 2 MiB transport setting.

## Validation

New transport regressions reproduced twelve failures before the correction:
effect preparation was bypassed, permanent refusals were retried from their
details, and unreadable error bodies lost their HTTP status. The corrected
focused transport, identity and existing client suites pass. An additional
case checks outer/nested provider statuses and permanent dispatch refusal.

The asynchronous envelope test holds its result pending and proves inbound
dispatch waits for it. The reaction integration regression initially failed
because its substitute intercepted only the old synchronous API. Updating the
substitute to the awaited API restores its original dispatch/adoption checks;
the reaction, system-event and reference-media suites pass all 79 cases.
No test timeout, concurrency setting or monorepo-only exclusion was relaxed.

The browser regression replaces the old rendering assertions with an explicit
retirement check: activation must register no accessory, subscribe to no host
events and perform no RPCs. Link construction/validation tests remain independent
of the removed host persistence contract.

The final standalone gate passes all 105 included suites and 1,286 tests.
The focused transport, browser and permalink check passes 29 cases.
The runtime build validates 264 named SDK exports across 85 subpaths against
the installed `openclaw@2026.10.5`. The browser entry is self-contained.
The packed artifact contains 36 files (244,374 bytes), with an unchanged
manifest, external Node SDK imports, no source/development dependency tree,
and runtime files identical to the verified build. Artifact SHA-256:
`687fa0a2f5c8f15a85e2ca1c2d46261a3954e8fabe4789e528e75b4d5bd43aff`.

Source comparison receipts, logs and the self-contained artifact are retained
under `/tmp/openclaw/mattermost-2026-10-5`.

## Deployment boundary

This source adaptation does not install the artifact, upgrade the live Gateway,
change plugin ownership or restart services. Source tests and package checks
do not establish live browser rendering or Mattermost post order.

After an authorized installation on a 10.5 host, use a fresh inbound turn to
verify slash commands, reactions, approvals, protected secret dialogs,
mobile form open/select/submit and long-message delivery. Check planless and
planned turns, both late-plan boundaries, terminal task cards, tool/final
result identity and restart recovery. The retired Web UI origin shortcut should
remain absent. A resumed run or historical deployment receipt
does not replace this fresh acceptance.
