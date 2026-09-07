// Protocol §2 (lifecycle) and §1's "stdout carries nothing else", asserted
// against the built sidecar as a real child process. Written from
// docs/research/sidecar-protocol.md only -- see helpers.ts's header.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PACKAGE_VERSION,
  TIMEOUT,
  isJsonRpcLine,
  makeReferenceCardsWorkDir,
  makeTmpDir,
  spawnSidecar,
  sweepSidecars,
  writeTmpFile,
} from './helpers.ts';

after(sweepSidecars);

test('package.json exposes the sidecar entry as the `ape-sidecar` bin (§2)', () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { bin?: Record<string, string> };
  assert.equal(pkg.bin?.['ape-sidecar'], 'dist/sidecar/index.js');
});

test('the first stdout line is the sidecar/ready notification with exactly its four fields (§2.1)', { timeout: TIMEOUT }, async () => {
  const s = spawnSidecar();
  const ready = await s.ready;
  assert.equal(ready.jsonrpc, '2.0');
  assert.equal(ready.method, 'sidecar/ready');
  assert.ok(!('id' in ready), 'a notification omits id entirely (acp-protocol.md #3), it is not null');
  assert.deepEqual(ready.params, {
    engine: 'ape',
    version: PACKAGE_VERSION,
    node: process.versions.node, // same process.execPath -> same Node
    pid: s.child.pid,
  });
  assert.equal(await s.end(), 0);
});

test('EOF on stdin exits 0 with no further stdout (§2.3)', { timeout: TIMEOUT }, async () => {
  const s = spawnSidecar();
  await s.ready;
  assert.equal(await s.end(), 0);
  assert.equal(s.lines.length, 1, 'only the ready line should ever have been written');
  assert.equal(s.child.stdin?.writable, false);
});

test('EOF flushes responses to requests already on stdin before exiting 0 (§2.3)', { timeout: TIMEOUT }, async () => {
  const s = spawnSidecar();
  await s.ready;
  // Write the request and close stdin in one go -- the response must still
  // come out before the exit.
  await s.writeRaw('{"jsonrpc":"2.0","id":"last","method":"sidecar/ping"}\n');
  const code = await s.end();
  assert.equal(code, 0);
  const res = await s.responseFor('last');
  assert.equal((res.result as { engine: string }).engine, 'ape');
});

test('sidecar/shutdown answers {} and then the process exits 0 (§2.4, §4)', { timeout: TIMEOUT }, async () => {
  const s = spawnSidecar();
  await s.ready;
  const res = await s.request(1, 'sidecar/shutdown');
  assert.deepEqual(res, { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(await s.exit, 0, 'exit must follow without the client closing stdin');
  assert.ok(s.lines.every(isJsonRpcLine), `non-JSON-RPC stdout line:\n${s.lines.map((l) => l.raw).join('\n')}`);
});

test('sidecar/ping returns engine/version/node, with or without params (§4)', { timeout: TIMEOUT }, async () => {
  const s = spawnSidecar();
  await s.ready;
  const expected = { engine: 'ape', version: PACKAGE_VERSION, node: process.versions.node };
  const bare = await s.request(1, 'sidecar/ping');
  assert.deepEqual(bare, { jsonrpc: '2.0', id: 1, result: expected });
  const empty = await s.request(2, 'sidecar/ping', {});
  assert.deepEqual(empty, { jsonrpc: '2.0', id: 2, result: expected });
  assert.equal(await s.end(), 0);
});

test('stdout is only JSON-RPC lines across a whole session, including engine failures and file writes (§1)', { timeout: TIMEOUT }, async () => {
  const { dir, deckPath, mediaDir } = makeReferenceCardsWorkDir();
  const s = spawnSidecar({ mediaDir });
  await s.ready;
  await s.request(1, 'sidecar/ping');
  await s.request(2, 'media/dir');
  await s.request(3, 'deck/load', { path: deckPath });
  await s.request(4, 'deck/check', { path: deckPath });
  await s.request(5, 'deck/review', { path: deckPath, outPath: `${dir}/out/review.html` });
  await s.request(6, 'deck/export', { path: deckPath });
  await s.request(7, 'flags/write', { path: deckPath, flags: [] });
  await s.request(8, 'flags/read', { path: deckPath });
  await s.request(9, 'deck/load', { path: `${dir}/missing.json` }); // engine error
  await s.request(10, 'no/such/method'); // -32601
  await s.writeRaw('this is not json\n'); // -32700
  await s.request(11, 'sidecar/ping');
  await s.writeRaw('{"jsonrpc":"2.0","id":12,"method":"sidecar/shutdown"}\n');
  assert.equal(await s.exit, 0);
  assert.equal(s.lines.length, 14, `ready + 12 responses + one -32700 line:\n${s.lines.map((l) => l.raw).join('\n')}`);
  for (const line of s.lines) {
    assert.equal(line.parseError, undefined, `stdout line is not JSON: ${JSON.stringify(line.raw)}`);
    assert.ok(isJsonRpcLine(line), `stdout line is not a JSON-RPC message: ${line.raw}`);
    assert.ok(!line.raw.includes('Content-Length'), 'no LSP-style header framing (acp-protocol.md #2)');
  }
  // §2.2: responses go out in arrival order.
  const ids = s.lines.slice(1).map((l) => l.json?.id);
  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, null, 11, 12]);
});

