// Protocol §4 (every method's golden path on the seven reference cards) and
// every -32602 / -32000 row §3 and §4 list. Written from docs/research/
// sidecar-protocol.md (message text via check-deck-contract.md §1.6, whose
// templates the loader owes) only -- see helpers.ts's header.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';

import {
  TIMEOUT,
  extractZipMember,
  makeReferenceCardsWorkDir,
  makeTmpDir,
  readZipMember,
  spawnSidecar,
  sweepSidecars,
  writeTmpFile,
  type RpcMessage,
} from './helpers.ts';

after(sweepSidecars);

const DECK_NAME = 'Fixtures::Reference Cards';
const EXPECTED_CARDS = [2, 2, 3, 2, 2, 2, 1].reduce((a, b) => a + b, 0); // one card per distinct cloze number, ref-01..07

function expectError(res: RpcMessage, code: number, label: string): { message: string; data?: unknown } {
  assert.ok(res.error, `${label}: expected an error response, got ${JSON.stringify(res)}`);
  assert.ok(!('result' in res), `${label}: an error response carries no result`);
  assert.equal(res.error.code, code, `${label}: ${res.error.message}`);
  assert.ok(res.error.message.length > 0, `${label}: message must be human-readable`);
  return res.error;
}
function expectEngineError(res: RpcMessage, label: string): string {
  const err = expectError(res, -32000, label);
  // §3: data.name is the thrown Error's class name; every loader/apkg
  // failure below is a plain Error.
  assert.deepEqual(err.data, { name: 'Error' }, `${label}: data.name`);
  return err.message;
}

test('deck/load returns the fixture notes verbatim with count 7 (§4)', { timeout: TIMEOUT }, async () => {
  const { deckPath, notes } = makeReferenceCardsWorkDir();
  const s = spawnSidecar();
  await s.ready;
  const res = await s.request(1, 'deck/load', { path: deckPath });
  assert.deepEqual(res, { jsonrpc: '2.0', id: 1, result: { notes, count: 7 } });
  assert.equal(await s.end(), 0);
});

test('deck/load failures are -32000 with the loader message (§3, §4; contract §1.6)', { timeout: TIMEOUT }, async () => {
  const dir = makeTmpDir();
  const missing = join(dir, 'missing.json');
  const malformed = writeTmpFile(dir, 'malformed.json', '{"notes": [ {');
  const noText = writeTmpFile(dir, 'no-text.json', JSON.stringify({ notes: [{ fields: { Text: 'ok' } }, { fields: { Extra: '' } }] }));
  const notList = writeTmpFile(dir, 'not-list.json', '"just a string"');
  const s = spawnSidecar();
  await s.ready;
  assert.ok(expectEngineError(await s.request(1, 'deck/load', { path: missing }), 'missing').startsWith(`cannot read ${missing}`));
  assert.ok(expectEngineError(await s.request(2, 'deck/load', { path: malformed }), 'malformed').startsWith(`${malformed} is not valid JSON`));
  assert.equal(expectEngineError(await s.request(3, 'deck/load', { path: noText }), 'no Text'), `${noText}: note 2 has no fields.Text`);
  assert.equal(expectEngineError(await s.request(4, 'deck/load', { path: notList }), 'not a list'), `${notList}: expected a list of notes`);
  assert.equal(await s.end(), 0);
});

test('deck/load params validation is -32602 naming the field (§3)', { timeout: TIMEOUT }, async () => {
  const s = spawnSidecar();
  await s.ready;
  for (const [id, params] of [[1, undefined], [2, {}], [3, { path: 42 }], [5, { path: null }]] as const) {
    const err = expectError(await s.request(id, 'deck/load', params), -32602, `params ${JSON.stringify(params)}`);
    assert.match(err.message, /\bpath\b/, `must name the field: ${err.message}`);
  }
  // params of the wrong type altogether: -32602, but whether the message
  // names `params` or `path` is not pinned by the spec, so only the code is.
  expectError(await s.request(4, 'deck/load', 'deck.json'), -32602, 'params is a string');
  assert.equal(await s.end(), 0);
});

