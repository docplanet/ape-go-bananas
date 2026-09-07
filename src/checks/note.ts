// The per-note check - contract §5 (the 23-row rule table) and §12 (the same table
// collapsed to control flow). Rule numbers in the comments below refer to contract §5.1;
// the execution order here IS the order that table's rows are listed in, which is also
// the order a differential test's per-note message ordering must match (contract §9).
import { existsSync } from 'node:fs';
import type { DeckNote } from '../types.js';
import { clozes, flattenClozes, shapeOf } from './cloze.js';
import { unbacked } from './inventory.js';
import { zoomWornAsMagnification } from './magnification.js';
import {
  ANY_TAG_RE,
  BOLD_RUN_RE,
  BOLD_SPAN_NONGREEDY_RE,
  HAS_ROLE_TAG_RE,
  IMAGE_SRC_RE,
  IMAGE_TAG_RE,
  IMAGE_TAG_TEST_RE,
  NBSP_OR_SPACE_RE,
  NUMBERED_LIST_GUARD_RE,
  POSSESSIVE_RE,
  ROLE_WRAPS_CLOZE_RE,
} from './regex.js';
import { htmlUnescape, pyListRepr, pyOsPathJoin, pyRepr, pyRStrip, pySlice, pySplit, pyStrip } from './pystrings.js';
import { unsourcedQuoteFragments } from './transcript.js';

