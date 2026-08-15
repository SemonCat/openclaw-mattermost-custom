// Coordinates channel-model changes with new Mattermost root-post ingress.

type MattermostChannelModelTransition = {
  targetModel: string;
  settled: Promise<void>;
};

const activeTransitions = new Map<string, MattermostChannelModelTransition>();

function transitionKey(params: { accountId: string; channelId: string }): string {
  return `${params.accountId}:${params.channelId}`;
}

export async function runMattermostChannelModelTransition<T>(
  params: { accountId: string; channelId: string; targetModel: string },
  task: () => Promise<T>,
): Promise<
  | { status: "completed"; value: T }
  | { status: "busy"; targetModel: string }
> {
  const key = transitionKey(params);
  const active = activeTransitions.get(key);
  if (active) {
    return { status: "busy", targetModel: active.targetModel };
  }

  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const transition = { targetModel: params.targetModel, settled };
  activeTransitions.set(key, transition);

  try {
    return { status: "completed", value: await task() };
  } finally {
    if (activeTransitions.get(key) === transition) {
      activeTransitions.delete(key);
    }
    settle();
  }
}

export async function waitForMattermostChannelModelTransition(params: {
  accountId: string;
  channelId: string;
}): Promise<boolean> {
  const active = activeTransitions.get(transitionKey(params));
  if (!active) {
    return false;
  }
  await active.settled;
  return true;
}
