// Mattermost plugin module persists provider post identities in native post props.
import {
  fetchMattermostChannelPosts,
  type MattermostClient,
  type MattermostPost,
} from "./client.js";

const MATTERMOST_IDENTITY_PROP = "openclaw_mattermost";
const MATTERMOST_IDENTITY_VERSION = 1;
const RECOVERY_LOOKUP_LIMIT = 200;

export type MattermostDurablePostKind = "task_progress" | "turn_result";
export type MattermostRecoveredTaskTerminalStatus = "completed" | "failed" | "cancelled";

type MattermostPostIdentity = {
  version: number;
  kind: MattermostDurablePostKind;
  accountId: string;
  agentId: string;
  channelId: string;
  threadId?: string;
};

export type MattermostPostIdentityScope = Omit<MattermostPostIdentity, "version" | "kind">;

export type MattermostRecoveryPostIdentity = {
  taskPost: MattermostPost;
  resultPost?: MattermostPost;
  source: "metadata" | "legacy";
};

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readPostIdentity(post: MattermostPost): MattermostPostIdentity | undefined {
  const identity = readRecord(post.props?.[MATTERMOST_IDENTITY_PROP]);
  const version = identity?.version;
  const kind = identity?.kind;
  const accountId = identity?.accountId;
  const agentId = identity?.agentId;
  const channelId = identity?.channelId;
  const threadId = identity?.threadId;
  if (
    version !== MATTERMOST_IDENTITY_VERSION ||
    (kind !== "task_progress" && kind !== "turn_result") ||
    typeof accountId !== "string" ||
    !accountId ||
    typeof agentId !== "string" ||
    !agentId ||
    typeof channelId !== "string" ||
    !channelId ||
    (threadId !== undefined && (typeof threadId !== "string" || !threadId))
  ) {
    return undefined;
  }
  return { version, kind, accountId, agentId, channelId, ...(threadId ? { threadId } : {}) };
}

export function buildMattermostPostIdentityProps(
  kind: MattermostDurablePostKind,
  scope: MattermostPostIdentityScope,
): Record<string, unknown> {
  return {
    [MATTERMOST_IDENTITY_PROP]: {
      version: MATTERMOST_IDENTITY_VERSION,
      kind,
      ...scope,
    },
  };
}

function isInProgressTaskMessage(message: string | null | undefined): boolean {
  const value = message ?? "";
  if (/^####\s+Task progress\s*·\s*In progress\s*$/im.test(value)) {
    return true;
  }
  return (
    /^###\s+Task progress\s*$/im.test(value) &&
    /^\*\*Status:\*\*.*\bIn progress\b.*$/im.test(value)
  );
}

function isTaskMessage(message: string | null | undefined): boolean {
  return /^#{3,4}\s+Task progress(?:\s*·.*)?\s*$/im.test(message ?? "");
}

function isExactRoutePost(params: {
  post: MattermostPost;
  botUserId: string;
  channelId: string;
  threadId?: string;
}): boolean {
  if (params.post.user_id !== params.botUserId) {
    return false;
  }
  if (params.post.channel_id && params.post.channel_id !== params.channelId) {
    return false;
  }
  const rootId = params.post.root_id?.trim() || undefined;
  return params.threadId ? rootId === params.threadId : rootId === undefined;
}

function sortNewestFirst(posts: readonly MattermostPost[]): MattermostPost[] {
  return posts
    .map((post, index) => ({ post, index }))
    .toSorted(
      (left, right) =>
        (right.post.create_at ?? 0) - (left.post.create_at ?? 0) || right.index - left.index,
    )
    .map(({ post }) => post);
}

function isAtOrAfter(post: MattermostPost, anchor: MattermostPost): boolean {
  const postCreatedAt = post.create_at ?? 0;
  const anchorCreatedAt = anchor.create_at ?? 0;
  return postCreatedAt === 0 || anchorCreatedAt === 0 || postCreatedAt >= anchorCreatedAt;
}

export function findMattermostRecoveryPostIdentity(params: {
  posts: readonly MattermostPost[];
  botUserId: string;
  channelId: string;
  threadId?: string;
  accountId: string;
  agentId: string;
}): MattermostRecoveryPostIdentity | undefined {
  const routed = sortNewestFirst(
    params.posts.filter((post) => isExactRoutePost({ ...params, post })),
  );
  const taggedTask = routed.find((post) => {
    const identity = readPostIdentity(post);
    return (
      identity?.kind === "task_progress" &&
      identity.accountId === params.accountId &&
      identity.agentId === params.agentId &&
      identity.channelId === params.channelId &&
      identity.threadId === params.threadId &&
      isInProgressTaskMessage(post.message)
    );
  });
  if (taggedTask) {
    const resultPost = routed.find((post) => {
      const identity = readPostIdentity(post);
      return (
        identity?.kind === "turn_result" &&
        identity.accountId === params.accountId &&
        identity.agentId === params.agentId &&
        identity.channelId === params.channelId &&
        identity.threadId === params.threadId &&
        isAtOrAfter(post, taggedTask)
      );
    });
    return { taskPost: taggedTask, resultPost, source: "metadata" };
  }

  // Compatibility for cards created before identity props shipped. Restrict the
  // fallback to the exact route, bot author, in-progress renderer, and posts after it.
  const legacyTask = routed.find((post) => isInProgressTaskMessage(post.message));
  if (!legacyTask) {
    return undefined;
  }
  const resultPost = routed.find(
    (post) =>
      post.id !== legacyTask.id &&
      !isTaskMessage(post.message) &&
      isAtOrAfter(post, legacyTask),
  );
  return { taskPost: legacyTask, resultPost, source: "legacy" };
}

export async function hydrateMattermostRecoveryPostIdentity(params: {
  client: MattermostClient;
  botUserId: string;
  channelId: string;
  threadId?: string;
  accountId: string;
  agentId: string;
  log: (message: string) => void;
}): Promise<MattermostRecoveryPostIdentity | undefined> {
  try {
    const page = await fetchMattermostChannelPosts(params.client, params.channelId, {
      limit: RECOVERY_LOOKUP_LIMIT,
    });
    return findMattermostRecoveryPostIdentity({ ...params, posts: page.messages });
  } catch (error: unknown) {
    params.log(`mattermost restart recovery identity hydration failed: ${String(error)}`);
    return undefined;
  }
}

function terminalLabel(status: MattermostRecoveredTaskTerminalStatus): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

export function renderMattermostRecoveredTaskTerminal(
  message: string | null | undefined,
  status: MattermostRecoveredTaskTerminalStatus,
): string | undefined {
  if (!isInProgressTaskMessage(message)) {
    return undefined;
  }
  const output: string[] = [];
  let wroteHeader = false;
  for (const line of (message ?? "").split(/\r?\n/)) {
    if (!wroteHeader && /^#{3,4}\s+Task progress(?:\s*·.*)?\s*$/i.test(line)) {
      output.push(`#### Task progress · ${terminalLabel(status)}`);
      wroteHeader = true;
      continue;
    }
    if (/^\*\*Status:\*\*/i.test(line) || /^\*\*Plan updated\*\*\s*$/i.test(line)) {
      continue;
    }
    if (line === "" && output.at(-1) === "") {
      continue;
    }
    output.push(line);
  }
  while (output.at(-1) === "") {
    output.pop();
  }
  return wroteHeader ? output.join("\n") : undefined;
}
