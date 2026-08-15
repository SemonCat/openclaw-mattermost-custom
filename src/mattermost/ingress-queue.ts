// Mattermost custom owns a SQLite ingress spool because beta.2 restricts the
// host channel-ingress queue to bundled and trusted-official plugins.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementResultingChanges } from "node:sqlite";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";

type Queue<TPayload, TMetadata, TCompletedMetadata> = ChannelIngressQueue<
  TPayload,
  TMetadata,
  TCompletedMetadata
>;
type QueueRecord<TPayload, TMetadata> = Awaited<
  ReturnType<Queue<TPayload, TMetadata, unknown>["listPending"]>
>[number];
type QueueClaim<TPayload, TMetadata> = Awaited<
  ReturnType<Queue<TPayload, TMetadata, unknown>["listClaims"]>
>[number];

type StoredRow = {
  event_id: string;
  status: "pending" | "claimed" | "completed" | "failed";
  lane_key: string | null;
  payload_json: string;
  metadata_json: string | null;
  received_at: number;
  updated_at: number;
  attempts: number;
  last_attempt_at: number | null;
  last_error: string | null;
  claim_token: string | null;
  claim_owner: string | null;
  claimed_at: number | null;
  completed_at: number | null;
  completed_metadata_json: string | null;
  failed_at: number | null;
  failed_reason: string | null;
};

const CHANNEL_ID = "mattermost";
const QUEUE_DIR = "mattermost-custom";
const QUEUE_FILE = "ingress.sqlite";

function positiveLimit(value: number | "all" | undefined, fallback = 100): number {
  return value === "all" ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.floor(value ?? fallback));
}

function idFrom(value: string | { id: string }): string {
  const id = (typeof value === "string" ? value : value.id).trim();
  if (!id) {
    throw new Error("Mattermost ingress event id cannot be empty");
  }
  return id;
}

function tokenFrom(value: string | { id: string; claim?: { token: string } }): string | null {
  return typeof value === "string" ? null : (value.claim?.token ?? null);
}

function changed(result: StatementResultingChanges): boolean {
  return Number(result.changes) > 0;
}

function parseOptionalJson<T>(value: string | null): T | undefined {
  return value === null ? undefined : (JSON.parse(value) as T);
}

export function createMattermostIngressQueue<
  TPayload,
  TMetadata = unknown,
  TCompletedMetadata = unknown,
