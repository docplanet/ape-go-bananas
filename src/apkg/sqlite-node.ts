// The Node half of the SQLite seam (sqlite.ts), over node:sqlite.
//
// Written to a scratch file because node:sqlite has no true
// in-memory-to-bytes path that also yields the final page-aligned file --
// the same reason the writer has always done this. The scratch file and its
// directory are removed by `finish()` or `dispose()`, success or failure, so
// no caller has to remember to.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { OpenSqlite, SqliteDatabase } from './sqlite.js';

export const openNodeSqlite: OpenSqlite = (): SqliteDatabase => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ape-apkg-collection-'));
  const dbPath = join(tempDir, 'collection.anki21');
  const discard = (): void => rmSync(tempDir, { recursive: true, force: true });

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
  } catch (err) {
    // The caller cannot clean up after this: it has no handle to dispose
    // until this function returns. The pre-seam code had the constructor
    // inside the same try/finally that removed the directory, so a failure
    // here (SQLITE_CANTOPEN, EMFILE under fd pressure, a full /tmp) still
    // cleaned up; without this it would orphan one scratch directory per
    // failed export, forever, in a sidecar that outlives many of them.
    discard();
    throw err;
  }

  let open = true;

  // Closing flushes SQLite's own buffers -- the file is only complete on
  // disk afterwards, which is why the read below happens after the close
  // and not before it.
  const closeOnce = (): void => {
    if (!open) return;
    open = false;
    db.close();
  };

  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return { run: (...params) => void statement.run(...params) };
    },
    // Both exits put `discard` in a finally that also covers closeOnce():
    // a throwing db.close() would otherwise skip the removal entirely, which
    // is the same leak by a different route.
    finish: () => {
      try {
        closeOnce();
        const bytes = readFileSync(dbPath);
        // A view rather than a copy: Buffer is a Uint8Array, but a pooled
        // one, so the offset and length both matter.
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      } finally {
        discard();
      }
    },
    dispose: () => {
      try {
        closeOnce();
      } finally {
        discard();
      }
    },
  };
};
