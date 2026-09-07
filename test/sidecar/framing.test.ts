// Protocol §1 (framing) and §3's -32700 / -32601 rows, asserted at the byte
// level the way test/acp/framing.test.ts does for the ACP client: raw bytes
// in, captured lines out, no assumption about any internal line buffer.
// Written from docs/research/sidecar-protocol.md only -- see helpers.ts.
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after } from 'node:test';

import {
  REFERENCE_CARDS_FIXTURE,
  TIMEOUT,
  isJsonRpcLine,
  makeTmpDir,
  spawnSidecar,
  sweepSidecars,
  type RpcMessage,
} from './helpers.ts';

after(sweepSidecars);

const PING = (id: unknown) => JSON.stringify({ jsonrpc: '2.0', id, method: 'sidecar/ping' });

function assertPingResult(res: RpcMessage, id: string | number): void {
  assert.equal(res.jsonrpc, '2.0');
  assert.deepEqual(res.id, id, 'id echoed verbatim');
  assert.equal(res.error, undefined, `unexpected error: ${JSON.stringify(res.error)}`);
  assert.equal((res.result as { engine?: unknown }).engine, 'ape');
}

test('a string id comes back as the same string, a number id as the same number (§1)', { timeout: TIMEOUT }, async () => {
  const s = spawnSidecar();
  await s.ready;
  assertPingResult(await s.request('req-abc', 'sidecar/ping'), 'req-abc');
  assertPingResult(await s.request(42, 'sidecar/ping'), 42);
  assertPingResult(await s.request(0, 'sidecar/ping'), 0);
  assertPingResult(await s.request('7', 'sidecar/ping'), '7');
  const res = await s.responseFor('7');
  assert.equal(typeof res.id, 'string', 'the string "7" must not come back as the number 7');
  assert.equal(await s.end(), 0);
});

test('two requests in one write both decode, and are answered in arrival order (§1, §2.2)', { timeout: TIMEOUT }, async () => {
  const s = spawnSidecar();
  await s.ready;
  await s.writeRaw(`${PING('first')}\n${PING('second')}\n`);
  const a = await s.responseFor('first');
  const b = await s.responseFor('second');
  assertPingResult(a, 'first');
  assertPingResult(b, 'second');
  assert.deepEqual(s.lines.slice(1).map((l) => l.json?.id), ['first', 'second']);
  assert.equal(await s.end(), 0);
});

test('one request split across two writes, mid-JSON, decodes as one message (§1)', { timeout: TIMEOUT }, async () => {
  const s = spawnSidecar();
  await s.ready;
  const line = `${PING('split')}\n`;
  const cut = line.indexOf('"method"') + 4; // inside the key "method"
  await s.writeRaw(line.slice(0, cut));
  await new Promise((r) => setTimeout(r, 100)); // let the first fragment be read alone
  assert.equal(s.lines.length, 1, 'no response may be emitted from a half-received line');
  await s.writeRaw(line.slice(cut));
  assertPingResult(await s.responseFor('split'), 'split');
  assert.equal(await s.end(), 0);
});

