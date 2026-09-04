// Mattermost plugin command that replaces the licensed thread-move endpoint with
// an owner-gated copy, read-back verification, and source-root deletion flow.
import { randomUUID } from "node:crypto";
import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/account-helpers";
import {
  KeyedAsyncQueue,
  type OpenClawPluginApi,
  type OpenClawPluginCommandDefinition,
  type PluginCommandContext,
} from "openclaw/plugin-sdk/core";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveMattermostAccount } from "./accounts.js";
import {
  createMattermostClient,
  createMattermostPost,
  deleteMattermostPost,
  downloadMattermostFile,
  fetchMattermostChannel,
  fetchMattermostChannelByName,
  fetchMattermostMe,
  fetchMattermostPost,
  fetchMattermostPostThread,
  fetchMattermostUserTeams,
  parseMattermostApiStatus,
  uploadMattermostFile,
  type MattermostChannel,
  type MattermostClient,
  type MattermostPost,
} from "./client.js";
import { resolveMattermostCommandChannelId } from "./channel-model-command.js";
import { parseMattermostTarget } from "./target-resolution.js";

const COMMAND_NAME = "move_thread";
const MATTERMOST_POST_ID_PATTERN = /^[a-z0-9]{26}$/i;
const MAX_MOVE_POSTS = 100;
const MAX_MOVE_FILES = 24;
const DEFAULT_MOVE_FILE_MAX_BYTES = 8 * 1024 * 1024;
const moveQueue = new KeyedAsyncQueue();

export type MattermostThreadMoveDependencies = {
  createClient: typeof createMattermostClient;
  createPost: typeof createMattermostPost;
  deletePost: typeof deleteMattermostPost;
  downloadFile: typeof downloadMattermostFile;
  fetchChannel: typeof fetchMattermostChannel;
  fetchChannelByName: typeof fetchMattermostChannelByName;
  fetchMe: typeof fetchMattermostMe;
  fetchPost: typeof fetchMattermostPost;
  fetchThread: typeof fetchMattermostPostThread;
  fetchUserTeams: typeof fetchMattermostUserTeams;
  uploadFile: typeof uploadMattermostFile;
  operationId: () => string;
};

const defaultDependencies: MattermostThreadMoveDependencies = {
  createClient: createMattermostClient,
  createPost: createMattermostPost,
  deletePost: deleteMattermostPost,
  downloadFile: downloadMattermostFile,
  fetchChannel: fetchMattermostChannel,
  fetchChannelByName: fetchMattermostChannelByName,
  fetchMe: fetchMattermostMe,
  fetchPost: fetchMattermostPost,
  fetchThread: fetchMattermostPostThread,
  fetchUserTeams: fetchMattermostUserTeams,
  uploadFile: uploadMattermostFile,
  operationId: randomUUID,
};

export type MattermostThreadMoveResult = {
  status: "moved" | "source-delete-unknown";
  sourceRootId: string;
  destinationRootId: string;
  destinationChannelId: string;
  postCount: number;
  fileCount: number;
  warnings: string[];
};

