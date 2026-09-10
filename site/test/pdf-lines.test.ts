// pdf-extract.ts's pure parts. pdf.js itself needs a canvas, so the render
// path is proven in a browser (docs/APP.md, Stage 3); what a Node test can
// pin is how text items become lines and how pages are named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageLines, pageStem, toBase64 } from '../src/engine/pdf-extract.ts';

const item = (str: string, hasEOL = false) => ({ str, hasEOL });

test('pageLines: breaks where the item says, collapses space runs, drops trailing space and blank stacks', () => {
  assert.equal(pageLines([item('Gene '), item('transcription', true), item('  is   '), item('copying', true), item('', true), item('', true), item('DNA → RNA')]), 'Gene transcription\nis copying\n\nDNA → RNA');
  assert.equal(pageLines([]), '');
  assert.equal(pageLines([item('   ', true), item('\u00a0')]), '');
});

test('pageStem pads to three so a name sort is a page sort', () => {
  assert.deepEqual([1, 9, 10, 99, 100, 1000].map(pageStem), ['p001', 'p009', 'p010', 'p099', 'p100', 'p1000']);
  assert.deepEqual(['p010', 'p002', 'p001'].sort(), ['p001', 'p002', 'p010']);
});

test('toBase64 matches Buffer across the chunk boundary', () => {
  const bytes = new Uint8Array(0x8000 * 2 + 7);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31) & 0xff;
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
  assert.equal(toBase64(new Uint8Array()), '');
});
