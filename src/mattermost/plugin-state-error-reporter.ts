// Keep plugin-state error reporting ownership inside the plugin so the
// runtime remains compatible with hosts that predate the equivalent public
// SDK helper (`createPluginStateErrorReporter` from
// `openclaw/plugin-sdk/plugin-state-runtime`). The returned reporter never
// throws: a persistence-layer failure must not break message handling, and
// the runtime lookup itself is deferred until an error actually occurs so a
// not-yet-initialized plugin runtime cannot crash cache construction.
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

export function createPluginStateErrorReporter(
  getRuntime: () => Pick<PluginRuntime, "logging"> | null | undefined,
  plugin: string,
  feature: string,
  message: string,
  formatError: (error: unknown) => Record<string, unknown> = (error) => ({ error: String(error) }),
) {
  return (error: unknown): void => {
    try {
      getRuntime()?.logging.getChildLogger({ plugin, feature }).warn(message, formatError(error));
    } catch {
      // State fallback must remain available even when logger setup or formatting fails.
    }
  };
}
