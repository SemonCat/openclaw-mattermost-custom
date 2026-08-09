// Mattermost tests cover session-admission-retry plugin behavior.
import { describe, expect, it, vi } from "vitest";
import {
  isMattermostSessionAdmissionRaceError,
  withMattermostSessionAdmissionRetry,
} from "./session-admission-retry.js";

describe("isMattermostSessionAdmissionRaceError", () => {
  it("matches the core 'changed while starting work' message", () => {
    expect(
      isMattermostSessionAdmissionRaceError(
        new Error('Session "mattermost:acct:channel:123" changed while starting work. Retry.'),
      ),
    ).toBe(true);
  });

  it("matches the core 'was deleted while starting work' message", () => {
    expect(
      isMattermostSessionAdmissionRaceError(
        new Error('Session "mattermost:acct:channel:123" was deleted while starting work. Retry.'),
      ),
    ).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isMattermostSessionAdmissionRaceError(new Error("ECONNREFUSED"))).toBe(false);
    expect(
      isMattermostSessionAdmissionRaceError(
        new Error("Session changed while starting work, but not quoted"),
      ),
    ).toBe(false);
  });

  it("does not match non-Error throws", () => {
    expect(isMattermostSessionAdmissionRaceError("session changed while starting work. Retry.")).toBe(
      false,
    );
    expect(isMattermostSessionAdmissionRaceError(undefined)).toBe(false);
  });
});

describe("withMattermostSessionAdmissionRetry", () => {
  it("retries once and succeeds when the race pattern fires before any work started", async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('Session "k" changed while starting work. Retry.'))
      .mockResolvedValueOnce("ok");

    const result = await withMattermostSessionAdmissionRetry({
      run,
      hasStartedWork: () => false,
      retryDelayMs: 0,
    });

    expect(result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not retry once work has started, even on a matching error", async () => {
    const raceError = new Error('Session "k" changed while starting work. Retry.');
    const run = vi.fn<() => Promise<string>>().mockRejectedValueOnce(raceError);

    await expect(
      withMattermostSessionAdmissionRetry({
        run,
        hasStartedWork: () => true,
        retryDelayMs: 0,
      }),
    ).rejects.toBe(raceError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-matching error", async () => {
    const otherError = new Error("boom");
    const run = vi.fn<() => Promise<string>>().mockRejectedValueOnce(otherError);

    await expect(
      withMattermostSessionAdmissionRetry({
        run,
        hasStartedWork: () => false,
        retryDelayMs: 0,
      }),
    ).rejects.toBe(otherError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("propagates the retry's own failure when the race repeats", async () => {
    const secondError = new Error('Session "k" changed while starting work. Retry.');
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('Session "k" changed while starting work. Retry.'))
      .mockRejectedValueOnce(secondError);

    await expect(
      withMattermostSessionAdmissionRetry({
        run,
        hasStartedWork: () => false,
        retryDelayMs: 0,
      }),
    ).rejects.toBe(secondError);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
