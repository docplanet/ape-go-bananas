// Verifies the project scaffold itself: the shared types compile and link
// through the dist/ build, and the seven reference-card fixtures are exactly
// what docs/research/check-deck-contract.md (sourced from
// .claude/skills/anki-cards/SKILL.md) says they are. Module-specific behavior
// (actual check logic, apkg bytes, ACP wire messages) belongs in that
// module's own tests, not here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DeckNote, Finding } from '../dist/types.js';

const fixturePath = fileURLToPath(new URL('./fixtures/reference-cards.json', import.meta.url));

interface FixturePayload {
  notes: DeckNote[];
}

function loadFixture(): FixturePayload {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as FixturePayload;
}

test('Finding type shape compiles and holds an optional noteIndex', () => {
  const deckWide: Finding = { message: 'deck-wide finding, no note attached' };
  const perNote: Finding = { message: 'c1 carries no hint', noteIndex: 0 };
  assert.equal(deckWide.noteIndex, undefined);
  assert.equal(perNote.noteIndex, 0);
});

test('reference-cards.json has exactly the seven ref-01..ref-07 notes, in order', () => {
  const { notes } = loadFixture();
  assert.equal(notes.length, 7);
  notes.forEach((note, i) => {
    const n = i + 1;
    assert.equal(note.deckName, 'Fixtures::Reference Cards');
    assert.equal(note.modelName, 'Custom Cloze');
    assert.deepEqual(note.tags, ['reference', `ref-0${n}`]);
    assert.equal(note.fields.Extra, '');
    assert.equal(note.fields.Source, `Slide ${n}`);
  });
});

// Byte-for-byte against SKILL.md's own code fence (the canonical source) —
// a single dropped character here would silently poison every downstream
// checks/apkg/render test built against this fixture.
test('reference-cards.json Text fields are verbatim against the canonical source', () => {
  const { notes } = loadFixture();
  const text = (i: number) => notes[i].fields.Text;

  assert.equal(text(0), '{{c1::<b>Osteoid</b>::what?}} is {{c2::<i>unmineralized bone matrix</i>::what is it?}}');
  assert.equal(
    text(1),
    '{{c1::<b>Osteoclasts</b>::which cells?}} <u>function</u> to {{c2::<i>resorb bone matrix</i>::do what?}}',
  );
  assert.equal(
    text(2),
    '{{c1::<b>Calcitonin</b>::which hormone?}} acts on bone to {{c2::<u>lower</u>::raise or lower?}} {{c3::<i>blood calcium levels</i>::which levels?}}',
  );
  assert.equal(
    text(3),
    '{{c1::<b>Connective tissue</b>::which tissue?}} is <u>classified</u> into {{c2::<i>embryonic, proper, and specialized types</i>::which three classes?}}',
  );
  assert.equal(
    text(4),
    'The {{c1::<b>epiphyseal growth</b>::which?}} <b>plate</b> has five <u>zones</u>:<br><br>1. {{c2::<i>resting cartilage</i>::which?}}<br>2. {{c2::<i>proliferating cartilage</i>}}<br>3. {{c2::<i>hypertrophic cartilage</i>}}<br>4. {{c2::<i>calcified cartilage</i>}}<br>5. {{c2::<i>ossification</i>}}',
  );
  assert.equal(
    text(5),
    '{{c1::<img src="slide.jpg">}}<br><br>This is {{c2::<i>compact bone</i>::which tissue?}}',
  );
  assert.equal(text(6), '<img src="slide.jpg"><br><br>This is {{c1::<i>compact bone</i>::which tissue?}}');
});
