// container/framing.ts and engine/bytes.ts: the line protocol between the
// page and the wrapper that owns the sidecar's pipes inside the container.
//
// The first spike read frames with `atob` alone and put "Step 1 â Extract"
// on the screen for "Step 1 — Extract": `atob` yields one character per
// byte, so every multi-byte character came apart. Method files, lecture
// text and card fields are full of them, so the round trip is pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineSplitter, decodeLine, encodeIn } from '../src/container/framing.ts';
import { decodeUtf8Base64, encodeUtf8Base64, fromBase64, toBase64 } from '../src/engine/bytes.ts';

// Node 22+ has btoa/atob globally, which is what the page uses.
const SAMPLES = ['plain ascii', 'Step 1 — Extract', '3′-to-5′ direction', 'β-oxidation · 37 °C', '日本語のテキスト', '{"jsonrpc":"2.0","id":1,"result":{"text":"— quote —"}}', ''];

test('utf8 base64 round-trips every shape of text the protocol carries', () => {
  for (const s of SAMPLES) assert.equal(decodeUtf8Base64(encodeUtf8Base64(s)), s, s);
});

test('encodeUtf8Base64 matches what the wrapper produces in Node', () => {
  for (const s of SAMPLES) assert.equal(encodeUtf8Base64(s), Buffer.from(s, 'utf8').toString('base64'), s);
});

test('toBase64/fromBase64 round-trip bytes across the chunk boundary', () => {
  const bytes = new Uint8Array(0x8000 * 2 + 5);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 37) & 0xff;
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
  assert.equal(toBase64(new Uint8Array()), '');
});

test('encodeIn wraps one JSON-RPC line, newline-terminated', () => {
  const json = '{"jsonrpc":"2.0","id":1,"method":"sidecar/ping"}';
  const wire = encodeIn(json);
  assert.ok(wire.startsWith('IN '));
  assert.ok(wire.endsWith('\n'));
  assert.equal(decodeUtf8Base64(wire.slice(3).trim()), json, 'the payload survives verbatim');
});

test('decodeLine reads OUT, ERR and EXIT, and ignores anything else on the stream', () => {
  const out = decodeLine(`OUT ${encodeUtf8Base64('{"a":"—"}')}`);
  assert.deepEqual(out, { kind: 'out', text: '{"a":"—"}' });
  assert.deepEqual(decodeLine(`ERR ${encodeUtf8Base64('[session/create] phase=settings')}`), { kind: 'err', text: '[session/create] phase=settings' });
  assert.deepEqual(decodeLine('EXIT 0'), { kind: 'exit', code: 0 });
  assert.deepEqual(decodeLine('EXIT 137'), { kind: 'exit', code: 137 });
  assert.deepEqual(decodeLine('EXIT'), { kind: 'exit', code: null }, 'a signal death carries no code');
  // A pty is free to add its own noise; none of it is a frame.
  for (const junk of ['', '   ', 'npm notice', 'OUTPUT something', '> node run.mjs', 'IN abc']) {
    assert.equal(decodeLine(junk), null, JSON.stringify(junk));
  }
});

test('decodeLine tolerates carriage returns and an empty payload', () => {
  assert.deepEqual(decodeLine(`OUT ${encodeUtf8Base64('hi')}\r`), { kind: 'out', text: 'hi' });
  assert.deepEqual(decodeLine('OUT '), { kind: 'out', text: '' });
  assert.deepEqual(decodeLine('OUT'), { kind: 'out', text: '' });
});

test('LineSplitter holds the partial tail until its newline arrives', () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push('one\ntw'), ['one'], 'complete lines only');
  assert.deepEqual(s.push('o\nthree\n'), ['two', 'three']);
  assert.deepEqual(s.push(''), []);
  // A frame split across three chunks still decodes to one message.
  const frame = `OUT ${encodeUtf8Base64('{"m":"—"}')}\n`;
  const split = new LineSplitter();
  const lines = [...split.push(frame.slice(0, 6)), ...split.push(frame.slice(6, 14)), ...split.push(frame.slice(14))];
  assert.equal(lines.length, 1);
  assert.deepEqual(decodeLine(lines[0]!), { kind: 'out', text: '{"m":"—"}' });
});