test('deck/check is clean on the fixture with the media dir present (§4; contract §9)', { timeout: TIMEOUT }, async () => {
  const { deckPath, mediaDir } = makeReferenceCardsWorkDir();
  const s = spawnSidecar({ mediaDir });
  await s.ready;
  const res = await s.request(1, 'deck/check', { path: deckPath });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const r = res.result as { result: { findings: unknown[] }; report: string; clean: boolean; count: number; mediaNote: unknown };
  assert.equal(r.clean, true);
  assert.deepEqual(r.result.findings, []);
  assert.equal(r.count, 7);
  assert.equal(r.mediaNote, null, 'media dir exists and the check was wanted -> no note');
  assert.ok(r.report.startsWith('notes: 7\n'), `report's first line (contract §9.1):\n${r.report}`);
  // Strict reading of "formatCheckReport byte-for-byte": the CLI's stdout
  // ends with the `clean` line and its newline (contract §9.10).
  assert.ok(r.report.endsWith('\nclean\n'), `report must end with the clean line:\n${JSON.stringify(r.report)}`);
  assert.doesNotMatch(r.report, /PROBLEMS:/);
  assert.equal(await s.end(), 0);
});

test('deck/check mediaNote: set when the check was wanted but the dir is absent, else null (§4)', { timeout: TIMEOUT }, async () => {
  const { deckPath, mediaDir } = makeReferenceCardsWorkDir();
  const absent = join(makeTmpDir(), 'no-such-media');
  const s = spawnSidecar({ mediaDir: absent });
  await s.ready;
  const wanted = (await s.request(1, 'deck/check', { path: deckPath })).result as { clean: boolean; mediaNote: unknown };
  assert.equal(wanted.mediaNote, `note: ${absent} not found - skipping the media check`);
  assert.equal(wanted.clean, true, 'the media check is skipped, not failed');
  const unwanted = (await s.request(2, 'deck/check', { path: deckPath, checkMedia: false })).result as { mediaNote: unknown };
  assert.equal(unwanted.mediaNote, null, 'checkMedia:false -> never a note');
  const override = (await s.request(3, 'deck/check', { path: deckPath, mediaDir })).result as { mediaNote: unknown; clean: boolean };
  assert.equal(override.mediaNote, null, 'an explicit existing mediaDir wins over ANKI_MEDIA');
  assert.equal(override.clean, true);
  assert.equal(await s.end(), 0);
});

test('deck/check engine errors: zero notes, rowless inventory, unreadable transcript (§4)', { timeout: TIMEOUT }, async () => {
  const { deckPath, mediaDir, dir } = makeReferenceCardsWorkDir();
  const empty = writeTmpFile(dir, 'empty.json', '{"notes": []}');
  const bareEmpty = writeTmpFile(dir, 'bare-empty.json', '[]');
  const inventory = writeTmpFile(dir, 'inventory.md', '# Facts\n\nNo table rows here, just prose.\n| not | numbered |\n');
  const transcript = join(dir, 'missing.vtt');
  const s = spawnSidecar({ mediaDir });
  await s.ready;
  assert.equal(expectEngineError(await s.request(1, 'deck/check', { path: empty }), 'empty'), `${empty} contains no notes`);
  assert.equal(expectEngineError(await s.request(2, 'deck/check', { path: bareEmpty }), 'bare empty'), `${bareEmpty} contains no notes`);
  assert.equal(expectEngineError(await s.request(3, 'deck/check', { path: deckPath, inventoryPath: inventory }), 'inventory'), `${inventory}: no numbered fact rows found`);
  assert.ok(expectEngineError(await s.request(4, 'deck/check', { path: deckPath, transcriptPaths: [transcript] }), 'transcript').startsWith(`cannot read ${transcript}`));
  const bad = expectError(await s.request(5, 'deck/check', { path: deckPath, transcriptPaths: 'one.vtt' }), -32602, 'transcriptPaths type');
  assert.match(bad.message, /transcriptPaths/);
  assert.equal(await s.end(), 0);
});

test('deck/review renders 7 articles and writes nothing without outPath (§4)', { timeout: TIMEOUT }, async () => {
  const { dir, deckPath, mediaDir } = makeReferenceCardsWorkDir();
  const before = readdirSync(dir).sort();
  const s = spawnSidecar({ mediaDir });
  await s.ready;
  const res = await s.request(1, 'deck/review', { path: deckPath });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const r = res.result as { html: string; count: number; outPath: unknown };
  assert.equal(r.count, 7);
  assert.equal(r.outPath, null);
  assert.equal((r.html.match(/<article/g) ?? []).length, 7, 'one <article> per note');
  assert.match(r.html, /Fixtures::Reference Cards/);
  assert.deepEqual(readdirSync(dir).sort(), before, 'no file may be written without outPath');
  expectError(await s.request(2, 'deck/review', {}), -32602, 'no path');
  assert.equal(await s.end(), 0);
});

