const heading = /^#### Task progress · (In progress|Completed|Incomplete|Failed|Cancelled)(?=\n|$)/u;

// Server consumption hooks project task bodies for the official mobile renderer.
// Internal history and recovery must still see the authoritative full checklist.
export function restoreMattermostTaskMessage<T extends {
  message?: string | null;
  type?: string | null;
  channel_id?: string | null;
  root_id?: string | null;
  user_id?: string | null;
  props?: Record<string, unknown> | null;
}>(post: T, botUserId: string): T {
  const work = post.props?.openclaw_work_details as Record<string, unknown> | undefined;
  const projection = post.props?.openclaw_work_projection as Record<string, unknown> | undefined;
  const workIdentity = post.props?.openclaw_mattermost as Record<string, unknown> | undefined;
  if (botUserId && post.user_id === botUserId &&
      ["custom_openclaw_work", "custom_openclaw_stream"].includes(post.type ?? "") &&
      workIdentity?.version === 1 && workIdentity.kind === "turn_result" &&
      workIdentity.channelId === post.channel_id &&
      (workIdentity.threadId ?? "") === (post.root_id ?? "") &&
      work?.version === 1 && projection?.version === 1 &&
      typeof work.source_message === "string" && work.source_message.length <= 15_000 &&
      projection.source_message === work.source_message && post.message === "Work details") {
    return { ...post, message: work.source_message };
  }
  const marker = post.props?.openclaw_task_mobile as Record<string, unknown> | undefined;
  const card = post.props?.openclaw_task_progress as Record<string, unknown> | undefined;
  const identity = post.props?.openclaw_mattermost as Record<string, unknown> | undefined;
  const source = marker?.source_message;
  if (!botUserId || post.user_id !== botUserId ||
      post.type !== "custom_openclaw_task" || marker?.version !== 1 ||
      identity?.version !== 1 ||
      (identity.kind !== "task_progress" && identity.kind !== "subagent_progress") ||
      identity.channelId !== post.channel_id ||
      (identity.threadId ?? "") !== (post.root_id ?? "") ||
      card?.version !== 1 || typeof card.source_message !== "string" ||
      typeof source !== "string" || source.length > 65_536 ||
      source.match(heading)?.[0] !== post.message) {
    return post;
  }
  if (source !== card.source_message) {
    const terminal = source.match(heading);
    if (!terminal || terminal[1] === "In progress" ||
        card.source_message.replace(/^#### Task progress · In progress(?=\n|$)/u, terminal[0]) !== source) {
      return post;
    }
  }
  return {...post, message: source};
}
