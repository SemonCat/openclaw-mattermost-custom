# OpenClaw 2026.10.3 Mattermost adaptation

Compared the full official `v2026.10.2` and `v2026.10.3` tag archives, published
npm packages, release notes, and relevant shared host changes before editing.
The official Mattermost delta is package declarations only. This adaptation
introduces no Mattermost lifecycle implementation changes.

## Authoritative sources

| Source | Identity |
| --- | --- |
| Official `v2026.10.2` | Annotated tag `67f65e1408ba7b8589a1116155ade1e74e173244`, peeled commit `b8952d477f0c932d8ddc6da5c89cab5a169b6ff1` |
| Official `v2026.10.3` | Annotated tag `3a8c04b0832eabc4410ba7c7a30c9c27e4b5fc81`, peeled/release commit `59cb44796b0f1f0daa0e37af8b1495abb45d9bc1` |
| Official 10.2 archive SHA-256 | `5ab2200d6e0b31bc30e1c97998fa15bc577e1a6abc98a0814fa399b9abd77010` |
| Official 10.3 archive SHA-256 | `f34a8bda643b4b7b358b9dcbeeeceaa7f749ffb0f49f7273fb8e725a10c8eb34` |
| Published `openclaw@2026.10.2` tarball SHA-256 | `d1c979c9ff6c5fb600a4582a7d777e0ef5264f5a570d2e822323a8c508d744fe` |
| Published `openclaw@2026.10.3` tarball SHA-256 | `761685d010d96645d1deabe19299ecde263eac3f2489a17322f48c461a1130a5` |
| Published 10.3 registry integrity | `sha512-ncl6LntMlf76K39LFhVrDXQTbaGNAG5j52f7PL5P8vIn0knWmCrvfAe9DHMslFq+47HeOWBH2CBYQH8zEb+UAA==` |
| Published 10.3 registry SHA-1 | `789ced199b21c620c47cc502cd4c8ccd880f0ed4` |

Both npm tarballs passed the registry SHA-512 integrity and SHA-1 shasum checks.
The release's integrity and release SHA agree with the downloaded package and
peeled tag. Archives and npm packages are held in task-private directories;
no live core checkout is used as a dependency. Full archive comparisons, rather
than the capped GitHub compare API file list, establish the inventories below.
The initial unauthenticated release API fetch hit a rate limit; its failed
receipt is retained, and root supplied authenticated release evidence.