export interface CheckNoteOptions {
  /** Gate for rule 2 (media existence). Default false - matches the Python default of
   *  requiring an explicit, already-resolved decision from the caller (contract §1.4's
   *  `check_media` is computed once in main(), never re-derived per note). `true` with
   *  `mediaDir` left undefined is a caller error, not "skip the check": checkNote() throws
   *  rather than silently reporting a clean deck that was never actually checked. */
  checkMedia?: boolean;
  /** Joined via pyOsPathJoin (os.path.join semantics, NOT node:path.join - contract §11
   *  hazard 4) and checked via fs.existsSync; only consulted when checkMedia is true. */
  mediaDir?: string;
  /** undefined = the --transcript gate (rule 4) never runs, regardless of the Source field. */
  transcript?: string[];
  /** undefined = the --inventory gate (rules 5a/5b) never runs. */
  inventory?: Map<string, Set<string>>;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Raw, fully-formatted problem strings for one note, in check()'s exact order. */
export function checkNote(note: DeckNote, opts: CheckNoteOptions = {}): string[] {
  const problems: string[] = [];
  const fields = note.fields;
  const text = fields.Text;
  const extra = fields.Extra ?? '';
  const shape = shapeOf(text);
  const spans = clozes(text);
  const numbers = [...new Set(spans.map((s) => s.number))].sort((a, b) => Number(a) - Number(b));

  // Rule 0 - short-circuits: nothing else runs for this note.
  if (spans.length === 0) {
    return ['no cloze at all'];
  }

  const checkMedia = opts.checkMedia ?? false;
  const mediaDir = opts.mediaDir;
  // A caller that asks for media checking but supplies no directory to check against would
  // otherwise have every image silently pass - "checked, all present" and "never checked at
  // all" render as the identical clean report, which is exactly the misconfiguration a
  // still-to-come CLI layer is likeliest to make. Fail loudly instead of fabricating a clean
  // result (no test in this suite ever sets checkMedia without also setting mediaDir).
  if (checkMedia && mediaDir === undefined) {
    throw new Error('checkMedia is true but mediaDir is undefined; media checking would silently no-op for every note');
  }

  // Rules 1-2: <img> src presence, then (gated on checkMedia only) media existence.
  // Extra as well as Text: a slide image can legitimately live in Extra on a prose card.
  for (const [field, fieldText] of [['Text', text] as const, ['Extra', extra] as const]) {
    for (const tag of fieldText.match(IMAGE_TAG_RE) ?? []) {
      const source = IMAGE_SRC_RE.exec(tag);
      if (!source) {
        problems.push(`an <img> with no src in ${field}`);
        continue;
      }
      if (checkMedia && mediaDir !== undefined && !existsSync(pyOsPathJoin(mediaDir, source[1]))) {
        problems.push(`media missing from the collection: ${source[1]} (in ${field})`);
      }
    }
  }

  // Rule 3: a stated magnification that is really the slide link's own zoom percentage.
  for (const claim of zoomWornAsMagnification(extra)) {
    problems.push(`states ${claim}: a slideview z is a zoom percentage, not an objective`);
  }

  // Rule 4: only a quote the card itself attributes to the lecture (the SHORT Source
  // field, not Extra) is checked against the transcript. Python reads this gate as
  // `fields.get("Source", "").lower()` - a MISSING key defaults to "", but a PRESENT
  // non-string value (a null Source is the realistic case; deck.json is untrusted input,
  // not something this module validates on the way in) has no default to fall back to and
  // raises AttributeError, crashing the whole run before unsourced_quote_fragments is ever
  // reached. Contract §11 hazard 12 is explicit that a port must not turn that crash into a
  // different SUCCESSFUL result - `fields.Source ?? ''` alone would silently do exactly
  // that (report "clean" where Python dies), so the non-string case is rejected here first.
  if (opts.transcript !== undefined) {
    if (fields.Source !== undefined && typeof fields.Source !== 'string') {
      throw new TypeError(
        'fields.Source is present but not a string; check_deck.py\'s ' +
          'fields.get("Source", "").lower() would raise AttributeError on this note',
      );
    }
    if ((fields.Source ?? '').toLowerCase().includes('transcript')) {
      for (const fragment of unsourcedQuoteFragments(extra, opts.transcript)) {
        problems.push(`quoted text is not in the transcript: ${pyRepr(fragment)}`);
      }
    }
  }

  // Rules 5a/5b: fact:: tag presence and validity.
  if (opts.inventory !== undefined) {
    const [broken] = unbacked(note, opts.inventory);
    problems.push(...broken);
  }

  // Rules 6-10: per-cloze-span checks.
  for (const { number, value, hint } of spans) {
    const isImage = IMAGE_TAG_TEST_RE.test(value);
    if (isImage) {
      if (hint) {
        problems.push('the image cloze carries a hint; it should have none');
      }
      continue; // rules 7-10 never run for an image cloze
    }
    if (!HAS_ROLE_TAG_RE.test(value)) {
      problems.push(`c${number} has no role tag on ${pyRepr(pySlice(value, 40))}`);
    }
    // The ref-05 shared-hint exemption (contract §5.2): a hintless span is exempt only
    // when its number is shared by >1 span AND the very first span with that number does
    // carry a hint.
    const shared = spans.filter((s) => s.number === number);
    if (hint === null && !(shared.length > 1 && shared[0].hint)) {
      problems.push(`c${number} carries no hint`);
    }
    if (hint !== null) {
      if (!hint.endsWith('?')) {
        problems.push(`c${number} hint does not end in '?': ${pyRepr(hint)}`);
      } else if (hint.includes(',') || pySplit(pyRStrip(hint, '?')).length > 3) {
        problems.push(`c${number} hint is not one to three words: ${pyRepr(hint)}`);
      }
    }
  }

  // Rule 11: too many distinct cloze numbers.
  if (numbers.length > 3) {
    problems.push(`${numbers.length} cloze numbers; never more than three`);
  }

  // Rule 12: text after the final cloze. Tags stripped to the EMPTY string (not a space),
  // then entities decoded, then trimmed (Python's strip(), not JS's .trim() - they disagree
  // on \x1c-\x1f and U+FEFF) - reused as-is (`trailing`) by the ref-07 branch.
  const trailing = text.slice(text.lastIndexOf('}}') + 2);
  const tail = pyStrip(htmlUnescape(trailing.replace(ANY_TAG_RE, '')));
  if (tail) {
    problems.push(`text after the final cloze: ${pyRepr(pySlice(tail, 48))}`);
  }

  // Rule 13: a role tag must sit directly on the text, never wrap the cloze braces.
  if (ROLE_WRAPS_CLOZE_RE.test(text)) {
    problems.push('a role tag wraps a cloze; the tag must sit directly on the text');
  }

  // Rule 14: a possessive outside the bolded subject - prose only. Every <b>...</b> span
  // is blanked (non-greedy, so each is removed individually) before the test.
  if (shape === 'prose') {
    const bare = htmlUnescape(text.replace(BOLD_SPAN_NONGREEDY_RE, ' ')).split('’').join("'");
    if (POSSESSIVE_RE.test(bare)) {
      problems.push('a possessive outside the subject; step 2 handed the wrong entity');
    }
  }

  // Rule 15: one subject, literally - a second free-standing <b> run (on the
  // hint-flattened text) separated from the first by real content is two subjects.
  // Checks every consecutive pair, stops at the first offending one.
  if (shape === 'prose') {
    const flat = flattenClozes(text);
    const bolds = [...flat.matchAll(BOLD_RUN_RE)];
    for (let i = 0; i < bolds.length - 1; i++) {
      const left = bolds[i];
      const right = bolds[i + 1];
      // matchAll() results always carry a defined `index` in practice; the type only
      // marks it optional because it is inherited from the general match-array shape.
      const gap = flat.slice(left.index! + left[0].length, right.index!);
      if (gap.replace(NBSP_OR_SPACE_RE, '')) {
        problems.push(`a second <b> run split from the subject by ${pyRepr(pySlice(pyStrip(gap), 24))}; one subject, one name`);
        break;
      }
    }
  }

  // Rule 16: an inline series of five or more items in one cloze value - prose only, and
  // only when the numbered-list guard doesn't already exempt this card as a real ref-05
  // list. Stops at the first offending cloze value; image clozes are skipped entirely.
  if (shape === 'prose' && !NUMBERED_LIST_GUARD_RE.test(text.replace(ANY_TAG_RE, ''))) {
    for (const { value } of spans) {
      if (IMAGE_TAG_TEST_RE.test(value)) continue;
      const itemCommas = value.replace(ANY_TAG_RE, '').split(',').length - 1;
      if (itemCommas >= 4) {
        problems.push(`a ${itemCommas + 1}-item series inline; ref-05 list form`);
        break;
      }
    }
  }

  // Rules 17a/17b: <b> is required on prose, forbidden on a recognition card.
  if (shape === 'prose') {
    if (!text.includes('<b>')) {
      problems.push('no <b> subject on a card that is not a recognition card');
    }
  } else if (text.includes('<b>')) {
    problems.push('a recognition card must carry no <b>; this one does');
  }

  // Rule 18: ref-06 must produce exactly cloze numbers ["1", "2"].
  if (shape === 'ref-06' && !arraysEqual(numbers, ['1', '2'])) {
    problems.push(`image is clozed (ref-06) so expect c1 and c2, found ${pyListRepr(numbers)}`);
  }

  // Rule 19/20: ref-07 must produce exactly ["1"], and no long answer word may leak onto
  // the rendered front (the hint is deliberately excluded from the front text).
  if (shape === 'ref-07') {
    if (!arraysEqual(numbers, ['1'])) {
      problems.push(`image is visible (ref-07) so expect c1 alone, found ${pyListRepr(numbers)}`);
    }
    const answerSpan = spans.find((s) => s.number === '1');
    const answer = answerSpan ? answerSpan.value : '';
    const lead = text.slice(0, text.indexOf('{{'));
    let front = lead.replace(IMAGE_TAG_RE, ' ') + ' ' + trailing;
    front = front.replace(ANY_TAG_RE, ' ').toLowerCase();
    for (const word of pySplit(answer.replace(ANY_TAG_RE, '').toLowerCase())) {
      if (word.length > 3 && front.includes(word)) {
        problems.push(`the answer word ${pyRepr(word)} is visible on the front`);
      }
    }
  }

  return problems;
}
