// The centrepiece suite: every case below is run through BOTH the real
// `python3 tools/check_deck.py` (the fixed oracle - see helpers.ts) and the TypeScript
// checkDeck()+formatCheckReport(), and the two outputs must match byte-for-byte. No
// expected string is ever hand-typed as "the answer" here (except in the handful of
// `expectClean`-style sanity notes, which just say a case ought to have zero PROBLEMS,
// not what the deck-wide numbers say) - the oracle is Python, run fresh, every time.
//
// Scope boundary, deliberate: this suite covers contract §3-§9 (the regex/shape/rule/
// report logic that lives in check()/main()'s report-building). It does NOT cover §1-§2
// (CLI argv parsing, exit-code-2 usage errors, ANKI_MEDIA default-path resolution, or the
// three-shapes-of-JSON unwrapping in load()) - those are CLI/loader concerns for whatever
// module drives checkDeck() from argv and a file on disk, not the checks module itself.
// Every case here therefore always passes either `noMedia: true` or a real, pre-created
// `mediaDir`, NEVER both omitted - leaving both unset would make check_media (and thus
// the whole run) depend on whether this host happens to have Anki installed, which is
// exactly the kind of host-dependence a portable test suite must not have.
//
// Rule numbers in each case's name/comment refer to contract §5.1's table. "at least 40
// cases... a rule with no case is a rule the port can silently drop" - every row 0-20
// (with 5 and 17 split into their a/b halves) has at least one case; most have two or
// three (a true fire, a boundary, and/or a false-positive guard).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DeckNote } from '../../dist/types.js';
import { checkDeck, formatCheckReport, loadTranscript, loadInventory } from '../../dist/checks/index.js';
import type { CheckDeckOptions } from '../../dist/checks/index.js';
import { nodeMediaExists } from '../../dist/checks/media-exists-node.js';
import { runCheckDeckPython, makeMediaDir } from './helpers.ts';

function note(text: string, opts: { extra?: string; tags?: string[]; source?: string } = {}): DeckNote {
  return {
    deckName: 'Differential::Cases',
    modelName: 'Custom Cloze',
    fields: { Text: text, Extra: opts.extra ?? '', Source: opts.source ?? 'S' },
    tags: opts.tags ?? [],
  };
}

function referenceCards(): DeckNote[] {
  const fixturePath = fileURLToPath(new URL('../fixtures/reference-cards.json', import.meta.url));
  return (JSON.parse(readFileSync(fixturePath, 'utf8')) as { notes: DeckNote[] }).notes;
}

// One real directory with one real file, shared read-only across every media case in this
// file - both check_deck.py's os.path.exists and the port's own existence check answer
// against this same, real filesystem state.
const MEDIA_DIR = makeMediaDir(['present.jpg']);

const TRANSCRIPT_1 = [
  '00:00:01.000 --> 00:00:03.000',
  'Speaker: The outer layer here is the capsule surrounding the organ.',
  '00:00:03.000 --> 00:00:05.000',
  'Speaker: It protects the tissue beneath from injury.',
].join('\n');

const INVENTORY_1 = [
  '| 1 | Osteoid is unmineralized bone matrix secreted by osteoblasts. | Osteoid | Slide 1 | "osteoid is unmineralized bone matrix" | high |',
  '| 2 | Osteoclasts resorb bone matrix during remodeling. | Osteoclasts | Slide 2 | "osteoclasts resorb bone matrix" | high |',
].join('\n');

const INVENTORY_2 = [
  '| 1 | Osteoid is unmineralized bone matrix. | Osteoid | Slide 1 | "osteoid is unmineralized bone matrix" | high |',
  '| 2 | Osteoclasts resorb the calcified matrix during remodeling. | Osteoclasts | Slide 2 | "osteoclasts resorb the calcified matrix" | high |',
].join('\n');

interface Case {
  name: string;
  notes: DeckNote[];
  noMedia?: boolean;
  mediaDir?: string;
  transcripts?: string[];
  inventoryText?: string;
}

