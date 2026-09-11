import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mergeFlags } from '../src/agent/flags.ts';

test('a card flagged from two angles goes to the adjudicator once, with both notes', () => {
  const merged = mergeFlags([
    { noteIndex: 37, note: '[truth] wrong way round', at: '2026-09-11T13:28:00Z' },
    { noteIndex: 3, note: 'owner: too vague', at: '2026-09-11T12:00:00Z' },
    { noteIndex: 37, note: '[style] no facet', at: '2026-09-11T13:28:01Z' },
  ]);
  assert.deepEqual(merged, [
    { noteIndex: 3, note: 'owner: too vague', at: '2026-09-11T12:00:00Z' },
    { noteIndex: 37, note: '(1) [truth] wrong way round (2) [style] no facet', at: '2026-09-11T13:28:00Z' },
  ]);
});

test('a single flag is left as it is, and an empty note stays empty', () => {
  assert.deepEqual(mergeFlags([{ noteIndex: 0, note: '', at: 't' }]), [{ noteIndex: 0, note: '', at: 't' }]);
  assert.deepEqual(mergeFlags([]), []);
});
