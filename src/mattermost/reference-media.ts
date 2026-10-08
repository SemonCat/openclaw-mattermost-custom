import { stat } from "node:fs/promises";
import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/account-helpers";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveMattermostAccount } from "./accounts.js";
import { MattermostPostSchema, fetchMattermostFileInfo, type MattermostPost } from "./client.js";
import { resolveMattermostMonitorInboundAccess, shouldRetainMattermostSenderHistory } from "./monitor-auth.js";
import type { MattermostMediaInfo } from "./monitor-resources.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import { collectMattermostPermalinkReferences } from "./thread-context.js";
import { isDangerousNameMatchingEnabled, type ChatType } from "./runtime-api.js";

const MAX_FILES = 4;
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const ID = /^[a-z0-9]{26}$/i;

/** One explicit same-instance reference, otherwise one native thread root. Never history traversal. */
export async function resolveMattermostReferenceMedia(params: {
  monitor: MattermostMonitorContext; post: MattermostPost; kind: ChatType;
}): Promise<MattermostMediaInfo[]> {
  const { monitor, post, kind } = params;
  const account = resolveMattermostAccount({ cfg: monitor.cfg, accountId: monitor.account.accountId });
  if (account.config.referenceMedia?.enabled === false || account.config.permalinkHydration?.enabled === false ||
    !account.baseUrl || monitor.abortSignal?.aborted) return [];
  const explicit = collectMattermostPermalinkReferences({
    text: post.message ?? "", props: post.props,
    baseUrl: account.baseUrl, allowedOrigins: account.config.permalinkHydration?.allowedOrigins, maxLinks: 1
  });
  const referenceId = explicit[0] ?? (ID.test(post.root_id ?? "") ? post.root_id! : undefined);
  if (!referenceId || referenceId === post.id) return [];
  const budget = Math.min(MAX_BYTES, resolveChannelMediaMaxBytes({
    cfg: monitor.cfg,
    resolveChannelLimitMb: () => account.config.mediaMaxMb, accountId: account.accountId
  }) ?? MAX_BYTES);
  const controller = new AbortController();
  const signal = monitor.abortSignal ? AbortSignal.any([controller.signal, monitor.abortSignal]) : controller.signal;
  const started = Date.now();
  const remainingTime = () => Math.max(1, TIMEOUT_MS - (Date.now() - started));
  // This wrapper keeps both rate-limit waits and body reads within this operation's deadline.
  const client = {
    ...monitor.client, request: <T>(path: string, init?: Parameters<typeof monitor.client.request>[1]) =>
      monitor.client.request<T>(path, { ...init, signal, timeoutMs: remainingTime() })
  };
  let timer: ReturnType<typeof setTimeout>;
  const stopped = new Promise<never>((_, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => controller.abort(new DOMException("Mattermost reference media deadline", "TimeoutError")), TIMEOUT_MS);
  });
  const operation = async (): Promise<MattermostMediaInfo[]> => {
    signal.throwIfAborted();
    const reference = MattermostPostSchema.parse(await client.request<unknown>(`/posts/${encodeURIComponent(referenceId)}`));
    signal.throwIfAborted();
    if (reference.id !== referenceId || reference.channel_id !== post.channel_id || !reference.user_id || reference.delete_at || reference.type ||
      (!explicit.length && reference.root_id) || (reference.file_ids ?? []).some(fileId => !ID.test(fileId))) return [];
    // Same-channel only, including private/DM conversations: no cross-conversation media fetch.
    const senderName = isDangerousNameMatchingEnabled(account.config)
      ? (await client.request<{ username?: string }>(`/users/${encodeURIComponent(reference.user_id)}`)).username ?? reference.user_id
      : reference.user_id;
    signal.throwIfAborted();
    const access = reference.user_id === monitor.botUserId ? null : await resolveMattermostMonitorInboundAccess({
      cfg: monitor.cfg, account, senderId: reference.user_id, senderName, channelId: post.channel_id!, kind,
      groupPolicy: monitor.groupPolicy, readStoreAllowFrom: monitor.pairing.readAllowFromStore,
      allowTextCommands: false, hasControlCommand: false, mayPair: false,
    });
    signal.throwIfAborted();
    // Media requires admitted sender visibility even when text quote/history policy is permissive.
    if (access && (access.ingress.decision !== "allow" || !shouldRetainMattermostSenderHistory({
      cfg: monitor.cfg, accountId: account.accountId, kind, ingress: access.ingress,
    }))) return [];
    const current = new Set(post.file_ids ?? []);
    const fileIds = [...new Set(reference.file_ids ?? [])].filter(id => !current.has(id)).slice(0, MAX_FILES);
    const out: MattermostMediaInfo[] = [];
    let remainingBytes = budget;
    for (const fileId of fileIds) {
      signal.throwIfAborted();
      if (remainingBytes <= 0) break;
      try {
        const info = await fetchMattermostFileInfo(client, fileId);
        signal.throwIfAborted();
        if (info.id !== fileId || (info.post_id && info.post_id !== reference.id) || !Number.isSafeInteger(info.size) || info.size! < 0) continue;
        const allocation = Math.max(1, info.size!);
        if (allocation > remainingBytes) continue;
        // Charge every attempted transfer, including denied/failed bodies. Never replenish on failure.
        remainingBytes -= allocation;
        const media = await monitor.resources.resolveMattermostMedia([fileId], {
          signal, maxBytes: allocation, timeoutMs: remainingTime(), allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
        });
        signal.throwIfAborted();
        const saved = media[0];
        if (!saved?.path) continue;
        const size = (await stat(saved.path)).size;
        signal.throwIfAborted();
        if (size > allocation) break;
        out.push(saved);
      } catch {
        if (signal.aborted) break;
        monitor.logVerboseMessage("mattermost: referenced attachment unavailable");
      }
    }
    return out;
  };
  try {
    return await Promise.race([operation(), stopped]);
  } catch {
    return []; // Preserve existing text/metadata hydration on deleted, denied, unavailable or aborted media.
  } finally {
    clearTimeout(timer!);
    controller.abort();
  }
}
