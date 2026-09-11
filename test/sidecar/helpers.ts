// Shared plumbing for test/sidecar/*.test.ts -- written from
// docs/research/sidecar-protocol.md alone, by a context that has not seen
// src/sidecar/. Every test here drives the built sidecar (dist/sidecar/
// index.js) as a real child process over stdio and asserts only at that
// boundary: the exact bytes on stdout, the exit code, and files on disk.
//
// The line reader below is deliberately byte-level (splits on 0x0A only,
// decodes each line as UTF-8 afterwards) and keeps EVERY stdout line, parsed
// or not, so a test can prove protocol §1's "stdout carries nothing else".
//
// Imports of other test files use an explicit .ts specifier
// (tsconfig.test.json's allowImportingTsExtensions), matching the sibling
// helpers under test/integration and test/acp.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIDECAR_ENTRY = fileURLToPath(new URL('../../dist/sidecar/index.js', import.meta.url));
export const REFERENCE_CARDS_FIXTURE = fileURLToPath(new URL('../fixtures/reference-cards.json', import.meta.url));
const SLIDE_JPG_FIXTURE = fileURLToPath(new URL('../apkg/fixtures/slide.jpg', import.meta.url));
export const PACKAGE_VERSION = (JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version: string }).version;

export const TIMEOUT = 10_000;
export type RpcId = string | number | null;
export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}
export interface RpcMessage {
  jsonrpc?: unknown;
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RpcError;
}
/** One captured stdout line: the raw text, and its parse (or the parse failure). */
export interface CapturedLine {
  raw: string;
  json?: RpcMessage;
  parseError?: string;
}

export function withTimeout<T>(p: Promise<T>, label: string, ms = TIMEOUT): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface Sidecar {
  child: ChildProcess;
  /** Every stdout line seen so far, in arrival order, ready line included. */
  lines: CapturedLine[];
  stderr: () => string;
  /** Resolves with the first stdout line's parse (protocol §2 step 1). */
  ready: Promise<RpcMessage>;
  /** Writes one request line; resolves with the response line carrying the same id. */
  request: (id: string | number, method: string, params?: unknown) => Promise<RpcMessage>;
  /** Writes one notification line (no id). */
  notify: (method: string, params?: unknown) => void;
  /** Writes raw bytes, exactly as given -- for split / combined-write framing tests. */
  writeRaw: (bytes: Buffer | string) => Promise<void>;
  /** Resolves once at least `n` stdout lines have been captured. */
  waitForLines: (n: number) => Promise<CapturedLine[]>;
  /** Resolves with the response carrying `id`, however it was written. */
  responseFor: (id: string | number) => Promise<RpcMessage>;
  /** Closes stdin (EOF) and resolves with the exit code. */
  end: () => Promise<number | null>;
  exit: Promise<number | null>;
}

const live: ChildProcess[] = [];
const tmpDirs: string[] = [];

/** Register once per test file with `after(sweepSidecars)` from 'node:test'. */
export function sweepSidecars(): void {
  for (const c of live) if (c.exitCode === null && !c.killed) c.kill('SIGKILL');
  live.length = 0;
}

export function makeTmpDir(prefix = 'ape-sidecar-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Spawns `node dist/sidecar/index.js` via process.execPath (immune to a
 * v20 `node` on PATH shadowing the pinned v24). ANKI_MEDIA is always set
 * explicitly -- to `mediaDir`, or to a fresh empty temp dir -- so nothing
 * here depends on the developer's real Anki profile.
 */
