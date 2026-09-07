// The end-to-end proof this repo's three modules actually integrate: the
// seven reference cards, driven through the real `ape` CLI exactly as a
// user would run it -- check (must pass clean) -> render the review HTML
// -> export a .apkg -> reopen that .apkg with tools sharing no code with
// this repo (the system `unzip`, node:sqlite) and check its contents
// against independently hand-derived expectations. Every step spawns
// dist/cli/index.js as a real child process (helpers.ts's runCli); nothing
// here imports checkDeck/renderReview/writeApkg directly.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { extractZipMember, makeReferenceCardsWorkDir, readZipMember, runCli } from './helpers.ts';

// check-deck-contract.md §10.1, cross-checked directly against
// test/checks/reference-cards.test.ts's own "documented distinct cloze
// numbers" test: each reference card's distinct cloze-NUMBER count, one
// card per number (docs/research/apkg-format.md §7's "load-bearing rule").
// Hand-derived from the contract, not from anything this repo computes --
// the same independence test/apkg/cloze-ordinals.test.ts insists on for its
// own expected {ord} sets.
const EXPECTED_CARDS_PER_NOTE = [2, 2, 3, 2, 2, 2, 1]; // ref-01..ref-07
const EXPECTED_TOTAL_CARDS = EXPECTED_CARDS_PER_NOTE.reduce((sum, n) => sum + n, 0); // 14

interface NoteRow {
  flds: string;
}

test('full pipeline: check -> review -> export -> reopen, on the seven reference cards', () => {
  const { dir, deckPath, mediaDir } = makeReferenceCardsWorkDir();

  // 1. check -- real media resolution (not --no-media), so rule 2's
  // existence check is genuinely exercised (and genuinely passes, because
  // slide.jpg is really there), not merely skipped.
  const checked = runCli(['check', deckPath], { cwd: dir, mediaDir });
  assert.equal(checked.stderr, '', `check wrote to stderr unexpectedly:\n${checked.stderr}`);
  assert.equal(checked.status, 0, `check should exit 0 (clean); stdout was:\n${checked.stdout}`);
  assert.match(checked.stdout, /^notes: 7$/m);
  assert.match(checked.stdout, /^clean$/m);
  assert.doesNotMatch(checked.stdout, /PROBLEMS:/);

  // 2. review -- one HTML page, one <article> per note, media resolved
  // against the same ANKI_MEDIA this test controls.
  const reviewPath = join(dir, 'review.html');
  const reviewed = runCli(['review', deckPath, '-o', reviewPath], { cwd: dir, mediaDir });
  assert.equal(reviewed.status, 0, `review should exit 0; stderr was:\n${reviewed.stderr}`);
  assert.equal(reviewed.stdout.trim(), `wrote ${reviewPath} (7 notes)`);
  assert.ok(existsSync(reviewPath), 'review.html was not written');
  const html = readFileSync(reviewPath, 'utf8');
  assert.equal((html.match(/<article>/g) ?? []).length, 7, 'one <article> per note');
  assert.match(html, /Fixtures::Reference Cards/, "deck name (notes[0].deckName) in the page's header");
  assert.match(html, new RegExp(`file://${mediaDir}/slide\\.jpg`), 'media src resolved against the given ANKI_MEDIA');

  // 3. export -- a real .apkg, with slide.jpg's bytes genuinely resolved
  // (mediaDir has the file this time, unlike test/apkg's own unresolved-
  // media cases), so this repo's own "not found"/"packaged without"
  // warnings should be absent. Node's own SQLite ExperimentalWarning
  // (src/apkg/collection.ts uses node:sqlite -- expected on every run on
  // node 24, per this repo's own environment notes) still legitimately
  // lands on the same stream, so this checks for the absence of export.ts's
  // own message rather than an empty stream.
  const apkgPath = join(dir, 'deck.apkg');
  const exported = runCli(['export', deckPath, '-o', apkgPath], { cwd: dir, mediaDir });
  assert.equal(exported.status, 0, `export should exit 0; stderr was:\n${exported.stderr}`);
  assert.equal(exported.stdout.trim(), `wrote ${apkgPath} (7 notes)`);
  assert.doesNotMatch(exported.stderr, /not found|packaged without/, `unresolved-media warning should be absent:\n${exported.stderr}`);
  assert.ok(existsSync(apkgPath), 'deck.apkg was not written');

  // 4. reopen -- independent zip reader, independent SQLite reader, and
  // expectations computed independently of anything writeApkg itself
  // decided.
  const extractDir = join(dir, 'extracted');
  mkdirSync(extractDir);

  const manifest = JSON.parse(readZipMember(apkgPath, 'media').toString('utf8')) as Record<string, string>;
  assert.deepEqual(manifest, { '0': 'slide.jpg' }, 'media manifest names the one referenced file');
  assert.equal(readZipMember(apkgPath, '0').toString('utf8'), 'not-a-real-jpeg-just-fixture-bytes', "member \"0\" is slide.jpg's actual bytes");

  const anki21Path = extractZipMember(apkgPath, 'collection.anki21', extractDir);
  const db = new DatabaseSync(anki21Path, { readOnly: true });
  try {
    const { n: noteCount } = db.prepare('SELECT COUNT(*) AS n FROM notes').get() as { n: number };
    assert.equal(noteCount, 7, 'notes table row count');

    const { n: cardCount } = db.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number };
    assert.equal(cardCount, EXPECTED_TOTAL_CARDS, 'cards table row count (one card per distinct cloze number)');

    const col = db.prepare('SELECT decks, models FROM col').get() as { decks: string; models: string };
    const deckNames = Object.values(JSON.parse(col.decks) as Record<string, { name: string }>).map((d) => d.name);
    assert.ok(deckNames.includes('Fixtures::Reference Cards'), `decks JSON should include the notes' own deckName, got: ${deckNames.join(', ')}`);
    const modelNames = Object.values(JSON.parse(col.models) as Record<string, { name: string }>).map((m) => m.name);
    assert.deepEqual(modelNames, ['Custom Cloze'], 'exactly one notetype, the one this exporter emits');

    // The seven notes round-tripped with their own Text/Extra/Source
    // intact -- not merely present in some count, but byte-identical to
    // what the fixture actually says (0x1F is the flds field separator,
    // apkg-format.md §6).
    const rows = db.prepare('SELECT flds FROM notes').all() as unknown as NoteRow[];
    const fixtureNotes = (JSON.parse(readFileSync(join(dir, 'deck.json'), 'utf8')) as { notes: { fields: { Text: string; Extra: string; Source: string } }[] }).notes;
    const expectedFlds = new Set(fixtureNotes.map((n) => [n.fields.Text, n.fields.Extra, n.fields.Source].join('\x1f')));
    const actualFlds = new Set(rows.map((r) => r.flds));
    assert.deepEqual(actualFlds, expectedFlds, 'every note round-tripped into the package with its fields intact');
  } finally {
    db.close();
  }
});
