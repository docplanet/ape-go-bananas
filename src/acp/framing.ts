// JSON-RPC 2.0 wire framing for ACP: encode a message as exactly one
// newline-terminated UTF-8 JSON line, and decode a byte stream back into
// messages, tolerating partial reads and multiple messages per chunk.
// Every rule here is transcribed from docs/research/acp-protocol.md #2
// ("Transport") and #3 ("JSON-RPC 2.0 conventions"), not assumed:
//
//   - one JSON value per line, delimited by '\n', never embedding a raw
//     newline inside a line (#2's "Framing checklist" -- JSON.stringify's
//     own \-escaping of control characters inside string values, combined
//     with never passing it a `space` argument, is what guarantees this);
//   - no Content-Length/Content-Type framing -- that's LSP, not ACP;
//   - a notification OMITS `id` entirely -- not present, not null (#3,
//     quoting the schema's own RequestId doc: "If it is not included it is
//     assumed to be a notification").
//
// Deliberately narrow: no ACP method names, session/prompt/permission
// semantics, or param shapes live here (see this file's owning task) --
// only the generic JSON-RPC 2.0 envelope and the newline framing around it.
//
// The decoder never throws on bad input and never drops it silently: a line
// that isn't valid JSON, or doesn't match one of the four JSON-RPC 2.0
// shapes (request / notification / success response / error response),
// comes back as a typed FramingError instead of a parsed message. What that
// *means* for in-flight work is transport.ts's call, not this module's --
// this file's only job is to never let a bad line crash the process or
// vanish without a trace.

/**
 * JSON-RPC's own id type (the schema's `RequestId`): a string, a number, or
 * null. ACP agents/clients only ever mint string or number ids in practice
 * -- null is spec-legal but discouraged (#3) -- this stays permissive on
 * the *receiving* end regardless, since we don't get to pick what an agent
 * sends.
 */
export type RequestId = string | number | null;

/** The standard JSON-RPC 2.0 error object shape (#15). */
export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** One fully-parsed, shape-validated JSON-RPC 2.0 message, tagged by kind for easy dispatch. */
export type DecodedMessage =
  | { kind: 'request'; id: RequestId; method: string; params: unknown }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'response'; id: RequestId; result: unknown }
  | { kind: 'error-response'; id: RequestId; error: JsonRpcErrorObject };

/**
 * A line that arrived on the wire but could not be turned into a
 * DecodedMessage -- either it wasn't valid JSON, or it parsed but doesn't
 * match any of the four JSON-RPC 2.0 message shapes. `raw` is the exact
 * text that failed, kept for diagnostics (e.g. logging what an agent
 * actually sent).
 */
export class FramingError extends Error {
  readonly raw: string;

  constructor(message: string, raw: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'FramingError';
    this.raw = raw;
  }
}

/** The result of decoding one line: either it worked, or it didn't -- never a throw. */
export type DecodedLine = { ok: true; message: DecodedMessage } | { ok: false; error: FramingError };

// ---- encoding --------------------------------------------------------------
//
// Each function returns the exact bytes to write to the agent's stdin: one
// JSON.stringify()'d value with no `space` argument (so it never contains
// literal whitespace *between* tokens -- pretty-printing is exactly what
// framing.test.ts's "no pretty-printing, no embedded newline" case forbids)
// plus a single trailing '\n'. A `params`/`data` value left `undefined` is
// omitted from the object entirely -- JSON.stringify's own behavior for
// object properties -- which is what lets encodeNotification(method) work
// with no params at all, and is exactly how a notification's object ends up
// with no `id` key: the type itself never has one to begin with.

function line(value: unknown): string {
  return JSON.stringify(value) + '\n';
}

export function encodeRequest(id: RequestId, method: string, params?: unknown): string {
  return line({ jsonrpc: '2.0', id, method, params });
}

/** A notification's object has no `id` key at all -- not present, not null (#3). */
export function encodeNotification(method: string, params?: unknown): string {
  return line({ jsonrpc: '2.0', method, params });
}

