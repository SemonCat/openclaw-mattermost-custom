// The host supplies audience-prepared items; Mattermost retains only its confirmed draft.
import { createChannelProgressDraftCompositor } from "openclaw/plugin-sdk/channel-outbound";
import type { ReplyDispatchRuntimeInfo } from "openclaw/plugin-sdk/reply-runtime";
import { deleteMattermostPost, type MattermostClient } from "./client.js";
import { createMattermostDraftStream } from "./draft-stream.js";

type CompositorParams = Parameters<typeof createChannelProgressDraftCompositor>[0];
type RetainedDraft = Parameters<NonNullable<ReplyDispatchRuntimeInfo["adoptProgressDraft"]>>[0];
type MattermostRetainedDraft = RetainedDraft & { release: () => void; readonly retired: boolean };

export function retainMattermostProgressDraft(params: {
  client: MattermostClient;
  channelId: string;
  rootId?: string;
  postId: string;
  text: string;
  snapshot: NonNullable<CompositorParams["initialSnapshot"]>;
  entry: CompositorParams["entry"];
  seed: string;
  maxChars: number;
  abortSignal?: AbortSignal;
  assertCurrent: () => void;
  onRetired?: () => void;
  log: (message: string) => void;
}): MattermostRetainedDraft {
  let retired = false;
  const abort = new AbortController();
  const stream = createMattermostDraftStream({
    client: {
      ...params.client,
      request: (path, init) => {
        params.assertCurrent();
        abort.signal.throwIfAborted();
        return params.client.request(path, { ...init, signal: abort.signal });
      },
    },
    channelId: params.channelId,
    rootId: params.rootId,
    initialPost: { id: params.postId, message: params.text },
    maxChars: params.maxChars,
    throttleMs: 1200,
    warn: params.log,
  });
  const compositor = createChannelProgressDraftCompositor({
    preparedItems: true,
    showWorkStatus: true,
    entry: params.entry,
    mode: "progress",
    active: true,
    seed: params.seed,
    reasoningGate: false,
    toolIcons: true,
    initialSnapshot: params.snapshot,
    update: async (text, options) => {
      if (retired) return false;
      params.assertCurrent();
      stream.update(text);
      if (options.flush) await stream.flush();
      return true;
    },
  });
  let tail = Promise.resolve();
  let started = false;
  const dispose = (deletePost: boolean) => {
    if (retired) return;
    retired = true;
    abort.abort();
    params.abortSignal?.removeEventListener("abort", retire);
    compositor.markFinalReplyStarted();
    params.onRetired?.();
    // Stop timers and join an already accepted edit before deleting this transient identity.
    tail = tail.then(async () => {
      await stream.discardPending();
      if (deletePost) await deleteMattermostPost(params.client, params.postId);
    }).catch((error: unknown) => params.log(`mattermost retained progress cleanup failed: ${String(error)}`));
  };
  const retire = () => dispose(true);
  params.abortSignal?.addEventListener("abort", retire, { once: true });
  if (params.abortSignal?.aborted) retire();
  return {
    push: (item) => {
      tail = tail.then(async () => {
        if (retired) return;
        params.assertCurrent();
        if (!started) {
          started = true;
          await compositor.start();
        }
        await compositor.pushItemEvent(item);
      }).catch((error: unknown) => {
        params.log(`mattermost retained progress failed: ${String(error)}`);
        retire();
      });
    },
    retire,
    release: () => dispose(false),
    get retired() { return retired; },
  };
}
