# OpenClaw 2026.10.2 Mattermost adaptation

Historical release adaptation record. Its source identities, decisions and
validation describe that adaptation. Current retained ports and subsequent
cleanup are tracked in [the porting audit](porting-audit-2026.10.5.md).

Compared the complete official `v2026.10.1` and `v2026.10.2` Mattermost and
Plugin SDK source trees before changing this standalone package. The official
Mattermost delta is package declarations only. This adaptation introduces no
Mattermost lifecycle code changes and does not install or restart a Gateway.

## Authoritative sources

| Source | Identity |
| --- | --- |
| Official `v2026.10.1` tag | Annotated tag `250c0e30dcb1c4fb661b55af912236773b58f1b8`, peeled commit `e178c39e9aae3fa440735217f9aef9574f286677` |
| Official `v2026.10.2` tag | Annotated tag `67f65e1408ba7b8589a1116155ade1e74e173244`, peeled commit `b8952d477f0c932d8ddc6da5c89cab5a169b6ff1` |
| Published `openclaw@2026.10.1` | Registry tarball SHA-256 `6af9925274c60309763e1c6c9bcc9afcc3c59775c0ac4c403fe5460fe0190136` |
| Published `openclaw@2026.10.2` | Registry tarball SHA-256 `d1c979c9ff6c5fb600a4582a7d777e0ef5264f5a570d2e822323a8c508d744fe` |

Both npm tarballs were downloaded from the registry and verified against the
registry's SHA-512 integrity and SHA-1 shasum. Official tag archives were
downloaded into a task-private directory; no core or live Gateway checkout was
used as a dependency.

Sources: [official 10.1 Mattermost](https://github.com/openclaw/openclaw/tree/v2026.10.1/extensions/mattermost),
[official 10.2 Mattermost](https://github.com/openclaw/openclaw/tree/v2026.10.2/extensions/mattermost),
[official SDK](https://github.com/openclaw/openclaw/tree/v2026.10.2/src/plugin-sdk),
[published npm SDK](https://www.npmjs.com/package/openclaw/v/2026.10.2),
and [release notes](https://github.com/openclaw/openclaw/releases/tag/v2026.10.2).

## Carried, ported, core-owned, and deferred decisions

| Area | Decision |
| --- | --- |
| Official Mattermost delta | Of 150 files in each tag's Mattermost tree, only `package.json` changed: version, peer host floor, plugin API floor, and build version became 2026.10.2. Port those equivalent declarations; also advance this downstream package's explicit minimum host and exact development SDK. |
| Public SDK | All 729 files under `src/plugin-sdk` are byte-identical. All 344 published Plugin SDK export-map entries are identical. Validate actual emitted runtime subpaths and named bindings against the installed exact npm 10.2 dependency. Regenerated declaration/chunk filenames are not evidence of an SDK source contract change. |
| Standalone build | Carry the existing external-SDK build and browser-only public Control UI SDK bundle. Keep OpenClaw a development dependency and optional host peer. Do not import monorepo test infrastructure or bundle core into the plugin. |
| Commands and callbacks | Carry slash commands, skill filtering, channel model commands, approval cards, protected secret dialogs, question/select callbacks, account-scoped signatures, and durable callback admission unchanged. |
| Mattermost lifecycle | Carry reactions, threads, streaming, recovery, cardless planless turns, both late-plan handoff boundaries, accepted-without-id handling, yielded cards, and provenance-based parent continuation unchanged. There is no official Mattermost source fix to port in 10.2. |
| Shared host fixes | Reply startup/delivery, subagent/ACP completion, requester wake, stall/approval handling, prompt-cache provenance, redaction, compaction, and update/doctor recovery belong to core. Consume them through the 10.2 host; their implementation and deployment remain with the core owner. |
| Cross-channel fixes | Telegram replacement/final-delivery handling, owner rejection, and send context changes are provider-specific and deferred. No speculative equivalent is added to Mattermost's existing delivery reconciliation and identity handoff. |
| Existing diagnostics | Preserve the previously documented standalone TypeScript diagnostic limitations and non-public `SessionEntry.lastRunId` reader as follow-up work. Do not add casts, declaration stubs, or source links to conceal them. |

## Local validation and deployment boundary

Run focused downstream command, callback, recovery, draft-stream, task-card,
and continuation regressions before the complete `npx vitest run` and
`npm run build` gate. The existing artifact identity regression now asserts
the exact 10.2 package, SDK, host, API, build, and lockfile contracts; its
initial failures with stale 10.1 expectations are preserved in the task proof.
No lifecycle regression is added because this adaptation changes no lifecycle
implementation. The existing ten monorepo-only suites stay excluded.

The build checks every emitted SDK subpath and named import against the exact
published 10.2 dependency. Pack with `npm pack --omit=dev`; inspect the artifact
for runtime entries, the standalone browser asset, manifest identity, external
SDK imports, and absence of bundled core or development dependencies.

Root owns installation, capability consent, plugin ownership, Gateway restart,
and live acceptance. After authorized deployment, use fresh inbound 10.2 turns
to check both a planless reply (no task card) and a planned/tool-using turn:
the `task_progress` post must predate `turn_result`, tool/final edits must retain
the result identity, and the card must end truthfully. Also exercise a yielded
parent and its committed child-settle continuation to confirm the same card
stays In progress until the parent completes. Check native slash, approval,
secret-dialog and question callbacks, reactions, thread routing, and recovery
on the installed host. The prior 10.1 yield/child-continuation live receipt
is historical evidence only; a resumed turn is not a fresh inbound lifecycle
proof for 10.2.

Exact source inventories, commands, test/build results, packed artifact hashes,
and the complete-baseline independent review receipt are retained in the task's
`/tmp/openclaw/mattermost-2026-10-2` handoff artifacts.
