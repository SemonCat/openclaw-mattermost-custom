// Mattermost plugin module retries a transient core session-admission race once.

// Matches the exact message OpenClaw's core session/agent-admission layer throws when two
// concurrent attempts (e.g. a debounced channel message and a native slash command reply)
// race to start work on the same session key. The message itself instructs the caller to
// retry ("...Retry."); core does not retry this on the caller's behalf (see e.g.
// src/gateway/server-methods/chat-send-admission.ts, src/agents/agent-command.ts,
// src/cron/retry-hint.ts's SESSION_LIFECYCLE_CLAIM_ERROR_PATTERN upstream, which classifies
// the identical wording as retryable only before execution starts).
const SESSION_ADMISSION_RACE_PATTERN =
  /^Session ".+" (?:changed|was deleted) while starting work\. Retry\.$/;

export function isMattermostSessionAdmissionRaceError(error: unknown): boolean {
  return error instanceof Error && SESSION_ADMISSION_RACE_PATTERN.test(error.message);
}

const DEFAULT_RETRY_DELAY_MS = 300;

/**
 * Run `run()`; if it fails on the exact core session-admission race pattern, wait briefly
 * and try once more. Retrying is only safe while nothing user-visible has happened yet, so
 * the caller must prove that itself via `hasStartedWork` (e.g. a flag flipped by the first
 * reply/tool callback or delivery attempt) rather than this helper assuming which core
 * admission call site can and cannot fire after partial side effects.
 */
export async function withMattermostSessionAdmissionRetry<T>(params: {
  run: () => Promise<T>;
  hasStartedWork: () => boolean;
  retryDelayMs?: number;
}): Promise<T> {
  try {
    return await params.run();
  } catch (error) {
    if (params.hasStartedWork() || !isMattermostSessionAdmissionRaceError(error)) {
      throw error;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, params.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    });
    return await params.run();
  }
}
