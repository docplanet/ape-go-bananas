// The HTTP/SSE transport (src/sidecar/serve.ts), driven the way a browser
// page drives it: fetch with an Origin, a token in the query, one events
// stream, JSON-RPC lines in POST bodies.
//
// The method table is the same one the stdio oracle covers exhaustively, so
// this file is about the transport and its gate: what gets in, what gets
// refused, and that what comes out arrives in order on the one stream.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveSidecar, type SidecarServer } from '../../dist/sidecar/serve.js';

const ORIGIN = 'https://example.test';
const TOKEN = 'tok-0123456789abcdef';
const INFO = { engine: 'ape' as const, version: 'test', node: process.versions.node };

async function start(overrides: Partial<Parameters<typeof serveSidecar>[0]> = {}): Promise<SidecarServer> {
  return serveSidecar({ info: INFO, port: 0, token: TOKEN, allowedOrigins: [ORIGIN], ...overrides });
}

const base = (s: SidecarServer) => `http://${s.host}:${s.port}`;
const withToken = (s: SidecarServer, path: string, token = TOKEN) => `${base(s)}${path}?token=${token}`;

/** Opens /events and yields each `data:` payload, parsed, as it arrives. */
async function* events(s: SidecarServer, origin = ORIGIN): AsyncGenerator<Record<string, unknown>> {
  const res = await fetch(withToken(s, '/events'), { headers: { origin } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      if (data !== '') yield JSON.parse(data) as Record<string, unknown>;
    }
  }
}

/** Collects the next `n` events, then abandons the stream. */
async function take(s: SidecarServer, n: number, after?: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const it = events(s);
  const first = it.next(); // subscribes before `after` runs, so nothing is missed
  if (after) await after();
  const got = await first;
  if (!got.done) out.push(got.value);
  while (out.length < n) {
    const next = await it.next();
    if (next.done) break;
    out.push(next.value);
  }
  void it.return(undefined);
  return out;
}

function post(s: SidecarServer, body: string, init: { origin?: string; token?: string } = {}) {
  return fetch(withToken(s, '/rpc', init.token), { method: 'POST', headers: { origin: init.origin ?? ORIGIN }, body });
}

const rpc = (id: number | string, method: string, params?: unknown) =>
  `${JSON.stringify(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params })}\n`;

test('refuses to bind anything but loopback, before listening', async () => {
  await assert.rejects(start({ host: '0.0.0.0' }), /loopback only/);
  await assert.rejects(start({ host: '192.168.1.10' }), /loopback only/);
});

test('health answers with the engine info and names the transport', async () => {
  const s = await start();
  try {
    const res = await fetch(withToken(s, '/health'), { headers: { origin: ORIGIN } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ...INFO, transport: 'sse' });
  } finally {
    await s.close();
  }
});

test('the gate: no origin, wrong origin, wrong token, missing token', async () => {
  const s = await start();
  try {
    assert.equal((await fetch(withToken(s, '/health'))).status, 403, 'no Origin header');
    assert.equal((await fetch(withToken(s, '/health'), { headers: { origin: 'https://evil.test' } })).status, 403, 'wrong origin');
    assert.equal((await fetch(withToken(s, '/health', 'wrong'), { headers: { origin: ORIGIN } })).status, 401, 'wrong token');
    assert.equal((await fetch(`${base(s)}/health`, { headers: { origin: ORIGIN } })).status, 401, 'missing token');
    // A refused request must not have been dispatched: the events stream
    // sees only the ready line.
    const seen = await take(s, 1);
    assert.equal(seen[0]!.method, 'sidecar/ready');
  } finally {
    await s.close();
  }
});

