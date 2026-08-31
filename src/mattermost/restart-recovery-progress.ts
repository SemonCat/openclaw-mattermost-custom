// Mattermost plugin module reconnects restart-recovered runs to process-local UI progress.
import {
  buildChannelProgressDraftLineForEntry,
  createChannelProgressDraftCompositor,
  createTypingKeepaliveLoop,
} from "openclaw/plugin-sdk/channel-outbound";
import { createMattermostDraftStream } from "./draft-stream.js";
import { shouldUpdateMattermostDraftToolProgress } from "./monitor-context.js";
import type { MattermostMonitorContext } from "./monitor-types.js";

export type MattermostRestartRecoveryEvent = {
  runId: string;
  stream: string;
  data: Record<string, unknown>;
  sessionKey?: string;
  deliverySessionKey?: string;
  mainSessionRestartRecovery?: true;
};

export type MattermostRestartRecoveryRoute = {
  kind: "channel" | "group";
  channelId: string;
  threadId?: string;
};

export type MattermostRestartRecoveryRunUi = {
  event: (event: MattermostRestartRecoveryEvent) => void | Promise<void>;
  stop: () => void | Promise<void>;
};

type ActiveRecoveryRun = {
  ui: MattermostRestartRecoveryRunUi;
  tail: Promise<void>;
};

const MAX_ACTIVE_RECOVERY_RUNS = 32;
const MAX_TERMINAL_RECOVERY_RUN_IDS = 128;
const MATTERMOST_RECOVERY_TYPING_INTERVAL_MS = 4_000;

export function parseMattermostRestartRecoverySessionKey(
  sessionKey: string | null | undefined,
): MattermostRestartRecoveryRoute | null {
  const match =
    /^agent:[^:]+:mattermost:(channel|group):([^:]+)(?::thread:([^:]+))?$/i.exec(
      sessionKey?.trim() ?? "",
    );
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    kind: match[1].toLowerCase() as "channel" | "group",
    channelId: match[2],
    threadId: match[3],
  };
}

function isTerminalLifecycleEvent(event: MattermostRestartRecoveryEvent): boolean {
  if (event.stream !== "lifecycle") {
    return false;
  }
  const phase = event.data.phase;
  return phase === "end" || phase === "error";
}