test('a malformed line never exits the process; the next request is answered (§2.5)', { timeout: TIMEOUT }, async () => {
  const s = spawnSidecar();
  await s.ready;
  await s.writeRaw('{not json at all\n');
  await s.writeRaw('\x00\xff garbage\n');
  const res = await s.request('after-garbage', 'sidecar/ping');
  assert.equal(res.id, 'after-garbage');
  assert.ok(res.result, 'the ping after malformed input must still succeed');
  assert.equal(s.child.exitCode, null, 'process must still be alive');
  assert.equal(await s.end(), 0);
});

test('an unknown method never exits the process; the next request is answered (§2.5)', { timeout: TIMEOUT }, async () => {
  const s = spawnSidecar();
  await s.ready;
  const bad = await s.request(1, 'deck/frobnicate', { path: 'x' });
  assert.equal(bad.error?.code, -32601);
  const res = await s.request(2, 'sidecar/ping');
  assert.ok(res.result);
  assert.equal(s.child.exitCode, null, 'process must still be alive');
  assert.equal(await s.end(), 0);
});

test('an engine error never exits the process; the next request is answered (§2.5)', { timeout: TIMEOUT }, async () => {
  const dir = makeTmpDir();
  const bad = writeTmpFile(dir, 'bad.json', '{"notes": [');
  const s = spawnSidecar();
  await s.ready;
  const err = await s.request(1, 'deck/load', { path: bad });
  assert.equal(err.error?.code, -32000);
  const err2 = await s.request(2, 'deck/check', { path: `${dir}/nope.json` });
  assert.equal(err2.error?.code, -32000);
  const res = await s.request(3, 'sidecar/ping');
  assert.ok(res.result);
  assert.equal(s.child.exitCode, null, 'process must still be alive');
  assert.equal(await s.end(), 0);
});

test('diagnostics, if any, go to stderr -- never to stdout (§1)', { timeout: TIMEOUT }, async () => {
  const dir = makeTmpDir();
  const s = spawnSidecar();
  await s.ready;
  await s.request(1, 'deck/load', { path: `${dir}/missing.json` });
  await s.writeRaw('garbage\n');
  await s.request(2, 'sidecar/ping');
  assert.equal(await s.end(), 0);
  // Whatever stderr says is free-form and not asserted; stdout must be
  // exactly the four protocol lines.
  assert.equal(s.lines.length, 4);
  assert.ok(s.lines.every(isJsonRpcLine));
});
