// Course-protocol §3 (docs/research/course-protocol.md): method/list,
// method/read, course/list, course/read. Written from that page and
// sidecar-protocol.md §1-§3 only -- see helpers.ts's header; src/sidecar/
// was never opened. The sidecar reads APE_METHOD_DIR from its environment,
// which spawnSidecar copies from process.env, so each spawn below sets or
// deletes it on process.env for the duration of the spawn call.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import test, { after } from 'node:test';

import { TIMEOUT, makeTmpDir, spawnSidecar, sweepSidecars, writeTmpFile, type RpcMessage, type Sidecar } from './helpers.ts';

after(sweepSidecars);

const METHOD_DIR_MSG = 'APE_METHOD_DIR is not set or not a directory';
const bytesOf = (s: string | Buffer) => Buffer.byteLength(s);

function spawnWithMethodDir(dir: string | undefined): Sidecar {
  const saved = process.env.APE_METHOD_DIR;
  if (dir === undefined) delete process.env.APE_METHOD_DIR; else process.env.APE_METHOD_DIR = dir;
  try { return spawnSidecar(); } finally {
    if (saved === undefined) delete process.env.APE_METHOD_DIR; else process.env.APE_METHOD_DIR = saved;
  }
}

function expectError(res: RpcMessage, code: number, label: string): { message: string; data?: unknown } {
  assert.ok(res.error, `${label}: expected an error response, got ${JSON.stringify(res)}`);
  assert.ok(!('result' in res), `${label}: an error response carries no result`);
  assert.equal(res.error.code, code, `${label}: ${res.error.message}`);
  assert.ok(res.error.message.length > 0, `${label}: message must be human-readable`);
  return res.error;
}
/** Protocol §3: -32602's message names the offending field. */
function expectParamError(res: RpcMessage, field: string, label: string): void {
  const err = expectError(res, -32602, label);
  assert.match(err.message, new RegExp(`\\b${field}\\b`), `${label}: must name \`${field}\`: ${err.message}`);
}

// --- §1 method files -------------------------------------------------------

// Sorted order is a-, b-, c-; each title comes from a different rule.
const METHOD_FILES: Record<string, string> = {
  'a-heading.md': 'Intro prose before the heading.\n\n# Extract facts\n\nBody.\n',
  'b-frontmatter.md': '---\nname: Organize plan\ndescription: no heading anywhere below\n---\n\nBody without a heading.\n',
  'c-bare.md': 'Just prose: no heading, no frontmatter.\n',
};
function makeMethodDir(): string {
  const dir = makeTmpDir('ape-method-');
  for (const [name, text] of Object.entries(METHOD_FILES).reverse()) writeTmpFile(dir, name, text);
  writeTmpFile(dir, 'README.txt', 'not markdown\n'); // not *.md -> not listed
  mkdirSync(join(dir, 'nested'));
  writeTmpFile(join(dir, 'nested'), 'deep.md', '# Not directly in the directory\n'); // not listed either
  return dir;
}

test('method/list: every *.md directly in APE_METHOD_DIR, sorted, titled by heading / frontmatter / file name (§1, §3)', { timeout: TIMEOUT }, async () => {
  const dir = makeMethodDir();
  const s = spawnWithMethodDir(dir);
  await s.ready;
  const res = await s.request(1, 'method/list');
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepStrictEqual(res.result, {
    dir,
    files: [
      { name: 'a-heading.md', title: 'Extract facts', bytes: bytesOf(METHOD_FILES['a-heading.md']) },
      { name: 'b-frontmatter.md', title: 'Organize plan', bytes: bytesOf(METHOD_FILES['b-frontmatter.md']) },
      { name: 'c-bare.md', title: 'c-bare', bytes: bytesOf(METHOD_FILES['c-bare.md']) },
    ],
  });
  assert.equal(await s.end(), 0);
});

test('method/read returns the exact text of each listed file (§1, §3)', { timeout: TIMEOUT }, async () => {
  const s = spawnWithMethodDir(makeMethodDir());
  await s.ready;
  let id = 0;
  for (const [name, text] of Object.entries(METHOD_FILES)) {
    const res = await s.request(++id, 'method/read', { name });
    assert.deepStrictEqual(res, { jsonrpc: '2.0', id, result: { name, text } });
  }
  assert.equal(await s.end(), 0);
});