test('deck/review with outPath writes exactly the returned html, creating parent dirs (§4)', { timeout: TIMEOUT }, async () => {
  const { dir, deckPath, mediaDir } = makeReferenceCardsWorkDir();
  const outPath = join(dir, 'out', 'nested', 'review.html');
  const s = spawnSidecar({ mediaDir });
  await s.ready;
  const r = (await s.request(1, 'deck/review', { path: deckPath, outPath })).result as { html: string; count: number; outPath: string };
  assert.equal(r.outPath, outPath, 'echoed back as given');
  assert.equal(r.count, 7);
  assert.ok(existsSync(outPath), 'file written under created parent directories');
  assert.equal(readFileSync(outPath, 'utf8'), r.html, 'file bytes === returned html');
  assert.equal(await s.end(), 0);
});

test('deck/export defaults to <stem>.apkg beside the deck and reopens to 7 notes / 14 cards (§4, §6)', { timeout: TIMEOUT }, async () => {
  const { dir, deckPath, mediaDir, notes } = makeReferenceCardsWorkDir();
  const s = spawnSidecar({ mediaDir });
  await s.ready;
  const res = await s.request(1, 'deck/export', { path: deckPath });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const r = res.result as { outPath: string; count: number; unresolvedMedia: string[] };
  assert.equal(r.outPath, join(dir, 'deck.apkg'));
  assert.equal(r.count, 7);
  assert.deepEqual(r.unresolvedMedia, [], 'slide.jpg is really in mediaDir');
  assert.equal(await s.end(), 0);

  // Reopen with tools sharing no code with this repo (system unzip, node:sqlite).
  assert.deepEqual(JSON.parse(readZipMember(r.outPath, 'media').toString('utf8')), { '0': 'slide.jpg' });
  assert.deepEqual(readZipMember(r.outPath, '0'), readFileSync(join(mediaDir, 'slide.jpg')));
  const extractDir = join(dir, 'extracted');
  mkdirSync(extractDir);
  const db = new DatabaseSync(extractZipMember(r.outPath, 'collection.anki21', extractDir), { readOnly: true });
  try {
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM notes').get() as { n: number }).n, 7);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n, EXPECTED_CARDS);
    const col = db.prepare('SELECT decks FROM col').get() as { decks: string };
    const deckNames = Object.values(JSON.parse(col.decks) as Record<string, { name: string }>).map((d) => d.name);
    assert.ok(deckNames.includes(DECK_NAME), `decks: ${deckNames.join(', ')}`);
    const flds = new Set((db.prepare('SELECT flds FROM notes').all() as unknown as { flds: string }[]).map((r) => r.flds));
    const expected = new Set((notes as { fields: { Text: string; Extra: string; Source: string } }[]).map((n) => [n.fields.Text, n.fields.Extra, n.fields.Source].join('\x1f')));
    assert.deepEqual(flds, expected, 'every note round-tripped with its fields intact');
  } finally {
    db.close();
  }
});

test('deck/export honours outPath and a matching deckName; a mismatching deckName is -32000 (§4)', { timeout: TIMEOUT }, async () => {
  const { dir, deckPath, mediaDir } = makeReferenceCardsWorkDir();
  const outPath = join(dir, 'custom', 'cards.apkg');
  const s = spawnSidecar({ mediaDir });
  await s.ready;
  const ok = (await s.request(1, 'deck/export', { path: deckPath, outPath, deckName: DECK_NAME })).result as { outPath: string; count: number };
  assert.equal(ok.outPath, outPath);
  assert.equal(ok.count, 7);
  assert.ok(existsSync(outPath));
  const msg = expectEngineError(await s.request(2, 'deck/export', { path: deckPath, deckName: 'Other::Deck' }), 'mismatch');
  assert.ok(msg.includes('"Other::Deck"') && msg.includes(`"${DECK_NAME}"`), `both names in the guard's message: ${msg}`);
  expectError(await s.request(3, 'deck/export', { path: deckPath, deckName: 7 }), -32602, 'deckName type');
  assert.equal(await s.end(), 0);
});

