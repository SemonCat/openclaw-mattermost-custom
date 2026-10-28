# OpenClaw 2026.10.8 Mattermost adaptation

Adaptation date: 2026-10-28. Compare the complete official 10.7 and 10.8 source
trees at the plugin boundaries, then validate against the exact published
`openclaw@2026.10.8` development dependency. This does not upgrade the running
Gateway or install either Mattermost artifact.

## Source identities

| Source | Identity |
| --- | --- |
| Official 10.7 tag | Annotated tag `5c101ce5a0637df375c5f6ae49d44d0d27cc26b1`, peeled commit `157d8c2bc3ea2fa183afdc11088e69690bf8e64e` |
| Official 10.8 tag | Annotated tag `e07a2f67d11717ed39aa2fa07bbe9342376ebfbf`, peeled commit `dc2523e5a5c7a309517fd7fa834add938231d526` |
| Official 10.8 archive SHA-256 | `42dc4a9f5f921c77487dd8c95e92d91c792187266a0b60cd15626b284674de9c` |
| Published 10.8 npm integrity | `sha512-fWOIOOyddIBqeuPz82DBCdY5kNl1yD51qebAHnxlTN7SmVoH5/WSIudR/N1zDhcIIksgJXe6ZgGy5ngSRxZOrQ==` |
| Published 10.8 npm SHA-1 | `2a70a420662d88faacaee147ad7243ea6a1630a1` |

The 10.7 baseline uses the existing local official tag's Git objects; the 10.8
candidate uses the complete official tag archive. File inventories compare all
paths and Git blob identities within each listed scope, including tests,
without a capped compare-API file list. Tag identities were read with
`git ls-remote`; GitHub's tag API was rate-limited. Registry metadata, source
inventories and exact patches are retained outside the repository under
`/tmp/openclaw/mattermost-adapt-2026.10.8/`.

Primary sources:
[official comparison](https://github.com/openclaw/openclaw/compare/v2026.10.7...v2026.10.8),
[Mattermost](https://github.com/openclaw/openclaw/tree/v2026.10.8/extensions/mattermost),
[secret contract](https://github.com/openclaw/openclaw/blob/v2026.10.8/extensions/mattermost/src/secret-contract.ts),
[shared secret runtime](https://github.com/openclaw/openclaw/blob/v2026.10.8/src/secrets/channel-secret-basic-runtime.ts),
[release notes](https://github.com/openclaw/openclaw/blob/v2026.10.8/CHANGELOG/2026.10.8.md)
and [published package](https://www.npmjs.com/package/openclaw/v/2026.10.8).

## Comparison and decisions

| Area | Evidence and decision |
| --- | --- |
| Official Mattermost | Both trees have 145 files. Only `package.json` and `src/secret-contract.ts` change. Advance all downstream version/host contracts together and port the secret ownership correction. |
| Secret ownership | Account listing already preserves an implicit default when root `baseUrl` and a root or environment bot token exist. The old collector considered only explicit named accounts, losing the root SecretRef if every named account overrides it. Use the published `createChannelSecretContract` with the same implicit-default predicate and the resolver's `context.env`. Keep existing exports, registry targets, disabled-account behavior and explicit-default precedence. |
| Public SDK | Of 749 files, only `concurrency-runtime.ts` changes, adding `runInDetachedAsyncContext`. All 345 SDK export-map entries and targets are unchanged. No new concurrency helper is needed by this port. Shared secret runtime behavior and declarations change behind the existing public SDK subpath. |
| Shared channel layer | Of 523 files, four ingress retry/writer files change. The host's queue owner now bounds prepared-runtime recovery retries, honors deferred eligibility, avoids charging non-attempts, and clears terminal recovery state. Custom ingress already calls the public `createChannelIngressMonitor` with its queue; use the updated SDK instead of copying the host policy. |
| Outbound layer | Of 262 files, `source-delivery-plan.ts` and its test change. The host contract adds `messageTool.finalByDefault`; the custom plugin does not construct that internal plan. Preserve outbound adapters and receipts. |
| Native footer | All eight usage-bar source files are byte-identical. Core remains responsible for native usage footers; no plugin formatter or live template changes are part of this adaptation. |
| Dependencies | Node remains `>=24.22.1 <25 || >=26.12.1`. OpenClaw and `@openclaw/ai` advance to 10.8; npm also resolves development-only `qs` to 6.17.0. Runtime `zod` and the root artifact allowlist are unchanged. |
| Companion | The independent Mattermost server/web artifact under `companion/` has no source or protocol changes. It remains outside the root npm artifact. |
| Host release fixes | Runtime recovery, database startup, provider/model continuity, update/Doctor recovery and streaming fixes stay with the host. This plugin adaptation does not claim to activate them on an installed Gateway. |

## Regression and validation boundary

The new secret regression runs the real published SDK collector. Before the
source fix, the named-account case loses the default owner's assignment:
one of seven tests fails and six pass. After the fix, it must collect and
materialize both root/default and named tokens. Other cases cover root-only
ownership, enabled/disabled explicit defaults, a disabled channel, an absent
root base URL, and named-account inheritance.

Keep the existing standalone test configuration, ten monorepo-only suite
exclusions, timeouts and concurrency. No source-checkout SDK link, declaration
stub or cast is added. The root TypeScript diagnostic is not a green gate;
the existing declaration gaps and documented `SessionEntry.lastRunId` access
remain outside this adaptation.

Build a self-contained archive only after the source gates pass. Verify the
unchanged capability manifest, public SDK imports, version metadata and absence
of core, development dependencies and companion files from that archive.

No installation, restart, production configuration/DB change or Mattermost
message is part of these source checks. After a separately authorized
deployment, use a fresh inbound turn to verify the installed host/plugin
boundary; source tests cannot establish live message ordering or previews.
