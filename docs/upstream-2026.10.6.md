# OpenClaw 2026.10.6 adaptation and selected Mattermost ports

Implemented on 2026-10-23 against the exact published `openclaw@2026.10.6`
development dependency. Package version, peer/minimum host, plugin API and build
metadata move together to 2026.10.6. Node follows the release's
`>=24.22.1 <25 || >=26.12.1` contract. SDK imports remain external; standalone
test exclusions and the live Gateway dependency boundary are unchanged.

The official Mattermost extension changes only its package version between
10.5 and 10.6. No additional downstream subsystem is retired. The preceding
[research report](cross-channel-2026.10.6.md) remains the source comparison and
backlog record; this document describes the subsequently authorized work.

## Silent delivery

The public SDK message action reads `silent` into outbound context, independently
of reply payload fields. The plugin forwards that context through text, media,
and payload sends, advertises durable silent support, and uses the documented
`/posts?silent=true` endpoint only for explicit true. Normal sends retain `/posts`.
The client recognizes exactly these create paths for dispatch evidence and
accepted-but-unreadable receipt handling. Other query endpoints gain no message
dispatch classification. Provider rejection never becomes a normal-send retry.
Independent review also found a preexisting text-reconciliation client mismatch:
reconciliation now reuses the resolved account client and resolves the bot with
that client. A real loopback accepted-without-ID send is recovered only by its
exact signed marker, author and thread, without a second create.

Primary provider evidence: Mattermost
[posts API](https://github.com/mattermost/mattermost/blob/v12.0.0/api/v4/source/posts.yaml),
[API parser](https://github.com/mattermost/mattermost/blob/v12.0.0/server/channels/api4/post.go),
and [integration permission check](https://github.com/mattermost/mattermost/blob/v12.0.0/server/channels/app/post.go).
Silence requires integration authority; PAT ownership alone is insufficient.
No implicit silence policy is added for approval or question prompts.

## Group and sender tool policy

The local schema now preserves `buildGroupEntrySchema`'s `tools` and
`toolsBySender`. The host already falls back to
`resolveChannelGroupToolsPolicy` for channels without a custom tool resolver.
No redundant local resolver is installed. Its account map, exact/wildcard,
typed-sender and `senderPolicyMode` semantics remain authoritative. Skill
availability retains its independent behavior.

Tests use public `channel-policy` APIs and the published
`agent-harness.createOpenClawCodingTools` factory with isolated state and only
base coding-tool construction enabled. They select tools without executing them,
loading provider tools, or calling a provider. This proves actual host global-deny
intersection. Shared schema compatibility still permits untyped sender keys;
shared runtime resolution rejects them with its doctor migration message.

Primary host contracts:
[group fallback](https://github.com/openclaw/openclaw/blob/v2026.10.6/src/agents/agent-tools.policy.ts),
[policy layers](https://github.com/openclaw/openclaw/blob/v2026.10.6/src/agents/tool-policy-pipeline.ts),
[flat group resolver](https://github.com/openclaw/openclaw/blob/v2026.10.6/src/config/group-policy.ts).

## One-post attachment collections

Public message action preparation retains the full supported collection.
Outbound payload and ordinary inbound reply delivery both pass it to the
sender. The outbound adapter opts into the host's `sendPayloadGroupsMedia`
contract so ordinary collections reach the payload sender intact. Files upload
sequentially before a single create receives the complete
ordered ID list. The provider model's `PostFileidsMaxRunes = 300` permits ten
26-character IDs (291 JSON runes) but rejects eleven (320). A conservative
20 MiB aggregate cap also applies, reduced by an explicit effective media limit.
Existing single-file limits/fallback remain.

The sender uses published Markdown chunking and account chunk-mode resolution,
with the actual client base URL's observed server limit and configured limit.
Files and controls stay on the first post; text overflow produces text-only
posts. Aggregate receipts retain known successes across rejected or ambiguous
tail failures. Single-intent markers reflect actual physical count; nested
host-counted fanout omits markers rather than signing an inaccurate count.
Media unknown-send reconciliation remains disabled.

A failed upload prevents any visible post. Known successful uploads may remain
unattached after failure; the verified provider's
[file route registry](https://github.com/mattermost/mattermost/blob/v12.0.0/server/channels/api4/file.go)
has no standalone file-delete route. No invented cleanup API or capability is
introduced, and accepted attachments are never deleted as cleanup.
Oversized collections and upload failures deliberately fail as one group;
they do not fall back to sequential visible posts.
Primary count validation:
[Mattermost post model](https://github.com/mattermost/mattermost/blob/v12.0.0/server/public/model/post.go).

## Verification boundary

Focused regressions use public adapters and real loopback REST transport, actual
SDK media loading, and public host tool selection. They cover ordered uploads,
count/byte limits, local-root/SSRF rejection, cancellation/current sender
retirement, text overflow/Markdown/newline behavior, queue markers, receipt
callbacks, and accepted-without-ID no-retry behavior.
Caller cancellation remains active for uploads and the sender's pre-dispatch
fences. Once a create starts, its receipt is allowed to settle: a loopback
provider records the post, cancels the caller, and then returns either a known
identity or an accepted-without-ID response. Both normal and silent text/group
paths retain the resulting evidence without a second create. Cancellation
still fences subsequent overflow posts. This repair does not change the
preexisting transport timeout/network ambiguity handling or equate dispatch
alone with provider acceptance.
The published message bridge is exercised with intact media collections and
real transport. The installed SDK does not export an injectable top-level
host router or registry setup API; the host routing decision is covered by
the exported adapter flag and the exact official
[handler](https://github.com/openclaw/openclaw/blob/v2026.10.6/src/infra/outbound/deliver-channel.ts)
and [delivery](https://github.com/openclaw/openclaw/blob/v2026.10.6/src/infra/outbound/deliver-core.ts)
contracts in review context. No private compiled import or copied router
substitutes for host integration coverage.

Exact test/build/package/review receipts are kept outside the repository in the
task evidence root. This work does not install a plugin, restart a Gateway, send
an external message, accept capability consent, commit, or push. No live
Mattermost lifecycle proof is claimed. The preexisting cleanup and lifecycle
changes remain part of the complete candidate and require parent acceptance.
