import { createHash } from "node:crypto";
import {
  jsonResult, type AnyAgentTool, type OpenClawPluginApi, type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { z } from "zod";
import { resolveMattermostAccount } from "./accounts.js";
import { createMattermostClient, fetchMattermostMe } from "./client.js";
import { formQuestions, MattermostFormSchema, parseQuestionSubmission } from "./form-schema.js";
import { buildMattermostQuestionFormButtons } from "./question-dialog.js";
import { createMattermostQuestionRpc, type MattermostQuestionRpc } from "./question-rpc.js";
import { sendMessageMattermost } from "./send.js";
import { MATTERMOST_V12_TEXT_LIMIT, resolveMattermostTextLimit } from "./text-limits.js";

const requestSchema = MattermostFormSchema.extend({
  timeoutSeconds: z.number().int().min(15).max(120).optional(),
});
const waitSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("cancelled") }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("answered"), answers: z.object({ answers: z.record(z.string(), z.array(z.string())) }) }),
]);
type Dependencies = {
  createClient: typeof createMattermostClient;
  send: typeof sendMessageMattermost;
  rpc?: MattermostQuestionRpc;
};

export function createMattermostFormTool(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
  deps: Dependencies = { createClient: createMattermostClient, send: sendMessageMattermost },
): AnyAgentTool | null {
  const channelId = (context.nativeChannelId ?? context.deliveryContext?.to?.match(/^channel:(.+)$/i)?.[1])
    ?.replace(/^channel:/i, "").trim();
  if (context.messageChannel !== "mattermost" || !channelId ||
    !context.sessionKey || !context.requesterSenderId) return null;
  const cfg = () => context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config ?? api.config;
  const rpc = deps.rpc ?? createMattermostQuestionRpc(cfg);
  return {
    name: "mattermost_form",
    label: "Mattermost Form",
    description: "Ask ordinary, non-secret choices in the current Mattermost conversation using a dialog. Fields can be select (multiple=true for multiple choices) or matrix (rows/columns; multiple=false for one choice per row). Fill form uses mobile-compatible multi-select menus and one menu per matrix row; Web form uses native checkbox groups and matrices. This waiting tool returns the same structured answers from either layout. Use ask_user for normal clarification questions. Requires Mattermost 12+. IDs must be lowercase letters/digits/underscores and start with a letter. Default wait is 90 seconds, maximum 120; a Gateway restart invalidates this transient question.",
    parameters: z.toJSONSchema(requestSchema) as never,
    async execute(toolCallId, rawParams, signal) {
      const { timeoutSeconds = 90, ...form } = requestSchema.parse(rawParams);
      context.assertInvocationCurrent?.();
      signal?.throwIfAborted();
      const account = resolveMattermostAccount({ cfg: cfg(), accountId: context.agentAccountId });
      if (!account.enabled || !account.baseUrl || !account.botToken) throw new Error("Mattermost account unavailable");
      const client = deps.createClient({
        baseUrl: account.baseUrl, botToken: account.botToken,
        allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
      });
      const assertCurrent = () => {
        context.assertInvocationCurrent?.();
        signal?.throwIfAborted();
        const current = resolveMattermostAccount({ cfg: cfg(), accountId: account.accountId });
        if (!current.enabled || cfg().channels?.mattermost?.enabled === false ||
          current.baseUrl !== account.baseUrl || current.botToken !== account.botToken) {
          throw new Error("Mattermost account changed during form creation");
        }
      };
      await fetchMattermostMe(client);
      if (resolveMattermostTextLimit({ baseUrl: client.baseUrl }) < MATTERMOST_V12_TEXT_LIMIT) {
        throw new Error("Native forms require a verified Mattermost 12+ server");
      }
      const id = `ask_${createHash("sha256").update(JSON.stringify([context.sessionKey, toolCallId])).digest("hex").slice(0, 32)}`;
      const deadline = Date.now() + timeoutSeconds * 1000;
      assertCurrent();
      // A fixed call identity rejects replays while the Gateway retains the question.
      // Do not replay an ambiguous question.request or visible Mattermost send.
      const created = z.object({ id: z.literal(id), expiresAtMs: z.number() }).parse(
        await rpc("question.request", {
          id, sessionKey: context.sessionKey,
          ...(context.agentId ? { agentId: context.agentId } : {}),
          questions: formQuestions(form), timeoutMs: timeoutSeconds * 1000,
        }, { signal }),
      );
      const finish = (answer: z.infer<typeof waitSchema>) => {
        if (answer.status !== "answered") return jsonResult({ questionId: id, status: answer.status });
        // Re-validate host answers (including answers submitted outside Mattermost).
        const validated = parseQuestionSubmission(formQuestions(form), answer.answers.answers, form);
        const answers = Object.fromEntries(form.fields.map((field) => [
          field.id, field.type === "matrix"
            ? Object.fromEntries(validated[field.id]!.map((row) => {
              const [key, values] = row.split(":");
              return [key!, values!.split(",")];
            }))
            : validated[field.id],
        ]));
        return jsonResult({ questionId: id, status: "answered", answers });
      };
      const retire = async () => {
        let latest = waitSchema.parse(await rpc("question.waitAnswer", { id, timeoutMs: 1 }));
        if (latest.status === "pending") {
          try {
            latest = waitSchema.parse(await rpc("question.resolve", { id, cancel: true }));
          } catch {
            // A concurrent human answer can beat cancellation.
            latest = waitSchema.parse(await rpc("question.waitAnswer", { id, timeoutMs: 1 }));
            if (latest.status === "pending") throw new Error("Form cancellation outcome is unknown");
          }
        }
        return latest;
      };
      try {
        assertCurrent();
        await deps.send(`channel:${channelId}`, form.title, {
          cfg: cfg(), accountId: account.accountId,
          replyToId: context.deliveryContext?.threadId == null ? undefined : String(context.deliveryContext.threadId),
          buttons: [buildMattermostQuestionFormButtons(id, form)], questionId: id,
          assertDirectAdapterHandoff: assertCurrent,
        });
        while (Date.now() < Math.min(deadline, created.expiresAtMs)) {
          context.assertInvocationCurrent?.();
          signal?.throwIfAborted();
          const remaining = Math.min(deadline, created.expiresAtMs) - Date.now();
          const wait = Math.max(1, Math.min(20_000, remaining));
          const answer = waitSchema.parse(await rpc(
            "question.waitAnswer", { id, timeoutMs: wait }, { signal, timeoutMs: wait + 10_000 },
          ));
          if (answer.status !== "pending") return finish(answer);
        }
      } catch (error) {
        // Preserve an answer that won the race with cancellation or transport failure.
        const latest = await retire();
        if (latest.status === "answered") return finish(latest);
        if (signal?.aborted) throw signal.reason ?? error;
        throw error;
      }
      return finish(await retire());
    },
  };
}

export function registerMattermostFormTool(api: OpenClawPluginApi): void {
  api.registerTool((context) => createMattermostFormTool(api, context), {
    name: "mattermost_form", optional: false,
  });
}