test('a write split inside a multi-byte UTF-8 character still decodes (§1: byte-level, 0x0A only)', { timeout: TIMEOUT }, async () => {
  const dir = makeTmpDir();
  const deckPath = join(dir, 'déck.json'); // é = 0xC3 0xA9
  copyFileSync(REFERENCE_CARDS_FIXTURE, deckPath);
  const s = spawnSidecar();
  await s.ready;
  const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 'utf8', method: 'deck/load', params: { path: deckPath } })}\n`, 'utf8');
  const cut = bytes.indexOf(Buffer.from([0xc3, 0xa9])) + 1; // between the two bytes of é
  assert.equal(bytes[cut - 1], 0xc3);
  await s.writeRaw(bytes.subarray(0, cut));
  await new Promise((r) => setTimeout(r, 100));
  await s.writeRaw(bytes.subarray(cut));
  const res = await s.responseFor('utf8');
  assert.equal(res.error, undefined, `path must survive the split: ${JSON.stringify(res.error)}`);
  assert.equal((res.result as { count: number }).count, 7);
  assert.equal(await s.end(), 0);
});

test('a stray blank line is ignored: no response, no exit (§6)', { timeout: TIMEOUT }, async () => {
  const s = spawnSidecar();
  await s.ready;
  await s.writeRaw('\n');
  await s.writeRaw('\n\n');
  assertPingResult(await s.request(1, 'sidecar/ping'), 1);
  assert.equal(s.lines.length, 2, 'ready + one ping response; blank lines produce nothing');
  assert.equal(await s.end(), 0);
});

test('a line that is not JSON gets -32700 with id null (§3)', { timeout: TIMEOUT }, async () => {
  const s = spawnSidecar();
  await s.ready;
  await s.writeRaw('{"jsonrpc":"2.0","id":1,"method":"sidecar/ping"\n'); // truncated object
  const [, line] = await s.waitForLines(2);
  assert.ok(isJsonRpcLine(line), `not a JSON-RPC line: ${line.raw}`);
  assert.deepEqual(line.json?.id, null);
  assert.equal(line.json?.error?.code, -32700);
  assert.equal(typeof line.json?.error?.message, 'string');
  assert.ok((line.json?.error?.message ?? '').length > 0, 'message is human-readable, never empty');
  assertPingResult(await s.request(2, 'sidecar/ping'), 2);
  assert.equal(await s.end(), 0);
});

test('valid JSON that is not a JSON-RPC message shape gets -32700 with id null (§3)', { timeout: TIMEOUT }, async () => {
  const s = spawnSidecar();
  await s.ready;
  // Strict reading of "JSON that is not a JSON-RPC message shape": a bare
  // scalar, an array, and an object with neither method nor result/error.
  const shapes = ['42', '"ping"', '[1,2,3]', '{"foo":"bar"}'];
  for (const raw of shapes) await s.writeRaw(`${raw}\n`);
  const lines = await s.waitForLines(1 + shapes.length);
  for (const [i, line] of lines.slice(1).entries()) {
    assert.ok(isJsonRpcLine(line), `not a JSON-RPC line for ${shapes[i]}: ${line.raw}`);
    assert.deepEqual(line.json?.id, null, `id must be null for ${shapes[i]}`);
    assert.equal(line.json?.error?.code, -32700, `code for ${shapes[i]}`);
  }
  assertPingResult(await s.request(9, 'sidecar/ping'), 9);
  assert.equal(await s.end(), 0);
});

test('an unknown request method gets -32601 carrying the request id (§3)', { timeout: TIMEOUT }, async () => {
  const s = spawnSidecar();
  await s.ready;
  for (const [id, method] of [['s1', 'nope'], [77, 'deck/nope'], ['s2', 'agent/prompt']] as const) {
    const res = await s.request(id, method, {});
    assert.deepEqual(res.id, id);
    assert.equal(res.error?.code, -32601, `${method}: ${JSON.stringify(res)}`);
    assert.ok(!('result' in res), 'an error response carries no result');
    assert.ok((res.error?.message ?? '').length > 0);
  }
  assert.equal(await s.end(), 0);
});

test('a notification with an unknown method is ignored silently; the next request still works (§3)', { timeout: TIMEOUT }, async () => {
  const s = spawnSidecar();
  await s.ready;
  s.notify('nope/notification', { anything: true });
  s.notify('sidecar/ready'); // our own name reflected back is still just an unknown notification
  assertPingResult(await s.request(1, 'sidecar/ping'), 1);
  assert.equal(s.lines.length, 2, 'nothing may be written in response to a notification');
  assert.equal(await s.end(), 0);
});

test('a notification whose handling throws is ignored too (§3)', { timeout: TIMEOUT }, async () => {
  const dir = makeTmpDir();
  const s = spawnSidecar();
  await s.ready;
  s.notify('deck/load', { path: join(dir, 'missing.json') }); // would be -32000 as a request
  s.notify('deck/load'); // would be -32602 as a request
  assertPingResult(await s.request(1, 'sidecar/ping'), 1);
  assert.equal(s.lines.length, 2, 'no error response for a notification, whatever went wrong');
  assert.equal(s.child.exitCode, null);
  assert.equal(await s.end(), 0);
});

test('every response line is exactly one newline-terminated JSON value with no embedded newline (§1)', { timeout: TIMEOUT }, async () => {
  const dir = makeTmpDir();
  const s = spawnSidecar();
  await s.ready;
  // A path containing a newline must come back JSON-escaped inside the
  // -32000 message, never as a raw 0x0A byte on stdout.
  const res = await s.request(1, 'deck/load', { path: join(dir, 'line one\nline two.json') });
  assert.equal(res.error?.code, -32000);
  assert.ok(res.error?.message.includes('line one\nline two'), 'the message round-trips the newline through JSON escaping');
  assert.equal(await s.end(), 0);
  for (const line of s.lines) {
    assert.ok(!line.raw.includes('\n'));
    assert.ok(!line.raw.includes('\r'), 'no CRLF framing');
    assert.ok(isJsonRpcLine(line));
  }
});
