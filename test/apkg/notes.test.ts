// The `notes` table: field separator (0x1F), the tags-space convention,
// `sfld`, and `csum` -- docs/research/apkg-format.md §6.
//
// Every sfld/csum value below is INDEPENDENTLY COMPUTED, not sourced from
// the doc's own worked examples: a fresh Python implementation of
// strip_html_preserving_media_filenames (transcribed from the Rust source
// the doc cites, but written fresh here, not copied from the doc's prose)
// was run over each Text field, then sha1'd. That Python implementation was
// itself validated first against REAL ground truth before being trusted for
// these fixtures: run over a real note pulled live from
// ISF-Week_1-Histology.apkg (nid 1783048246516), it reproduced that note's
// actual stored `sfld` and `csum` columns exactly. The resulting csum values
// here were then cross-checked a second way with the `openssl sha1` CLI (a
// third, independent implementation) -- see the review notes returned
// alongside this suite for the transcript. The one EXCEPTION is the
// zero-tag/"always a lone leading+trailing space" claim, which the doc
// itself flags as not verified against any real zero-tag note (§11) --
// that assertion is doc-sourced only, marked as such below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeApkg } from '../../dist/apkg/index.js';
import type { DeckNote } from '../../dist/types.js';
import {
  FIXED_CLOCK_MS,
  fixedClock,
  makeTempDir,
  makeEmptyMediaDir,
  makeNote,
  extractZipMember,
  openCollection,
} from './helpers.ts';

const DECK_NAME = 'Fixtures::Reference Cards';
const FIELD_SEP = '\x1f';
const EXPECTED_MOD_SECONDS = Math.floor(FIXED_CLOCK_MS / 1000);

function loadSharedNotes(): DeckNote[] {
  const fixturePath = join(import.meta.dirname, '..', 'fixtures', 'reference-cards.json');
  return (JSON.parse(readFileSync(fixturePath, 'utf8')) as { notes: DeckNote[] }).notes;
}

interface NoteRow {
  id: number;
  guid: string;
  mid: number;
  mod: number;
  usn: number;
  tags: string;
  flds: string;
  sfld: string;
  csum: number;
  flags: number;
  data: string;
}

async function buildNotes(notes: DeckNote[]) {
  const tempDir = makeTempDir('notes');
  const outPath = join(tempDir, 'out.apkg');
  const mediaDir = makeEmptyMediaDir(tempDir);
  await writeApkg(notes, { deckName: DECK_NAME, outPath, mediaDir, clock: fixedClock });
  const dbPath = extractZipMember(outPath, 'collection.anki21', tempDir);
  const db = openCollection(dbPath);
  const rows = db.prepare('SELECT * FROM notes ORDER BY id').all() as unknown as NoteRow[];
  const col = db.prepare('SELECT models FROM col').get() as { models: string };
  db.close();
  return { rows, modelIds: Object.keys(JSON.parse(col.models)) };
}

// Index the produced rows by their Source field (the third `flds` slot) so
// each test case can find its own row regardless of row order.
function bySource(rows: NoteRow[]): Map<string, NoteRow> {
  const map = new Map<string, NoteRow>();
  for (const row of rows) {
    const fields = row.flds.split(FIELD_SEP);
    map.set(fields[2], row);
  }
  return map;
}

test('notes: field separator is exactly one 0x1F byte between fields, never a substitute character', async () => {
  const shared = loadSharedNotes();
  const ref01 = shared[0]; // '{{c1::<b>Osteoid</b>::what?}} is {{c2::<i>unmineralized bone matrix</i>::what is it?}}'
  const { rows } = await buildNotes([ref01]);
  assert.equal(rows.length, 1);
  const row = rows[0];

  const expectedFlds = [ref01.fields.Text, ref01.fields.Extra, ref01.fields.Source].join(FIELD_SEP);
  assert.equal(row.flds, expectedFlds);

  const parts = row.flds.split(FIELD_SEP);
  assert.equal(parts.length, 3, 'exactly two separators for a three-field notetype');
  assert.equal(parts[0], ref01.fields.Text);
  assert.equal(parts[1], ref01.fields.Extra);
  assert.equal(parts[2], ref01.fields.Source);

  // Confirm the actual byte, not just that split() on '\x1f' happened to
  // produce three pieces (which a wrong separator could also do if it were
  // absent from the field text by coincidence).
  const sepIndex = ref01.fields.Text.length;
  assert.equal(row.flds.charCodeAt(sepIndex), 0x1f);
});

test('notes: tags column is space-joined with a leading and trailing space', async () => {
  const shared = loadSharedNotes();
  const ref01 = shared[0]; // tags: ["reference", "ref-01"]
  const ref03 = shared[2]; // tags: ["reference", "ref-03"]
  const { rows } = await buildNotes([ref01, ref03]);
  const bySrc = bySource(rows);

  assert.equal(bySrc.get('Slide 1')!.tags, ' reference ref-01 ');
  assert.equal(bySrc.get('Slide 3')!.tags, ' reference ref-03 ');
});

