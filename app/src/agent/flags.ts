// One flag per card. The audit files a finding per angle, so a card it hit
// from two angles (or that the owner flagged besides) reached the adjudicator
// twice and came back with two verdicts to reconcile -- nine cards in the
// first full run. Merged, the card goes once, with every note under it.

import type { Flag } from '../engine/client.js';

export function mergeFlags(flags: Flag[]): Flag[] {
  const byCard = new Map<number, { flag: Flag; notes: string[] }>();
  for (const f of flags) {
    const have = byCard.get(f.noteIndex);
    if (have) {
      if (f.note) have.notes.push(f.note);
      if (f.at < have.flag.at) have.flag.at = f.at;
    } else {
      byCard.set(f.noteIndex, { flag: { ...f }, notes: f.note ? [f.note] : [] });
    }
  }
  return [...byCard.values()]
    .sort((a, b) => a.flag.noteIndex - b.flag.noteIndex)
    .map(({ flag, notes }) => ({ ...flag, note: notes.length > 1 ? notes.map((n, i) => `(${i + 1}) ${n}`).join(' ') : (notes[0] ?? '') }));
}
