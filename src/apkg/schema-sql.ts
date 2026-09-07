// Schema-11 DDL, read verbatim off a real Anki-exported collection.anki21
// (sqlite_master.sql, not the pretty-printed `.schema` CLI output) -- see
// docs/research/apkg-format.md §4. Generated via JSON.stringify from the
// same literal strings test/apkg/schema.test.ts asserts against (itself
// sourced the same way, independently, per that file's own header) so this
// file cannot silently drift from what the test suite checks, and neither
// can be transcribed wrong relative to the other.
//
// executeSchema() below runs these through db.exec() as one script; SQLite
// stores each CREATE statement's source text verbatim in sqlite_master.sql
// (confirmed by hand: round-tripping every one of these exact strings through
// node:sqlite and reading them back reproduces this file's strings exactly,
// including the multi-line comment inside CREATE TABLE notes).

import type { DatabaseSync } from 'node:sqlite';

const CREATE_COL = "CREATE TABLE col (\n  id integer PRIMARY KEY,\n  crt integer NOT NULL,\n  mod integer NOT NULL,\n  scm integer NOT NULL,\n  ver integer NOT NULL,\n  dty integer NOT NULL,\n  usn integer NOT NULL,\n  ls integer NOT NULL,\n  conf text NOT NULL,\n  models text NOT NULL,\n  decks text NOT NULL,\n  dconf text NOT NULL,\n  tags text NOT NULL\n)";
const CREATE_NOTES = "CREATE TABLE notes (\n  id integer PRIMARY KEY,\n  guid text NOT NULL,\n  mid integer NOT NULL,\n  mod integer NOT NULL,\n  usn integer NOT NULL,\n  tags text NOT NULL,\n  flds text NOT NULL,\n  -- The use of type integer for sfld is deliberate, because it means that integer values in this\n  -- field will sort numerically.\n  sfld integer NOT NULL,\n  csum integer NOT NULL,\n  flags integer NOT NULL,\n  data text NOT NULL\n)";
const CREATE_CARDS = "CREATE TABLE cards (\n  id integer PRIMARY KEY,\n  nid integer NOT NULL,\n  did integer NOT NULL,\n  ord integer NOT NULL,\n  mod integer NOT NULL,\n  usn integer NOT NULL,\n  type integer NOT NULL,\n  queue integer NOT NULL,\n  due integer NOT NULL,\n  ivl integer NOT NULL,\n  factor integer NOT NULL,\n  reps integer NOT NULL,\n  lapses integer NOT NULL,\n  left integer NOT NULL,\n  odue integer NOT NULL,\n  odid integer NOT NULL,\n  flags integer NOT NULL,\n  data text NOT NULL\n)";
const CREATE_REVLOG = "CREATE TABLE revlog (\n  id integer PRIMARY KEY,\n  cid integer NOT NULL,\n  usn integer NOT NULL,\n  ease integer NOT NULL,\n  ivl integer NOT NULL,\n  lastIvl integer NOT NULL,\n  factor integer NOT NULL,\n  time integer NOT NULL,\n  type integer NOT NULL\n)";
const CREATE_GRAVES = "CREATE TABLE graves (\n  usn integer NOT NULL,\n  oid integer NOT NULL,\n  type integer NOT NULL\n)";

const CREATE_IX_NOTES_USN = "CREATE INDEX ix_notes_usn ON notes (usn)";
const CREATE_IX_CARDS_USN = "CREATE INDEX ix_cards_usn ON cards (usn)";
const CREATE_IX_REVLOG_USN = "CREATE INDEX ix_revlog_usn ON revlog (usn)";
const CREATE_IX_CARDS_NID = "CREATE INDEX ix_cards_nid ON cards (nid)";
const CREATE_IX_CARDS_SCHED = "CREATE INDEX ix_cards_sched ON cards (did, queue, due)";
const CREATE_IX_REVLOG_CID = "CREATE INDEX ix_revlog_cid ON revlog (cid)";
const CREATE_IX_NOTES_CSUM = "CREATE INDEX ix_notes_csum ON notes (csum)";

const STATEMENTS: readonly string[] = [
  CREATE_COL,
  CREATE_NOTES,
  CREATE_CARDS,
  CREATE_REVLOG,
  CREATE_GRAVES,
  CREATE_IX_NOTES_USN,
  CREATE_IX_CARDS_USN,
  CREATE_IX_REVLOG_USN,
  CREATE_IX_CARDS_NID,
  CREATE_IX_CARDS_SCHED,
  CREATE_IX_REVLOG_CID,
  CREATE_IX_NOTES_CSUM,
];

// One db.exec() call per statement, not one semicolon-joined script --
// keeps each CREATE's exact source text isolated with no risk of a stray
// join character leaking into what sqlite_master.sql records.
export function executeSchema(db: DatabaseSync): void {
  for (const statement of STATEMENTS) {
    db.exec(statement);
  }
}
