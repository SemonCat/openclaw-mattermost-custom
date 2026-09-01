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

type MattermostTaskProgressStatus = "in_progress" | "completed" | "failed" | "cancelled";

type MattermostTaskProgressSnapshot = {
  revision: number;
  title?: string;
  explanation?: string;
  steps: AgentPlanStep[];
  status: MattermostTaskProgressStatus;
};

function normalizeSingleLine(value?: string): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function normalizeExplanation(value?: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized || /^plan updated[.!]?$/i.test(normalized)) {
    return undefined;
  }
  return normalized.length > 1_500 ? `${normalized.slice(0, 1_497)}…` : normalized;
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
  let publishedMessage: string | undefined;
  let publishedRevision = 0;
  let resultPostStarted = false;
  let taskPostId: string | undefined;
  let writeTail = Promise.resolve(true);

  const logFailure = (operation: "create" | "update", error: unknown) => {
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
      await updateMattermostPost(params.client, taskPostId, { message });
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

  return {
    postId: () => taskPostId,
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
      const title = normalizeSingleLine(plan.title);
      const explanation = normalizeExplanation(plan.explanation);
      const steps = normalizeSteps(plan.steps);
      if (!title && !explanation && steps.length === 0) {
        return false;
      }
      // A late card would necessarily sort below an already-created result post.
      // Keep the invariant truthful by declining to create one after that identity exists.
      if (resultPostStarted && !taskPostId) {
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
    settleBeforeResultPost: (): Promise<void> | undefined => {
      if (!latestSnapshot) {
        // Keep no-plan turns on their existing synchronous delivery path.
        resultPostStarted = true;
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
    },
    finish: async (result: {
      outcome?: "completed" | "failed";
      deliveryFailed?: boolean;
    }): Promise<void> => {
      finished = true;
      if (!latestSnapshot) {
        await writeTail;
        return;
      }
      const status: Exclude<MattermostTaskProgressStatus, "in_progress"> | undefined =
        lifecycleTerminal === "cancelled"
          ? "cancelled"
          : result.deliveryFailed || result.outcome === "failed" || lifecycleTerminal === "failed"
            ? "failed"
            : result.outcome === "completed" || lifecycleTerminal === "completed"
              ? "completed"
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
