// Mattermost plugin module durably admits validated interactive callbacks before HTTP ACK.
import { createHash } from "node:crypto";
import {
  createChannelIngressError,
  createChannelIngressMonitor,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { getMattermostRuntime } from "../runtime.js";
import { createMattermostIngressQueue } from "./ingress-queue.js";
import type {
  MattermostInteractionProcessor,
  MattermostValidatedInteraction,
} from "./interactions.js";

const MATTERMOST_INTERACTION_PAYLOAD_VERSION = 1;
const MATTERMOST_INTERACTION_POLL_INTERVAL_MS = 250;

type MattermostInteractionIngressPayload = {
  version: 1;
  receivedAt: number;
  interaction: MattermostValidatedInteraction;
};

const MattermostInteractionPermanentError = createChannelIngressError<
  "invalid-interaction" | "mattermost-auth"
>("MattermostInteractionPermanentError", { withReason: true });

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function buildMattermostInteractionEventId(
  interaction: MattermostValidatedInteraction,
): string {
  const identity = {
    accountAgnosticTriggerId: interaction.payload.trigger_id,
    channelId: interaction.payload.channel_id,
    postId: interaction.payload.post_id,
    userId: interaction.payload.user_id,
    actionId: interaction.actionId,
    context: interaction.context,
  };
  return `interaction:${createHash("sha256")
    .update(JSON.stringify(canonicalize(identity)))
    .digest("hex")}`;
}

function assertValidInteraction(
  interaction: MattermostValidatedInteraction,
): MattermostValidatedInteraction {
  if (
    !interaction ||
    !interaction.payload?.channel_id?.trim() ||
    !interaction.payload?.post_id?.trim() ||
    !interaction.payload?.user_id?.trim() ||
    !interaction.actionId?.trim() ||
    !interaction.actionName?.trim() ||
    !interaction.post?.id?.trim()
  ) {
    throw new MattermostInteractionPermanentError(
      "invalid-interaction",
      "Mattermost interaction payload is missing provider identity.",
    );
  }
  return interaction;
}

function resolveNonRetryableFailure(error: unknown) {
  if (error instanceof MattermostInteractionPermanentError) {
    return { reason: error.reason, message: error.message };
  }
  const message = formatErrorMessage(error);
  return /Mattermost API (?:401|403)\b/.test(message)
    ? { reason: "mattermost-auth", message }
    : null;
}

export type MattermostInteractionIngressMonitor = {
  admit: (interaction: MattermostValidatedInteraction) => Promise<() => void>;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

export function createMattermostInteractionIngressMonitor(options: {
  accountId: string;
  dispatch: MattermostInteractionProcessor;
  runtime: Pick<RuntimeEnv, "error" | "log">;
  queue?: ChannelIngressQueue<MattermostInteractionIngressPayload>;
  pollIntervalMs?: number;
  abortSignal?: AbortSignal;
}): MattermostInteractionIngressMonitor {
  const ackGates = new Map<
    string,
    { promise: Promise<void>; release: () => void }
  >();
  const inspect = (interaction: MattermostValidatedInteraction) => {
    const validated = assertValidInteraction(interaction);
    return {
      eventId: buildMattermostInteractionEventId(validated),
      laneKey: `channel:${validated.payload.channel_id}:post:${validated.payload.post_id}`,
    };
  };
  const monitor = createChannelIngressMonitor<
    MattermostValidatedInteraction,
    Omit<MattermostInteractionIngressPayload, "version">,
    MattermostInteractionIngressPayload
  >({
    queue:
      options.queue ??
      createMattermostIngressQueue<MattermostInteractionIngressPayload>({
        accountId: options.accountId,
        stateDir: getMattermostRuntime().state.resolveStateDir(),
        scope: "interactions",
      }),
    inspect,
    payload: {
      version: MATTERMOST_INTERACTION_PAYLOAD_VERSION,
      serialize: (interaction, { receivedAt }) => ({ interaction, receivedAt }),
      deserialize: (body) => assertValidInteraction(body.interaction),
      encode: ({ body }) => ({
        version: MATTERMOST_INTERACTION_PAYLOAD_VERSION,
        ...body,
      }),
      decode: (payload) => ({
        version: payload.version,
        body: {
          receivedAt: payload.receivedAt,
          interaction: payload.interaction,
        },
      }),
      createClaimError: () =>
        new MattermostInteractionPermanentError(
          "invalid-interaction",
          "Mattermost interaction queue row is invalid.",
        ),
    },
    deliver: async (interaction) => {
      await ackGates.get(buildMattermostInteractionEventId(interaction))?.promise;
      await options.dispatch(interaction);
    },
    pollIntervalMs: options.pollIntervalMs ?? MATTERMOST_INTERACTION_POLL_INTERVAL_MS,
    retention: "standard",
    drain: {
      resolveNonRetryableFailure,
      onLog: (message) => options.runtime.log?.(`mattermost interaction ${message}`),
    },
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    createStoppedError: () => new Error("Mattermost interaction ingress is stopped."),
    onError: (error) =>
      options.runtime.error?.(
        `mattermost interaction drain failed: ${formatErrorMessage(error)}`,
      ),
  });
  monitor.start();
  return {
    admit: async (interaction) => {
      const eventId = buildMattermostInteractionEventId(interaction);
      let gate = ackGates.get(eventId);
      if (!gate) {
        let release = () => {};
        const promise = new Promise<void>((resolve) => {
          release = resolve;
        });
        gate = { promise, release };
        ackGates.set(eventId, gate);
      }
      try {
        await monitor.admit(interaction);
      } catch (error) {
        ackGates.delete(eventId);
        gate.release();
        throw error;
      }
      return () => {
        if (ackGates.get(eventId) === gate) {
          ackGates.delete(eventId);
        }
        gate.release();
      };
    },
    stop: async () => {
      for (const gate of ackGates.values()) {
        gate.release();
      }
      ackGates.clear();
      await monitor.stop();
    },
    waitForIdle: monitor.waitForIdle,
  };
}