test('method/read refuses ../x.md, a/b.md, an unknown name and a bad `name` param with -32602 (§1, §3)', { timeout: TIMEOUT }, async () => {
  const s = spawnWithMethodDir(makeMethodDir());
  await s.ready;
  // "bare file name that method/list would return (no `/`, no `..`); otherwise -32602 naming `name`"
  for (const [id, name] of [[1, '../x.md'], [2, 'a/b.md'], [3, 'nested/deep.md'], [4, '..']] as const) {
    expectParamError(await s.request(id, 'method/read', { name }), 'name', name);
  }
  expectParamError(await s.request(5, 'method/read', {}), 'name', 'name absent');
  expectParamError(await s.request(6, 'method/read', { name: 7 }), 'name', 'name not a string');
  // "A name not present -> -32602" (the message text is not pinned by the spec).
  expectError(await s.request(7, 'method/read', { name: 'unknown.md' }), -32602, 'unknown name');
  expectError(await s.request(8, 'method/read', { name: 'README.txt' }), -32602, 'present on disk but never listed');
  // §2 lifecycle: the process survives every refusal.
  assert.deepStrictEqual((await s.request(9, 'method/read', { name: 'c-bare.md' })).result, { name: 'c-bare.md', text: METHOD_FILES['c-bare.md'] });
  assert.equal(await s.end(), 0);
});

test('APE_METHOD_DIR unset or not a directory -> -32000 with the fixed message on both methods (§1, §3)', { timeout: TIMEOUT }, async () => {
  const unset = spawnWithMethodDir(undefined);
  const notDir = spawnWithMethodDir(writeTmpFile(makeTmpDir(), 'method-file.md', '# a file, not a directory\n'));
  await Promise.all([unset.ready, notDir.ready]);
  for (const [s, label] of [[unset, 'unset'], [notDir, 'a file']] as const) {
    assert.equal(expectError(await s.request(1, 'method/list'), -32000, `${label}: list`).message, METHOD_DIR_MSG);
    assert.equal(expectError(await s.request(2, 'method/read', { name: 'a.md' }), -32000, `${label}: read`).message, METHOD_DIR_MSG);
    assert.equal(((await s.request(3, 'sidecar/ping')).result as { engine: string }).engine, 'ape', `${label}: still alive`);
    assert.equal(await s.end(), 0);
  }
});