test('flags/read on a deck with no flags file returns [] (§4)', { timeout: TIMEOUT }, async () => {
  const { dir, deckPath } = makeReferenceCardsWorkDir();
  const s = spawnSidecar();
  await s.ready;
  const res = await s.request(1, 'flags/read', { path: deckPath });
  assert.deepEqual(res, { jsonrpc: '2.0', id: 1, result: { flags: [], flagsPath: join(dir, 'flags.json') } });
  // Strict reading: a read "reads as []" -- it does not create the file.
  assert.equal(existsSync(join(dir, 'flags.json')), false);
  assert.equal(await s.end(), 0);
});

test('flags/write then flags/read round-trips; a second write replaces wholesale (§4)', { timeout: TIMEOUT }, async () => {
  const { dir, deckPath } = makeReferenceCardsWorkDir();
  const flagsPath = join(dir, 'flags.json');
  const flags = [
    { noteIndex: 0, note: 'osteoid hint is a giveaway', at: '2026-09-07T12:00:00.000Z' },
    { noteIndex: 6, note: 'same slide as ref-06 — dup?', at: new Date('2026-09-07T12:05:30Z').toISOString() },
  ];
  const s = spawnSidecar();
  await s.ready;
  const w = await s.request(1, 'flags/write', { path: deckPath, flags });
  assert.deepEqual(w, { jsonrpc: '2.0', id: 1, result: { flagsPath, count: 2 } });
  const file = readFileSync(flagsPath, 'utf8');
  assert.deepEqual(JSON.parse(file), flags, 'stored verbatim, not interpreted');
  assert.ok(file.endsWith('\n'), 'trailing newline');
  assert.match(file, /\n  /, 'pretty-printed (indented), not a single line');
  const r = await s.request(2, 'flags/read', { path: deckPath });
  assert.deepEqual(r.result, { flags, flagsPath });
  const w2 = await s.request(3, 'flags/write', { path: deckPath, flags: [flags[1]] });
  assert.deepEqual(w2.result, { flagsPath, count: 1 });
  assert.deepEqual((await s.request(4, 'flags/read', { path: deckPath })).result, { flags: [flags[1]], flagsPath });
  assert.equal(await s.end(), 0);
});

test('flags/write validates the Flag shape with -32602 naming the field (§3, §4)', { timeout: TIMEOUT }, async () => {
  const { dir, deckPath } = makeReferenceCardsWorkDir();
  const s = spawnSidecar();
  await s.ready;
  const cases: Array<[number, unknown, RegExp]> = [
    [1, { path: deckPath, flags: [{ noteIndex: '0', note: 'x', at: '2026-09-07T12:00:00.000Z' }] }, /noteIndex/],
    [2, { path: deckPath, flags: [{ noteIndex: 0, note: 'x' }] }, /\bat\b/],
    [3, { path: deckPath, flags: [{ noteIndex: 0, at: '2026-09-07T12:00:00.000Z' }] }, /\bnote\b/],
    [4, { path: deckPath, flags: { noteIndex: 0 } }, /flags/],
    [5, { path: deckPath }, /flags/],
    [6, { flags: [] }, /\bpath\b/],
  ];
  for (const [id, params, field] of cases) {
    const err = expectError(await s.request(id, 'flags/write', params), -32602, JSON.stringify(params));
    assert.match(err.message, field, `must name the field for ${JSON.stringify(params)}: ${err.message}`);
  }
  assert.equal(existsSync(join(dir, 'flags.json')), false, 'a rejected write stores nothing');
  assert.equal(await s.end(), 0);
});

test('media/dir reports the ANKI_MEDIA override and whether it exists (§4)', { timeout: TIMEOUT }, async () => {
  const existing = makeTmpDir('ape-sidecar-media-');
  const absent = join(makeTmpDir(), 'no-such-media');
  const yes = spawnSidecar({ mediaDir: existing });
  const no = spawnSidecar({ mediaDir: absent });
  await Promise.all([yes.ready, no.ready]);
  assert.deepEqual((await yes.request(1, 'media/dir')).result, { mediaDir: existing, exists: true });
  assert.deepEqual((await yes.request(2, 'media/dir', {})).result, { mediaDir: existing, exists: true });
  assert.deepEqual((await no.request(1, 'media/dir')).result, { mediaDir: absent, exists: false });
  assert.equal(await yes.end(), 0);
  assert.equal(await no.end(), 0);
});
