// The project's standing gate (docs/research/check-deck-contract.md §10, and the method
// file it quotes): "run these seven through it first - they are the regression test. A
// check that fails ref-06 or ref-07 has not understood recognition cards." This file
// tests exactly that claim and nothing else - no subprocess, no Python, so it stays fast
// and dependency-free as the thing every other change in this module must keep green.
//
// The full-report byte-for-byte comparison against `python3 check_deck.py` for these same
// seven cards lives in differential.test.ts (case "the seven reference cards"); this file
// only needs checkDeck/checkNote's own opinion of them to be "nothing wrong here."
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DeckNote } from '../../dist/types.js';
import { checkDeck, checkNote, clozes, shapeOf } from '../../dist/checks/index.js';

const fixturePath = fileURLToPath(new URL('../fixtures/reference-cards.json', import.meta.url));

function loadReferenceCards(): DeckNote[] {
  const payload = JSON.parse(readFileSync(fixturePath, 'utf8')) as { notes: DeckNote[] };
  return payload.notes;
}

const REF_NAMES = ['ref-01', 'ref-02', 'ref-03', 'ref-04', 'ref-05', 'ref-06', 'ref-07'];

test('checkDeck(referenceCards) has zero findings', () => {
  const notes = loadReferenceCards();
  const result = checkDeck(notes, { checkMedia: false });
  assert.deepEqual(
    result.findings,
    [],
    `expected no findings across the seven reference cards, got: ${JSON.stringify(result.findings)}`,
  );
});

test('each reference card is independently clean via checkNote', () => {
  const notes = loadReferenceCards();
  notes.forEach((note, i) => {
    const problems = checkNote(note, { checkMedia: false });
    assert.deepEqual(problems, [], `${REF_NAMES[i]} should have no problems, got: ${JSON.stringify(problems)}`);
  });
});

// Locks in contract §10.1's per-card shape/number claims directly, so a shape or cloze
// regression is pinpointed by name instead of surfacing only as "some finding appeared."
test('reference cards have the documented shape', () => {
  const notes = loadReferenceCards();
  const expectedShapes = ['prose', 'prose', 'prose', 'prose', 'prose', 'ref-06', 'ref-07'];
  notes.forEach((note, i) => {
    assert.equal(shapeOf(note.fields.Text), expectedShapes[i], `${REF_NAMES[i]} shape`);
  });
});

test('reference cards have the documented distinct cloze numbers', () => {
  const notes = loadReferenceCards();
  const numbersOf = (text: string) => [...new Set(clozes(text).map((s) => s.number))].sort((a, b) => Number(a) - Number(b));

  assert.deepEqual(numbersOf(notes[0].fields.Text), ['1', '2'], 'ref-01');
  assert.deepEqual(numbersOf(notes[1].fields.Text), ['1', '2'], 'ref-02');
  assert.deepEqual(numbersOf(notes[2].fields.Text), ['1', '2', '3'], 'ref-03');
  assert.deepEqual(numbersOf(notes[3].fields.Text), ['1', '2'], 'ref-04');
  // ref-05: five list items all on c2, one subject on c1 - two distinct numbers despite six spans.
  assert.equal(clozes(notes[4].fields.Text).length, 6, 'ref-05 has six cloze spans');
  assert.deepEqual(numbersOf(notes[4].fields.Text), ['1', '2'], 'ref-05 distinct numbers');
  assert.deepEqual(numbersOf(notes[5].fields.Text), ['1', '2'], 'ref-06');
  assert.deepEqual(numbersOf(notes[6].fields.Text), ['1'], 'ref-07');
});

// ref-05's shared-hint exemption (contract §5.2) only works because item 1 carries the
// hint and items 2-5 do not - pin that shape so a fixture edit can't silently break the
// exemption this card exists to demonstrate.
test('ref-05 hints: only the first c2 occurrence carries one', () => {
  const notes = loadReferenceCards();
  const c2Spans = clozes(notes[4].fields.Text).filter((s) => s.number === '2');
  assert.equal(c2Spans.length, 5);
  assert.equal(c2Spans[0].hint, 'which?');
  for (const span of c2Spans.slice(1)) {
    assert.equal(span.hint, null);
  }
});
