namespace OpenClawStreamState {
    export const POST_TYPE = 'custom_openclaw_stream';
    export const PROTOCOL_VERSION = 1;
    export const MAX_TEXT_UNITS = 262144;
    const MAX_SNAPSHOTS = 256;

    export interface Snapshot {
        post_id: string;
        channel_id: string;
        root_id: string;
        generation: string;
        seq: number;
        message: string;
        closed: boolean;
        updated_at: number;
        expires_at: number;
    }

    export interface PostLike {
        id: string;
        channel_id: string;
        root_id?: string | null;
        type: string;
        update_at?: number;
        message?: string;
        props?: Record<string, unknown>;
    }

    function isRecord(value: unknown): value is Record<string, unknown> {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    export function parseSnapshot(value: unknown): Snapshot | null {
        if (!isRecord(value)) {
            return null;
        }
        const snapshot = value as unknown as Snapshot;
        if (
            typeof snapshot.post_id !== 'string' ||
            typeof snapshot.channel_id !== 'string' ||
            typeof snapshot.root_id !== 'string' ||
            typeof snapshot.generation !== 'string' ||
            !Number.isSafeInteger(snapshot.seq) ||
            snapshot.seq <= 0 ||
            typeof snapshot.message !== 'string' ||
            snapshot.message.length > MAX_TEXT_UNITS ||
            typeof snapshot.closed !== 'boolean' ||
            !Number.isSafeInteger(snapshot.updated_at) ||
            !Number.isSafeInteger(snapshot.expires_at)
        ) {
            return null;
        }
        return snapshot;
    }

    export function snapshotForPost(post: PostLike, value: unknown, now = Date.now()): Snapshot | null {
        const snapshot = parseSnapshot(value);
        if (!snapshot || snapshot.closed || snapshot.expires_at <= now) {
            return null;
        }

        const mattermost = post.props?.openclaw_mattermost;
        const stream = post.props?.openclaw_stream;
        if (!isRecord(mattermost) || !isRecord(stream)) {
            return null;
        }
        if (
            post.type !== POST_TYPE ||
            mattermost.version !== PROTOCOL_VERSION ||
            mattermost.kind !== 'turn_result' ||
            mattermost.channelId !== post.channel_id ||
            stream.version !== PROTOCOL_VERSION ||
            snapshot.post_id !== post.id ||
            snapshot.channel_id !== post.channel_id ||
            snapshot.root_id !== (post.root_id || '') ||
            snapshot.generation !== stream.generation ||
            snapshot.updated_at < (post.update_at || 0)
        ) {
            return null;
        }
        return snapshot;
    }

    export function messageForPost(
        post: PostLike,
        snapshot: unknown,
        persistedPost?: PostLike | null,
        now = Date.now(),
    ): string {
        const effectivePost = persistedPost?.id === post.id &&
            (persistedPost.update_at || 0) >= (post.update_at || 0) ?
            persistedPost :
            post;
        const persistedMessage = typeof effectivePost.message === 'string' ?
            effectivePost.message :
            post.message || '';
        return snapshotForPost(effectivePost, snapshot, now)?.message ?? persistedMessage;
    }

    export class EventStore {
        private readonly snapshots = new Map<string, Snapshot>();
        private readonly listeners = new Map<string, Set<() => void>>();
        private readonly refreshers = new Set<() => void>();

        publish(value: unknown, now = Date.now()): boolean {
            this.pruneExpired(now);
            const next = parseSnapshot(value);
            if (!next || next.expires_at <= now) {
                return false;
            }
            const previous = this.snapshots.get(next.post_id);
            if (previous) {
                if (next.generation === previous.generation) {
                    if (previous.closed) {
                        return next.seq === previous.seq && sameSnapshot(previous, next);
                    }
                    if (next.seq < previous.seq || next.updated_at < previous.updated_at) {
                        return false;
                    }
                    if (next.seq === previous.seq) {
                        return sameSnapshot(previous, next);
                    }
                } else if (next.updated_at < previous.updated_at) {
                    return false;
                }
            }
            if (!previous) {
                this.makeRoom();
            } else {
                this.snapshots.delete(next.post_id);
            }
            this.snapshots.set(next.post_id, next);
            this.notify(next.post_id);
            return true;
        }

        get(postID: string, now = Date.now()): Snapshot | null {
            const snapshot = this.snapshots.get(postID);
            if (!snapshot) {
                return null;
            }
            if (snapshot.expires_at <= now) {
                this.snapshots.delete(postID);
                this.notify(postID);
                return null;
            }
            return snapshot;
        }

        forget(postID: string): void {
            if (this.snapshots.delete(postID)) {
                this.notify(postID);
            }
        }

        subscribe(postID: string, listener: () => void): () => void {
            let listeners = this.listeners.get(postID);
            if (!listeners) {
                listeners = new Set();
                this.listeners.set(postID, listeners);
            }
            listeners.add(listener);
            return () => {
                listeners?.delete(listener);
                if (listeners?.size === 0) {
                    this.listeners.delete(postID);
                }
            };
        }

        registerRefresh(refresh: () => void): () => void {
            this.refreshers.add(refresh);
            return () => this.refreshers.delete(refresh);
        }

        refreshAll(): void {
            for (const refresh of this.refreshers) {
                refresh();
            }
        }

        private notify(postID: string): void {
            for (const listener of this.listeners.get(postID) || []) {
                listener();
            }
        }

        private pruneExpired(now: number): void {
            for (const [postID, snapshot] of this.snapshots) {
                if (snapshot.expires_at <= now) {
                    this.snapshots.delete(postID);
                    this.notify(postID);
                }
            }
        }

        private makeRoom(): void {
            while (this.snapshots.size >= MAX_SNAPSHOTS) {
                const oldestPostID = this.snapshots.keys().next().value as string | undefined;
                if (oldestPostID === undefined) {
                    return;
                }
                this.snapshots.delete(oldestPostID);
                this.notify(oldestPostID);
            }
        }
    }

    function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
        return a.post_id === b.post_id &&
            a.channel_id === b.channel_id &&
            a.root_id === b.root_id &&
            a.generation === b.generation &&
            a.seq === b.seq &&
            a.message === b.message &&
            a.closed === b.closed &&
            a.updated_at === b.updated_at &&
            a.expires_at === b.expires_at;
    }
}
