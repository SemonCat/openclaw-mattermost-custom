# OpenClaw 2026.10.9 Mattermost adaptation

Adaptation date: 2026-10-30. Compare the complete official 10.8 and 10.9 source
trees at the plugin boundaries, then validate against the exact published
`openclaw@2026.10.9` development dependency. This does not upgrade the running
Gateway or install either Mattermost artifact.

## Source identities

| Source | Identity |
| --- | --- |
| Official 10.8 tag | Annotated tag `e07a2f67d11717ed39aa2fa07bbe9342376ebfbf`, peeled commit `dc2523e5a5c7a309517fd7fa834add938231d526` |
| Official 10.9 tag | Annotated tag `88a19e0d8677804d8ec98e30a3a3a3a9308ebee0`, peeled commit `8b18b5578f66eab1501cba4cef2310d88bfb9a41` |
| Official 10.9 archive SHA-256 | `c029b4a0294f63c9de48541c6a939f71974221c01452a73255a3500d3a6205c8` |
| Published 10.9 npm integrity | `sha512-KbIl0/7an0/nKBo92FnJg7LFcEpFVQyOgSRfHNE9yxELg1Ebql7BmBsdLL+1dDOLZnQtuwjt6Hy45CCrmYdJNA==` |
| Published 10.9 npm SHA-1 | `12242823a04ad5d60b6b2f8947b0d74d20dd0b1d` |

Both baselines use complete official tag archives. File inventories compare all
paths and file contents within each listed scope, including tests, without a
capped compare-API file list. Tag identities were read with `git ls-remote`.
Registry metadata, source inventories, exact patches and validation logs are
retained outside the repository under
`/tmp/openclaw/mattermost-adapt-2026.10.9/`.

Primary sources:
[official comparison](https://github.com/openclaw/openclaw/compare/v2026.10.8...v2026.10.9),
[Mattermost package](https://github.com/openclaw/openclaw/blob/v2026.10.9/extensions/mattermost/package.json),
[public SDK](https://github.com/openclaw/openclaw/tree/v2026.10.9/src/plugin-sdk),
[release notes](https://github.com/openclaw/openclaw/blob/v2026.10.9/CHANGELOG/2026.10.9.md)
and [published package](https://www.npmjs.com/package/openclaw/v/2026.10.9).

## Comparison and port decisions

| Area | Evidence and decision |
| --- | --- |
| Official Mattermost | Both trees have 145 files. Only `package.json` changes, advancing version, peer dependency, plugin API and build metadata. Advance downstream artifact, exact development SDK, peer/minimum host, plugin API and build contracts together. No Mattermost behavior change to port. |
| Public SDK | All 749 files are byte-identical. All 345 SDK export-map entries and targets are unchanged. Continue using the published SDK without source-checkout links or private imports. |
| Shared channel layer | All 523 files are byte-identical. Preserve existing ingress, commands, callbacks, reactions and recovery integration. |
| Outbound layer | All 262 files are byte-identical. Preserve adapters, receipts, silent sends, attachment grouping and accepted-without-ID behavior. |
| Native footer | All eight `src/auto-reply/usage-bar/` files are byte-identical. Native footer rendering remains host-owned. No plugin formatter or live template change is needed. |
| Workspace tool restrictions | Core changes `src/agents/openclaw-tools.fs-policy.ts`, `openclaw-tools.ts` and `tool-fs-policy.ts` so Gateway-built tools honor `tools.fs.workspaceOnly`. Use the host policy; do not duplicate it in the channel plugin. Existing Mattermost channel/sender policies remain in the shared pipeline. |
| Model refresh and ACP | Model-runtime publication/ownership synchronization and ACP session working-directory selection change in core. These can benefit Mattermost-triggered work after a host upgrade, without a native picker or channel routing port. |
| Security maintenance | The release notes identify URI/Zod validation, IMAP sender parsing, Teams authentication, MCP inspection and OAuth log redaction fixes. These belong to their host or provider owners, not this plugin's source. The plugin's runtime `zod` dependency remains exactly 4.6.5, matching the published host. Do not imply that rebuilding this artifact activates the host patches. |
| Recovery and data preservation | SQLite FTS/tokenizer recovery, disk-full recovery, large transcript archive migration, safe update rollback, remount recovery and Gateway service/runtime startup remain host-owned. Do not copy database, updater or service implementation into the plugin. |
| Dependencies | Node remains `>=24.22.1 <25 || >=26.12.1`. OpenClaw and `@openclaw/ai` advance to 10.9. npm also refreshes development-only transitive `@opentelemetry/semantic-conventions`, `encodeurl`, `express-rate-limit`, `jose` and `qs`; the plugin's declared runtime dependency and artifact allowlist are unchanged. |
| Companion | The independent Mattermost server/web artifact under `companion/` has no source or protocol changes. It remains outside the root npm artifact. |

No additional Mattermost feature port is justified by this release. Existing
downstream features remain in place; the host upgrade owns the maintenance
improvements above.

## Validation and deployment boundary

Use the existing version/identity regression against the real published SDK,
then run the full standalone Vitest gate and runtime build. Keep the existing
ten monorepo-only suite exclusions, timeouts and concurrency. No new behavior
test is needed for a package-only adaptation.

The build must verify every emitted SDK subpath and named binding against the
exact installed npm dependency. Build and inspect a self-contained tarball,
including its unchanged capability manifest and version metadata, and confirm
that it contains no core, development dependencies or companion files.

The root TypeScript diagnostic remains outside the passing standalone gate:
published declaration gaps and the existing `SessionEntry.lastRunId` access are
not changed by this adaptation.

No installation, restart, production configuration/DB change or Mattermost
message is part of these source checks. After a separately authorized
deployment, use a fresh inbound turn to verify the installed host/plugin
boundary. Source tests and packaging do not establish live post ordering,
task-card finalization, native controls or companion previews.