// --- §2 the course folder --------------------------------------------------

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ZIP = Buffer.from('PK', 'latin1');
/** [relPath, content, kind, mimeType], already in the order `course/list` must return. */
const COURSE_FILES: Array<[string, string | Buffer, string, string]> = [
  // "audio/mp4" is the usual (RFC 4337) registration for .m4a.
  ['audio/lecture.m4a', Buffer.from('\0\0\0\x1cftypM4A ', 'latin1'), 'audio', 'audio/mp4'],
  ['data.json', '{"k": 1}\n', 'text', 'application/json'],
  ['deck.pptx', ZIP, 'slides', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['handout.docx', ZIP, 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['lecture.pdf', '%PDF-1.4\n', 'pdf', 'application/pdf'],
  ['notes.md', '# Notes\n\nUTF-8 text — with a real dash.\n', 'text', 'text/markdown'],
  ['slide.png', PNG, 'image', 'image/png'],
  ['slides/01.png', PNG, 'image', 'image/png'],
  // Strict reading of "`kind` by extension": the extension is matched
  // case-insensitively, so an uppercase .JPG is still an image / image/jpeg.
  ['slides/02.JPG', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image', 'image/jpeg'],
  ['sub/a.txt', 'nested text\n', 'text', 'text/plain'],
  ['transcript.vtt', 'WEBVTT\n\n00:00.000 --> 00:01.000\nhi\n', 'text', 'text/vtt'],
  ['video/clip.mp4', Buffer.from('\0\0\0\x1cftypisom', 'latin1'), 'video', 'video/mp4'],
  ['weird.xyz', 'unknown extension\n', 'other', 'application/octet-stream'],
];
const SKIPPED = ['.DS_Store', '.hidden/secret.md', 'node_modules/x/index.js'];
const ARTIFACTS = ['inventory.md', 'plan.md', 'deck.json', 'flags.json', 'review.html', 'out.apkg'];
const NO_ARTIFACTS = { inventory: false, plan: false, deck: false, flags: false, review: false };
const EXPECTED_FILES = COURSE_FILES.map(([relPath, content, kind, mimeType]) => ({ name: basename(relPath), relPath, bytes: bytesOf(content), kind, mimeType }));

/** `<root>/course` holding COURSE_FILES (written in reverse order), the skipped entries, `artifacts`; plus `<root>/outside.md`. */
function makeCourseTree(artifacts: string[] = []): { root: string; dir: string } {
  const root = makeTmpDir('ape-course-');
  const dir = join(root, 'course');
  const put = (rel: string, content: string | Buffer) => {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  };
  for (const [rel, content] of [...COURSE_FILES].reverse()) put(rel, content);
  for (const rel of SKIPPED) put(rel, 'skipped\n');
  for (const rel of artifacts) put(rel, '{}\n');
  writeFileSync(join(root, 'outside.md'), 'outside the course folder\n');
  return { root, dir };
}

test('course/list: every regular file recursively, sorted by relPath, dotfiles and node_modules skipped, kinds and mime types by extension (§2, §3)', { timeout: TIMEOUT }, async () => {
  const { dir } = makeCourseTree();
  const s = spawnSidecar();
  await s.ready;
  const res = await s.request(1, 'course/list', { path: dir });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepStrictEqual(res.result, { path: dir, files: EXPECTED_FILES, artifacts: NO_ARTIFACTS, extracted: [] });
  assert.equal(await s.end(), 0);
});

test('course/list: artifacts are reported, never listed as files; *.apkg is skipped (§2, §3)', { timeout: TIMEOUT }, async () => {
  const all = makeCourseTree(ARTIFACTS);
  const planOnly = makeCourseTree(['plan.md']);
  const s = spawnSidecar();
  await s.ready;
  const full = await s.request(1, 'course/list', { path: all.dir });
  assert.equal(full.error, undefined, JSON.stringify(full.error));
  assert.deepStrictEqual(full.result, { path: all.dir, files: EXPECTED_FILES, artifacts: { inventory: true, plan: true, deck: true, flags: true, review: true }, extracted: [] });
  assert.deepStrictEqual((await s.request(2, 'course/list', { path: planOnly.dir })).result, { path: planOnly.dir, files: EXPECTED_FILES, artifacts: { ...NO_ARTIFACTS, plan: true }, extracted: [] });
  assert.equal(await s.end(), 0);
});

test('course/list: a path that is not a directory -> -32000; a bad `path` param -> -32602 (§2, §3)', { timeout: TIMEOUT }, async () => {
  const { dir } = makeCourseTree();
  const s = spawnSidecar();
  await s.ready;
  expectError(await s.request(1, 'course/list', { path: join(dir, 'notes.md') }), -32000, 'a file');
  expectError(await s.request(2, 'course/list', { path: join(dir, 'no-such-dir') }), -32000, 'nonexistent');
  expectParamError(await s.request(3, 'course/list', {}), 'path', 'path absent');
  expectParamError(await s.request(4, 'course/list', { path: 3 }), 'path', 'path not a string');
  assert.equal(((await s.request(5, 'course/list', { path: dir })).result as { files: unknown[] }).files.length, EXPECTED_FILES.length, 'still alive');
  assert.equal(await s.end(), 0);
});

test('course/read returns exact UTF-8 text and byte count for notes.md and nested sub/a.txt (§2, §3)', { timeout: TIMEOUT }, async () => {
  const { dir } = makeCourseTree();
  const s = spawnSidecar();
  await s.ready;
  for (const [id, name] of [[1, 'notes.md'], [2, 'sub/a.txt']] as const) {
    const text = COURSE_FILES.find(([rel]) => rel === name)![1] as string;
    assert.deepStrictEqual(await s.request(id, 'course/read', { path: dir, name }), { jsonrpc: '2.0', id, result: { name, text, bytes: bytesOf(text) } });
  }
  assert.equal(await s.end(), 0);
});

test('decks/create names a folder from the deck name, numbers a clash; decks/list reports each with its material and artifacts, newest first', { timeout: TIMEOUT }, async () => {
  const root = join(makeTmpDir(), 'decks');
  const s = spawnSidecar();
  await s.ready;
  assert.deepStrictEqual((await s.request(1, 'decks/list', { root })).result, { root, decks: [] }, 'an empty root is created and empty');
  const a = (await s.request(2, 'decks/create', { root, name: 'Anatomy::Lecture 3 / part 1' })).result as { name: string; path: string };
  assert.equal(a.name, 'Anatomy-Lecture 3 - part 1');
  assert.equal(a.path, join(root, a.name));
  const b = (await s.request(3, 'decks/create', { root, name: 'Anatomy::Lecture 3 / part 1' })).result as { name: string };
  assert.equal(b.name, 'Anatomy-Lecture 3 - part 1 (2)', 'a clash is numbered, not overwritten');
  writeFileSync(join(a.path, 'slides.pdf'), '%PDF-1.4\n');
  writeFileSync(join(a.path, 'inventory.md'), '# inv\n');
  const listed = (await s.request(4, 'decks/list', { root })).result as { decks: { name: string; files: number; pdfs: number; artifacts: { inventory: boolean; deck: boolean } }[] };
  assert.deepStrictEqual(listed.decks.map((d) => d.name).sort(), [a.name, b.name]);
  const da = listed.decks.find((d) => d.name === a.name)!;
  assert.equal(da.files, 1);
  assert.equal(da.pdfs, 1);
  assert.equal(da.artifacts.inventory, true);
  assert.equal(da.artifacts.deck, false);
  expectParamError(await s.request(5, 'decks/create', { root }), 'name', 'name absent');
  assert.equal(await s.end(), 0);
});

test('course/import copies files, and a folder\'s files one level deep minus dotfiles; course/delete removes a file with its extraction', { timeout: TIMEOUT }, async () => {
  const { dir } = makeCourseTree();
  const src = makeTmpDir();
  writeFileSync(join(src, 'a.pdf'), '%PDF-a');
  mkdirSync(join(src, 'lecture'));
  writeFileSync(join(src, 'lecture', 'b.pdf'), '%PDF-b');
  writeFileSync(join(src, 'lecture', '.DS_Store'), 'x');
  mkdirSync(join(src, 'lecture', 'nested'));
  writeFileSync(join(src, 'lecture', 'nested', 'c.pdf'), '%PDF-c');
  const s = spawnSidecar();
  await s.ready;
  const r = (await s.request(1, 'course/import', { path: dir, files: [join(src, 'a.pdf'), join(src, 'lecture')] })).result as { imported: string[] };
  assert.deepStrictEqual(r.imported.sort(), ['a.pdf', 'b.pdf'], 'nested/ and the dotfile are left behind');
  assert.equal(readFileSync(join(dir, 'b.pdf'), 'utf8'), '%PDF-b');
  expectParamError(await s.request(2, 'course/import', { path: dir, files: [join(src, 'missing.pdf')] }), 'files', 'a missing source');
  expectParamError(await s.request(3, 'course/import', { path: dir, files: 'a.pdf' }), 'files', 'not an array');
  // An extraction beside the file goes with it.
  await s.request(4, 'course/write', { path: dir, name: '_extracted/a.pdf/text.md', text: '# a' });
  assert.deepStrictEqual((await s.request(5, 'course/delete', { path: dir, name: 'a.pdf' })).result, { name: 'a.pdf', removed: true });
  assert.equal(existsSync(join(dir, 'a.pdf')), false);
  assert.equal(existsSync(join(dir, '_extracted', 'a.pdf')), false);
  assert.deepStrictEqual((await s.request(6, 'course/delete', { path: dir, name: 'a.pdf' })).result, { name: 'a.pdf', removed: false }, 'deleting twice is not an error');
  expectParamError(await s.request(7, 'course/delete', { path: dir, name: '../outside.md' }), 'name', 'escapes path');
  expectParamError(await s.request(8, 'course/delete', { path: dir, name: 'sub' }), 'name', 'a directory');
  assert.equal(await s.end(), 0);
});

test('course/read with encoding "base64" returns the exact bytes of any kind, and refuses another encoding (§2)', { timeout: TIMEOUT }, async () => {
  const { dir } = makeCourseTree();
  const s = spawnSidecar();
  await s.ready;
  for (const [id, name] of [[1, 'slide.png'], [2, 'lecture.pdf'], [3, 'notes.md']] as const) {
    const content = COURSE_FILES.find(([rel]) => rel === name)![1];
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    assert.deepStrictEqual(await s.request(id, 'course/read', { path: dir, name, encoding: 'base64' }), { jsonrpc: '2.0', id, result: { name, base64: buf.toString('base64'), bytes: buf.length } });
  }
  // The confinement is the same in both encodings; the text-kind check is not.
  expectParamError(await s.request(4, 'course/read', { path: dir, name: '../outside.md', encoding: 'base64' }), 'name', 'escapes path');
  expectParamError(await s.request(5, 'course/read', { path: dir, name: 'notes.md', encoding: 'latin1' }), 'encoding', 'unknown encoding');
  assert.equal(await s.end(), 0);
});

test('course/read refuses an escaping name, a non-text kind, a non-file, and bad params with -32602 (§2, §3)', { timeout: TIMEOUT }, async () => {
  const { root, dir } = makeCourseTree();
  const s = spawnSidecar();
  await s.ready;
  expectParamError(await s.request(1, 'course/read', { path: dir, name: '../outside.md' }), 'name', 'escapes path (exists, still refused)');
  expectParamError(await s.request(2, 'course/read', { path: dir, name: join(root, 'outside.md') }), 'name', 'absolute name escapes path');
  const png = expectError(await s.request(3, 'course/read', { path: dir, name: 'slide.png' }), -32602, 'slide.png');
  assert.match(png.message, /is not a text file/, png.message);
  expectError(await s.request(4, 'course/read', { path: dir, name: 'sub' }), -32602, 'a directory is not a regular file');
  expectError(await s.request(5, 'course/read', { path: dir, name: 'missing.txt' }), -32602, 'a missing file is not a regular file');
  expectParamError(await s.request(6, 'course/read', { path: dir }), 'name', 'name absent');
  expectParamError(await s.request(7, 'course/read', { name: 'notes.md' }), 'path', 'path absent');
  assert.equal(((await s.request(8, 'course/read', { path: dir, name: 'sub/a.txt' })).result as { bytes: number }).bytes, bytesOf('nested text\n'), 'still alive');
  assert.equal(await s.end(), 0);
});

// --- §2 course/write and `extracted` ---------------------------------------

test('course/write puts text and bytes beneath the folder, creating directories; course/list reports them as `extracted`, never as files (§2, §3)', { timeout: TIMEOUT }, async () => {
  const { dir } = makeCourseTree();
  const s = spawnSidecar();
  await s.ready;
  const md = '# lecture.pdf\n\n## Page 1\n\nUTF-8 text — with a dash.\n';
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  // images first, text last: the page writes in that order, and only a
  // finished extraction has its text.md
  assert.deepStrictEqual(await s.request(1, 'course/write', { path: dir, name: '_extracted/lecture.pdf/p002.png', base64: png.toString('base64') }), { jsonrpc: '2.0', id: 1, result: { name: '_extracted/lecture.pdf/p002.png', bytes: png.length } });
  assert.deepStrictEqual((await s.request(2, 'course/write', { path: dir, name: '_extracted/lecture.pdf/p001.png', base64: png.toString('base64') })).result, { name: '_extracted/lecture.pdf/p001.png', bytes: png.length });
  const partial = (await s.request(3, 'course/list', { path: dir })).result as { files: unknown; extracted: unknown };
  assert.deepStrictEqual(partial.files, EXPECTED_FILES, 'nothing under _extracted/ is material');
  assert.deepStrictEqual(partial.extracted, [{ source: 'lecture.pdf', text: null, images: ['_extracted/lecture.pdf/p001.png', '_extracted/lecture.pdf/p002.png'] }], 'images sorted by name, text absent until written');
  assert.deepStrictEqual((await s.request(4, 'course/write', { path: dir, name: '_extracted/lecture.pdf/text.md', text: md })).result, { name: '_extracted/lecture.pdf/text.md', bytes: bytesOf(md) });
  const done = (await s.request(5, 'course/list', { path: dir })).result as { extracted: unknown };
  assert.deepStrictEqual(done.extracted, [{ source: 'lecture.pdf', text: '_extracted/lecture.pdf/text.md', images: ['_extracted/lecture.pdf/p001.png', '_extracted/lecture.pdf/p002.png'] }]);
  assert.deepStrictEqual(readFileSync(join(dir, '_extracted/lecture.pdf/p001.png')), png, 'bytes round-trip exactly');
  assert.equal(readFileSync(join(dir, '_extracted/lecture.pdf/text.md'), 'utf8'), md, 'text round-trips exactly');
  assert.deepStrictEqual((await s.request(6, 'course/read', { path: dir, name: '_extracted/lecture.pdf/text.md' })).result, { name: '_extracted/lecture.pdf/text.md', text: md, bytes: bytesOf(md) }, 'and is readable back through course/read');
  // a nested source keeps its path; an extracted dir for nothing listed is ignored
  await s.request(7, 'course/write', { path: dir, name: '_extracted/sub/a.txt/text.md', text: 'x' });
  await s.request(8, 'course/write', { path: dir, name: '_extracted/ghost.pdf/text.md', text: 'x' });
  const nested = (await s.request(9, 'course/list', { path: dir })).result as { extracted: { source: string }[] };
  assert.deepStrictEqual(nested.extracted.map((e) => e.source), ['lecture.pdf', 'sub/a.txt'], 'source order, ghost skipped');
  // overwriting is allowed: a re-extraction replaces
  assert.deepStrictEqual((await s.request(10, 'course/write', { path: dir, name: '_extracted/lecture.pdf/text.md', text: 'v2' })).result, { name: '_extracted/lecture.pdf/text.md', bytes: 2 });
  assert.equal(readFileSync(join(dir, '_extracted/lecture.pdf/text.md'), 'utf8'), 'v2');
  assert.equal(await s.end(), 0);
});

test('course/write refuses an escaping name, the folder itself, a directory, both or neither body, and bad params with -32602 (§2, §3)', { timeout: TIMEOUT }, async () => {
  const { root, dir } = makeCourseTree();
  const s = spawnSidecar();
  await s.ready;
  expectParamError(await s.request(1, 'course/write', { path: dir, name: '../outside.md', text: 'x' }), 'name', 'escapes path');
  expectParamError(await s.request(2, 'course/write', { path: dir, name: join(root, 'outside.md'), text: 'x' }), 'name', 'absolute name escapes path');
  expectParamError(await s.request(3, 'course/write', { path: dir, name: '.', text: 'x' }), 'name', 'the folder itself');
  expectParamError(await s.request(4, 'course/write', { path: dir, name: 'sub', text: 'x' }), 'name', 'a directory is not a regular file');
  expectError(await s.request(5, 'course/write', { path: dir, name: 'a.md', text: 'x', base64: 'eA==' }), -32602, 'both bodies');
  expectError(await s.request(6, 'course/write', { path: dir, name: 'a.md' }), -32602, 'neither body');
  expectParamError(await s.request(7, 'course/write', { path: dir, text: 'x' }), 'name', 'name absent');
  expectParamError(await s.request(8, 'course/write', { name: 'a.md', text: 'x' }), 'path', 'path absent');
  expectError(await s.request(9, 'course/write', { path: join(dir, 'notes.md'), name: 'a.md', text: 'x' }), -32000, 'path is a file');
  assert.equal(readFileSync(join(root, 'outside.md'), 'utf8'), 'outside the course folder\n', 'nothing outside was touched');
  assert.equal(existsSync(join(dir, 'a.md')), false, 'nothing was written by a refused call');
  assert.equal(await s.end(), 0);
})