export function createMattermostRestartRecoveryProgressBridge(params: {
  subscribe: (
    listener: (event: MattermostRestartRecoveryEvent) => void,
  ) => (() => void) | undefined;
  createRunUi: (params: {
    runId: string;
    route: MattermostRestartRecoveryRoute;
  }) => MattermostRestartRecoveryRunUi;
  log: (message: string) => void;
}) {
  const activeRuns = new Map<string, ActiveRecoveryRun>();
  const terminalRunIds = new Set<string>();
  const pendingCleanups = new Set<Promise<void>>();
  let stopped = false;

  const rememberTerminal = (runId: string) => {
    terminalRunIds.delete(runId);
    terminalRunIds.add(runId);
    while (terminalRunIds.size > MAX_TERMINAL_RECOVERY_RUN_IDS) {
      const oldest = terminalRunIds.keys().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      terminalRunIds.delete(oldest);
    }
  };

  const enqueue = (
    runId: string,
    operation: (ui: MattermostRestartRecoveryRunUi) => void | Promise<void>,
  ) => {
    const active = activeRuns.get(runId);
    if (!active) {
      return;
    }
    active.tail = active.tail
      .then(() => operation(active.ui))
      .catch((error: unknown) => {
        params.log(`mattermost restart recovery progress failed run=${runId}: ${String(error)}`);
      });
  };

  const retire = (runId: string) => {
    const active = activeRuns.get(runId);
    if (!active) {
      rememberTerminal(runId);
      return;
    }
    activeRuns.delete(runId);
    rememberTerminal(runId);
    const cleanup = active.tail
      .then(() => active.ui.stop())
      .catch((error: unknown) => {
        params.log(`mattermost restart recovery cleanup failed run=${runId}: ${String(error)}`);
      });
    pendingCleanups.add(cleanup);
    void cleanup.finally(() => pendingCleanups.delete(cleanup));
  };

  const listener = (event: MattermostRestartRecoveryEvent) => {
    if (stopped || event.mainSessionRestartRecovery !== true || !event.runId) {
      return;
    }
    if (isTerminalLifecycleEvent(event)) {
      retire(event.runId);
      return;
    }
    if (event.stream === "lifecycle" && event.data.phase === "start") {
      if (activeRuns.has(event.runId) || terminalRunIds.has(event.runId)) {
        return;
      }
      const route = parseMattermostRestartRecoverySessionKey(
        event.sessionKey ?? event.deliverySessionKey,
      );
      if (!route) {
        return;
      }
      try {
        activeRuns.set(event.runId, {
          ui: params.createRunUi({ runId: event.runId, route }),
          tail: Promise.resolve(),
        });
      } catch (error) {
        params.log(
          `mattermost restart recovery progress could not start run=${event.runId}: ${String(error)}`,
        );
        rememberTerminal(event.runId);
        return;
      }
      while (activeRuns.size > MAX_ACTIVE_RECOVERY_RUNS) {
        const oldest = activeRuns.keys().next().value;
        if (typeof oldest !== "string") {
          break;
        }
        retire(oldest);
      }
      return;
    }
    if (event.stream === "tool" || event.stream === "item") {
      enqueue(event.runId, (ui) => ui.event(event));
    }
  };

  const unsubscribe = params.subscribe(listener) ?? (() => {});

  return {
    async stop(): Promise<void> {
      if (stopped) {
        return;
      }
      stopped = true;
      unsubscribe();
      const pending = [...activeRuns.values()].map((active) =>
        active.tail.then(() => active.ui.stop()),
      );
      activeRuns.clear();
      await Promise.allSettled([...pending, ...pendingCleanups]);
    },
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function createMattermostRestartRecoveryRunUi(params: {
  monitor: MattermostMonitorContext;
  route: MattermostRestartRecoveryRoute;
  runId: string;
}): MattermostRestartRecoveryRunUi {
  const { account, cfg, core } = params.monitor;
  const startTyping = () => {
    const typing = createTypingKeepaliveLoop({
      intervalMs: MATTERMOST_RECOVERY_TYPING_INTERVAL_MS,
      onTick: async () => {
        try {
          await params.monitor.resources.sendTypingIndicator(
            params.route.channelId,
            params.route.threadId,
          );
        } catch (error) {
          params.monitor.logVerboseMessage(
            `mattermost restart recovery typing failed run=${params.runId}: ${String(error)}`,
          );
        }
      },
    });
    void typing.tick();
    typing.start();
    return typing;
  };

  if (!shouldUpdateMattermostDraftToolProgress(account)) {
    const typing = startTyping();
    return {
      event: () => {},
      stop: () => typing.stop(),
    };
  }

  const textLimit = core.channel.text.resolveTextChunkLimit(
    cfg,
    "mattermost",
    account.accountId,
    { fallbackLimit: account.textChunkLimit ?? 4000 },
  );
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "mattermost",
    accountId: account.accountId,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "mattermost", account.accountId);
  const draft = createMattermostDraftStream({
    client: params.monitor.client,
    channelId: params.route.channelId,
    rootId: params.route.threadId,
    throttleMs: 1200,
    chunkText: (value) =>
      core.channel.text.chunkMarkdownTextWithMode(
        core.channel.text.convertMarkdownTables(value, tableMode),
        textLimit,
        chunkMode,
      ),
    log: params.monitor.logVerboseMessage,
    warn: params.monitor.logVerboseMessage,
  });
  const progress = createChannelProgressDraftCompositor({
    entry: account.config,
    mode: account.streamingMode,
    active: true,
    seed: `restart-recovery:${account.accountId}:${params.route.channelId}:${params.runId}`,
    update: async (text, options) => {
      draft.update(text);
      if (options?.flush) {
        await draft.flush();
      }
    },
  });
  const typing = startTyping();

  return {
    async event(event) {
      if (
        event.data.hideFromChannelProgress === true ||
        event.data.suppressChannelProgress === true
      ) {
        return;
      }
      if (event.stream === "tool") {
        const name = readString(event.data.name);
        await progress.pushToolProgress(
          buildChannelProgressDraftLineForEntry(account.config, {
            event: "tool",
            name,
            phase: readString(event.data.phase),
            toolCallId: readString(event.data.toolCallId),
            itemId: readString(event.data.itemId),
            args: readRecord(event.data.args),
          }),
          { toolName: name, startImmediately: true },
        );
        return;
      }
      if (event.stream === "item") {
        await progress.pushToolProgress(
          buildChannelProgressDraftLineForEntry(account.config, {
            event: "item",
            itemKind: readString(event.data.kind),
            meta: readString(event.data.meta),
            name: readString(event.data.name),
            title: readString(event.data.title),
            status: readString(event.data.status),
            phase: readString(event.data.phase),
            summary: readString(event.data.summary),
            toolCallId: readString(event.data.toolCallId),
            itemId: readString(event.data.itemId),
            progressText: readString(event.data.progressText),
          }),
          { startImmediately: true },
        );
      }
    },
    async stop() {
      typing.stop();
      progress.cancel();
      await draft.clear();
    },
  };
}

export function attachMattermostRestartRecoveryProgress(
  monitor: MattermostMonitorContext,
) {
  return createMattermostRestartRecoveryProgressBridge({
    subscribe: (listener) => monitor.core.events.onAgentEvent(listener),
    createRunUi: ({ route, runId }) =>
      createMattermostRestartRecoveryRunUi({ monitor, route, runId }),
    log: monitor.logVerboseMessage,
  });
}