>(options: {
  accountId: string;
  stateDir: string;
  now?: () => number;
}): Queue<TPayload, TMetadata, TCompletedMetadata> {
  const accountId = options.accountId.trim() || "default";
  const queueName = JSON.stringify(["mattermost-custom", accountId]);
  const now = options.now ?? Date.now;
  const queueDir = path.join(options.stateDir, QUEUE_DIR);
  const databasePath = path.join(queueDir, QUEUE_FILE);
  mkdirSync(queueDir, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(databasePath);
  try {
    chmodSync(databasePath, 0o600);
  } catch {
    // The database remains usable on filesystems without POSIX permissions.
  }
  database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS ingress_events (
      account_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'completed', 'failed')),
      lane_key TEXT,
      payload_json TEXT NOT NULL,
      metadata_json TEXT,
      received_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER,
      last_error TEXT,
      claim_token TEXT,
      claim_owner TEXT,
      claimed_at INTEGER,
      completed_at INTEGER,
      completed_metadata_json TEXT,
      failed_at INTEGER,
      failed_reason TEXT,
      PRIMARY KEY (account_id, event_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS ingress_events_pending
      ON ingress_events (account_id, status, received_at, event_id);
    CREATE INDEX IF NOT EXISTS ingress_events_claimed
      ON ingress_events (account_id, status, claimed_at);
  `);

  const selectRow = (id: string): StoredRow | undefined =>
    database
      .prepare("SELECT * FROM ingress_events WHERE account_id = ? AND event_id = ?")
      .get(accountId, id) as StoredRow | undefined;

  const baseRecord = (row: StoredRow): QueueRecord<TPayload, TMetadata> => ({
    id: row.event_id,
    channelId: CHANNEL_ID,
    accountId,
    queueName,
    payload: JSON.parse(row.payload_json) as TPayload,
    ...(row.metadata_json === null
      ? {}
      : { metadata: JSON.parse(row.metadata_json) as TMetadata }),
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
    ...(row.lane_key === null ? {} : { laneKey: row.lane_key }),
    attempts: row.attempts,
    ...(row.last_attempt_at === null ? {} : { lastAttemptAt: row.last_attempt_at }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  });

  const claimRecord = (row: StoredRow): QueueClaim<TPayload, TMetadata> => ({
    ...baseRecord(row),
    claim: {
      token: row.claim_token ?? "",
      ownerId: row.claim_owner ?? "",
      claimedAt: row.claimed_at ?? 0,
    },
  });

  const duplicateResult = (row: StoredRow) => {
    if (row.status === "pending") {
      return { kind: "pending" as const, duplicate: true as const, record: baseRecord(row) };
    }
    if (row.status === "claimed") {
      return { kind: "claimed" as const, duplicate: true as const, record: claimRecord(row) };
    }
    if (row.status === "completed") {
      return {
        kind: "completed" as const,
        duplicate: true as const,
        record: {
          id: row.event_id,
          channelId: CHANNEL_ID,
          accountId,
          queueName,
          completedAt: row.completed_at ?? row.updated_at,
          ...(row.completed_metadata_json === null
            ? {}
            : { metadata: JSON.parse(row.completed_metadata_json) as TCompletedMetadata }),
        },
      };
    }
    return {
      kind: "failed" as const,
      duplicate: true as const,
      record: {
        id: row.event_id,
        channelId: CHANNEL_ID,
        accountId,
        queueName,
        failedAt: row.failed_at ?? row.updated_at,
        reason: row.failed_reason ?? "failed",
        ...(row.last_error === null ? {} : { message: row.last_error }),
      },
    };
  };

  const withTransaction = <T>(work: () => T): T => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const queue: Queue<TPayload, TMetadata, TCompletedMetadata> = {
    enqueue: async (id, payload, enqueueOptions) => {
      const eventId = idFrom(id);
      const receivedAt = enqueueOptions?.receivedAt ?? now();
      return withTransaction(() => {
        const result = database
          .prepare(`
            INSERT OR IGNORE INTO ingress_events (
              account_id, event_id, status, lane_key, payload_json, metadata_json,
              received_at, updated_at, attempts
            ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, 0)
          `)
          .run(
            accountId,
            eventId,
            enqueueOptions?.laneKey ?? null,
            JSON.stringify(payload),
            enqueueOptions?.metadata === undefined ? null : JSON.stringify(enqueueOptions.metadata),
            receivedAt,
            now(),
          );
        const row = selectRow(eventId);
        if (!row) {
          throw new Error(`Failed to persist Mattermost ingress event ${eventId}`);
        }
        return changed(result)
          ? { kind: "accepted" as const, duplicate: false as const, record: baseRecord(row) }
          : duplicateResult(row);
      });
    },

    listPending: async (listOptions) => {
      const order = listOptions?.orderBy === "id" ? "event_id" : "received_at, event_id";
      return (
        database
          .prepare(
            `SELECT * FROM ingress_events WHERE account_id = ? AND status = 'pending' ORDER BY ${order} LIMIT ?`,
          )
          .all(accountId, positiveLimit(listOptions?.limit)) as StoredRow[]
      ).map(baseRecord);
    },

    listClaims: async () =>
      (
        database
          .prepare(
            "SELECT * FROM ingress_events WHERE account_id = ? AND status = 'claimed' ORDER BY claimed_at, received_at, event_id",
          )
          .all(accountId) as StoredRow[]
      ).map(claimRecord),

    listFailed: async (listOptions) =>
      (
        database
          .prepare(
            "SELECT * FROM ingress_events WHERE account_id = ? AND status = 'failed' ORDER BY failed_at, event_id LIMIT ?",
          )
          .all(accountId, positiveLimit(listOptions?.limit)) as StoredRow[]
      ).map((row) => ({
        ...baseRecord(row),
        failedAt: row.failed_at ?? row.updated_at,
        reason: row.failed_reason ?? "failed",
        ...(row.last_error === null ? {} : { message: row.last_error }),
      })),

    claimNext: async (claimOptions) => {
      if (claimOptions?.staleMs !== undefined) {
        await queue.recoverStaleClaims({ staleMs: claimOptions.staleMs });
      }
      const blocked = new Set(claimOptions?.blockedLaneKeys ?? []);
      const candidates =
        claimOptions?.candidateIds === undefined ? undefined : new Set(claimOptions.candidateIds);
      const order = claimOptions?.orderBy === "id" ? "event_id" : "received_at, event_id";
      return withTransaction(() => {
        const rows = database
          .prepare(
            `SELECT * FROM ingress_events WHERE account_id = ? AND status = 'pending' ORDER BY ${order} LIMIT ?`,
          )
          .all(accountId, positiveLimit(claimOptions?.scanLimit)) as StoredRow[];
        const selected = rows.find((row) => {
          if (candidates && !candidates.has(row.event_id)) {
            return false;
          }
          const record = baseRecord(row);
          let laneKey = record.laneKey ?? claimOptions?.deriveLaneKey?.(record);
          if (record.laneKey && claimOptions?.deriveLaneKey && claimOptions.reconcileStoredLaneKey) {
            const derived = claimOptions.deriveLaneKey(record);
            if (
              derived &&
              derived !== record.laneKey &&
              claimOptions.reconcileStoredLaneKey(record, record.laneKey, derived)
            ) {
              laneKey = derived;
            }
          }
          return !laneKey || !blocked.has(laneKey);
        });
        if (!selected) {
          return null;
        }
        const transitionAt = now();
        const token = randomUUID();
        const ownerId = claimOptions?.ownerId?.trim() || `${process.pid}`;
        const record = baseRecord(selected);
        const derivedLane = record.laneKey ?? claimOptions?.deriveLaneKey?.(record) ?? null;
        const updated = database
          .prepare(`
            UPDATE ingress_events
            SET status = 'claimed', claim_token = ?, claim_owner = ?, claimed_at = ?,
                lane_key = COALESCE(?, lane_key), updated_at = ?
            WHERE account_id = ? AND event_id = ? AND status = 'pending'
          `)
          .run(token, ownerId, transitionAt, derivedLane, transitionAt, accountId, selected.event_id);
        const row = selectRow(selected.event_id);
        return changed(updated) && row ? claimRecord(row) : null;
      });
    },

    claim: async (id, claimOptions) => {
      const eventId = idFrom(id);
      return withTransaction(() => {
        const transitionAt = now();
        const token = randomUUID();
        const ownerId = claimOptions?.ownerId?.trim() || `${process.pid}`;
        const updated = database
          .prepare(`
            UPDATE ingress_events
            SET status = 'claimed', claim_token = ?, claim_owner = ?, claimed_at = ?, updated_at = ?
            WHERE account_id = ? AND event_id = ? AND status = 'pending'
          `)
          .run(token, ownerId, transitionAt, transitionAt, accountId, eventId);
        const row = selectRow(eventId);
        return changed(updated) && row ? claimRecord(row) : null;
      });
    },

    refreshClaim: async (claim, refreshOptions) =>
      changed(
        database
          .prepare(`
            UPDATE ingress_events SET claimed_at = ?, updated_at = ?
            WHERE account_id = ? AND event_id = ? AND status = 'claimed' AND claim_token = ?
          `)
          .run(
            refreshOptions?.refreshedAt ?? now(),
            refreshOptions?.refreshedAt ?? now(),
            accountId,
            claim.id,
            claim.claim.token,
          ),
      ),

    complete: async (idOrClaim, completeOptions) => {
      const eventId = idFrom(idOrClaim);
      const token = tokenFrom(idOrClaim);
      const completedAt = completeOptions?.completedAt ?? now();
      const statement = database.prepare(`
        UPDATE ingress_events
        SET status = 'completed', completed_at = ?, completed_metadata_json = ?,
            payload_json = 'null', metadata_json = NULL, claim_token = NULL,
            claim_owner = NULL, claimed_at = NULL, last_attempt_at = NULL,
            last_error = NULL, updated_at = ?
        WHERE account_id = ? AND event_id = ? AND status = ?
          AND (? IS NULL OR claim_token = ?)
      `);
      return changed(
        statement.run(
          completedAt,
          completeOptions?.metadata === undefined ? null : JSON.stringify(completeOptions.metadata),
          completedAt,
          accountId,
          eventId,
          token === null ? "pending" : "claimed",
          token,
          token,
        ),
      );
    },

    release: async (idOrClaim, releaseOptions) => {
      const eventId = idFrom(idOrClaim);
      const token = tokenFrom(idOrClaim);
      const releasedAt = releaseOptions?.releasedAt ?? now();
      return changed(
        database
          .prepare(`
            UPDATE ingress_events
            SET status = 'pending', claim_token = NULL, claim_owner = NULL, claimed_at = NULL,
                attempts = attempts + ?, last_attempt_at = CASE WHEN ? = 1 THEN ? ELSE last_attempt_at END,
                last_error = COALESCE(?, last_error), updated_at = ?
            WHERE account_id = ? AND event_id = ? AND status = ?
              AND (? IS NULL OR claim_token = ?)
          `)
          .run(
            releaseOptions?.recordAttempt === false ? 0 : 1,
            releaseOptions?.recordAttempt === false ? 0 : 1,
            releasedAt,
            releaseOptions?.lastError ?? null,
            releasedAt,
            accountId,
            eventId,
            token === null ? "pending" : "claimed",
            token,
            token,
          ),
      );
    },

    fail: async (idOrClaim, failOptions) => {
      const eventId = idFrom(idOrClaim);
      const token = tokenFrom(idOrClaim);
      const failedAt = failOptions.failedAt ?? now();
      return changed(
        database
          .prepare(`
            UPDATE ingress_events
            SET status = 'failed', failed_at = ?, failed_reason = ?, last_error = ?,
                claim_token = NULL, claim_owner = NULL, claimed_at = NULL, updated_at = ?
            WHERE account_id = ? AND event_id = ? AND status = ?
              AND (? IS NULL OR claim_token = ?)
          `)
          .run(
            failedAt,
            failOptions.reason,
            failOptions.message ?? null,
            failedAt,
            accountId,
            eventId,
            token === null ? "pending" : "claimed",
            token,
            token,
          ),
      );
    },

    delete: async (idOrClaim) => {
      const eventId = idFrom(idOrClaim);
      const token = tokenFrom(idOrClaim);
      return changed(
        database
          .prepare(`
            DELETE FROM ingress_events
            WHERE account_id = ? AND event_id = ? AND status = ?
              AND (? IS NULL OR claim_token = ?)
          `)
          .run(accountId, eventId, token === null ? "pending" : "claimed", token, token),
      );
    },

    recoverStaleClaims: async (recoverOptions) => {
      const current = recoverOptions?.now ?? now();
      const cutoff = current - Math.max(0, Math.floor(recoverOptions?.staleMs ?? 0));
      const rows = database
        .prepare(
          "SELECT * FROM ingress_events WHERE account_id = ? AND status = 'claimed' AND claimed_at <= ?",
        )
        .all(accountId, cutoff) as StoredRow[];
      let recovered = 0;
      for (const row of rows) {
        const claim = claimRecord(row);
        if (recoverOptions?.shouldRecover && !(await recoverOptions.shouldRecover(claim))) {
          continue;
        }
        const released = database
          .prepare(`
            UPDATE ingress_events
            SET status = 'pending', claim_token = NULL, claim_owner = NULL, claimed_at = NULL,
                attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
            WHERE account_id = ? AND event_id = ? AND status = 'claimed'
              AND claim_token = ? AND claimed_at <= ?
          `)
          .run(current, current, accountId, row.event_id, claim.claim.token, cutoff);
        if (changed(released)) {
          recovered += 1;
        }
      }
      return recovered;
    },

    prune: async (pruneOptions) => {
      const current = pruneOptions?.now ?? now();
      const protectedIds = new Set(pruneOptions?.protectIds ?? []);
      let deleted = 0;
      const ttlByStatus = {
        pending: pruneOptions?.pendingTtlMs,
        completed: pruneOptions?.completedTtlMs,
        failed: pruneOptions?.failedTtlMs,
      } as const;
      const maxByStatus = {
        pending: pruneOptions?.pendingMaxEntries,
        completed: pruneOptions?.completedMaxEntries,
        failed: pruneOptions?.failedMaxEntries,
      } as const;
      for (const status of ["pending", "completed", "failed"] as const) {
        const rows = database
          .prepare(
            "SELECT event_id, updated_at FROM ingress_events WHERE account_id = ? AND status = ? ORDER BY updated_at DESC, event_id DESC",
          )
          .all(accountId, status) as Array<{ event_id: string; updated_at: number }>;
        const ttl = ttlByStatus[status];
        const maxEntries = maxByStatus[status];
        const remove = rows.filter(
          (row, index) =>
            !protectedIds.has(row.event_id) &&
            ((ttl !== undefined && row.updated_at < current - ttl) ||
              (maxEntries !== undefined && index >= Math.max(0, Math.floor(maxEntries)))),
        );
        for (const row of remove) {
          deleted += Number(
            database
              .prepare(
                "DELETE FROM ingress_events WHERE account_id = ? AND event_id = ? AND status = ?",
              )
              .run(accountId, row.event_id, status).changes,
          );
        }
      }
      return deleted;
    },
  };

  return queue;
}
