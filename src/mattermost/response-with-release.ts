// Keep response lifecycle ownership inside the plugin so the runtime remains
// compatible with hosts that predate the equivalent public SDK helper.
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

export function responseWithRelease(response: Response, release: () => Promise<void>): Response {
  let released = false;
  let canceling: Promise<void> | undefined;
  const releaseOnce = async () => {
    if (released) {
      return;
    }
    released = true;
    await release();
  };

  if (!response.body || NULL_BODY_STATUSES.has(response.status)) {
    void releaseOnce();
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (canceling) {
          await canceling;
          await releaseOnce();
          return;
        }
        if (next.done) {
          controller.close();
          await releaseOnce();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        if (canceling) {
          await canceling;
          await releaseOnce();
          return;
        }
        await releaseOnce();
        throw error;
      }
    },
    async cancel(reason) {
      canceling = reader.cancel(reason).catch(() => undefined);
      await canceling;
      await releaseOnce();
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