Sources: [official 10.2 Mattermost](https://github.com/openclaw/openclaw/tree/v2026.10.2/extensions/mattermost),
[official 10.3 Mattermost](https://github.com/openclaw/openclaw/tree/v2026.10.3/extensions/mattermost),
[official SDK](https://github.com/openclaw/openclaw/tree/v2026.10.3/src/plugin-sdk),
[shared channels](https://github.com/openclaw/openclaw/tree/v2026.10.3/src/channels),
[published npm SDK](https://www.npmjs.com/package/openclaw/v/2026.10.3),
and [release notes](https://github.com/openclaw/openclaw/releases/tag/v2026.10.3).

## Port, preserve, and defer decisions

| Area | Decision |
| --- | --- |
| Official Mattermost | Both trees contain 150 files; only `package.json` changed. Port version, host peer floor, plugin API floor, and build version; advance the downstream explicit minimum host and exact development SDK to 2026.10.3. |
| Consumed SDK contracts | All 729 `src/plugin-sdk` files and all 537 `src/channels` files are byte-identical. All 344 published SDK export-map entries, including targets, are identical. Keep the build's actual emitted named-export checks against exact installed published 10.3; unchanged source contracts do not imply identical bundled host internals. |
| Dependency boundary | Keep OpenClaw as an exact development dependency and optional host peer. Its required `@openclaw/ai` dependency advances from 2026.10.2 to 2026.10.3. Preserve unrelated lock entries whose ranges remain satisfied. Keep SDK, `ws`, and `zod` external in Node output and bundle only the public browser SDK in the self-contained Control UI asset. |
| Custom interactions | Preserve native/dynamic commands, `/channel_model`, callbacks, approvals, protected secret dialogs, questions/selects, account-scoped signatures, and durable callback admission. No official interaction source change requires a port. |
| Mattermost lifecycle | Preserve reactions, thread routing, streaming, recovery, planless cardlessness, both late-plan boundaries and identity handoff, accepted-without-id handling, yielded parent progress, and committed-provenance continuation. No lifecycle code or ordering contract is changed. |
| Shared account startup | Core changes `server-channel-startup.ts` and `server-channels.ts` to clear stale caller/operator authority and bind the current Gateway context for restarted accounts (#159396). Consume through the 10.3 host; do not duplicate authority handling in the plugin. |
| Shared outbound recovery | Core's queue recovery excludes actively owned live sends before taking inspection claims (#169010). Preserve Mattermost's own reconciliation and result/card identities; no local queue implementation is replaced. |
| Shared restart recovery | Core retains human ingress provenance when steering changes the transcript tail (#170252). This does not add proof of same-run human steer adoption to this plugin's public transcript reader; keep its existing continuation retirement rules. |
| Plugin generations/upgrades | Registration now checks the calling workspace generation; native graph refresh, deferred webhook upgrades, Doctor repairs, and stale Codex runtime fixes belong to core (#169272, #169321, #169035, #170306, #170339). No plugin capability expansion or live config edits are introduced here. |
| Other host fixes | Compaction, model/harness selection, provider transport, update/Doctor recovery, OAuth preservation, and service/platform fixes remain core-owned. The separate core workspace owns upgrade and deployment. |
| Cross-channel | Root's independent full archive comparison covers Slack (435 files), Telegram (520), and Discord (744); each changes only `package.json`. There is no new provider behavior to transplant. Prior release-specific cross-channel follow-ups remain deferred. |
| Existing diagnostics | Preserve the ten monorepo-only suite exclusions and documented standalone TypeScript diagnostics, including the non-public `SessionEntry.lastRunId` reader. No source links, declaration stubs, or unrelated type cleanup are added. |

## Local proof and remaining live acceptance

Run the relevant identity, command, interaction, recovery, draft-stream, task-card,
and continuation regressions first, then `npx vitest run` and `npm run build`.
Update active exact-version assertions alongside package and lock declarations.
The build validates every emitted SDK subpath and named binding against the exact
installed npm 10.3 package. Pack a self-contained npm artifact and inspect runtime
entries, browser asset, manifest/capabilities, external SDK imports, and absence
of bundled core or development dependencies. Independent autoreview covers the
complete frozen baseline diff, including this new document.

No new lifecycle regression is required because no lifecycle implementation
changes. Existing source tests do not establish live post ordering. Root owns
acceptance and the authorized install/restart after the core upgrade; this source
task does not install a live plugin, edit core/live configuration, restart the
Gateway, commit, or push.

After deployment, use **new inbound Mattermost turns** to confirm a planless
reply creates no task card, and a planned/tool-using turn leaves `task_progress`
older than `turn_result`, with subsequent tool/final edits retaining the result
identity and a truthful terminal card. Exercise both late-plan boundaries:
result delivery entered before any result post, and commentary already posted
before the plan. Also confirm yielded parents remain In progress and a committed
child-settle continuation updates that same card until real parent completion.
Check slash commands, approvals, protected secret dialogs, questions, reactions,
thread routing, recovery, and the Control UI origin link on the installed host.
A resumed turn after restart and historical 10.2 live receipts do not satisfy
fresh-inbound 10.3 acceptance.

Exact command/test/build/pack receipts, source inventories, artifact hashes,
review input binding, serving-model metadata, and root handoff are retained under
`/tmp/openclaw/mattermost-2026-10-3`.