const CASES: Case[] = [
  // ---- Baseline: the seven reference cards must stay clean as a whole deck ----
  { name: 'the seven reference cards, as one deck', notes: referenceCards(), noMedia: true },

  // ---- Rule 0: no cloze at all (short-circuits; nothing else runs for that note) ----
  {
    name: 'rule 0: no cloze at all short-circuits to a single finding',
    notes: [note('No cloze here at all.')],
    noMedia: true,
  },

  // ---- Rules 1-2: <img> src / media existence, gated by check_media only for rule 2 ----
  {
    name: 'rule 1: an <img> with no src in Text, not suppressed by --no-media',
    notes: [note('{{c1::<b>Bone</b>::what?}} is <img> shown here and {{c2::<i>osteocytes</i>::what cells?}}')],
    noMedia: true,
  },
  {
    name: 'rule 1: an <img> with no src in Extra specifically (field name in the message)',
    notes: [note('{{c1::<b>Bone</b>::what?}} is {{c2::<i>osteocytes</i>::what cells?}}', { extra: '<img>' })],
    noMedia: true,
  },
  {
    name: 'rule 2: media missing from the collection (in Extra), alongside rule 1 in Text',
    notes: [
      note('{{c1::<b>Bone</b>::what?}} is <img> shown here and {{c2::<i>osteocytes</i>::what cells?}}', {
        extra: '<img src="missing.jpg">',
      }),
    ],
    mediaDir: MEDIA_DIR,
  },
  {
    name: 'rule 2: a src that resolves to a real file is not reported missing',
    notes: [
      note('{{c1::<b>Bone</b>::what?}} is {{c2::<i>osteocytes</i>::what cells?}}', {
        extra: '<img src="present.jpg">',
      }),
    ],
    mediaDir: MEDIA_DIR,
  },

  // ---- Rule 3: magnification worn as a slide-zoom percentage ----
  {
    name: 'rule 3: a stated magnification within tolerance of the link\'s own z=',
    notes: [
      note('{{c1::<b>Bone</b>::what?}} shows {{c2::<i>osteocytes</i>::what cells?}}', {
        extra: '<a href="https://slides.example/view?z=74.286">slide</a> at 75x',
      }),
    ],
    noMedia: true,
  },
  {
    name: 'rule 3: a real objective far outside tolerance is not reported',
    notes: [
      note('{{c1::<b>Bone</b>::what?}} shows {{c2::<i>osteocytes</i>::what cells?}}', {
        extra: '<a href="https://slides.example/view?z=50">slide</a> at 400x',
      }),
    ],
    noMedia: true,
  },

  // ---- Rule 4: Source: quote vs --transcript, gated on the Source FIELD saying "transcript" ----
  {
    name: 'rule 4: a quoted fragment not present in the transcript, in order',
    notes: [
      note('{{c1::<b>Capsule</b>::what?}} is {{c2::<i>a fibrous covering</i>::what is it?}}', {
        extra:
          'Source: "the outer layer here is the capsule surrounding the organ, ' +
          'and this part was never spoken at all"',
        source: 'Lecture transcript',
      }),
    ],
    noMedia: true,
    transcripts: [TRANSCRIPT_1],
  },
  {
    name: 'rule 4: a fully-verified quote reports nothing',
    notes: [
      note('{{c1::<b>Capsule</b>::what?}} is {{c2::<i>a fibrous covering</i>::what is it?}}', {
        extra: 'Source: "the outer layer here is the capsule surrounding the organ"',
        source: 'Lecture transcript',
      }),
    ],
    noMedia: true,
    transcripts: [TRANSCRIPT_1],
  },
  {
    name: 'rule 4: the gate is the Source FIELD, not Extra - an unverifiable quote is skipped when Source omits "transcript"',
    notes: [
      note('{{c1::<b>Capsule</b>::what?}} is {{c2::<i>a fibrous covering</i>::what is it?}}', {
        extra: 'Source: "words that are definitely not anywhere in the transcript at all"',
        source: 'Slide 12',
      }),
    ],
    noMedia: true,
    transcripts: [TRANSCRIPT_1],
  },
  {
    name: 'rule 4: multiple --transcript sources are concatenated in the given order',
    notes: [
      note('{{c1::<b>Capsule</b>::what?}} is {{c2::<i>a fibrous covering</i>::what is it?}}', {
        extra:
          'Source: "the outer layer here is the capsule ... it surrounds the whole organ completely"',
        source: 'Lecture transcript',
      }),
    ],
    noMedia: true,
    transcripts: [
      '00:00:01.000 --> 00:00:03.000\nSpeaker: The outer layer here is the capsule.',
      '00:00:01.000 --> 00:00:03.000\nSpeaker: It surrounds the whole organ completely.',
    ],
  },

  // ---- Rules 5a/5b: fact:: tag presence and validity, gated on --inventory ----
  {
    name: 'rule 5a: no fact:: tag at all when an inventory is given',
    notes: [
      note('{{c1::<b>Osteoid</b>::what?}} is {{c2::<i>unmineralized bone matrix</i>::what is it?}}', {
        tags: [],
      }),
    ],
    noMedia: true,
    inventoryText: INVENTORY_1,
  },
  {
    name: 'rule 5b: a cited fact id not present in the inventory',
    notes: [
      note('{{c1::<b>Osteoclasts</b>::which cells?}} do {{c2::<i>resorb bone matrix</i>::what?}}', {
        tags: ['fact::F99'],
      }),
    ],
    noMedia: true,
    inventoryText: INVENTORY_1,
  },
  {
    name: 'rule 5: a valid, backed fact:: tag alongside an unbacked-tag and a no-tag note, in one deck',
    notes: [
      note('{{c1::<b>Osteoid</b>::what?}} is {{c2::<i>unmineralized bone matrix</i>::what is it?}}', {
        tags: ['fact::F1'],
      }),
      note('{{c1::<b>Osteoclasts</b>::which cells?}} do {{c2::<i>resorb bone matrix</i>::what?}}', {
        tags: ['fact::F99'],
      }),
      note('{{c1::<b>Chondrocytes</b>::which cells?}} secrete {{c2::<i>invented cartilage goo</i>::what?}}'),
    ],
    noMedia: true,
    inventoryText: INVENTORY_1,
  },

  // ---- Rule 6: an image cloze carrying a hint (it should carry none) ----
  {
    name: 'rule 6: the image cloze carries a hint',
    notes: [
      note(
        '{{c1::<img src="slide.jpg">::what is this?}}<br><br>This is {{c2::<i>compact bone</i>::which tissue?}}',
      ),
    ],
    noMedia: true,
  },

  // ---- Rule 7: a non-image cloze with no <b>/<i>/<u> role tag ----
  {
    name: 'rule 7: a cloze value with no role tag at all',
    notes: [note('{{c1::<b>Calcitonin</b>::which hormone?}} lowers {{c2::calcium levels::what?}}')],
    noMedia: true,
  },
  {
    name: "rule 7+8+14 together: a value containing an apostrophe forces repr()'s double-quote form",
    notes: [note("{{c1::<b>Calcitonin</b>::which hormone?}} lowers {{c2::patient's blood calcium}}")],
    noMedia: true,
  },

  // ---- Rule 8: a cloze with no hint, and its ref-05-style shared-hint exemption ----
  {
    name: 'rule 8: a single cloze with no hint at all',
    notes: [note('{{c1::<b>Calcitonin</b>::which hormone?}} lowers {{c2::<i>calcium levels</i>}}')],
    noMedia: true,
  },
  {
    name: 'rule 8: the shared-hint exemption - only the first of several same-numbered spans needs a hint',
    notes: [
      note(
        'The {{c1::<b>growth</b>::which?}} <b>plate</b> has:<br>1. {{c2::<i>a</i>::which?}}<br>2. {{c2::<i>b</i>}}',
      ),
    ],
    noMedia: true,
  },
  {
    name: 'rule 8: the exemption does NOT apply when the first same-numbered span also lacks a hint - both fail independently',
    notes: [note('The {{c1::<b>growth</b>::which?}} <b>plate</b> has:<br>1. {{c2::<i>a</i>}}<br>2. {{c2::<i>b</i>}}')],
    noMedia: true,
  },

  // ---- Rule 9 / Rule 10: hint shape (ends in "?", one to three words) ----
  {
    name: "rule 9: a hint that does not end in '?'",
    notes: [
      note(
        '{{c1::<b>Foo</b>::what}} is {{c2::<i>bar</i>::which is it, exactly, precisely?}} extra junk after',
      ),
    ],
    noMedia: true,
  },
  {
    name: 'rule 10: a hint with a comma fails even at three words or fewer',
    notes: [note('{{c1::<b>Bone</b>::which, exactly?}} is {{c2::<i>hard</i>::how hard?}}')],
    noMedia: true,
  },
  {
    name: 'rule 10: exactly three words passes, exactly four fails (word-count boundary)',
    notes: [
      note('{{c1::<b>Bone</b>::which tissue exactly?}} is {{c2::<i>hard</i>::how hard is it?}}'),
    ],
    noMedia: true,
  },
  {
    name: 'rule 10: rstrip strips every trailing "?", not just one - both hints stay clean',
    notes: [note('{{c1::<b>Bone</b>::which??}} is {{c2::<i>hard</i>::how hard??}}')],
    noMedia: true,
  },

  // ---- Rule 11: too many distinct cloze numbers ----
  {
    name: 'rule 11: four distinct cloze numbers is one too many',
    notes: [note('{{c1::<b>A</b>::a?}} {{c2::<i>b</i>::b?}} {{c3::<i>c</i>::c?}} {{c4::<i>d</i>::d?}}')],
    noMedia: true,
  },

  // ---- Rule 12: text after the final cloze ----
  {
    name: 'rule 12: plain trailing text after the last cloze',
    notes: [
      note('{{c1::<b>Nerve</b>::which?}} does {{c2::<u>not</u>::what?}} regenerate quickly'),
    ],
    noMedia: true,
  },
  {
    name: 'rule 12: trailing text with an HTML entity that must be unescaped',
    notes: [
      note('{{c1::<b>Enamel</b>::what?}} is {{c2::<i>hard tissue</i>::how hard?}} in AT&amp;T archives'),
    ],
    noMedia: true,
  },

  // ---- Rule 13: a role tag wraps a cloze (forbidden), vs. sitting inside it (required) ----
  {
    name: 'rule 13+7 together: a <b> wraps the cloze braces instead of sitting inside them',
    notes: [note("<b>{{c1::Osteoid::what?}}</b> is a matrix {{c2::<i>protein</i>::which kind?}}")],
    noMedia: true,
  },

  // ---- Rule 14: a possessive outside the bolded subject ----
  {
    name: 'rule 14: a true possessive outside any <b> span',
    notes: [
      note(
        "{{c1::<b>Calcitonin</b>::which hormone?}} lowers the osteoclast's own activity to " +
          '{{c2::<i>reduce blood calcium</i>::do what?}}',
      ),
    ],
    noMedia: true,
  },
  {
    name: "rule 14: an eponym's possessive swallowed whole inside <b>...</b> is not a false positive",
    notes: [
      note(
        "<b>Wharton's jelly</b>'s matrix is {{c1::<i>mucoid connective tissue</i>::which tissue?}}",
      ),
    ],
    noMedia: true,
  },
  {
    name: "rule 14: a possessive immediately followed by a tag boundary (no trailing space) is not matched",
    notes: [
      note(
        "{{c1::<b>Calcitonin</b>::which hormone?}} lowers the <i>osteoclast's</i> activity to " +
          '{{c2::<i>reduce blood calcium</i>::do what?}}',
      ),
    ],
    noMedia: true,
  },

  // ---- Rule 15: a second <b> run splits the subject ----
  {
    name: 'rule 15: two <b> runs with real prose between them - two subjects, not one',
    notes: [note('The <b>Osteoid</b> matrix <b>layer</b> forms {{c1::<i>bone</i>::what forms?}}')],
    noMedia: true,
  },
  {
    name: 'rule 15: two <b> runs separated only by &nbsp; is legal (the split-subject case), not a false positive',
    notes: [note('The <b>epiphyseal</b>&nbsp;<b>plate</b> has {{c1::<i>zones</i>::what?}}')],
    noMedia: true,
  },

  // ---- Rule 16: an inline series of five or more items in one cloze value ----
  {
    name: 'rule 16: five items (four commas) inline is an unwritten list',
    notes: [
      note(
        '{{c1::<b>Skull bones</b>::which?}} include ' +
          '{{c2::<i>frontal, parietal, temporal, occipital, sphenoid</i>::which five?}}',
      ),
    ],
    noMedia: true,
  },
  {
    name: 'rule 16: the numbered-list guard exempts a card written as an actual ref-05-style list',
    notes: [
      note(
        '1. {{c1::<b>Skull bones</b>::which?}} include ' +
          '{{c2::<i>frontal, parietal, temporal, occipital, sphenoid</i>::which five?}}',
      ),
    ],
    noMedia: true,
  },
  {
    name: 'rule 16: exactly four items (three commas) never fires, by design (contract §11 hazard 16)',
    notes: [
      note(
        '{{c1::<b>Germ layers</b>::which?}} include ' +
          '{{c2::<i>ectoderm, mesoderm, endoderm, neural crest</i>::which four?}}',
      ),
    ],
    noMedia: true,
  },

  // ---- Rules 17a/17b: <b> presence is required on prose, forbidden on a recognition card ----
  {
    name: 'rule 17a: no <b> at all on a prose-shaped card',
    notes: [note('Osteoid is {{c1::<i>unmineralized bone matrix</i>::what is it?}}')],
    noMedia: true,
  },
  {
    name: 'rule 17b: a recognition card (ref-07 shape) carrying a <b>',
    notes: [
      note(
        '<img src="x.jpg">extra prose sits <b>here</b> too<br><br>This is ' +
          '{{c1::<i>compact bone</i>::which tissue?}}',
      ),
    ],
    noMedia: true,
  },

  // ---- Rule 18: ref-06 must produce exactly numbers ["1", "2"] ----
  {
    name: 'rule 18: ref-06 shape with the wrong cloze numbers, list-repr in the message',
    notes: [
      note(
        '{{c1::<img src="slide.jpg">}}<br><br>This is {{c3::<i>compact bone</i>::which tissue?}}',
      ),
    ],
    noMedia: true,
  },

  // ---- Rule 19: ref-07 must produce exactly numbers ["1"] ----
  {
    name: 'rule 19: ref-07 shape with a non-c1 cloze number',
    notes: [
      note('<img src="slide.jpg"><br><br>This is {{c2::<i>compact bone</i>::which tissue?}}'),
    ],
    noMedia: true,
  },

  // ---- Rule 20: an answer word visible on a ref-07 front, hint excluded, every leak reported ----
  {
    name: 'rule 20: two separate answer words leak onto the front, both reported, hint text excluded from the check',
    notes: [
      note(
        '<img src="slide.jpg">Compact bone shows in this view.<br><br>This is ' +
          '{{c1::<i>compact bone</i>::which tissue?}}',
      ),
    ],
    noMedia: true,
  },

  // ---- §7 deck-wide numbers: frequency table, ties, subjects-never-clozed, facets, negations, slide coverage ----
  {
    name: '§7: answer/subject frequency table - answers block before subjects, ties broken by first-insertion order',
    notes: [
      note('{{c1::<b>Zeta</b>::which?}} is {{c2::<i>x</i>::x?}}'),
      note('{{c1::<b>Alpha</b>::which?}} is {{c2::<i>y</i>::y?}}'),
      note('{{c1::<b>Zeta</b>::which?}} is {{c2::<i>z</i>::z?}}'),
      note('{{c1::<b>Beta</b>::which?}} is {{c2::<i>w</i>::w?}}'),
    ],
    noMedia: true,
  },
  {
    name: '§7: a bolded subject never wrapped in any cloze is reported as "subjects never clozed"',
    notes: [note('<b>Bone</b> is {{c1::<i>hard</i>::how hard?}}')],
    noMedia: true,
  },
  {
    name: '§7: facets ratio counts only prose cards, and only the literal substring "<u>"',
    notes: [
      note('{{c1::<b>A</b>::a?}} has <u>x</u> {{c2::<i>b</i>::b?}}'),
      note('{{c1::<b>C</b>::c?}} has <u>y</u> {{c2::<i>d</i>::d?}}'),
      note('{{c1::<b>E</b>::e?}} is {{c2::<i>f</i>::f?}}'),
    ],
    noMedia: true,
  },
  {
    name: '§7: negation via "unlike" (a plain substring, not word-bounded) inside a <u> blank',
    notes: [
      note('{{c1::<b>Cardiac muscle</b>::which?}} is {{c2::<u>unlike skeletal muscle</u>::how?}}'),
    ],
    noMedia: true,
  },
  {
    name: '§7: "cannot" must not match the word-bounded \\bnot\\b (no word boundary inside it)',
    notes: [note('{{c1::<b>RBCs</b>::which?}} {{c2::<u>cannot</u>::what?}} synthesize protein')],
    noMedia: true,
  },
  {
    name: '§7: slide tag coverage with a hole in the middle',
    notes: [
      note('{{c1::<b>A</b>::a?}} is {{c2::<i>x</i>::x?}}', { tags: ['slide::lecture-01'] }),
      note('{{c1::<b>B</b>::b?}} is {{c2::<i>y</i>::y?}}', { tags: ['slide::lecture-02'] }),
      note('{{c1::<b>C</b>::c?}} is {{c2::<i>z</i>::z?}}', { tags: ['slide::lecture-04'] }),
    ],
    noMedia: true,
  },
  {
    name: '§7: slide tag coverage with no holes omits the "no card for" clause entirely',
    notes: [
      note('{{c1::<b>A</b>::a?}} is {{c2::<i>x</i>::x?}}', { tags: ['slide::lecture-01'] }),
      note('{{c1::<b>B</b>::b?}} is {{c2::<i>y</i>::y?}}', { tags: ['slide::lecture-02'] }),
    ],
    noMedia: true,
  },

  // ---- §7 items 7-8: inventory novel/foreign word reporting (reported, never failed) ----
  {
    name: '§7: a foreign word (absent from the WHOLE inventory) vs. a merely-novel one (present elsewhere in it)',
    notes: [
      note('{{c1::<b>Osteoid</b>::what?}} is {{c2::<i>calcified glorptonium matrix</i>::what is it?}}', {
        tags: ['fact::F1'],
      }),
    ],
    noMedia: true,
    inventoryText: INVENTORY_2,
  },

  // ---- Ordering fidelity: several independent rules firing on one note, and across notes ----
  {
    name: 'ordering: rules 1, 3, 7, 12, 17a fire together on one note, in check()\'s own order',
    notes: [
      note('{{c1::plainvalue::what?}} shows {{c2::<i>tissue</i>::which tissue?}} extra tail text <img>', {
        extra: '?z=50 at 50x',
      }),
    ],
    noMedia: true,
  },
  {
    name: 'ordering: a clean note, a "no cloze at all" note, and another clean note, in one deck',
    notes: [
      note('{{c1::<b>Osteoid</b>::what?}} is {{c2::<i>unmineralized bone matrix</i>::what is it?}}', {
        source: 'S1',
      }),
      note('No cloze here at all.', { source: 'S2' }),
      note('{{c1::<b>Osteoclasts</b>::which cells?}} <u>function</u> to {{c2::<i>resorb bone matrix</i>::do what?}}', {
        source: 'S3',
      }),
    ],
    noMedia: true,
  },
];