test('notes: tags column for a single tag follows the same join formula', async () => {
  // Same join formula the multi-tag case above exercises (§6: " " + tags.join(" ") + " "),
  // just with one element -- not itself flagged as unverified in the doc.
  const note = makeNote('{{c1::Berlin}} is the capital of Germany.', {
    deckName: DECK_NAME,
    source: 'case:one-tag',
    tags: ['solo'],
  });
  const { rows } = await buildNotes([note]);
  assert.equal(rows[0].tags, ' solo ');
});

test('notes: tags column for zero tags is a lone space, not an empty string (doc-sourced only -- not confirmed against a real zero-tag note, apkg-format.md §11)', async () => {
  const note = makeNote('{{c1::Madrid}} is the capital of Spain.', {
    deckName: DECK_NAME,
    source: 'case:zero-tags',
    tags: [],
  });
  const { rows } = await buildNotes([note]);
  assert.equal(rows[0].tags, ' ');
});

test('notes: sfld and csum are computed from field 0 (Text) with HTML stripped, cloze braces intact', async () => {
  const shared = loadSharedNotes();
  const ref01 = shared[0];
  const ref03 = shared[2];
  const { rows } = await buildNotes([ref01, ref03]);
  const bySrc = bySource(rows);

  const row01 = bySrc.get('Slide 1')!;
  assert.equal(row01.sfld, '{{c1::Osteoid::what?}} is {{c2::unmineralized bone matrix::what is it?}}');
  assert.equal(row01.csum, 2417530761);

  const row03 = bySrc.get('Slide 3')!;
  assert.equal(
    row03.sfld,
    '{{c1::Calcitonin::which hormone?}} acts on bone to {{c2::lower::raise or lower?}} {{c3::blood calcium levels::which levels?}}',
  );
  assert.equal(row03.csum, 3673359700);
});

test('notes: an <img> tag in Text keeps its filename as bare text in sfld/csum (ref-06 shape)', async () => {
  const shared = loadSharedNotes();
  const ref06 = shared[5]; // '{{c1::<img src="slide.jpg">}}<br><br>This is {{c2::<i>compact bone</i>::which tissue?}}'
  const { rows } = await buildNotes([ref06]);
  assert.equal(rows[0].sfld, '{{c1:: slide.jpg }}This is {{c2::compact bone::which tissue?}}');
  assert.equal(rows[0].csum, 1071418515);
});

test('notes: HTML entities decode before hashing (H&amp;E -> H&E)', async () => {
  const note = makeNote('{{c1::<b>H&amp;E stain</b>::what stain?}} is common in histology.', {
    deckName: DECK_NAME,
    source: 'case:entity-decode',
    tags: ['entity-test'],
  });
  const { rows } = await buildNotes([note]);
  assert.equal(rows[0].sfld, '{{c1::H&E stain::what stain?}} is common in histology.');
  assert.equal(rows[0].csum, 1329044297);
  assert.equal(rows[0].tags, ' entity-test ');
});

test('notes: flags is 0 and data is the empty string (not "{}" -- that is cards.data)', async () => {
  const note = makeNote('{{c1::Lisbon}} is the capital of Portugal.', { deckName: DECK_NAME });
  const { rows } = await buildNotes([note]);
  assert.equal(rows[0].flags, 0);
  assert.equal(rows[0].data, '');
});

test('notes: usn is -1 and mod is export time in whole seconds (not milliseconds)', async () => {
  const note = makeNote('{{c1::Rome}} is the capital of Italy.', { deckName: DECK_NAME });
  const { rows } = await buildNotes([note]);
  assert.equal(rows[0].usn, -1);
  assert.equal(rows[0].mod, EXPECTED_MOD_SECONDS);
  assert.notEqual(rows[0].mod, FIXED_CLOCK_MS, 'mod must not be left as raw milliseconds');
});

test('notes: every note shares the one Custom Cloze mid, and ids/guids are unique within the file', async () => {
  const shared = loadSharedNotes();
  const { rows, modelIds } = await buildNotes(shared);
  assert.equal(rows.length, shared.length);

  const mids = new Set(rows.map((r) => r.mid));
  assert.equal(mids.size, 1, 'all notes use the single Custom Cloze notetype');
  assert.ok(modelIds.includes(String([...mids][0])), 'notes.mid must name a real key in col.models');

  const ids = rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'note ids must be unique within the file');
  // Not a hard spec requirement (the doc only requires uniqueness, §8) but
  // the natural, near-certain consequence of any counter-based id
  // assignment processed in input order -- included to catch an
  // accidentally-shuffled write order.
  const sorted = [...ids].sort((a, b) => a - b);
  assert.deepEqual(ids, sorted, 'ids expected to increase in the same order notes were provided');

  const guids = rows.map((r) => r.guid);
  assert.ok(guids.every((g) => typeof g === 'string' && g.length > 0));
  assert.equal(new Set(guids).size, guids.length, 'guids must be unique within the file (doc §6: exact algorithm not required)');
});
