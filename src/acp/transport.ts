// Bidirectional JSON-RPC-over-stdio transport for one spawned ACP agent
// subprocess: request/response correlation (id -> pending promise) for
// requests *we* send, callbacks for requests and notifications the *agent*
// sends us, and a close() that always reaps the child. Protocol-agnostic on
// purpose -- no ACP method names, session/prompt/permission semantics, or
// param shapes live here (see this file's owning task); everything above
// this layer is built by composing request()/notify()/onRequest()/
// onNotification() with whatever method names and params ACP defines.
//
// Framing (line splitting, JSON-RPC 2.0 shape validation) is entirely
// framing.ts's job -- this file only decides what a decoded message, a
// framing error, or the child dying *means* for whatever is in flight.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';

import {
  encodeRequest,
  encodeNotification,
  encodeSuccessResponse,
  encodeErrorResponse,
  FrameDecoder,
  type DecodedLine,
  type DecodedMessage,
  type FramingError,
  type JsonRpcErrorObject,
  type RequestId,
} from './framing.js';

export type { RequestId, JsonRpcErrorObject } from './framing.js';

export interface SpawnAgentOptions {
  /** Executable to run -- an absolute path, or anything resolvable the way node:child_process.spawn normally resolves a command. */
  command: string;
  args?: string[];
  /**
   * Merged *over* this process's own env, never a replacement -- a caller
   * supplying one or two extra variables (as every test fixture in this
   * repo does) must not strip PATH/HOME/etc. out from under the spawned
   * agent as a side effect.
   */
  env?: Record<string, string>;
  cwd?: string;
}

/** A request the agent sent to us (e.g. session/request_permission, fs/read_text_file). Answer it via respond()/respondError(), keyed by `id`. */
export type IncomingRequestHandler = (method: string, params: unknown, id: RequestId) => void;
/** A notification the agent sent us (chiefly session/update). */
export type NotificationHandler = (method: string, params: unknown) => void;
/** Fires exactly once, when the connection stops being usable. `error` is undefined for a caller-initiated close() and set for anything else (the agent process exiting or erroring on its own). */
export type CloseHandler = (error: Error | undefined) => void;

/**
 * Rejects a still-pending request when the *connection itself* failed --
 * the agent process exited or errored, or a line on the wire didn't parse
 * (framing.ts's FramingError) -- so it can never be answered now. This is
 * distinct from a request the agent answered normally with a JSON-RPC error
 * object, which rejects instead with a plain Error carrying `.code` (and
 * `.data`, if present) copied from that object -- see toJsonRpcError below
 * -- so callers can match on the ACP error codes in
 * docs/research/acp-protocol.md #15 the same way they would against any
 * other JSON-RPC peer.
 */
export class AcpTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AcpTransportError';
  }
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

// How long close() waits for the agent to exit on its own after stdin ends
// before escalating to SIGTERM, and then SIGTERM before escalating to
// SIGKILL. Generous on purpose: these only matter for a misbehaving agent
// -- a well-behaved one (every fixture in this repo included) exits within
// milliseconds of seeing EOF on stdin.
const SIGTERM_AFTER_MS = 2000;
const SIGKILL_AFTER_MS = 1000;

function toJsonRpcError(error: JsonRpcErrorObject): Error {
  return Object.assign(new Error(error.message), { code: error.code, data: error.data });
}

/**
 * Resolves true if `p` settles (fulfills OR rejects) within `ms`, false if
 * the timer wins first -- never rejects itself, and always clears its own
 * timer either way so a fast settle doesn't leave a dangling handle.
 *
 * `p` is always the `once(child, 'exit')`-derived promise from shutdown()
 * below, which node:events' `once()` specifically documents as REJECTING if
 * the emitter fires 'error' before the awaited event -- a spawn failure
 * (ENOENT et al.) does exactly that. That still means the child is gone, so
 * a rejection is treated the same as a fulfillment here. Attaching only an
 * onFulfilled handler (`p.then(fn)` with no second argument) would leave the
 * promise THAT CALL produces with no rejection handler of its own -- an
 * unhandled rejection the moment `p` rejects, which is fatal to a Node
 * process with no global unhandledRejection listener.
 */
function withinMs(p: Promise<void>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    const settle = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    p.then(settle, settle);
  });
}