function toOptions(c: Case): CheckDeckOptions {
  if (!c.noMedia && c.mediaDir === undefined) {
    // Guards against accidentally adding a case that would make Python's own MEDIA_DIR
    // default-resolution (contract §1.3) depend on this host's actual filesystem.
    throw new Error(`case "${c.name}": must set noMedia or a real mediaDir to stay host-independent`);
  }
  return {
    checkMedia: !c.noMedia && c.mediaDir !== undefined,
    mediaDir: c.mediaDir,
    // Rule 2's existence predicate is injected now (checks/note.ts); this is
    // the same fs.existsSync the check used to import directly, so what these
    // cases compare against Python is unchanged.
    mediaExists: nodeMediaExists,
    transcript: c.transcripts ? c.transcripts.flatMap((raw) => loadTranscript(raw)) : undefined,
    inventory: c.inventoryText !== undefined ? loadInventory(c.inventoryText) : undefined,
  };
}

function runTs(c: Case): { stdout: string; exitCode: number } {
  const result = checkDeck(c.notes, toOptions(c));
  return { stdout: formatCheckReport(result), exitCode: result.findings.length > 0 ? 1 : 0 };
}

test('the case corpus covers at least 40 scenarios', () => {
  assert.ok(CASES.length >= 40, `expected >= 40 cases, found ${CASES.length}`);
});

for (const c of CASES) {
  test(c.name, () => {
    const py = runCheckDeckPython({
      notes: c.notes,
      noMedia: c.noMedia,
      mediaDir: c.mediaDir,
      transcripts: c.transcripts,
      inventoryText: c.inventoryText,
    });
    // Every case in this suite is constructed to be a "successful run" in contract §1.5's
    // sense (never a usage error or a load/transcript/inventory SystemExit), so stderr
    // must always come back empty - see the scope-boundary comment at the top of the file.
    assert.equal(py.stderr, '', 'stderr should be empty for every case in this suite');
    const ts = runTs(c);
    assert.equal(ts.stdout, py.stdout, 'the full stdout report must match byte-for-byte (contract §9)');
    assert.equal(ts.exitCode, py.status, 'exit code must be 1 iff findings is non-empty, else 0 (contract §1.5)');
  });
}