function normalizePostId(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  return MATTERMOST_POST_ID_PATTERN.test(normalized) ? normalized : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sortThreadPosts(posts: readonly MattermostPost[], rootPostId: string): MattermostPost[] {
  return [...posts].sort((left, right) => {
    if (left.id === rootPostId) {
      return -1;
    }
    if (right.id === rootPostId) {
      return 1;
    }
    const createdDelta = (left.create_at ?? 0) - (right.create_at ?? 0);
    return createdDelta || left.id.localeCompare(right.id);
  });
}

function assertCompleteSourceThread(params: {
  posts: readonly MattermostPost[];
  hasMore: boolean;
  rootPostId: string;
  sourceChannelId: string;
}): void {
  if (params.hasMore) {
    throw new Error(`Thread exceeds the ${MAX_MOVE_POSTS}-post move limit.`);
  }
  if (params.posts.length === 0 || !params.posts.some((post) => post.id === params.rootPostId)) {
    throw new Error("Mattermost did not return the source thread root.");
  }
  for (const post of params.posts) {
    if (post.channel_id?.trim() !== params.sourceChannelId) {
      throw new Error("Mattermost returned a source post from a different channel.");
    }
    if (post.id !== params.rootPostId && post.root_id?.trim() !== params.rootPostId) {
      throw new Error("Mattermost returned a post outside the source thread.");
    }
  }
}

function sourceSnapshot(posts: readonly MattermostPost[]): string {
  return JSON.stringify(
    posts.map((post) => ({
      id: post.id,
      userId: post.user_id ?? null,
      channelId: post.channel_id ?? null,
      rootId: post.root_id ?? null,
      message: post.message ?? "",
      fileIds: post.file_ids ?? [],
      type: post.type ?? null,
      updateAt: post.update_at ?? null,
      deleteAt: post.delete_at ?? null,
    })),
  );
}

function verifyCopiedPost(params: {
  post: MattermostPost;
  expectedChannelId: string;
  expectedMessage: string;
  expectedRootId?: string;
  expectedFileIds: readonly string[];
  sourcePostId: string;
  operationId: string;
}): void {
  const marker = params.post.props?.openclaw_mattermost_move;
  const markerRecord =
    marker && typeof marker === "object" ? (marker as Record<string, unknown>) : {};
  const actualFileIds = (params.post.file_ids ?? []).map((fileId) => fileId.trim());
  if (
    params.post.channel_id?.trim() !== params.expectedChannelId ||
    (params.post.message ?? "") !== params.expectedMessage ||
    (params.post.root_id?.trim() || undefined) !== params.expectedRootId ||
    JSON.stringify(actualFileIds) !== JSON.stringify(params.expectedFileIds) ||
    markerRecord.source_post_id !== params.sourcePostId ||
    markerRecord.operation_id !== params.operationId
  ) {
    throw new Error(`Copied Mattermost post ${params.post.id} failed read-back verification.`);
  }
}

async function resolveDestinationChannel(params: {
  client: MattermostClient;
  rawTarget: string;
  dependencies: MattermostThreadMoveDependencies;
}): Promise<MattermostChannel> {
  const target = parseMattermostTarget(params.rawTarget);
  if (target.kind === "user") {
    throw new Error("Thread moves require a channel target such as #town-square.");
  }
  if (target.kind === "channel") {
    return await params.dependencies.fetchChannel(params.client, target.id);
  }
  const me = await params.dependencies.fetchMe(params.client);
  const teams = await params.dependencies.fetchUserTeams(params.client, me.id);
  for (const team of teams) {
    try {
      return await params.dependencies.fetchChannelByName(params.client, team.id, target.name);
    } catch (error) {
      if (parseMattermostApiStatus(error) !== 404) {
        throw error;
      }
    }
  }
  throw new Error(`Mattermost channel "#${target.name}" was not found in the bot's teams.`);
}

async function bestEffortDeleteCopy(params: {
  client: MattermostClient;
  rootPostId?: string;
  dependencies: MattermostThreadMoveDependencies;
}): Promise<string | undefined> {
  if (!params.rootPostId) {
    return undefined;
  }
  try {
    await params.dependencies.deletePost(params.client, params.rootPostId);
    return undefined;
  } catch (error) {
    return `incomplete destination copy ${params.rootPostId} could not be removed: ${errorMessage(error)}`;
  }
}

async function bestEffortPost(params: {
  client: MattermostClient;
  channelId: string;
  message: string;
  pendingPostId: string;
  dependencies: MattermostThreadMoveDependencies;
  rootId?: string;
}): Promise<string | undefined> {
  try {
    await params.dependencies.createPost(params.client, {
      channelId: params.channelId,
      message: params.message,
      rootId: params.rootId,
      pendingPostId: params.pendingPostId,
    });
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

export async function moveMattermostThread(params: {
  client: MattermostClient;
  sourceChannelId: string;
  sourceRootId: string;
  rawDestination: string;
  fileMaxBytes: number;
  baseUrl: string;
  dependencies?: MattermostThreadMoveDependencies;
}): Promise<MattermostThreadMoveResult> {
  const dependencies = params.dependencies ?? defaultDependencies;
  const sourceRootId = normalizePostId(params.sourceRootId);
  if (!sourceRootId) {
    throw new Error("Run /move_thread from inside the Mattermost thread to move.");
  }
  const sourceChannelId = params.sourceChannelId.trim();
  if (!sourceChannelId) {
    throw new Error("Mattermost source channel is unavailable.");
  }

  return await moveQueue.enqueue(`${params.client.baseUrl}:${sourceRootId}`, async () => {
    const operationId = dependencies.operationId();
    const [sourceChannel, destinationChannel, initialThread] = await Promise.all([
      dependencies.fetchChannel(params.client, sourceChannelId),
      resolveDestinationChannel({
        client: params.client,
        rawTarget: params.rawDestination,
        dependencies,
      }),
      dependencies.fetchThread(params.client, sourceRootId, { limit: MAX_MOVE_POSTS }),
    ]);
    if (!["O", "P"].includes(sourceChannel.type?.trim() ?? "")) {
      throw new Error("Thread moves currently support public and private channels only.");
    }
    if (!["O", "P"].includes(destinationChannel.type?.trim() ?? "")) {
      throw new Error("The destination must be a public or private Mattermost channel.");
    }
    if (destinationChannel.id === sourceChannelId) {
      throw new Error("The destination channel must differ from the source channel.");
    }

    const sourcePosts = sortThreadPosts(initialThread.messages, sourceRootId);
    assertCompleteSourceThread({
      posts: sourcePosts,
      hasMore: initialThread.hasMore,
      rootPostId: sourceRootId,
      sourceChannelId,
    });
    const fileCount = sourcePosts.reduce(
      (count, post) => count + (post.file_ids?.length ?? 0),
      0,
    );
    if (fileCount > MAX_MOVE_FILES) {
      throw new Error(`Thread exceeds the ${MAX_MOVE_FILES}-attachment move limit.`);
    }

    const copiedFileIds = new Map<string, string[]>();
    for (const post of sourcePosts) {
      const newFileIds: string[] = [];
      for (const fileId of post.file_ids ?? []) {
        const downloaded = await dependencies.downloadFile(params.client, {
          fileId,
          maxBytes: params.fileMaxBytes,
        });
        const uploaded = await dependencies.uploadFile(params.client, {
          channelId: destinationChannel.id,
          buffer: downloaded.buffer,
          fileName: downloaded.info.name?.trim() || fileId,
          contentType: downloaded.contentType,
        });
        newFileIds.push(uploaded.id);
      }
      copiedFileIds.set(post.id, newFileIds);
    }

    let destinationRootId: string | undefined;
    try {
      for (const sourcePost of sourcePosts) {
        const expectedRootId = sourcePost.id === sourceRootId ? undefined : destinationRootId;
        if (sourcePost.id !== sourceRootId && !expectedRootId) {
          throw new Error("Destination thread root was not created.");
        }
        const expectedMessage = sourcePost.message ?? "";
        const expectedFileIds = copiedFileIds.get(sourcePost.id) ?? [];
        const created = await dependencies.createPost(params.client, {
          channelId: destinationChannel.id,
          message: expectedMessage,
          rootId: expectedRootId,
          fileIds: expectedFileIds,
          pendingPostId: `openclaw-move:${operationId}:${sourcePost.id}`,
          props: {
            openclaw_mattermost_move: {
              version: 1,
              operation_id: operationId,
              source_post_id: sourcePost.id,
              source_root_id: sourceRootId,
              source_channel_id: sourceChannelId,
              source_user_id: sourcePost.user_id ?? null,
              source_create_at: sourcePost.create_at ?? null,
            },
          },
        });
        if (sourcePost.id === sourceRootId) {
          destinationRootId = created.id;
        }
        const readBack = await dependencies.fetchPost(params.client, created.id);
        verifyCopiedPost({
          post: readBack,
          expectedChannelId: destinationChannel.id,
          expectedMessage,
          expectedRootId,
          expectedFileIds,
          sourcePostId: sourcePost.id,
          operationId,
        });
      }

      if (!destinationRootId) {
        throw new Error("Destination thread root was not created.");
      }
      const latestThread = await dependencies.fetchThread(params.client, sourceRootId, {
        limit: MAX_MOVE_POSTS,
      });
      const latestPosts = sortThreadPosts(latestThread.messages, sourceRootId);
      assertCompleteSourceThread({
        posts: latestPosts,
        hasMore: latestThread.hasMore,
        rootPostId: sourceRootId,
        sourceChannelId,
      });
      if (sourceSnapshot(latestPosts) !== sourceSnapshot(sourcePosts)) {
        throw new Error("Source thread changed during the move; the source was not deleted.");
      }
    } catch (error) {
      const cleanupWarning = await bestEffortDeleteCopy({
        client: params.client,
        rootPostId: destinationRootId,
        dependencies,
      });
      throw new Error(
        `${errorMessage(error)}${cleanupWarning ? ` (${cleanupWarning})` : ""}`,
        { cause: error },
      );
    }

    let status: MattermostThreadMoveResult["status"] = "moved";
    try {
      await dependencies.deletePost(params.client, sourceRootId);
    } catch (deleteError) {
      let sourceStillExists = false;
      try {
        await dependencies.fetchPost(params.client, sourceRootId);
        sourceStillExists = true;
      } catch (readBackError) {
        if (parseMattermostApiStatus(readBackError) !== 404) {
          status = "source-delete-unknown";
        }
      }
      if (sourceStillExists) {
        const cleanupWarning = await bestEffortDeleteCopy({
          client: params.client,
          rootPostId: destinationRootId,
          dependencies,
        });
        throw new Error(
          `Destination copy was verified, but the source could not be deleted: ${errorMessage(deleteError)}${cleanupWarning ? ` (${cleanupWarning})` : ""}`,
          { cause: deleteError },
        );
      }
    }

    const warnings: string[] = [];
    const destinationLabel =
      destinationChannel.display_name?.trim() ||
      destinationChannel.name?.trim() ||
      destinationChannel.id;
    const destinationPermalink = `${params.baseUrl.replace(/\/+$/, "")}/pl/${destinationRootId}`;
    const destinationNotice =
      status === "moved"
        ? `✅ Thread moved here from **${sourceChannel.display_name?.trim() || sourceChannel.name?.trim() || sourceChannel.id}**. The ${sourcePosts.length} copied posts were verified before the source was deleted.`
        : "⚠️ The thread copy was verified, but deletion of the source thread could not be confirmed. Check the source before retrying.";
    const destinationNoticeError = await bestEffortPost({
      client: params.client,
      channelId: destinationChannel.id,
      rootId: destinationRootId,
      message: destinationNotice,
      pendingPostId: `openclaw-move-notice:${operationId}:destination`,
      dependencies,
    });
    if (destinationNoticeError) {
      warnings.push(`destination notice failed: ${destinationNoticeError}`);
    }
    const sourceNoticeError = await bestEffortPost({
      client: params.client,
      channelId: sourceChannelId,
      message:
        status === "moved"
          ? `✅ Moved a ${sourcePosts.length}-post thread to [${destinationLabel}](${destinationPermalink}).`
          : `⚠️ Copied a thread to [${destinationLabel}](${destinationPermalink}), but source deletion could not be confirmed.`,
      pendingPostId: `openclaw-move-notice:${operationId}:source`,
      dependencies,
    });
    if (sourceNoticeError) {
      warnings.push(`source notice failed: ${sourceNoticeError}`);
    }

    return {
      status,
      sourceRootId,
      destinationRootId,
      destinationChannelId: destinationChannel.id,
      postCount: sourcePosts.length,
      fileCount,
      warnings,
    };
  });
}

export function createMattermostMoveThreadCommand(
  api: OpenClawPluginApi,
  dependencies: MattermostThreadMoveDependencies = defaultDependencies,
): OpenClawPluginCommandDefinition {
  return {
    name: COMMAND_NAME,
    description:
      "Move the current Mattermost thread to another channel using verified copy-then-delete semantics. Usage: /move_thread #channel",
    channels: ["mattermost"],
    acceptsArgs: true,
    requireAuth: true,
    exposeSenderIsOwner: true,
    nativeProgressMessages: { mattermost: "Moving thread…" },
    async handler(ctx: PluginCommandContext) {
      if (ctx.channel.trim().toLowerCase() !== "mattermost") {
        return { text: "`/move_thread` is available only in Mattermost.", isError: true };
      }
      if (ctx.senderIsOwner !== true) {
        return { text: "Only an OpenClaw owner can move Mattermost threads.", isError: true };
      }
      const sourceChannelId = resolveMattermostCommandChannelId(ctx);
      const sourceRootId = normalizePostId(ctx.messageThreadId);
      const rawDestination = ctx.args?.trim();
      if (!sourceChannelId || !sourceRootId) {
        return {
          text: "Run `/move_thread #channel` from the reply box inside the thread to move.",
          isError: true,
        };
      }
      if (!rawDestination) {
        return { text: "Usage: `/move_thread #target-channel`", isError: true };
      }

      const account = resolveMattermostAccount({ cfg: ctx.config, accountId: ctx.accountId });
      if (!account.enabled || !account.baseUrl?.trim() || !account.botToken?.trim()) {
        return { text: "Mattermost account credentials are unavailable.", isError: true };
      }
      const client = dependencies.createClient({
        baseUrl: account.baseUrl,
        botToken: account.botToken,
        allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
      });
      const fileMaxBytes =
        resolveChannelMediaMaxBytes({
          cfg: ctx.config,
          accountId: account.accountId,
          resolveChannelLimitMb: () => account.config.mediaMaxMb,
        }) ?? DEFAULT_MOVE_FILE_MAX_BYTES;
      try {
        const result = await moveMattermostThread({
          client,
          sourceChannelId,
          sourceRootId,
          rawDestination,
          fileMaxBytes,
          baseUrl: account.baseUrl,
          dependencies,
        });
        for (const warning of result.warnings) {
          api.logger.warn?.(`mattermost move_thread: ${warning}`);
        }
        return { suppressReply: true };
      } catch (error) {
        return {
          text: `❌ Thread move failed; the source was preserved. ${errorMessage(error)}`,
          isError: true,
        };
      }
    },
  };
}

export function registerMattermostMoveThreadCommand(api: OpenClawPluginApi): void {
  api.registerCommand(createMattermostMoveThreadCommand(api));
}
