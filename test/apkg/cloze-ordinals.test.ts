// Card-row count and `ord` assignment per note -- docs/research/apkg-format.md
// §7, "the load-bearing rule": one card per DISTINCT cloze number found
// across the note's fields, at `ord = number - 1`, gaps preserved (never
// compacted). This is where a subtle bug silently loses or misnumbers whole
// cards, so every expected {ords, due} pair below is HAND-COUNTED from the
// cloze syntax and hard-coded -- nothing here is computed by any shared
// cloze-parsing code that an implementation could also get wrong in the same
// way. The single-cloze/contiguous/repeated/non-contiguous/cloze-in-Extra
// cases are original to this file; the HTML-wrapped, repeated-c2, and both
// image shapes reuse the actual Text of ref-03/ref-05/ref-06/ref-07 straight
// from test/fixtures/reference-cards.json (read at run time, not retyped) so
// this suite is exercised against the same canonical cards the rest of the
// pipeline is held to.
//
// The cloze grammar exercised here -- {{cN::body}}, a single numeral,
// body running to the first literal "}}" -- is independently confirmed as
// the intended dialect by tools/check_deck.py's own regex:
//   CLOZE = re.compile(r"\{\{c(\d+)::((?:(?!\}\})[\s\S])*)\}\}")
// No comma-separated ordinals, no nesting -- neither appears anywhere in
// this pipeline's authoring rules, per the doc's own scope note.
//
// `due` is independently verified from source, not from any assumption
// shared with an implementation: apkg-format.md §7 cites
// rslib/src/notetype/cardgen.rs's `due_for_deck`, which fetches and advances
// a single collection-wide counter ONCE PER NOTE (cached across that note's
// own cards), starting wherever the writer chooses -- "for a from-scratch
// file 1 is fine" (§7/§5a). With 9 notes processed in array order, due must
// therefore run 1..9 regardless of how many cards each note produces or
// which clock is injected -- unlike ids/mod columns, this is not
// clock-derived at all, so it is asserted as an exact expected value with no
// caveats.
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

const DECK_NAME = 'Fixtures::Cloze Ordinals';
const FIELD_SEP = '\x1f';
const EXPECTED_MOD_SECONDS = Math.floor(FIXED_CLOCK_MS / 1000);

function loadSharedText(index: number): string {
  const fixturePath = join(import.meta.dirname, '..', 'fixtures', 'reference-cards.json');
  const { notes } = JSON.parse(readFileSync(fixturePath, 'utf8')) as { notes: DeckNote[] };
  return notes[index].fields.Text;
}

interface Case {
  label: string;
  text: string;
  extra?: string;
  expectedOrds: number[];
}

const CASES: Case[] = [
  {
    label: 'single',
    text: '{{c1::Paris}} is the capital of France.',
    expectedOrds: [0],
  },
  {
    label: 'contiguous-c1-c2',
    text: '{{c1::Paris}} is the capital of {{c2::France}}.',
    expectedOrds: [0, 1],
  },
  {
    label: 'repeated-c1',
    // Two deletions, same ordinal -- one card, not two.
    text: '{{c1::Paris}} and {{c1::Lyon}} are both cities in {{c1::France}}.',
    expectedOrds: [0],
  },
  {
    label: 'non-contiguous-c1-c3',
    // c2 is skipped entirely -- the ord for c3 stays 2, it does not compact to 1.
    text: '{{c1::Paris}} is farther from {{c3::Berlin}} than most people expect.',
    expectedOrds: [0, 2],
  },
  {
    label: 'html-wrapped-c1-c2-c3', // ref-03, verbatim
    text: loadSharedText(2),
    expectedOrds: [0, 1, 2],
  },
  {
    label: 'repeated-c2-single-c1', // ref-05, verbatim: c2 appears five times, c1 once
    text: loadSharedText(4),
    expectedOrds: [0, 1],
  },
  {
    label: 'image-in-cloze', // ref-06, verbatim
    text: loadSharedText(5),
    expectedOrds: [0, 1],
  },
  {
    label: 'image-outside-cloze', // ref-07, verbatim
    text: loadSharedText(6),
    expectedOrds: [0],
  },
  {
    label: 'cloze-in-extra-field',
    // cardgen.rs's cloze_number_in_fields scans every field of the note, not
    // just the one the template renders -- a cloze sitting in Extra still
    // generates a real card. apkg-format.md §7 cites this exact source path;
    // independently confirmed by ankitects/anki's own cardgen.rs contract as
    // quoted there, not merely inferred.
    text: '{{c1::Tokyo}} is the capital of Japan.',
    extra: 'See also {{c2::Osaka}}, a nearby city.',
    expectedOrds: [0, 1],
  },
];

