# OpenClaw 2026.11.3 cross-channel port review

Review date: 2026-11-11. Scope: official OpenClaw `v2026.11.2`
(`b556fdf457b026574bf0f1e7b4914b15f3f179ce`) to `v2026.11.3`
(`847611dcaa3bf0e2783335f961dd1fd0580e4d9f`), compared with the standalone
Mattermost plugin after its 11.3 directory correction at
`2b30bea60836c919f00765cf272bbd54d0f9c4f7`.

## Recommendation

Aside from the directory correction, two findings merit Mattermost follow-up.
The first is a small linear-time hardening in `trimUrlPunctuation` in
[`src/mattermost/thread-context.ts`](../src/mattermost/thread-context.ts#L78).
The current unanchored punctuation-run regex rescans long runs when punctuation
is followed by a non-punctuation character. OpenClaw 11.3
fixed the same regex shape in abort-trigger normalization; Matrix 11.3 also
replaced backtracking-prone parsing of sender-controlled formatted HTML with a
forward-only scan.

The Mattermost helper runs on inbound message text. Permalink hydration passes
the full inbound text, and reference-media resolution passes the full post
message. `maxLinks` bounds the number of returned references, but
`collectMattermostPermalinkReferences` continues scanning the text after that
limit is reached. The recorded synthetic probe applies the exact current helper
to strings containing a valid permalink followed by punctuation and a final
`x`: 4,000 punctuation characters took 15 ms, 8,000 took 56 ms, 16,000 took
245 ms, and 32,000 took 963 ms. This is evidence of the helper's scaling, not a
live-message or service benchmark. The probe is retained at
`.artifacts/operations/cross-channel-2026.11.3/permalink-punctuation-probe.json`.

A narrow adaptation can require the first character of a trailing punctuation
run to be preceded by a non-punctuation character, following upstream's
lookbehind guard. Keep the existing punctuation set and trimming behavior.
Acceptance should cover existing URL punctuation cases, valid same-origin
permalink behavior, and a timeout-bounded adversarial input with a long
non-terminal punctuation run. Source review should confirm the matching
algorithm advances from the start of each run.

The second is a conditional cache-correctness fix in
[`src/mattermost/capabilities.ts`](../src/mattermost/capabilities.ts#L6).
`blocksSupportCache` and its in-flight `blocksSupportPending` map use only
`client.baseUrl` as the key. A failed, missing, or unparseable `/system/ping`
version probe returns `undefined`, which is cached without a TTL. A later
account using a valid token against that same server reuses the unknown result
without probing; the button-format resolver then defaults unknown support to
Blocks. The maps also coalesce concurrent probes from separate clients for the
same base URL.

The actual-source isolated probe is retained at
`.artifacts/operations/cross-channel-2026.11.3/capability-cache-probe.json`.
With synthetic responses, token A's failed probe returned unknown and was
cached; token B's healthy probe for server version 11.7.8 was never called, so
the resolver chose Blocks where that version should select legacy buttons.
`x-version-id` is public server-version metadata: this is a capability and
cache-lifetime correctness issue, not evidence of private-content exposure.

Microsoft Teams 11.3 adds a credential hash to its parent-message cache key,
which supports scoping cache identity to the credential owner. A Mattermost
adaptation should also avoid permanently caching unknown probe results:
credential-scoped in-flight/cache identity can prevent cross-account
coalescing, while a bounded lifetime or retry policy is needed to recover from
transient failures under the same credential. Acceptance should cover a failed
probe followed by a healthy credential on the same server, concurrent probes
from separate accounts, transient recovery under one account, and a server
version change after cache expiry.

The official source fixes are
[abort-trigger punctuation handling](https://github.com/openclaw/openclaw/blob/51b6f79d1efe5b1cfc22d3a76f5bea7414b36fab/src/auto-reply/reply/abort-trigger-text.ts)
and
[Matrix mention parsing](https://github.com/openclaw/openclaw/blob/f4932950a9f3a2bb5ce459713d213cf672f73189/extensions/matrix/src/matrix/monitor/mentions.ts).
For the second candidate, see
[the Teams cache-key change](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/msteams/src/thread-parent-context.ts).
The abort-trigger patch is the closest implementation match for punctuation
trimming. The Matrix parser itself is provider-specific; its relevant lesson is
to bound work on sender-controlled text.

These are narrow hardening and cache-correctness candidates; neither requires a
new Mattermost feature. Twitch 11.3 also stops its parser-error logger from
including raw incoming IRC lines or parameters. That privacy pattern reinforces
the earlier conditional review of Mattermost diagnostics, but no corresponding
Mattermost content leak was reproduced here. Other 11.3 extension changes are
either already covered by Mattermost's own boundaries or belong to their
owning component.

## Inventory

The pinned extension diff contains 240 changed paths: 73 non-`package.json`
paths across 24 extension packages, plus the separate
`extensions/tsconfig.package-boundary.paths.json` path. In total, 167 extension
packages changed: 143 have `package.json` changes only, and 24 have other
changed paths. One of those 24 is Mattermost itself. The listed source changes
were reviewed against the official 11.3 tree.

| Extension area | 11.3 change | Mattermost assessment |
| --- | --- | --- |
| [Amazon Bedrock](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/amazon-bedrock/stream.runtime.test.ts) | Adds a runtime test assertion; no production behavior change. | No port. |
| [Baseten](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/baseten/models.ts), [Copilot Proxy](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/copilot-proxy/index.ts), [DeepInfra](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/deepinfra/provider-models.ts), [GitHub Copilot](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/github-copilot/models.ts), [Hugging Face](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/huggingface/models.ts), [llama.cpp](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/llama-cpp/src/external-server/models.ts), [LM Studio](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/lmstudio/src/models.ts), [Ollama](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/ollama/src/defaults.ts), [OpenRouter](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/openrouter/provider-catalog.ts), [Synthetic](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/synthetic/provider-catalog.ts) | Provider model catalogs, defaults, setup selection, and/or stream request behavior change. | Provider-owned model and transport policy. The Mattermost adapter consumes model choices through OpenClaw and does not own provider defaults. |
| [Exa](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/exa/src/exa-web-search-provider.runtime.ts), [Firecrawl](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/firecrawl/src/config.ts), [Tavily](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/tavily/src/tavily-client.ts) | Scope search/extract caches by credential; Exa also redacts request credentials from provider errors. Firecrawl now resolves a key and endpoint from the same selected configuration scope. | No matching shared search cache or sibling web-search/web-fetch configuration in Mattermost. Mattermost's outbound target caches key by base URL and token; its monitor-resource caches are created inside each account monitor. Its API error path already uses the SDK credential redactor, with tests for reflected credentials. |
| [Matrix](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/matrix/src/matrix/monitor/mentions.ts) | Replaces regex-heavy parsing of sender-controlled formatted HTML with bounded scans and tests varied anchor forms. | The HTML parser does not map to Mattermost's message format. Its linear-work principle supports the permalink punctuation fix above. |
| [Mattermost](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/mattermost/src/mattermost/directory.ts) | Fixes directory transport behavior and adds focused transport coverage. | Already included in the 11.3 adaptation; no other Mattermost runtime source path changed upstream. |
| [Memory Core](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/memory-core/src/memory/manager-provider-lifecycle.ts) | Adjusts recall budget and embedding/worker lifecycle handling, with focused tests. | Host memory subsystem behavior; no channel-owned equivalent. |
| [Hermes migration](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/migrate-hermes/config-provider-contract.ts) | Updates the provider configuration contract. | Migration-specific and not used by Mattermost message handling. |
| [Microsoft Teams](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/msteams/src/thread-parent-context.ts) | Adds a token hash to parent-message cache identity, alongside group, channel, and parent IDs. | Shared outbound target caches include the exact base URL and token, and per-account resource caches are instance-scoped. The separate capability cache is keyed only by base URL and is the conditional candidate described above; hashing alone would not fix permanently cached unknown probe results. |
| [QA Lab](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/qa-lab/src/providers/mock-openai/mock-openai-compaction-summaries.ts) | Changes mock OpenAI compaction summaries and test-suite session handling. | Test harness only. |
| [Signal](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/signal/src/daemon-env.ts) | Passes a minimal allowlisted environment to its managed `signal-cli` process and reports common dropped proxy/trust-store settings. | Mattermost does not launch a comparable managed daemon. |
| [Tlon](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/tlon/src/monitor/approval.ts) | Bare approval decisions resolve only when exactly one request is pending; multiple requests require an ID. | Mattermost interactive controls are tied to signed callback/action identity; it has no matching free-form pending-approval queue. |
| [Twitch](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/twitch/src/twitch-client.ts) | Replaces parser-error messages containing incoming IRC lines or parameters with a fixed diagnostic, while preserving other log messages. | IRC-specific; it reinforces the existing conditional Mattermost content-safe diagnostics review but does not establish a Mattermost leak. |
| [xAI](https://github.com/openclaw/openclaw/blob/847611dcaa3bf0e2783335f961dd1fd0580e4d9f/extensions/xai/tsconfig.json) | Adjusts TypeScript project configuration only. | Build configuration for the xAI provider. |

The package directories with non-metadata changes are Amazon Bedrock,
Baseten, Copilot Proxy, DeepInfra, Exa, Firecrawl, GitHub Copilot, Hugging Face,
llama.cpp, LM Studio, Matrix, Mattermost, Memory Core, Hermes migration,
Microsoft Teams, Ollama, OpenRouter, QA Lab, Signal, Synthetic, Tavily, Tlon,
Twitch, and xAI. The Mattermost-owned upstream change is linked in the pinned
[official 11.3 comparison](https://github.com/openclaw/openclaw/compare/b556fdf457b026574bf0f1e7b4914b15f3f179ce...847611dcaa3bf0e2783335f961dd1fd0580e4d9f).

## Shared/core changes: consume through the host

The shared `src/channels` and `src/infra/outbound` trees have no changes between
the pinned releases. Several important 11.3 agent changes do affect what a
Mattermost user sees, but their implementation belongs to the host:

| Core repair | Owning boundary and local assessment | Future integrated acceptance |
| --- | --- | --- |
| [Private task completion visibility](https://github.com/openclaw/openclaw/blob/9fde2f36f855f40d4748e2338ee0efc509304313/src/agents/command/session-preparation.ts) | Re-registration now keeps `privateCompletion` work out of visible session messages/activity, as it already does for coordination provenance. Mattermost uses the host's prepared progress lane; its child rows gate authored detail on `publicRead` and suppression flags, and do not project reasoning or assistant prose. Preserve those distinct boundaries. | A private child completion must not become a public transcript or authored child detail. Permitted child labels/status should retain their normal task-card behavior. |
| [Cancellation and replacement child handoff](https://github.com/openclaw/openclaw/blob/214cff537d024c4d940c202b0059f365fa8c0992/src/agents/subagents/registry/subagent-control-kill.ts) | The host retires the current requester's accepted-spawn completion receipt after acknowledged final cancellation publication and identity checks. The plugin observes lifecycle/status; it does not own these registry receipts. | Cancel child A, start child B, and confirm A stays cancelled, B progresses, and the parent continues without an extra result or task-card identity. |
| [Unanswered tool failure reporting](https://github.com/openclaw/openclaw/blob/3881c3a5d1a621f768b0055422bed0ac536b9f08/src/agents/embedded-agent-runner/run/attempt-terminal-evidence.ts) | The host stops classifying an unanswered failed tool as intentional terminal silence. Mattermost's final-delivery paths already distinguish `isError` payloads from normal draft adoption. A failed individual tool must not automatically mark an otherwise recovered turn as failed. | One unanswered tool failure produces one truthful visible result and terminal status, with no stranded preview. A recoverable tool failure followed by successful completion remains successful. |

Local source evidence:
[`monitor-turn.ts`](../src/mattermost/monitor-turn.ts#L293),
[`monitor-progress-continuation.ts`](../src/mattermost/monitor-progress-continuation.ts#L49),
[`task-progress-card.ts`](../src/mattermost/task-progress-card.ts#L286),
and [`subagent-progress.test.ts`](../src/mattermost/subagent-progress.test.ts#L79).
These are source/regression coverage observations, not fresh live lifecycle
proofs from this research task.

The maintained core candidate
`2229433d5ea210a3c66af95d93d90f3055d1d4a3` also repairs the downstream
non-process failed-tool completion fence after the official terminal-helper
change. Its production compiled SDK probe accepted the existing plugin artifact
with 85 public subpaths, 270 named exports, no failures, and the asynchronous
invalid-input secret resolver contract. The binding is retained separately in
`.artifacts/operations/adapt-2026.11.3/core-compiled-acceptance.json`; the original
test candidate identity remains in the earlier validation evidence.
This compiled probe establishes the SDK contract, not the integrated lifecycle
scenarios above.

Provider-auth run deadlines, model output budgets, memory/compaction handling,
and provider/search tool behavior should likewise remain with their host or
extension owner. They do not justify duplicating those mechanisms in the
Mattermost channel.

## Earlier backlog and conditional hardening

The [11.2 review](cross-channel-2026.11.2.md) already identified cancellation
during startup authentication as a useful narrow port. It remains relevant:
[`monitor.ts`](../src/mattermost/monitor.ts#L144) passes the abort signal to
`runWithReconnect`, but its pending `fetchMattermostMe(client)` request does not
receive that signal. The HTTP client has a timeout; this is not evidence of an
unlimited hang. OpenClaw 11.3's
[provider-auth run deadline](https://github.com/openclaw/openclaw/blob/53a9f35dfe6b6e816accd5d661191808d76ead50/src/agents/embedded-agent-runner/run/auth-controller.ts)
reinforces cancellation ownership, but it is a different authentication
operation and does not itself cancel Mattermost's `/users/me`.

Keep this as an existing backlog item, after the newly confirmed permalink and
capability-cache findings. Acceptance should abort a pending request and its
rate-limit wait, prevent late routes/workers/WebSocket startup, and preserve
normal retries while the account remains active.

Twitch's content-safe parser diagnostic reinforces the earlier conditional
HTTP-error logging concern. Mattermost drops malformed WebSocket payloads
without ordinary raw-payload logging, and its HTTP error boundary already
bounds reads and redacts the current request credential. A provider could still
reflect submitted prose in an error message; there is no Mattermost-specific
reflected-prose reproduction in this audit. Keep a synthetic rejection/log
check as a separate hardening candidate, retaining status, retry facts and
accepted-delivery uncertainty. Opt-in diagnostic capture has a separate
explicit purpose and should not be conflated with ordinary logging.

## Local checks and limits

- [`collectMattermostPermalinkReferences`](../src/mattermost/thread-context.ts#L131)
  scans all URL matches even after it has collected the configured maximum.
- [`monitor-posts.ts`](../src/mattermost/monitor-posts.ts#L408) supplies the
  inbound text to permalink hydration;
  [`reference-media.ts`](../src/mattermost/reference-media.ts#L25) supplies the
  post message to the same collector.
- [`send.ts`](../src/mattermost/send.ts#L305) scopes shared outbound lookup
  cache keys by base URL and token. [`monitor-resources.ts`](../src/mattermost/monitor-resources.ts)
  constructs its lookup maps within the monitor-resource factory. The
  capability-probe cache is process-global and keyed by base URL only.
- [`client.ts`](../src/mattermost/client.ts#L255) bounds provider error-body
  reads and redacts request credentials; the corresponding regression tests are
  in [`client.error-redaction.test.ts`](../src/mattermost/client.error-redaction.test.ts).
  This credential redaction does not establish that provider error text cannot
  echo submitted message content.
- The timing evidence comes from the retained pure-function probe. No network,
  account, Mattermost server, state, source edit, test suite, or build was used
  for this cross-channel review.

The full path inventory and probe receipts are retained under
`.artifacts/operations/cross-channel-2026.11.3/`:
`upstream-inventory.json`, `permalink-punctuation-probe.json`,
`capability-cache-probe.json`, and `research-summary.json`.
The latter records the accepted artifact hash
`31bbc37086b06ccd60ae0f5128e5351b7c5c28e98149d8ba5404bdf8d1893cca`
and compiled SDK contract hash, both preserved during this research. This
task adds this research note and local evidence only; it implements neither
recommended fix and performs no installation, restart, push or publication.
