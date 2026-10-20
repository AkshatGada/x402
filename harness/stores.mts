// Shared SQLite stores for two resource-server replicas (not part of any commit).
//
// SqliteChannelStore.update uses the same optimistic algorithm as x402's EVM
// RedisChannelStorage.updateChannel (typescript/packages/mechanisms/evm/src/
// batch-settlement/server/redisStorage.ts): read the record, run the updater,
// write only if the record is unchanged, otherwise re-read and retry.
import { DatabaseSync } from "node:sqlite";
import type { ChannelState, ChannelStore } from "../src/batch-settlement/server/types.ts";
import type {
  BatchOperation,
  BatchOperationStore,
} from "../src/batch-settlement/server/operationStore.ts";

const encode = (value: unknown) =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? { $bigint: v.toString() } : v));
const decode = <T,>(raw: string): T =>
  JSON.parse(raw, (_k, v) =>
    v && typeof v === "object" && typeof v.$bigint === "string" ? BigInt(v.$bigint) : v,
  );

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operations (
      channel_id TEXT NOT NULL, request_id TEXT NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY (channel_id, request_id));
    CREATE TABLE IF NOT EXISTS events (
      at INTEGER NOT NULL, replica TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
  `);
  return db;
}

export class SqliteChannelStore implements ChannelStore {
  conflicts = 0;
  constructor(private readonly db: DatabaseSync) {}

  get(channelId: string): Promise<ChannelState | undefined> {
    const row = this.db.prepare("SELECT json FROM channels WHERE id = ?").get(channelId) as
      | { json: string }
      | undefined;
    return Promise.resolve(row ? decode<ChannelState>(row.json) : undefined);
  }

  list(): Promise<ChannelState[]> {
    const rows = this.db.prepare("SELECT json FROM channels ORDER BY id").all() as {
      json: string;
    }[];
    return Promise.resolve(rows.map(r => decode<ChannelState>(r.json)));
  }

  put(state: ChannelState): Promise<void> {
    this.db
      .prepare("INSERT INTO channels (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json")
      .run(state.channelId, encode(state));
    return Promise.resolve();
  }

  async update(
    channelId: string,
    updater: (current: ChannelState | undefined) => ChannelState | Promise<ChannelState>,
  ): Promise<ChannelState> {
    for (;;) {
      const row = this.db.prepare("SELECT json FROM channels WHERE id = ?").get(channelId) as
        | { json: string }
        | undefined;
      const next = await updater(row ? decode<ChannelState>(row.json) : undefined);
      const nextRaw = encode(next);
      const result = row
        ? this.db
            .prepare("UPDATE channels SET json = ? WHERE id = ? AND json = ?")
            .run(nextRaw, channelId, row.json)
        : this.db
            .prepare("INSERT INTO channels (id, json) VALUES (?, ?) ON CONFLICT(id) DO NOTHING")
            .run(channelId, nextRaw);
      if (Number(result.changes) === 1) return next;
      this.conflicts++;
      await new Promise(r => setTimeout(r, 10));
    }
  }
}

/** Same semantics as MemoryBatchOperationStore, with atomic SQL statements. */
export class SqliteBatchOperationStore implements BatchOperationStore {
  constructor(private readonly db: DatabaseSync) {}

  get(channelId: string, requestId: string): Promise<BatchOperation | undefined> {
    const row = this.db
      .prepare("SELECT json FROM operations WHERE channel_id = ? AND request_id = ?")
      .get(channelId, requestId) as { json: string } | undefined;
    return Promise.resolve(row ? decode<BatchOperation>(row.json) : undefined);
  }

  async reserve(channelId: string, requestId: string, ceiling: bigint) {
    const operation: BatchOperation = { status: "reserved", channelId, requestId, ceiling };
    const inserted = this.db
      .prepare(
        "INSERT INTO operations (channel_id, request_id, json) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      )
      .run(channelId, requestId, encode(operation));
    if (Number(inserted.changes) === 1) return { created: true, operation };
    const existing = (await this.get(channelId, requestId))!;
    if (existing.ceiling !== ceiling) {
      throw new Error("batch operation ceiling changed for a request id");
    }
    return { created: false, operation: existing };
  }

  complete(operation: Extract<BatchOperation, { status: "completed" }>): Promise<void> {
    const reserved = encode({
      status: "reserved",
      channelId: operation.channelId,
      requestId: operation.requestId,
      ceiling: operation.ceiling,
    });
    const result = this.db
      .prepare(
        "UPDATE operations SET json = ? WHERE channel_id = ? AND request_id = ? AND json = ?",
      )
      .run(encode(operation), operation.channelId, operation.requestId, reserved);
    if (Number(result.changes) !== 1) {
      return Promise.reject(new Error("batch operation reservation changed"));
    }
    return Promise.resolve();
  }

  release(): Promise<void> {
    // Tombstone semantics: the reserved record keeps the request id consumed.
    return Promise.resolve();
  }
}

export function logEvent(db: DatabaseSync, replica: string, kind: string, detail: object) {
  db.prepare("INSERT INTO events (at, replica, kind, detail) VALUES (?, ?, ?, ?)").run(
    Date.now(),
    replica,
    kind,
    encode(detail),
  );
}

export { decode, encode };
