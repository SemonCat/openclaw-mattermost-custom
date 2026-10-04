// Mattermost plugin module owns one durable, plan-backed task card per inbound turn.
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import type { AgentPlanStep } from "openclaw/plugin-sdk/channel-outbound";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  createMattermostPost,
  updateMattermostPost,
  type MattermostClient,
} from "./client.js";

const MAX_CREATE_ATTEMPTS = 2;
const MAX_DIAGNOSTIC_LOGS = 3;
const MAX_PLAN_STEPS = 50;
const MAX_STEP_CHARS = 240;
const MAX_RENDERED_WORK_SESSIONS = 5;
const MAX_WORK_LABEL_CHARS = 120;
const MAX_WORK_PROGRESS_CHARS = 240;

export type MattermostTaskProgressPlan = {
  phase?: string;
  title?: string;
  explanation?: string;
  steps?: AgentPlanStep[];
  source?: string;
};

export type MattermostTaskProgressAgentEvent = {
  runId?: string;
  sessionKey?: string;
  stream: string;
  data: Record<string, unknown>;
};

export type MattermostVisibleWorkSession = {
  sessionKey: string;
  url?: string;
  label?: string;
  runId?: string;
  status?: "queued" | "running" | "done" | "failed" | "interrupted" | "killed" | "timeout";
};

type MattermostTaskProgressStatus =
  | "in_progress"
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled";

type MattermostTaskProgressSnapshot = {
  revision: number;
  title?: string;
  explanation?: string;
  steps: AgentPlanStep[];
  workSessions?: MattermostTaskProgressWorkSession[];
  status: MattermostTaskProgressStatus;
};

type MattermostTaskProgressWorkSessionStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

type MattermostTaskProgressWorkSession = {
  sessionKey: string;
  url?: string;
  label: string;
  runId?: string;
  progress?: string;
  status: MattermostTaskProgressWorkSessionStatus;
};

type PendingNativeProgressCard = {
  toolCallId: string;
  markdown?: string;
};

function normalizeSingleLine(value?: string): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function normalizeBoundedSingleLine(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeSingleLine(value);
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxChars
    ? `${sliceUtf16Safe(normalized, 0, maxChars - 1).trimEnd()}…`
    : normalized;
}

function normalizeTitle(value?: string, source?: string): string | undefined {
  const normalized = normalizeSingleLine(value);
  if (source === "openclaw" && /^plan updated[.!]?$/i.test(normalized ?? "")) {
    return undefined;
  }
  return normalized;
}

function normalizeExplanation(value?: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized || /^plan updated[.!]?$/i.test(normalized)) {
    return undefined;
  }
  return normalized.length > 1_500 ? `${normalized.slice(0, 1_497)}…` : normalized;
}

function normalizePlanExplanation(value?: string, source?: string): string | undefined {
  const normalized = normalizeExplanation(value);
  if (source === "openclaw" && /^progress updated[.!]?$/i.test(normalized ?? "")) {
    return undefined;
  }
  return normalized;
}

function renderNativeProgressMarkdownForMattermost(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const markdown = value.trim();
  if (!markdown) {
    return undefined;
  }
  const progress = markdown.match(/^<progress\b([^>]*)><\/progress>\s*/iu);
  if (!progress) {
    return markdown;
  }
  const attributes = progress[1] ?? "";
  const ariaLabel = attributes.match(/\baria-label\s*=\s*(?:"([^"]*)"|'([^']*)')/iu);
  const label = (ariaLabel?.[1] ?? ariaLabel?.[2] ?? "").trim();
  const remainder = markdown.slice(progress[0].length).trim();
  return [label ? `**${label}**` : undefined, remainder].filter(Boolean).join("\n\n") || undefined;
}

function normalizeSteps(steps?: AgentPlanStep[]): AgentPlanStep[] {
  return (steps ?? [])
    .map((entry) => ({
      step: (() => {
        const normalized = entry.step.replace(/\s+/g, " ").trim();
        return normalized.length > MAX_STEP_CHARS
          ? `${sliceUtf16Safe(normalized, 0, MAX_STEP_CHARS - 1).trimEnd()}…`
          : normalized;
      })(),
      status: entry.status,
    }))
    .filter((entry) => entry.step)
    .slice(0, MAX_PLAN_STEPS);
}

function renderStatus(status: MattermostTaskProgressStatus): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "incomplete":
      return "Incomplete";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "in_progress":
      return "In progress";
  }
}