export class AcpTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly decoder = new FrameDecoder();
  // Keyed on the *string* form of the id we minted, not the number itself --
  // see settlePending() below for why.
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 0;
  private closing = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private requestHandler: IncomingRequestHandler | undefined;
  private notificationHandler: NotificationHandler | undefined;
  private closeHandler: CloseHandler | undefined;

  constructor(options: SpawnAgentOptions) {
    this.child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
    });

    // Every stream/emitter that could ever fire 'error' gets a listener --
    // an unhandled 'error' event is one of the few things in Node that
    // crashes the process outright, and a pipe to an agent that already
    // died (EPIPE) or was never spawned at all (ENOENT et al.) is exactly
    // the kind of ordinary failure this transport must survive.
    this.child.on('error', (err) => this.markClosed(err));
    this.child.stdin.on('error', () => {});
    this.child.stdout.on('error', () => {});
    this.child.stderr.on('error', () => {});
    // docs/research/acp-protocol.md #2: stderr is the agent's own log
    // output, never protocol data. `.resume()` with no 'data' listener
    // actively drains and discards it -- not reading it at all risks the
    // agent blocking on a full stderr pipe if it ever logs a lot.
    this.child.stderr.resume();

    this.child.on('exit', (code, signal) => {
      this.markClosed(
        this.closing
          ? undefined
          : new AcpTransportError(`agent process exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`),
      );
    });

    this.child.stdout.on('data', (chunk: Buffer) => {
      for (const decoded of this.decoder.push(chunk)) this.handleLine(decoded);
    });
    this.child.stdout.on('end', () => {
      for (const decoded of this.decoder.end()) this.handleLine(decoded);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /**
   * Sends a JSON-RPC request and resolves with its `result` once the agent
   * answers. Rejects with a plain Error carrying `.code` (and `.data`, if
   * present) if the agent answers with a JSON-RPC error instead; rejects
   * with AcpTransportError if the connection closes, the agent process
   * exits, or the wire desyncs before any answer arrives.
   */
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new AcpTransportError(`cannot send "${method}": the transport is closed`));
    }
    const id = this.nextId++;
    const key = String(id);
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(key, { resolve, reject });
      this.write(encodeRequest(id, method, params), (err) => {
        const pending = this.pending.get(key);
        if (!pending) return; // already settled by a real response that raced the write callback
        this.pending.delete(key);
        pending.reject(new AcpTransportError(`failed to send "${method}" to the agent`, { cause: err }));
      });
    });
  }

  /** Sends a one-way JSON-RPC notification. Silently does nothing once the transport is closed -- a fire-and-forget call has no promise to reject and nothing meaningful to do differently. */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write(encodeNotification(method, params));
  }

  /** Answers a request the agent sent us (see onRequest) with a success result. */
  respond(id: RequestId, result: unknown): void {
    if (this.closed) return;
    this.write(encodeSuccessResponse(id, result));
  }

  /** Answers a request the agent sent us (see onRequest) with a JSON-RPC error. */
  respondError(id: RequestId, error: JsonRpcErrorObject): void {
    if (this.closed) return;
    this.write(encodeErrorResponse(id, error));
  }

  /** The single handler for requests the agent sends us (e.g. session/request_permission). One handler, set once -- a transport has exactly one owner. */
  onRequest(handler: IncomingRequestHandler): void {
    this.requestHandler = handler;
  }

  /** The single handler for notifications the agent sends us (chiefly session/update). */
  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  /** The single handler invoked once, when the connection ends (see CloseHandler). */
  onClose(handler: CloseHandler): void {
    this.closeHandler = handler;
  }

  /**
   * Ends stdin so a well-behaved agent exits on its own, waits for it to
   * actually exit, and escalates to SIGTERM then SIGKILL if it doesn't.
   * Never rejects -- safe to call more than once (every call after the
   * first returns the same promise) and safe to call after the child has
   * already exited on its own.
   */
  close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      this.closePromise = this.shutdown();
    }
    return this.closePromise;
  }

  private async shutdown(): Promise<void> {
    if (!this.hasExited()) {
      const exited = once(this.child, 'exit').then(() => {});
      this.endStdinQuietly();
      if (!(await withinMs(exited, SIGTERM_AFTER_MS))) {
        this.killQuietly('SIGTERM');
        if (!(await withinMs(exited, SIGKILL_AFTER_MS))) {
          this.killQuietly('SIGKILL');
          // `exited` can still be the rejected promise described on
          // withinMs() above (an 'error' event with no 'exit' ever
          // following) -- close() is documented to never reject, and
          // SIGKILL has already been sent regardless, so swallow it here
          // rather than let it propagate out of shutdown().
          await exited.catch(() => {});
        }
      }
    }
    this.markClosed(undefined); // no-op if the 'exit' listener above already ran (the normal case)
    this.destroyStreamsQuietly();
  }

  private hasExited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  private endStdinQuietly(): void {
    try {
      if (!this.child.stdin.destroyed) this.child.stdin.end();
    } catch {
      // already closed / EPIPE -- fine, we're shutting down anyway
    }
  }

  private killQuietly(signal: NodeJS.Signals): void {
    try {
      if (!this.hasExited()) this.child.kill(signal);
    } catch {
      // process already gone between our check and the signal
    }
  }

  private destroyStreamsQuietly(): void {
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      try {
        if (!stream.destroyed) stream.destroy();
      } catch {
        // best-effort cleanup only
      }
    }
  }

  private write(text: string, onError?: (err: Error) => void): void {
    if (this.child.stdin.destroyed) {
      onError?.(new AcpTransportError('cannot write: stdin is already closed'));
      return;
    }
    try {
      this.child.stdin.write(text, 'utf8', (err) => {
        if (err) onError?.(err);
      });
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private handleLine(decoded: DecodedLine): void {
    if (decoded.ok) {
      this.dispatch(decoded.message);
    } else {
      this.failPendingOnFramingError(decoded.error);
    }
  }

  private dispatch(message: DecodedMessage): void {
    try {
      switch (message.kind) {
        case 'response':
          this.settlePending(message.id, (p) => p.resolve(message.result));
          return;
        case 'error-response':
          this.settlePending(message.id, (p) => p.reject(toJsonRpcError(message.error)));
          return;
        case 'notification':
          this.notificationHandler?.(message.method, message.params);
          return;
        case 'request':
          this.requestHandler?.(message.method, message.params, message.id);
          return;
      }
    } catch (err) {
      // A bug in a consumer-supplied handler must not take down the whole
      // process from inside a stdout 'data' callback.
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`acp transport: handler for "${message.kind}" threw: ${detail}\n`);
    }
  }

  /**
   * We mint only numeric ids (see `nextId` above), but JSON-RPC 2.0 only
   * requires a response's `id` to *equal* the request's -- not to preserve
   * its exact JS type -- and framing.ts already types a received `RequestId`
   * as `string | number | null` for exactly that reason: an agent that
   * echoes our numeric id back as e.g. `"3"` instead of `3` is still
   * answering request 3, not sending garbage. Correlating on the string form
   * of the id (rather than requiring `typeof id === 'number'`) means that
   * kind of type-coerced echo still resolves the right pending request
   * instead of leaving it hanging forever with no timeout and no diagnostic.
   */
  private settlePending(id: RequestId, settle: (p: PendingRequest) => void): void {
    if (id === null) {
      // We never send a request with a null id, so this can never correlate
      // to anything pending -- but it's still worth a trace rather than a
      // mute drop; see the stderr write below for why.
      process.stderr.write(`acp transport: got a response with id null, which this client never uses as a request id -- ignoring\n`);
      return;
    }
    const key = String(id);
    const pending = this.pending.get(key);
    if (!pending) {
      // Either a duplicate/late reply to a request that already settled, or
      // an id this client never issued at all. Not fatal -- the connection
      // stays open -- but silently dropping it here is exactly what turns a
      // misbehaving agent into an unbounded, undiagnosable hang for whoever
      // was actually waiting on the id that never came back; one line on
      // stderr is enough to make that debuggable.
      process.stderr.write(`acp transport: response id ${JSON.stringify(id)} does not correlate to any pending request (already settled, or never issued)\n`);
      return;
    }
    this.pending.delete(key);
    settle(pending);
  }

  private failPendingOnFramingError(error: FramingError): void {
    // We cannot tell which in-flight request (if any) this garbled line was
    // meant to answer -- docs/research/acp-protocol.md #2 says the agent
    // "MUST NOT write anything to its stdout that is not a valid ACP
    // message", so if it does anyway, no pending caller can trust an answer
    // is still coming. Fail everything currently waiting rather than let
    // one hang forever; the connection itself stays open (this is not a
    // process exit), since a bad line doesn't necessarily desync framing
    // for whatever the agent sends next.
    //
    // The raw offending text is captured on FramingError specifically for
    // diagnostics (framing.ts's `.raw`); surface it here -- the same way
    // dispatch() below already reports a throwing handler -- so the most
    // common real-world integration failure (an agent that logs a stray
    // line to stdout instead of stderr) is debuggable from one stderr line
    // instead of a rejection with no context.
    process.stderr.write(`acp transport: ${error.message}: ${error.raw}\n`);
    this.rejectAllPending(new AcpTransportError(`invalid data from agent: ${error.message}`, { cause: error }));
  }

  private rejectAllPending(error: Error): void {
    if (this.pending.size === 0) return;
    const toReject = [...this.pending.values()];
    this.pending.clear();
    for (const p of toReject) p.reject(error);
  }

  private markClosed(error: Error | undefined): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAllPending(error ?? new AcpTransportError('the transport was closed'));
    this.closeHandler?.(error);
  }
}
