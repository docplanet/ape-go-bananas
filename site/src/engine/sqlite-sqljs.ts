// The browser half of the engine's SQLite seam (src/apkg/sqlite.ts), over
// sql.js -- SQLite itself compiled to WebAssembly.
//
// Shorter than the Node half, not longer: node:sqlite can only address a
// path, so it writes a scratch file and reads it back; sql.js is already an
// in-memory database and `export()` hands over the finished file bytes
// directly. There is no temp directory to create and nothing to clean up.
//
// The WASM module is passed in already-initialized rather than loaded here,
// because initSqlJs() is async and the engine's writer is deliberately
// synchronous end to end. Loading happens once when the worker starts
// (worker.ts); by the time anything calls buildApkg, this is all sync.

import type { BindParams, Database, SqlJsStatic } from 'sql.js';
import type { OpenSqlite, SqliteDatabase } from '../../../dist/apkg/sqlite.js';

export function sqlJsOpener(SQL: SqlJsStatic): OpenSqlite {
  return (): SqliteDatabase => {
    const db: Database = new SQL.Database();
    let live = true;

    return {
      exec: (sql) => {
        db.run(sql);
      },
      prepare: (sql) => {
        const statement = db.prepare(sql);
        // sql.js's run() binds, steps and resets, so one prepared statement
        // serves every row -- the same shape node:sqlite's does. Nothing
        // frees them here: both export() and close() free every statement
        // the database has registered (verified in sql-wasm-debug.js), so a
        // free() loop of our own would be a second finalize on each.
        return { run: (...params) => void statement.run(params as BindParams) };
      },
      finish: () => {
        // export() does not merely read the database -- it closes and reopens
        // it: free every statement, sqlite3_close_v2, read the file out of the
        // virtual FS, sqlite3_open, and only THEN reassign its own handle. A
        // throw anywhere between the close and that reassignment leaves a
        // stale, already-freed pointer, which Database.close()'s
        // `this.db === null` guard does not catch -- so a later dispose()
        // would close freed memory.
        //
        // Marking the handle spent before the call makes that dispose() a
        // no-op, which is the whole reason this is not written as
        // `const bytes = db.export(); closeOnce();`.
        live = false;
        const bytes = db.export();
        // Reached only when export() completed, so this closes the fresh
        // handle it installed, not the one it already freed.
        db.close();
        return bytes;
      },
      dispose: () => {
        if (!live) return;
        live = false;
        db.close();
      },
    };
  };
}