export function spawnSidecar(opts: { mediaDir?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Sidecar {
  const env: NodeJS.ProcessEnv = { ...process.env, ANKI_MEDIA: opts.mediaDir ?? makeTmpDir('ape-sidecar-media-'), ...(opts.env ?? {}) };
  const child = spawn(process.execPath, [SIDECAR_ENTRY], { cwd: opts.cwd ?? process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'] });
  live.push(child);

  const lines: CapturedLine[] = [];
  let stderrBuf = '';
  let pending = Buffer.alloc(0);
  const idWaiters = new Map<string, (m: RpcMessage) => void>();
  const countWaiters: Array<{ n: number; resolve: (l: CapturedLine[]) => void }> = [];
  const keyOf = (id: RpcId) => JSON.stringify(id);

  const pushLine = (buf: Buffer) => {
    const raw = buf.toString('utf8');
    const line: CapturedLine = { raw };
    try {
      line.json = JSON.parse(raw) as RpcMessage;
    } catch (err) {
      line.parseError = (err as Error).message;
    }
    lines.push(line);
    if (line.json && 'id' in line.json && line.json.id !== null && line.json.id !== undefined) {
      const w = idWaiters.get(keyOf(line.json.id));
      if (w) { idWaiters.delete(keyOf(line.json.id)); w(line.json); }
    }
    for (let i = countWaiters.length - 1; i >= 0; i--) {
      if (lines.length >= countWaiters[i].n) { countWaiters[i].resolve(lines.slice()); countWaiters.splice(i, 1); }
    }
  };

  child.stdout.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    let nl = pending.indexOf(0x0a);
    while (nl !== -1) {
      pushLine(pending.subarray(0, nl));
      pending = pending.subarray(nl + 1);
      nl = pending.indexOf(0x0a);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf8'); });

  const exit = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      // A trailing unterminated stdout fragment is itself a framing bug
      // (§1: one complete message per line); surface it as a captured line
      // so the "every line is JSON-RPC" assertions see it.
      if (pending.length > 0) { pushLine(pending); pending = Buffer.alloc(0); }
      resolve(code);
    });
  });

  const waitForLines = (n: number) =>
    withTimeout(new Promise<CapturedLine[]>((resolve) => {
      if (lines.length >= n) resolve(lines.slice());
      else countWaiters.push({ n, resolve });
    }), `waiting for ${n} stdout lines (have ${lines.length})`);

  const responseFor = (id: string | number) =>
    withTimeout(new Promise<RpcMessage>((resolve) => {
      const found = lines.find((l) => l.json && 'id' in l.json && keyOf(l.json.id ?? null) === keyOf(id));
      if (found?.json) resolve(found.json);
      else idWaiters.set(keyOf(id), resolve);
    }), `response for id ${JSON.stringify(id)}`);

  const writeRaw = (bytes: Buffer | string) =>
    new Promise<void>((resolve, reject) => {
      child.stdin.write(bytes, (err) => (err ? reject(err) : resolve()));
    });

  const request = async (id: string | number, method: string, params?: unknown) => {
    const msg: Record<string, unknown> = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;
    await writeRaw(`${JSON.stringify(msg)}\n`);
    return responseFor(id);
  };
  const notify = (method: string, params?: unknown) => {
    const msg: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  };
  const end = () => { child.stdin.end(); return withTimeout(exit, 'exit after EOF'); };
  const ready = waitForLines(1).then((ls) => {
    if (!ls[0].json) throw new Error(`first stdout line is not JSON: ${JSON.stringify(ls[0].raw)}`);
    return ls[0].json;
  });
  ready.catch(() => undefined); // observed by tests via `await s.ready`

  return { child, lines, stderr: () => stderrBuf, ready, request, notify, writeRaw, waitForLines, responseFor, end, exit };
}

/** Protocol §1: is this captured line exactly one JSON-RPC 2.0 message? */
export function isJsonRpcLine(line: CapturedLine): boolean {
  const m = line.json;
  if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return false;
  if (typeof m.method === 'string') return !('result' in m) && !('error' in m);
  return 'id' in m && ('result' in m) !== ('error' in m);
}

/**
 * A fresh temp directory holding a copy of the seven-reference-card fixture
 * as `deck.json` (so `<stem>.apkg` and `flags.json` land here, never inside
 * test/fixtures/) and a media dir holding the `slide.jpg` ref-06/ref-07
 * reference, copied from test/apkg/fixtures.
 */
export function makeReferenceCardsWorkDir(): { dir: string; deckPath: string; mediaDir: string; notes: unknown[] } {
  const dir = makeTmpDir();
  const deckPath = join(dir, 'deck.json');
  const raw = readFileSync(REFERENCE_CARDS_FIXTURE, 'utf8');
  writeFileSync(deckPath, raw);
  const mediaDir = join(dir, 'media');
  mkdirSync(mediaDir);
  writeFileSync(join(mediaDir, 'slide.jpg'), readFileSync(SLIDE_JPG_FIXTURE));
  return { dir, deckPath, mediaDir, notes: (JSON.parse(raw) as { notes: unknown[] }).notes };
}

/** Writes `content` to `<dir>/<name>` and returns the path. */
export function writeTmpFile(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

/** Extracts one zip member via the system `unzip` (no code shared with src/apkg). */
export function extractZipMember(zipPath: string, memberName: string, destDir: string): string {
  execFileSync('unzip', ['-o', '-q', zipPath, memberName, '-d', destDir]);
  return join(destDir, memberName);
}

/** Reads one zip member's decompressed bytes via `unzip -p`. */
export function readZipMember(zipPath: string, memberName: string): Buffer {
  return execFileSync('unzip', ['-p', zipPath, memberName]);
}
