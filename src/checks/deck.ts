// The whole-deck check and its stdout report - contract §7 (the never-failing deck-wide
// numbers) and §9 (the exact, ordered stdout script). checkDeck() computes every number;
// formatCheckReport() is the only place that turns them into check_deck.py's exact text,
// so a byte-for-byte differential failure always points at one of these two functions.
import type { DeckNote, Finding } from '../types.js';
import { checkNote, type CheckNoteOptions } from './note.js';
import { clozes, shapeOf } from './cloze.js';
import { foreign, stem, unbacked } from './inventory.js';
import { ANY_TAG_RE, CLOZED_BOLD_SUBJECT_RE, IMAGE_TAG_TEST_RE, NEGATION_RE, SLIDE_TAG_RE } from './regex.js';

export type CheckDeckOptions = CheckNoteOptions;

export interface FrequencyEntry {
  value: string;
  count: number;
}

export interface ForeignByNote {
  noteIndex: number;
  words: string[];
}

export interface CheckDeckResult {
  findings: Finding[];
  notesCount: number;
  answers: FrequencyEntry[];
  subjects: FrequencyEntry[];
  subjectsNeverClozed: number[];
  prose: { count: number; faceted: number };
  underlinedWithoutEitherOr: number[];
  negated: number[];
  inventory?: { novelWordTotal: number; novelByNoteCount: number; foreignByNote: ForeignByNote[] };
  slideCoverage?: { low: number; high: number; holes: number[] };
}

/** Counter.most_common(): count descending, ties broken by first-insertion order (contract
 *  §11 hazard 1) - an insertion-ordered Map plus a stable sort (spec-guaranteed since
 *  ES2019) over its entries. */
function mostCommon(counts: Map<string, number>): FrequencyEntry[] {
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);
}

export function checkDeck(notes: DeckNote[], opts: CheckDeckOptions = {}): CheckDeckResult {
  const findings: Finding[] = [];
  notes.forEach((note, noteIndex) => {
    for (const message of checkNote(note, opts)) {
      findings.push({ message, noteIndex });
    }
  });

  // On a recognition card the first non-image cloze IS the answer; on a prose card it is
  // the subject - two different things, tallied into two different counters. Stops at the
  // first non-image span regardless of whether ITS stripped text is empty (matching
  // Python's next(generator, None) exactly - it never skips ahead looking for a
  // non-empty one).
  const answerCounts = new Map<string, number>();
  const subjectCounts = new Map<string, number>();
  for (const note of notes) {
    const text = note.fields.Text;
    const firstSpan = clozes(text).find((s) => !IMAGE_TAG_TEST_RE.test(s.value));
    if (!firstSpan) continue;
    const stripped = firstSpan.value.replace(ANY_TAG_RE, '');
    if (!stripped) continue;
    const counts = shapeOf(text) !== 'prose' ? answerCounts : subjectCounts;
    counts.set(stripped, (counts.get(stripped) ?? 0) + 1);
  }

  // Reported, not failed: a visible subject is legal only with a defence a script cannot
  // read, so this is just the count.
  const subjectsNeverClozed: number[] = [];
  notes.forEach((note, i) => {
    if (shapeOf(note.fields.Text) === 'prose' && !CLOZED_BOLD_SUBJECT_RE.test(note.fields.Text)) {
      subjectsNeverClozed.push(i + 1);
    }
  });

  // Reported, not failed: the deck-wide <u> facet ratio, prose cards only.
  let proseCount = 0;
  let faceted = 0;
  for (const note of notes) {
    if (shapeOf(note.fields.Text) === 'prose') {
      proseCount++;
      if (note.fields.Text.includes('<u>')) faceted++;
    }
  }

  // Reported, not failed: an underline inside a blank is legal only as an either/or answer.
  const underlinedWithoutEitherOr: number[] = [];
  notes.forEach((note, i) => {
    const flagged = clozes(note.fields.Text).some(
      (s) => s.value.includes('<u>') && !(s.hint ?? '').includes(' or '),
    );
    if (flagged) underlinedWithoutEitherOr.push(i + 1);
  });

  // Reported, not failed: a negation inside a blank is usually a contrast bolted onto the
  // answer, but sometimes the negative IS the fact - a script can only count.
  const negated: number[] = [];
  notes.forEach((note, i) => {
    const flagged = clozes(note.fields.Text).some((s) => NEGATION_RE.test(s.value.replace(ANY_TAG_RE, '')));
    if (flagged) negated.push(i + 1);
  });

  // Inventory-only reports: present iff an inventory was given at all (item 7 has no
  // further gate - it prints even when the count is zero); item 8's per-note breakdown is
  // gated on foreignByNote being non-empty.
  let inventoryResult: CheckDeckResult['inventory'];
  if (opts.inventory !== undefined) {
    const inventory = opts.inventory;
    let novelWordTotal = 0;
    let novelByNoteCount = 0;
    for (const note of notes) {
      const [broken, novel] = unbacked(note, inventory);
      if (broken.length === 0 && novel.length > 0) {
        novelWordTotal += novel.length;
        novelByNoteCount++;
      }
    }
    const everything = new Set<string>();
    for (const row of inventory.values()) {
      for (const w of row) everything.add(stem(w));
    }
    const foreignByNote: ForeignByNote[] = [];
    notes.forEach((note, i) => {
      const f = foreign(note, inventory, everything);
      if (f.length > 0) foreignByNote.push({ noteIndex: i, words: f });
    });
    inventoryResult = { novelWordTotal, novelByNoteCount, foreignByNote };
  }

  // Slide-tag coverage: only printed at all if at least one slide::...-NN tag exists
  // anywhere in the deck. Leading zeros in the tag's own digits are lost here (int()
  // parity with the original - contract §11 hazard 14), unlike a cloze number's string.
  let slideCoverage: CheckDeckResult['slideCoverage'];
  const carded = new Set<number>();
  for (const note of notes) {
    for (const tag of note.tags ?? []) {
      const m = SLIDE_TAG_RE.exec(tag);
      if (m) carded.add(parseInt(m[1], 10));
    }
  }
  if (carded.size > 0) {
    const low = Math.min(...carded);
    const high = Math.max(...carded);
    const holes: number[] = [];
    for (let s = low; s <= high; s++) {
      if (!carded.has(s)) holes.push(s);
    }
    slideCoverage = { low, high, holes };
  }

  return {
    findings,
    notesCount: notes.length,
    answers: mostCommon(answerCounts),
    subjects: mostCommon(subjectCounts),
    subjectsNeverClozed,
    prose: { count: proseCount, faceted },
    underlinedWithoutEitherOr,
    negated,
    inventory: inventoryResult,
    slideCoverage,
  };
}

