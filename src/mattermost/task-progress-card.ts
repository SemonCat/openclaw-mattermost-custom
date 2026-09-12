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

export type MattermostTaskProgressPlan = {
  phase?: string;
  title?: string;
  explanation?: string;
  steps?: AgentPlanStep[];
  source?: string;
};

export type MattermostTaskProgressAgentEvent = {
  runId?: string;
  stream: string;
  data: Record<string, unknown>;
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
  status: MattermostTaskProgressStatus;
};

type PendingNativeProgressCard = {
  toolCallId: string;
  markdown?: string;
};

function normalizeSingleLine(value?: string): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
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
  return lines.join("\n");
}

export function createMattermostTaskProgressCard(params: {
  client: MattermostClient;
  channelId: string;
  rootId?: string;
  postProps?: Record<string, unknown>;
  claimResultPost?: () => Promise<string | undefined>;
  log: (message: string) => void;
}) {
  let activeRunId: string | undefined;
  let createAttempts = 0;
  let createDisabled = false;
  let diagnosticLogs = 0;
  let finished = false;
  let latestSnapshot: MattermostTaskProgressSnapshot | undefined;
  let lifecycleTerminal: Exclude<MattermostTaskProgressStatus, "in_progress"> | undefined;
  let nextRevision = 0;
  const pendingNativeProgressCards: PendingNativeProgressCard[] = [];
  let publishedMessage: string | undefined;
  let publishedRevision = 0;
  let resultPostStarted = false;
  let taskPostId: string | undefined;
  let taskPostNeedsIdentityUpdate = false;
  let writeTail = Promise.resolve(true);

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
        !activeRunId ||
        event.runId !== activeRunId ||
        event.stream !== "lifecycle"
      ) {
        return;
      }
      const phase = event.data.phase;
      if (phase !== "end" && phase !== "error") {
        return;
      }
      lifecycleTerminal =
        event.data.aborted === true ? "cancelled" : phase === "error" ? "failed" : "completed";
    },
    updatePlan: async (plan: MattermostTaskProgressPlan): Promise<boolean> => {
      if (finished) {
        return false;
      }
      const nativeProgressCard =
        plan.source === "openclaw" ? pendingNativeProgressCards.shift() : undefined;
      const title = normalizeTitle(plan.title, plan.source);
      const explanation =
        normalizePlanExplanation(plan.explanation, plan.source) ??
        normalizeExplanation(nativeProgressCard?.markdown);
      const steps = normalizeSteps(plan.steps);
      if (!title && !explanation && steps.length === 0) {
        return false;
      }
      latestSnapshot = {
        revision: ++nextRevision,
        title,
        explanation,
        steps,
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
      finished = true;
      if (!latestSnapshot) {
        await writeTail;
        return;
      }
      const nominallyCompleted =
        result.outcome === "completed" || lifecycleTerminal === "completed";
      const status: Exclude<MattermostTaskProgressStatus, "in_progress"> | undefined =
        lifecycleTerminal === "cancelled"
          ? "cancelled"
          : result.deliveryFailed || result.outcome === "failed" || lifecycleTerminal === "failed"
            ? "failed"
            : nominallyCompleted
              ? latestSnapshot.steps.some((step) => step.status !== "completed")
                ? "incomplete"
                : "completed"
              : undefined;
      if (status) {
        latestSnapshot = {
          ...latestSnapshot,
          revision: ++nextRevision,
          status,
        };
        await schedulePublish();
        return;
      }
      await writeTail;
    },
  };
}
