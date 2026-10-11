import {
  createSessionHeaderLink,
  defineControlUiPlugin,
  type ControlUiAccessory,
  type ControlUiSession,
} from "openclaw/plugin-sdk/control-ui";
import { validateMattermostConversationLink } from "../src/mattermost/conversation-link.js";

// channels.status returns flattened account snapshots. No credentials/config RPC.
function accountBaseUrl(status: unknown, accountId: string): unknown {
  const rows = (status as { channelAccounts?: { mattermost?: unknown } } | null)?.channelAccounts
    ?.mattermost;
  if (!Array.isArray(rows)) return undefined;
  const matches = rows.filter((row) => row?.accountId === accountId);
  return matches.length === 1 && matches[0].configured === true && matches[0].enabled !== false
    ? matches[0].baseUrl
    : undefined;
}

export default defineControlUiPlugin({
  id: "mattermost-custom",
  activate(host) {
    const mount: ControlUiAccessory["mount"] = (container, initialContext) => {
      let context = initialContext;
      let baseUrl: unknown;
      let scope = "";
      let generation = 0;
      let disposed = false;
      // The semantic helper's resolver is narrowed, but its mount receives the
      // actual public ControlUiSession supplied by the host view.
      const link = createSessionHeaderLink((session) => {
        const current = session as ControlUiSession;
        return current.channel === "mattermost" &&
          current.accountId &&
          host.connection.connected &&
          host.connection.canRead
          ? validateMattermostConversationLink(current.conversationLink, baseUrl)
          : undefined;
      })(container, context);
      const refresh = () => {
        if (disposed) return;
        const session = context.props.session;
        const nextScope =
          context.presented &&
          !context.signal.aborted &&
          host.connection.connected &&
          host.connection.canRead &&
          session?.channel === "mattermost" &&
          session.accountId
            ? JSON.stringify([session.key, session.accountId])
            : "";
        if (nextScope === scope) {
          link?.update?.(context);
          return;
        }
        scope = nextScope;
        baseUrl = undefined;
        const requestGeneration = ++generation;
        link?.update?.(context);
        if (!nextScope || !session?.accountId) return;
        const accountId = session.accountId;
        void host.request("channels.status", { channel: "mattermost", probe: false }).then(
          (status) => {
            if (disposed || requestGeneration !== generation) return;
            baseUrl = accountBaseUrl(status, accountId);
            link?.update?.(context);
          },
          () => {
            /* Unavailable/denied status leaves the accessory hidden. */
          },
        );
      };
      const unsubscribe = host.subscribe(refresh);
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        ++generation;
        unsubscribe();
        link?.dispose?.();
        initialContext.signal.removeEventListener("abort", dispose);
      };
      initialContext.signal.addEventListener("abort", dispose, { once: true });
      refresh();
      if (initialContext.signal.aborted) dispose();
      return {
        update(next) {
          context = next;
          refresh();
        },
        dispose,
      };
    };
    return host.ui.registerAccessory({
      id: "conversation-origin",
      placement: "session-header",
      mount,
    });
  },
});