export function encodeSuccessResponse(id: RequestId, result: unknown): string {
  return line({ jsonrpc: '2.0', id, result });
}

export function encodeErrorResponse(id: RequestId, error: JsonRpcErrorObject): string {
  return line({ jsonrpc: '2.0', id, error });
}

// ---- decoding ----------------------------------------------------------------

function isRequestId(value: unknown): value is RequestId {
  return value === null || typeof value === 'string' || typeof value === 'number';
}

function isErrorObject(value: unknown): value is JsonRpcErrorObject {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.code === 'number' && typeof obj.message === 'string';
}

/** Classifies an already-JSON.parse()'d value as one of the four JSON-RPC 2.0 message shapes, or `undefined` if it matches none of them. */
function classify(value: unknown): DecodedMessage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  if (obj.jsonrpc !== '2.0') return undefined;

  if (typeof obj.method === 'string') {
    if ('id' in obj) {
      return isRequestId(obj.id) ? { kind: 'request', id: obj.id, method: obj.method, params: obj.params } : undefined;
    }
    return { kind: 'notification', method: obj.method, params: obj.params };
  }

  if ('id' in obj && isRequestId(obj.id)) {
    const hasResult = 'result' in obj;
    const hasError = 'error' in obj;
    if (hasResult && !hasError) return { kind: 'response', id: obj.id, result: obj.result };
    if (hasError && !hasResult && isErrorObject(obj.error)) {
      return { kind: 'error-response', id: obj.id, error: obj.error };
    }
  }
  return undefined;
}

function decodeLine(text: string): DecodedLine | undefined {
  // Blank lines are tolerated, not reported -- this mirrors both test
  // fixtures' own line readers on the other end of this pipe (mock-agent.ts
  // / raw-agent.ts: `if (line.length > 0) onLine(line);`), and a stray
  // blank line is harmless noise, not a protocol violation worth failing
  // in-flight work over.
  if (text.trim().length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    return { ok: false, error: new FramingError('invalid JSON on the wire', text, cause) };
  }
  const message = classify(value);
  if (!message) {
    return { ok: false, error: new FramingError('valid JSON but not a JSON-RPC 2.0 request, notification, or response', text) };
  }
  return { ok: true, message };
}

/**
 * Stateful newline-delimited decoder: feed it raw bytes as they arrive from
 * the agent's stdout, in whatever chunks the OS/pipe happens to deliver
 * them in -- a line split across two chunks, several lines in one chunk,
 * one byte at a time -- all handled the same way.
 *
 * Byte-level throughout: it searches for the single-byte newline (0x0A),
 * which UTF-8 guarantees never appears as part of a multi-byte sequence, so
 * a multi-byte character split across a chunk boundary is never at risk of
 * being mis-decoded there. Each complete line is decoded to a UTF-8 string
 * only once every one of its bytes is in hand.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  /** Feeds newly-arrived bytes; returns every complete line found, in wire order. Bytes with no trailing '\n' yet are held for the next push(). */
  push(chunk: Buffer): DecodedLine[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const results: DecodedLine[] = [];
    let newlineIndex = this.buffer.indexOf(0x0a);
    while (newlineIndex !== -1) {
      const text = this.buffer.subarray(0, newlineIndex).toString('utf8');
      this.buffer = this.buffer.subarray(newlineIndex + 1);
      const decoded = decodeLine(text);
      if (decoded) results.push(decoded);
      newlineIndex = this.buffer.indexOf(0x0a);
    }
    return results;
  }

  /**
   * Call once when the underlying stream ends. Bytes left in the buffer at
   * that point are a final message the agent never terminated with '\n' --
   * surfaced as a decode error rather than silently dropped, unless they're
   * empty/whitespace (the ordinary case: every message ended cleanly).
   */
  end(): DecodedLine[] {
    const leftover = this.buffer.toString('utf8');
    this.buffer = Buffer.alloc(0);
    if (leftover.trim().length === 0) return [];
    return [{ ok: false, error: new FramingError('stream ended mid-line: a final message with no trailing newline', leftover) }];
  }
}
