// The SQLite seam -- docs/research/apkg-format.md §4.
//
// collection.anki21 is a real SQLite file, and the two runtimes reach one by
// different routes: Node has node:sqlite, which can only write to a path
// (sqlite-node.ts), while a browser has SQLite compiled to WASM, which can
// only work in memory (sqlite-sqljs.ts). This interface is the small shape
// both can present, so collection.ts -- the schema, the rows, every value
// written -- is shared and neither runtime's quirks leak into it.
//
// Narrow on purpose: the writer creates a fresh database, executes DDL,
// inserts rows, and reads the finished file back. It never queries, never
// reopens, never updates. Nothing here is more general than that.

/**
 * Bound parameter types. Deliberately not `bigint`: every id and timestamp
 * this writer binds is a plain `number` (see NoteRow/CardRow in
 * collection.ts), and keeping bigint out means an implementation backed by
 * WASM SQLite needs no BigInt bridging.
 */
export type SqliteParam = number | string | null;

export interface SqliteStatement {
  run(...params: SqliteParam[]): void;
}

export interface SqliteDatabase {
  /** Runs one DDL statement. */
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  /**
   * Finishes the database and returns its complete file bytes, exactly as
   * SQLite would have written them to disk. The database is unusable
   * afterwards and every resource behind it is released -- so this is the
   * success path's only exit, and it cannot leave a scratch file behind.
   */
  finish(): Uint8Array;
  /**
   * Releases the same resources without producing bytes: the failure path.
   * Safe to call after `finish()`, and safe to call twice.
   */
  dispose(): void;
}

/** Opens a fresh, empty database. */
export type OpenSqlite = () => SqliteDatabase;
