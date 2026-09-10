// The line protocol between the page and the wrapper process inside the
// container.
//
// WebContainer's `spawn` gives a process a pseudo-terminal: it echoes what
// you write, and it is free to wrap, translate newlines and inject control
// sequences. JSON-RPC is newline-delimited, so a pty mangles it -- the first
// spike watched its own `initialize` come back as output. The fix is a
// wrapper inside the container that owns the real pipes and relays each line
// base64-encoded, which no terminal can rewrite:
//
//   page -> wrapper   `IN <base64 of one JSON-RPC line>`
//   wrapper -> page   `OUT <base64>` | `ERR <base64>` | `EXIT <code>`
//
// stderr is kept separate rather than discarded: the agent adapters log their
// session phases there, and that is the only view of why a session stalled.

// The .ts extension (allowImportingTsExtensions) rather than .js: Vite and
// tsc take either, and it lets `node --test` load this module straight from
// source, as site/test does.
import { decodeUtf8Base64, encodeUtf8Base64 } from '../engine/bytes.ts';

export type WrapperLine =
  | { kind: 'out'; text: string }
  | { kind: 'err'; text: string }
  | { kind: 'exit'; code: number | null };

/** One JSON-RPC line, wrapped for the trip down. */
export function encodeIn(json: string): string {
  return `IN ${encodeUtf8Base64(json)}\n`;
}

/** Parses one wrapper line, or null for anything else the terminal put on the stream. */
export function decodeLine(line: string): WrapperLine | null {
  const trimmed = line.replace(/\r/g, '').trim();
  const match = /^(OUT|ERR|EXIT)(?: (.*))?$/.exec(trimmed);
  if (!match) return null;
  const [, tag, payload = ''] = match;
  if (tag === 'EXIT') {
    // The wrapper writes the code, or nothing at all when a signal killed it.
    const code = Number(payload.trim());
    return { kind: 'exit', code: payload.trim() === '' || !Number.isFinite(code) ? null : code };
  }
  try {
    return { kind: tag === 'OUT' ? 'out' : 'err', text: decodeUtf8Base64(payload) };
  } catch {
    return null; // a truncated frame: dropped, never guessed at
  }
}

/** Splits a stream of chunks into complete lines, holding the partial tail. */
export class LineSplitter {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return lines;
  }
}