function renderChecklistLine(step: AgentPlanStep): string {
  if (step.status === "completed") {
    return `- [x] ${step.step}`;
  }
  if (step.status === "in_progress") {
    return `- [ ] **${step.step}**`;
  }
  return `- [ ] ${step.step}`;
}

function normalizeWorkSessionUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.href.replace(/\(/gu, "%28").replace(/\)/gu, "%29");
  } catch {
    return undefined;
  }
}

function normalizeWorkSessionStatus(
  status: MattermostVisibleWorkSession["status"],
): MattermostTaskProgressWorkSessionStatus {
  switch (status) {
    case "done":
      return "completed";
    case "failed":
    case "timeout":
      return "failed";
    case "interrupted":
    case "killed":
      return "cancelled";
    case "queued":
      return "queued";
    case "running":
    default:
      return "running";
  }
}

function isActiveWorkSession(status: MattermostTaskProgressWorkSessionStatus): boolean {
  return status === "queued" || status === "running";
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\[\]()*_`~])/gu, "\\$1");
}

function renderWorkSessionLine(session: MattermostTaskProgressWorkSession): string {
  const escapedLabel = escapeMarkdownLabel(session.label);
  const label = session.url ? `[${escapedLabel}](${session.url})` : escapedLabel;
  switch (session.status) {
    case "completed":
      return `- [x] ${label} · Completed`;
    case "failed":
      return `- [ ] ${label} · Failed`;
    case "cancelled":
      return `- [ ] ${label} · Cancelled`;
    case "queued":
      return `- [ ] ${label} · Queued`;
    case "running":
      return `- [ ] **${label} · Running**${session.progress ? ` — ${session.progress}` : ""}`;
  }
}

function readWorkSessionProgress(event: MattermostTaskProgressAgentEvent): string | undefined {
  if (event.stream === "plan") {
    const steps = Array.isArray(event.data.steps) ? event.data.steps : [];
    const currentStep = steps.find(
      (step): step is Record<string, unknown> =>
        Boolean(step) &&
        typeof step === "object" &&
        (step as Record<string, unknown>).status === "in_progress",
    );
    const pendingStep = steps.find(
      (step): step is Record<string, unknown> =>
        Boolean(step) &&
        typeof step === "object" &&
        (step as Record<string, unknown>).status === "pending",
    );
    return (
      normalizeBoundedSingleLine(currentStep?.step, MAX_WORK_PROGRESS_CHARS) ??
      normalizeBoundedSingleLine(pendingStep?.step, MAX_WORK_PROGRESS_CHARS) ??
      normalizeBoundedSingleLine(event.data.explanation, MAX_WORK_PROGRESS_CHARS) ??
      normalizeTitle(
        normalizeBoundedSingleLine(event.data.title, MAX_WORK_PROGRESS_CHARS),
        typeof event.data.source === "string" ? event.data.source : undefined,
      )
    );
  }
  if (event.stream === "item") {
    if (
      event.data.hideFromChannelProgress === true ||
      event.data.suppressChannelProgress === true
    ) {
      return undefined;
    }
    return (
      normalizeBoundedSingleLine(event.data.progressText, MAX_WORK_PROGRESS_CHARS) ??
      normalizeBoundedSingleLine(event.data.summary, MAX_WORK_PROGRESS_CHARS) ??
      normalizeBoundedSingleLine(event.data.title, MAX_WORK_PROGRESS_CHARS) ??
      normalizeBoundedSingleLine(event.data.name, MAX_WORK_PROGRESS_CHARS)
    );
  }
  if (event.stream === "tool") {
    return (
      normalizeBoundedSingleLine(event.data.progressText, MAX_WORK_PROGRESS_CHARS) ??
      normalizeBoundedSingleLine(event.data.meta, MAX_WORK_PROGRESS_CHARS) ??
      normalizeBoundedSingleLine(event.data.name, MAX_WORK_PROGRESS_CHARS)
    );
  }
  return undefined;
}

export function renderMattermostTaskProgressCard(
  snapshot: Omit<MattermostTaskProgressSnapshot, "revision">,
): string {
  const lines = [`#### Task progress · ${renderStatus(snapshot.status)}`];
  if (snapshot.title) {
    lines.push(snapshot.title);
  }
  const explanation = normalizeExplanation(snapshot.explanation);
  if (explanation) {
    lines.push(explanation);
  }
  const checklist = snapshot.steps.map(renderChecklistLine);
  if (checklist.length > 0) {
    lines.push("", ...checklist);
  }
  const allWorkSessions = snapshot.workSessions ?? [];
  const workSessions = allWorkSessions.slice(0, MAX_RENDERED_WORK_SESSIONS);
  if (workSessions.length > 0) {
    lines.push("", "##### Subtasks", ...workSessions.map(renderWorkSessionLine));
    const hiddenCount = allWorkSessions.length - workSessions.length;
    if (hiddenCount > 0) {
      lines.push(`- _${hiddenCount} additional ${hiddenCount === 1 ? "subtask" : "subtasks"} tracked_`);
    }
  }
  return lines.join("\n");
}

