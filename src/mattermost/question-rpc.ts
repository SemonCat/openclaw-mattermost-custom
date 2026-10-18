import { resolveGatewayPort } from "openclaw/plugin-sdk/core";
import { GatewayClient, resolveGatewayAuth } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawConfig } from "./runtime-api.js";

export type MattermostQuestionRpc = (
  method: "question.get" | "question.request" | "question.resolve" | "question.waitAnswer",
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<unknown>;

/** Custom plugins cannot use the trusted-official-only runtime.gateway surface. */
export function createMattermostQuestionRpc(cfg: () => OpenClawConfig): MattermostQuestionRpc {
  return async (method, params, options) => {
    options?.signal?.throwIfAborted();
    const config = cfg();
    const auth = resolveGatewayAuth({
      authConfig: config.gateway?.auth,
      tailscaleMode: config.gateway?.tailscale?.mode,
    });
    const timeoutMs = Math.min(35_000, Math.max(1, options?.timeoutMs ?? 10_000));
    return await new Promise((resolve, reject) => {
      let settled = false;
      let dispatched = false;
      const finish = (error?: unknown, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", abort);
        client.stop();
        if (error) reject(error);
        else resolve(value);
      };
      const abort = () => finish(options?.signal?.reason ?? new Error("Question request aborted"));
      // A local authenticated backend client requests only the question scope.
      // It neither creates device credentials nor retries an ambiguous mutation.
      const client = new GatewayClient({
        url: `${config.gateway?.tls?.enabled ? "wss" : "ws"}://127.0.0.1:${resolveGatewayPort(config)}`,
        token: auth.token,
        password: auth.password,
        clientName: "gateway-client",
        clientDisplayName: "Mattermost forms",
        mode: "backend",
        role: "operator",
        scopes: ["operator.questions"],
        deviceIdentity: null,
        sharedStateMode: "read-only",
        onHelloOk: () => {
          if (dispatched || settled) return;
          dispatched = true;
          void client.request(method, params, { timeoutMs, signal: options?.signal })
            .then((value) => finish(undefined, value), finish);
        },
        onConnectError: finish,
        onClose: () => finish(new Error("Question connection closed")),
      });
      const timer = setTimeout(() => finish(new Error("Question request timed out")), timeoutMs);
      options?.signal?.addEventListener("abort", abort, { once: true });
      if (options?.signal?.aborted) abort();
      try {
        if (!settled) client.start();
      } catch (error) {
        finish(error);
      }
    });
  };
}
