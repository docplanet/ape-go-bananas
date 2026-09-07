// Cloze parsing and shape detection - contract §3.1 (CLOZE) and §4 (shape_of). This one
// regex and this one four-line function decide every shape-gated rule in note.ts, so they
// are pinned here on their own, ahead of anything that consumes them.
import { CLOZE_RE } from './regex.js';

export type Shape = 'prose' | 'ref-06' | 'ref-07';

export interface ClozeSpan {
  number: string;
  value: string;
  hint: string | null;
}

/**
 * Every {{cN::BODY}} span in `text`, left to right. BODY is split on its FIRST "::" -
 * whatever precedes is the value, whatever follows (if a "::" was found at all) is the
 * hint. A value containing a literal "::" is truncated there, same as the original
 * (contract §11 hazard 15) - this is existing behavior to replicate, not a bug to route
 * around. No "::" anywhere in the body means hint is null, never an empty string.
 */
export function clozes(text: string): ClozeSpan[] {
  const out: ClozeSpan[] = [];
  for (const match of text.matchAll(CLOZE_RE)) {
    const number = match[1];
    const body = match[2];
    const sep = body.indexOf('::');
    if (sep === -1) {
      out.push({ number, value: body, hint: null });
    } else {
      out.push({ number, value: body.slice(0, sep), hint: body.slice(sep + 2) });
    }
  }
  return out;
}

/**
 * The rendered face with every cloze's hint removed, keeping only the value - the
 * "CLOZE.sub(lambda m: m.group(2).partition('::')[0], text)" idiom, reused for rule 15's
 * bold-run scan and for unbacked()'s face-word extraction. Same first-"::" truncation as
 * clozes() itself (necessarily - it is the same split, just discarding the hint half).
 */
export function flattenClozes(text: string): string {
  return text.replace(CLOZE_RE, (_match, _number: string, body: string) => {
    const sep = body.indexOf('::');
    return sep === -1 ? body : body.slice(0, sep);
  });
}

/**
 * The sole determinant of shape for every shape-gated rule (contract §4). Case-sensitive,
 * markup-literal, and load-bearing in its specificity: ref-06 is hard-coded to cloze
 * number 1 ("{{c1::<img"), never generalized to "any digit" - an image clozed as c2 falls
 * through to prose, not ref-06. Leading whitespace only (Python lstrip()) is stripped
 * before either prefix test; the text is otherwise untouched.
 */
export function shapeOf(text: string): Shape {
  const stripped = text.trimStart();
  if (stripped.startsWith('{{c1::<img')) return 'ref-06';
  if (stripped.startsWith('<img')) return 'ref-07';
  return 'prose';
}