export function createMattermostTaskProgressCard(params: {
  client: MattermostClient;
  channelId: string;
  rootId?: string;
  postProps?: Record<string, unknown>;
  claimResultPost?: () => Promise<string | undefined>;
  onSettled?: () => void;
  log: (message: string) => void;
}) {
  let activeRunId: string | undefined;
  let createAttempts = 0;
  let createDisabled = false;
  let diagnosticLogs = 0;
  let parentFinished = false;
  let parentTerminalStatus: Exclude<MattermostTaskProgressStatus, "in_progress"> | undefined;
  let settled = false;
  let latestSnapshot: MattermostTaskProgressSnapshot | undefined;
  let lastNativeProgressMarkdown: string | undefined;
  let lifecycleTerminal: Exclude<MattermostTaskProgressStatus, "in_progress"> | undefined;
  let nextRevision = 0;
  const pendingNativeProgressCards: PendingNativeProgressCard[] = [];
  let publishedMessage: string | undefined;
  let publishedRevision = 0;
  let resultPostStarted = false;
  let taskPostId: string | undefined;
  let taskPostNeedsIdentityUpdate = false;
  let writeTail = Promise.resolve(true);
  const workSessions = new Map<string, MattermostTaskProgressWorkSession>();

  const logFailure = (operation: "create" | "handoff" | "update", error: unknown) => {
    if (diagnosticLogs >= MAX_DIAGNOSTIC_LOGS) {
      return;
    }
    diagnosticLogs += 1;
    params.log(`mattermost task progress card ${operation} failed: ${String(error)}`);
  };

  const publishLatest = async (): Promise<boolean> => {
    const snapshot = latestSnapshot;
    if (!snapshot || snapshot.revision <= publishedRevision) {
      return Boolean(taskPostId);
    }
    const message = renderMattermostTaskProgressCard(snapshot);
    if (taskPostId && message === publishedMessage) {
      publishedRevision = snapshot.revision;
      return true;
    }
    if (!taskPostId && createDisabled) {
      return false;
    }
    if (!taskPostId && resultPostStarted) {
      if (!params.claimResultPost) {
        return false;
      }
      try {
        taskPostId = await params.claimResultPost();
        taskPostNeedsIdentityUpdate = Boolean(taskPostId);
      } catch (error: unknown) {
        logFailure("handoff", error);
        return false;
      }
      if (!taskPostId) {
        return false;
      }
    }
    if (!taskPostId) {
      if (createDisabled || createAttempts >= MAX_CREATE_ATTEMPTS) {
        return false;
      }
      createAttempts += 1;
      try {
        const post = await createMattermostPost(params.client, {
          channelId: params.channelId,
          message,
          rootId: params.rootId,
          props: params.postProps,
        });
        taskPostId = post.id;
        publishedMessage = message;
        publishedRevision = snapshot.revision;
        return true;
      } catch (error: unknown) {
        // A partial create may already be visible but has no safe edit identity. Never
        // retry it: doing so could create duplicate durable cards.
        if (isChannelPartialDeliveryError(error)) {
          createDisabled = true;
        }
        logFailure("create", error);
        return false;
      }
    }
    try {
      await updateMattermostPost(params.client, taskPostId, {
        message,
        ...(taskPostNeedsIdentityUpdate ? { props: params.postProps } : {}),
      });
      taskPostNeedsIdentityUpdate = false;
      publishedMessage = message;
      publishedRevision = snapshot.revision;
      return true;
    } catch (error: unknown) {
      logFailure("update", error);
      return false;
    }
  };

  const schedulePublish = (): Promise<boolean> => {
    const operation = writeTail.then(publishLatest, publishLatest);
    writeTail = operation;
    return operation;
  };

  const settle = () => {
    if (settled) {
      return;
    }
    settled = true;
    try {
      params.onSettled?.();
    } catch (error: unknown) {
      params.log(`mattermost task progress card settle callback failed: ${String(error)}`);
    }
  };

  const listWorkSessions = (): MattermostTaskProgressWorkSession[] =>
    [...workSessions.values()].map((session) => ({ ...session }));

  const hasActiveWorkSessions = (): boolean =>
    [...workSessions.values()].some((session) => isActiveWorkSession(session.status));

  const resolveTerminalStatus = () => {
    if (hasActiveWorkSessions()) {
      return undefined;
    }
    if (parentTerminalStatus === "failed" || parentTerminalStatus === "cancelled") {
      return parentTerminalStatus;
    }
    if ([...workSessions.values()].some((session) => session.status === "failed")) {
      return "failed" as const;
    }
    if ([...workSessions.values()].some((session) => session.status === "cancelled")) {
      return "incomplete" as const;
    }
    return parentTerminalStatus;
  };

  const publishWorkSessionChange = () => {
    if (!latestSnapshot) {
      if (parentFinished && !hasActiveWorkSessions()) {
        settle();
      }
      return;
    }
    const terminalStatus = parentFinished ? resolveTerminalStatus() : undefined;
    latestSnapshot = {
      ...latestSnapshot,
      revision: ++nextRevision,
      status: terminalStatus ?? "in_progress",
      workSessions: listWorkSessions(),
    };
    const publication = schedulePublish();
    if (parentFinished && !hasActiveWorkSessions()) {
      void publication.then(settle, settle);
    }
  };

  const settleBeforeResultPost = (
    resultIdentityStarting: boolean,
  ): Promise<void> | undefined => {
    if (resultIdentityStarting && resultPostStarted) {
      // Only the first physical result identity participates in card ordering. Later
      // generations may be needed by a handoff that is already awaiting this callback.
      return undefined;
    }
    if (!latestSnapshot) {
      // Entering core result delivery does not mean a Mattermost post exists yet. Keep
      // the late-plan window open until the draft stream actually starts that create.
      if (resultIdentityStarting) {
        resultPostStarted = true;
      }
      return undefined;
    }
    // Progress bridges preserve callback start order, not callback completion. Snapshot
    // the tail only after the earlier plan callback has synchronously queued its write.
    const pendingPlanWrites = writeTail;
    return pendingPlanWrites.then(() => {
      resultPostStarted = true;
      if (!taskPostId) {
        // A failed initial card must not retry after the result and appear below it.
        createDisabled = true;
      }
    });
  };

  return {
    postId: () => taskPostId,
    noteToolStart: (payload: {
      toolCallId?: string;
      name?: string;
      phase?: string;
      args?: Record<string, unknown>;
    }) => {
      if (payload.phase !== "start" || payload.name !== "progress_card" || !payload.toolCallId) {
        return;
      }
      pendingNativeProgressCards.push({
        toolCallId: payload.toolCallId,
        markdown: renderNativeProgressMarkdownForMattermost(payload.args?.markdown),
      });
    },
    noteToolEnd: (toolCallId?: string) => {
      if (!toolCallId) {
        return;
      }
      const index = pendingNativeProgressCards.findIndex((entry) => entry.toolCallId === toolCallId);
      if (index >= 0) {
        pendingNativeProgressCards.splice(index, 1);
      }
    },
    noteRunStart: (runId: string) => {
      activeRunId = runId;
      lifecycleTerminal = undefined;
    },
    noteAgentEvent: (event: MattermostTaskProgressAgentEvent) => {
      if (
        activeRunId &&
        event.runId === activeRunId &&
        event.stream === "lifecycle"
      ) {
        const phase = event.data.phase;
        if (phase === "end" || phase === "error") {
          lifecycleTerminal =
            event.data.aborted === true
              ? "cancelled"
              : phase === "error"
                ? "failed"
                : "completed";
        }
      }
      if (settled || !event.sessionKey) {
        return;
      }
      const workSession = workSessions.get(event.sessionKey);
      if (!workSession) {
        return;
      }
      const phase = event.data.phase;
      if (
        workSession.runId &&
        event.runId &&
        event.runId !== workSession.runId &&
        !(event.stream === "lifecycle" && phase === "start")
      ) {
        return;
      }
      if (event.runId) {
        workSession.runId = event.runId;
      }
      if (event.stream === "lifecycle") {
        if (phase === "start") {
          workSession.status = "running";
          workSession.progress = undefined;
        } else if (phase === "end" || phase === "error") {
          workSession.status =
            event.data.aborted === true
              ? "cancelled"
              : phase === "error"
                ? "failed"
                : "completed";
          workSession.progress = undefined;
        } else {
          return;
        }
      } else if (event.stream === "plan" || event.stream === "item" || event.stream === "tool") {
        const progress = readWorkSessionProgress(event);
        if (!progress) {
          return;
        }
        workSession.status = "running";
        workSession.progress = progress;
      } else {
        return;
      }
      publishWorkSessionChange();
    },
    noteVisibleWorkSessions: async (
      sessions: readonly MattermostVisibleWorkSession[],
    ): Promise<boolean> => {
      if (settled) {
        return false;
      }
      let changed = false;
      for (const session of sessions) {
        const sessionKey = normalizeSingleLine(session.sessionKey);
        const url = session.url === undefined ? undefined : normalizeWorkSessionUrl(session.url);
        if (!sessionKey || (session.url !== undefined && !url)) {
          continue;
        }
        const existing = workSessions.get(sessionKey);
        const status = normalizeWorkSessionStatus(session.status);
        const label =
          normalizeBoundedSingleLine(session.label, MAX_WORK_LABEL_CHARS) ??
          existing?.label ??
          `Subtask ${workSessions.size + 1}`;
        if (existing) {
          existing.url = url ?? existing.url;
          existing.label = label;
          existing.runId = session.runId ?? existing.runId;
          if (!(isActiveWorkSession(status) && !isActiveWorkSession(existing.status))) {
            existing.status = status;
            if (!isActiveWorkSession(status)) {
              existing.progress = undefined;
            }
          }
        } else {
          workSessions.set(sessionKey, {
            sessionKey,
            url,
            label,
            runId: session.runId,
            status,
          });
        }
        changed = true;
      }
      if (!changed || !latestSnapshot) {
        return false;
      }
      publishWorkSessionChange();
      return await writeTail;
    },
    updatePlan: async (plan: MattermostTaskProgressPlan): Promise<boolean> => {
      if (parentFinished) {
        return false;
      }
      const nativeProgressCard =
        plan.source === "openclaw" ? pendingNativeProgressCards.shift() : undefined;
      if (nativeProgressCard) {
        // Each native call replaces the whole card. Remember its renderer-owned
        // Markdown across duplicate/late plan projections, but clear it when the
        // next native call intentionally carries only a structured checklist.
        lastNativeProgressMarkdown = nativeProgressCard.markdown;
      }
      const title = normalizeTitle(plan.title, plan.source);
      const explanation =
        (plan.source === "openclaw"
          ? normalizeExplanation(lastNativeProgressMarkdown)
          : undefined) ??
        normalizePlanExplanation(plan.explanation, plan.source);
      const steps = normalizeSteps(plan.steps);
      if (!title && !explanation && steps.length === 0) {
        return false;
      }
      latestSnapshot = {
        revision: ++nextRevision,
        title,
        explanation,
        steps,
        workSessions: listWorkSessions(),
        status: "in_progress",
      };
      return await schedulePublish();
    },
    settleBeforeResultPost: (): Promise<void> | undefined =>
      settleBeforeResultPost(false),
    settleBeforeResultPostCreate: (): Promise<void> | undefined =>
      settleBeforeResultPost(true),
    finish: async (result: {
      outcome?: "completed" | "failed";
      deliveryFailed?: boolean;
    }): Promise<void> => {
      parentFinished = true;
      if (!latestSnapshot) {
        await writeTail;
        settle();
        return;
      }
      const nominallyCompleted =
        result.outcome === "completed" || lifecycleTerminal === "completed";
      parentTerminalStatus =
        lifecycleTerminal === "cancelled"
          ? "cancelled"
          : result.deliveryFailed || result.outcome === "failed" || lifecycleTerminal === "failed"
            ? "failed"
            : nominallyCompleted
              ? latestSnapshot.steps.some((step) => step.status !== "completed")
                ? "incomplete"
                : "completed"
              : undefined;
      if (hasActiveWorkSessions()) {
        if (latestSnapshot.status !== "in_progress") {
          latestSnapshot = {
            ...latestSnapshot,
            revision: ++nextRevision,
            status: "in_progress",
            workSessions: listWorkSessions(),
          };
          await schedulePublish();
        } else {
          await writeTail;
        }
        return;
      }
      const status = resolveTerminalStatus();
      if (status) {
        latestSnapshot = {
          ...latestSnapshot,
          revision: ++nextRevision,
          status,
          workSessions: listWorkSessions(),
        };
        await schedulePublish();
      } else {
        await writeTail;
      }
      settle();
    },
  };
}