test('preflight echoes the exact origin and the local-network header; never *', async () => {
  const s = await start();
  try {
    const res = await fetch(`${base(s)}/rpc`, {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(res.headers.get('access-control-allow-private-network'), 'true');
    assert.equal(res.headers.get('vary'), 'origin');
    const bad = await fetch(`${base(s)}/rpc`, { method: 'OPTIONS', headers: { origin: 'https://evil.test' } });
    assert.equal(bad.status, 403);
  } finally {
    await s.close();
  }
});

test('the first thing on the stream is sidecar/ready, naming this transport', async () => {
  const s = await start();
  try {
    const [ready] = await take(s, 1);
    assert.equal(ready!.method, 'sidecar/ready');
    const params = ready!.params as Record<string, unknown>;
    assert.equal(params.engine, 'ape');
    assert.equal(params.transport, 'sse');
    assert.equal(typeof params.pid, 'number');
  } finally {
    await s.close();
  }
});

test('a POSTed request is acknowledged 202 and answered on the stream with its id', async () => {
  const s = await start();
  try {
    const [, reply] = await take(s, 2, async () => {
      const res = await post(s, rpc(7, 'sidecar/ping'));
      assert.equal(res.status, 202);
      assert.deepEqual(await res.json(), { accepted: 1 });
    });
    assert.equal(reply!.id, 7);
    assert.deepEqual(reply!.result, INFO);
  } finally {
    await s.close();
  }
});

test('two requests in one body come back in arrival order; a string id survives', async () => {
  const s = await start();
  try {
    const [, a, b] = await take(s, 3, () => post(s, rpc('first', 'sidecar/ping') + rpc(2, 'sidecar/ping')));
    assert.equal(a!.id, 'first');
    assert.equal(b!.id, 2);
  } finally {
    await s.close();
  }
});

test('a body is complete in itself: no trailing newline still works, a partial line is an error', async () => {
  const s = await start();
  try {
    // The last newline is optional -- a client that forgets it is not ignored.
    const [, reply] = await take(s, 2, () => post(s, rpc(9, 'sidecar/ping').trimEnd()));
    assert.equal(reply!.id, 9);
    // But a line cut off mid-JSON is answered as a parse error, not held for
    // a later POST to complete (which stdin would have done).
    const whole = rpc(10, 'sidecar/ping');
    // A fresh subscriber sees sidecar/ready first; the parse error follows.
    const [, parse] = await take(s, 2, () => post(s, whole.slice(0, Math.floor(whole.length / 2))));
    assert.equal((parse!.error as { code: number }).code, -32700);
    assert.equal(parse!.id, null);
  } finally {
    await s.close();
  }
});

test('responses sent before any subscriber are held and delivered on connect', async () => {
  const s = await start();
  try {
    await post(s, rpc(11, 'sidecar/ping'));
    const [ready, reply] = await take(s, 2);
    assert.equal(ready!.method, 'sidecar/ready');
    assert.equal(reply!.id, 11);
  } finally {
    await s.close();
  }
});

test('malformed and unknown are protocol errors on the stream, not HTTP errors', async () => {
  const s = await start();
  try {
    const [, parse, unknown] = await take(s, 3, async () => {
      assert.equal((await post(s, 'not json at all\n')).status, 202);
      assert.equal((await post(s, rpc(3, 'no/such'))).status, 202);
    });
    assert.equal((parse!.error as { code: number }).code, -32700);
    assert.equal(parse!.id, null);
    assert.equal((unknown!.error as { code: number }).code, -32601);
    assert.equal(unknown!.id, 3);
  } finally {
    await s.close();
  }
});

test('an engine method with a real result works over the wire: deck/load', async () => {
  const s = await start();
  try {
    const path = new URL('../fixtures/reference-cards.json', import.meta.url).pathname;
    const [, reply] = await take(s, 2, () => post(s, rpc(5, 'deck/load', { path })));
    assert.equal((reply!.result as { count: number }).count, 7);
  } finally {
    await s.close();
  }
});

test('sidecar/shutdown reaches the host callback', async () => {
  let called = 0;
  const s = await start({ onShutdown: () => { called += 1; } });
  try {
    await take(s, 2, () => post(s, rpc(1, 'sidecar/shutdown')));
    assert.equal(called, 1);
  } finally {
    await s.close();
  }
});

test('/file serves a file beneath the named root and nothing outside it', async () => {
  const s = await start();
  const root = mkdtempSync(join(tmpdir(), 'ape-serve-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'ape-serve-outside-'));
  mkdirSync(join(root, 'slides'));
  writeFileSync(join(root, 'slides', 'one.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(outside, 'secret.txt'), 'no');
  symlinkSync(join(outside, 'secret.txt'), join(root, 'escape.txt'));
  const get = (path: string, r = root) =>
    fetch(`${withToken(s, '/file')}&root=${encodeURIComponent(r)}&path=${encodeURIComponent(path)}`, { headers: { origin: ORIGIN } });
  try {
    const ok = await get('slides/one.png');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.deepEqual(new Uint8Array(await ok.arrayBuffer()), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    assert.equal((await get('../' + outside.split('/').pop() + '/secret.txt')).status, 403, 'dot-dot escape');
    assert.equal((await get('escape.txt')).status, 403, 'symlink escape, resolved after realpath');
    assert.equal((await get('slides')).status, 404, 'a directory is not a file');
    assert.equal((await get('missing.png')).status, 404);
    assert.equal((await fetch(`${base(s)}/file?root=${encodeURIComponent(root)}&path=slides/one.png`, { headers: { origin: ORIGIN } })).status, 401, 'no token');
  } finally {
    await s.close();
  }
});

test('a second subscriber also sees sidecar/ready first -- a reloaded page must not hang', async () => {
  const s = await start();
  try {
    const [first] = await take(s, 1);
    assert.equal(first!.method, 'sidecar/ready');
    // Then a fresh page subscribes; before the fix the ready line had been
    // consumed by the first and this waited forever.
    const [again, reply] = await take(s, 2, () => post(s, rpc(21, 'sidecar/ping')));
    assert.equal(again!.method, 'sidecar/ready');
    assert.equal(reply!.id, 21);
  } finally {
    await s.close();
  }
});