function noteList(indices: number[]): string {
  return indices.map((i) => `note ${i}`).join(', ');
}

/**
 * Exact stdout reproduction - contract §9. Sections gated exactly as documented, in
 * order; each line is "\n"-terminated including the last, matching print()'s own
 * per-call newline exactly (so the concatenation of every print() call in the original
 * is reproduced, not merely each line's own text).
 */
export function formatCheckReport(result: CheckDeckResult): string {
  const lines: string[] = [];
  lines.push(`notes: ${result.notesCount}`);

  for (const { label, entries } of [
    { label: 'answer', entries: result.answers },
    { label: 'subject', entries: result.subjects },
  ]) {
    for (const { value, count } of entries) {
      lines.push(`  ${String(count).padStart(3, ' ')}  ${label.padEnd(8, ' ')} ${value}`);
    }
  }

  if (result.subjectsNeverClozed.length > 0) {
    lines.push(
      `subjects never clozed (${result.subjectsNeverClozed.length} - each needs a defence): ` +
        noteList(result.subjectsNeverClozed),
    );
  }

  if (result.prose.count > 0) {
    lines.push(`facets: ${result.prose.faceted} of ${result.prose.count} prose cards carry a <u>`);
  }

  if (result.underlinedWithoutEitherOr.length > 0) {
    lines.push(
      `underlines inside a blank without an either/or hint (${result.underlinedWithoutEitherOr.length} - the ` +
        `bridge is shown, never tested): ${noteList(result.underlinedWithoutEitherOr)}`,
    );
  }

  if (result.negated.length > 0) {
    lines.push(
      `negations inside a blank (${result.negated.length} - contrast belongs in Extra ` +
        `unless the negative is the fact): ${noteList(result.negated)}`,
    );
  }

  if (result.inventory) {
    lines.push(
      `words a card's own cited facts do not carry: ${result.inventory.novelWordTotal} across ` +
        `${result.inventory.novelByNoteCount} cards (re-wording is the job; this is context, not a list ` +
        `to work through)`,
    );
    if (result.inventory.foreignByNote.length > 0) {
      const count = result.inventory.foreignByNote.reduce((sum, f) => sum + f.words.length, 0);
      lines.push(
        `words appearing NOWHERE in the inventory (${count} across ` +
          `${result.inventory.foreignByNote.length} cards - read every one):`,
      );
      for (const { noteIndex, words: ws } of result.inventory.foreignByNote) {
        lines.push(`    note ${noteIndex + 1}: ${ws.join(', ')}`);
      }
    }
  }

  if (result.slideCoverage) {
    const { low, high, holes } = result.slideCoverage;
    lines.push(`slide tags cover ${low}-${high}` + (holes.length > 0 ? `; no card for: ${holes.join(', ')}` : ''));
  }

  lines.push(result.findings.length > 0 ? 'PROBLEMS:' : 'clean');
  for (const finding of result.findings) {
    lines.push(`   note ${finding.noteIndex! + 1}: ${finding.message}`);
  }

  return lines.map((line) => line + '\n').join('');
}
