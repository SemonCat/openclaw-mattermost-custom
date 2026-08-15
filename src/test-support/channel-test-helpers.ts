// Test-only stand-in for the inbound debounce helper that the published
// OpenClaw package intentionally does not export.
type InboundDebounceFlushParams = {
  lifecycle?: {
    abortSignal?: AbortSignal;
    onAdopted?: () => Promise<void> | void;
    onDeferred?: () => void;
    onAdoptionFinalizing?: () => void;
    onFailed?: (error: unknown) => Promise<void> | void;
    onAbandoned?: () => Promise<void> | void;
  };
  dispatch: (params: {
    abortSignal: AbortSignal;
    onAdopted: () => Promise<void>;
    onDeferred: () => void;
    onAdoptionFinalizing: () => void;
    onFailed?: (error: unknown) => Promise<void>;
    onAbandoned: () => Promise<void>;
  }) => Promise<void>;
};

export const createTestInboundDebounceFlush = (params: InboundDebounceFlushParams) => {
  const source = params.lifecycle;
  const completion = params.dispatch({
    abortSignal: source?.abortSignal ?? new AbortController().signal,
    onAdopted: async () => await source?.onAdopted?.(),
    onDeferred: () => source?.onDeferred?.(),
    onAdoptionFinalizing: () => source?.onAdoptionFinalizing?.(),
    onFailed: source?.onFailed ? async (error) => await source.onFailed?.(error) : undefined,
    onAbandoned: async () => await source?.onAbandoned?.(),
  });
  return { admission: completion, completion };
};
