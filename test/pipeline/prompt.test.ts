// src/pipeline/stageBlocks: what a writing stage hands the agent, over a
// fake client. The two additions since the first website run are pinned:
// a companion method file is attached and named, and extracted text is
// described and linked so the agent never probes for PDF tooling.
import assert from 'node:assert/strict';
import test from 'node:test';

import { describeExtracted, stageBlocks, WRITING_STAGES, type ContentBlock, type PipelineClient } from '../../dist/pipeline/index.js';

const EXTRACT = WRITING_STAGES[0]!;
const PDF = { relPath: 'L.pdf', kind: 'pdf', bytes: 4096, mimeType: 'application/pdf' };
const ORIGINAL = { relPath: 'notes.md', kind: 'text', bytes: 10, mimeType: 'text/markdown' };

function client(over: Partial<PipelineClient> & { extracted?: unknown[] } = {}): PipelineClient {
  return {
    readMethod: async (name) => ({ text: `<${name}>` }),
    listCourse: async () => ({ files: [PDF, ORIGINAL], extracted: over.extracted as never }),
    readCourse: async () => ({ text: '' }),
    newSession: async () => ({ session: { sessionId: 'x' } }),
    prompt: async () => ({ stopReason: 'end_turn' }),
    isRpcError: () => false,
    ...over,
  };
}
const textOf = (b: ContentBlock[]) => (b[1] as { text: string }).text;
const uris = (b: ContentBlock[]) => b.map((x) => ('resource' in x ? x.resource.uri : 'uri' in x ? x.uri : x.type));

test('extract attaches SETUP.md as a method resource and says not to search for it', async () => {
  const b = await stageBlocks(client(), EXTRACT, '/c', 'Deck');
  assert.deepEqual(uris(b), ['ape://system', 'text', 'ape://method/SETUP.md', 'file:///c/L.pdf', 'file:///c/notes.md']);
  assert.match(textOf(b), /SETUP\.md from the method repository is attached below; do not search the file system for it\./);
  assert.equal((b[2] as { resource: { text: string } }).resource.text, '<SETUP.md>');
});

test('a companion the bridge cannot give is left out, and the stage still runs', async () => {
  const c = client({ readMethod: async (name) => { if (name === 'SETUP.md') throw new Error('no method file'); return { text: `<${name}>` }; } });
  const b = await stageBlocks(c, EXTRACT, '/c', 'Deck');
  assert.deepEqual(uris(b), ['ape://system', 'text', 'file:///c/L.pdf', 'file:///c/notes.md']);
  assert.doesNotMatch(textOf(b), /attached below/);
});

test('with nothing extracted the prompt reads as before: no paragraph, no extra link', async () => {
  for (const extracted of [undefined, []]) {
    const b = await stageBlocks(client({ extracted }), EXTRACT, '/c', 'Deck');
    assert.doesNotMatch(textOf(b), /extracted/i);
    assert.equal(b.length, 5);
  }
});

test('extracted text is described, tooling is waved off, and text.md is linked after the materials', async () => {
  const extracted = [{ source: 'L.pdf', text: '_extracted/L.pdf/text.md', images: ['_extracted/L.pdf/p001.png', '_extracted/L.pdf/p002.png', '_extracted/L.pdf/p003.png'] }];
  const b = await stageBlocks(client({ extracted }), EXTRACT, '/c', 'Deck');
  const t = textOf(b);
  assert.match(t, /Already extracted beside the material by this app, with no tools:/);
  assert.match(t, /- L\.pdf → _extracted\/L\.pdf\/text\.md \(the text of every page, under "## Page N" headings\); 3 page images, _extracted\/L\.pdf\/p001\.png … _extracted\/L\.pdf\/p003\.png/);
  assert.match(t, /do not look for pdftotext, pypdf or any other tooling/);
  assert.equal(uris(b).at(-1), 'file:///c/_extracted/L.pdf/text.md');
  assert.equal((b.at(-1) as { mimeType: string }).mimeType, 'text/markdown');
});

test('describeExtracted: one image, images only, text only, and an empty entry', () => {
  assert.match(describeExtracted([{ source: 'a.pdf', text: 'x/text.md', images: ['x/p001.png'] }]), /x\/text\.md \(.*\); one page image, x\/p001\.png/);
  assert.match(describeExtracted([{ source: 'a.pdf', text: null, images: ['x/p001.png', 'x/p002.png'] }]), /- a\.pdf → 2 page images, x\/p001\.png … x\/p002\.png$/m);
  assert.match(describeExtracted([{ source: 'a.pdf', text: 'x/text.md', images: [] }]), /- a\.pdf → x\/text\.md \(/);
  assert.equal(describeExtracted([{ source: 'a.pdf', text: null, images: [] }]), '');
});