interface CardRow {
  id: number;
  nid: number;
  did: number;
  ord: number;
  mod: number;
  usn: number;
  type: number;
  queue: number;
  due: number;
  ivl: number;
  factor: number;
  reps: number;
  lapses: number;
  left: number;
  odue: number;
  odid: number;
  flags: number;
  data: string;
}

async function buildCases() {
  const notes: DeckNote[] = CASES.map((c) =>
    makeNote(c.text, { deckName: DECK_NAME, extra: c.extra, source: `case:${c.label}` }),
  );

  const tempDir = makeTempDir('cloze-ordinals');
  const outPath = join(tempDir, 'out.apkg');
  const mediaDir = makeEmptyMediaDir(tempDir);
  await writeApkg(notes, { deckName: DECK_NAME, outPath, mediaDir, clock: fixedClock });

  const dbPath = extractZipMember(outPath, 'collection.anki21', tempDir);
  const db = openCollection(dbPath);
  const noteRows = db.prepare('SELECT id, flds FROM notes').all() as { id: number; flds: string }[];
  const cardRows = db.prepare('SELECT * FROM cards').all() as unknown as CardRow[];
  const decks = JSON.parse((db.prepare('SELECT decks FROM col').get() as { decks: string }).decks) as Record<
    string,
    Record<string, unknown>
  >;
  db.close();

  const nidBySource = new Map<string, number>();
  for (const row of noteRows) {
    const source = row.flds.split(FIELD_SEP)[2];
    nidBySource.set(source, row.id);
  }

  const cardsByLabel = new Map<string, CardRow[]>();
  for (const c of CASES) {
    const nid = nidBySource.get(`case:${c.label}`);
    assert.ok(nid !== undefined, `no note produced for case "${c.label}"`);
    const cards = cardRows.filter((card) => card.nid === nid).sort((a, b) => a.ord - b.ord);
    cardsByLabel.set(c.label, cards);
  }

  const nonDefaultDeckIds = Object.keys(decks)
    .filter((k) => k !== '1')
    .map((k) => decks[k].id as number);

  return { cardsByLabel, cardRows, nonDefaultDeckIds };
}

test('cloze-ordinals: card count and ord set match the hand-counted table for every case', async () => {
  const { cardsByLabel } = await buildCases();
  for (const c of CASES) {
    const cards = cardsByLabel.get(c.label)!;
    assert.equal(cards.length, c.expectedOrds.length, `case "${c.label}": expected ${c.expectedOrds.length} card(s)`);
    assert.deepEqual(
      cards.map((card) => card.ord),
      c.expectedOrds,
      `case "${c.label}": ord set must be exactly [${c.expectedOrds.join(', ')}], gaps preserved`,
    );
  }
});

test('cloze-ordinals: due is shared by every card from the same note, and increments by exactly 1 per note in input order', async () => {
  const { cardsByLabel } = await buildCases();
  CASES.forEach((c, i) => {
    const cards = cardsByLabel.get(c.label)!;
    const expectedDue = i + 1; // counter starts at 1, advances once per note (§7)
    for (const card of cards) {
      assert.equal(card.due, expectedDue, `case "${c.label}": all of this note's cards must share due=${expectedDue}`);
    }
  });
});

test('cloze-ordinals: every card is a brand-new, never-reviewed row with the fixed schema-11 constants', async () => {
  const { cardRows, nonDefaultDeckIds } = await buildCases();
  assert.ok(cardRows.length >= CASES.reduce((sum, c) => sum + c.expectedOrds.length, 0));
  assert.equal(nonDefaultDeckIds.length, 1, 'single-deck export');
  const [deckId] = nonDefaultDeckIds;

  for (const card of cardRows) {
    assert.equal(card.type, 0, 'type=0 (new)');
    assert.equal(card.queue, 0, 'queue=0 (new)');
    assert.equal(card.ivl, 0);
    assert.equal(card.factor, 0);
    assert.equal(card.reps, 0);
    assert.equal(card.lapses, 0);
    assert.equal(card.left, 0);
    assert.equal(card.odue, 0);
    assert.equal(card.odid, 0);
    assert.equal(card.flags, 0);
    assert.equal(card.data, '{}', 'cards.data is "{}" for a fresh card, not the empty string');
    assert.equal(card.usn, -1);
    assert.equal(card.mod, EXPECTED_MOD_SECONDS);
    assert.equal(card.did, deckId, 'every card belongs to this export\'s one deck');
  }

  const ids = cardRows.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'card ids must be unique within the file');
});
