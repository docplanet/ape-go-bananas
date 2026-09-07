// A local stand-in for OpenRouter, written from docs/research/openrouter-api.md
// (wire shapes quoted inline) and docs/research/agent-protocol.md §2/§4, by a
// context that has not seen src/agent/ or src/sidecar/agent*. The test and the
// fake share one process: a test preloads `queue` with scripted
// /chat/completions answers, points the sidecar here through env
// APE_OPENROUTER_BASE_URL, and reads back every request body from `requests`.
//
// Served surface (openrouter-api.md):
//   GET  /key              §1  -- 200 `{data:{...}}` for the good key, else 401 `{error:{code,message}}`
//   GET  /models           §3  -- `{data: Model[]}`; honours `supported_parameters` /
//                                 `input_modalities` query filters so a sidecar that
//                                 filters server-side and one that filters itself both pass
//   POST /chat/completions §2  -- the next queued script: SSE per §2.4, a mid-stream
//                                 error per §2.8, or a plain non-2xx JSON error per §2.8
// Paths are matched by suffix so the base URL may or may not carry `/api/v1`.
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const GOOD_KEY = 'good-key';

export interface FakeModel {
  id: string;
  name: string;
  context_length: number;
  input_modalities: string[];
  supported_parameters: string[];
  pricing: { prompt: string; completion: string };
}

// Per-token USD strings (§3: "Pricing values are strings"), chosen so that
// "<price> * 1e6" is an exact integer and the agent-protocol §2 option name
// ("<name> · $<prompt>/M in · $<completion>/M out") is unambiguous.
export const MODEL_REASONER: FakeModel = {
  id: 'zeta/omni-reasoner',
  name: 'Zeta: Omni Reasoner',
  context_length: 200_000,
  input_modalities: ['text', 'image', 'file'],
  supported_parameters: ['max_tokens', 'reasoning', 'temperature', 'tool_choice', 'tools'],
  pricing: { prompt: '0.000003', completion: '0.000015' },
};
export const MODEL_VISION: FakeModel = {
  id: 'alpha/vision-tools',
  name: 'Alpha: Vision Tools',
  context_length: 128_000,
  input_modalities: ['text', 'image'],
  supported_parameters: ['max_tokens', 'temperature', 'tool_choice', 'tools'],
  pricing: { prompt: '0.000001', completion: '0.000002' },
};
/** Sees images but takes no tools: agent-protocol §2 says it must not be offered. */
export const MODEL_NO_TOOLS: FakeModel = {
  id: 'beta/chatty',
  name: 'Beta: Chatty',
  context_length: 32_000,
  input_modalities: ['text', 'image'],
  supported_parameters: ['max_tokens', 'temperature'],
  pricing: { prompt: '0.0000002', completion: '0.0000004' },
};
/** Takes tools but no images: the other half of §2's filter ("and whose input_modalities includes image"). */
export const MODEL_TEXT_ONLY: FakeModel = {
  id: 'gamma/text-tools',
  name: 'Gamma: Text Tools',
  context_length: 64_000,
  input_modalities: ['text'],
  supported_parameters: ['max_tokens', 'tools', 'tool_choice'],
  pricing: { prompt: '0.000001', completion: '0.000001' },
};
export const MODELS: FakeModel[] = [MODEL_REASONER, MODEL_NO_TOOLS, MODEL_VISION, MODEL_TEXT_ONLY];

/** The `/models` entry shape of openrouter-api.md §3, trimmed to the fields a sidecar reads. */
function modelEntry(m: FakeModel): Record<string, unknown> {
  return {
    id: m.id,
    canonical_slug: m.id,
    name: m.name,
    created: 1_759_161_676,
    description: `fake model ${m.id}`,
    context_length: m.context_length,
    architecture: {
      modality: `${m.input_modalities.join('+')}->text`,
      input_modalities: m.input_modalities,
      output_modalities: ['text'],
      tokenizer: 'Other',
      instruct_type: null,
    },
    pricing: { ...m.pricing, request: '0', image: '0' },
    top_provider: { context_length: m.context_length, max_completion_tokens: 8192, is_moderated: false },
    per_request_limits: null,
    supported_parameters: m.supported_parameters,
  };
}

// ---- SSE scripting (§2.4) --------------------------------------------------

export type SseEvent = { comment: string } | { data: unknown } | { done: true };

/** One scripted answer to POST /chat/completions. `events` makes it an SSE stream; `json` a plain body. */
export interface Scripted {
  status?: number;
  json?: unknown;
  events?: SseEvent[];
  /** Pause before each event, for the cancel test. */
  delayMs?: number;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number;
  prompt_tokens_details: { cached_tokens: number };
  completion_tokens_details: { reasoning_tokens: number };
}

export const DEFAULT_USAGE: Usage = {
  prompt_tokens: 120,
  completion_tokens: 30,
  total_tokens: 150,
  cost: 0.00123,
  prompt_tokens_details: { cached_tokens: 40 },
  completion_tokens_details: { reasoning_tokens: 7 },
};

export const PROCESSING: SseEvent = { comment: 'OPENROUTER PROCESSING' };
export const DONE: SseEvent = { done: true };

let genCounter = 0;
function envelope(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `gen-fake-${++genCounter}`,
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'fake/model',
    provider: 'Fake',
    ...extra,
  };
}

/** A `choices[0].delta` chunk (§2.4). `finish` lands on the choice, never inside the delta. */
export function chunk(delta: Record<string, unknown>, finish: string | null = null): SseEvent {
  return { data: envelope({ choices: [{ index: 0, delta, finish_reason: finish, native_finish_reason: finish, logprobs: null }] }) };
}

/**
 * §2.4 verbatim: "every stream ends with an extra chunk that carries the
 * `usage` object ... one choice with a content-free `delta` that repeats the
 * `finish_reason`".
 */
export function usageChunk(finish: string, usage: Usage = DEFAULT_USAGE): SseEvent {
  return {
    data: envelope({
      choices: [{ index: 0, delta: { content: '', role: 'assistant' }, finish_reason: finish, native_finish_reason: finish }],
      usage,
    }),
  };
}

/** Splits `text` into `pieces` chunks of roughly equal length (at least one). */
export function splitText(text: string, pieces: number): string[] {
  const out: string[] = [];
  const n = Math.max(1, Math.min(pieces, text.length || 1));
  const size = Math.ceil(text.length / n);
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}

/** A plain assistant reply streamed as several `delta.content` chunks, with the §2.4 comment lines, terminal chunk, usage chunk and [DONE]. */
export function textTurn(text: string, opts: { pieces?: number; usage?: Usage; reasoning?: string[] } = {}): Scripted {
  const events: SseEvent[] = [PROCESSING];
  for (const r of opts.reasoning ?? []) events.push(chunk({ reasoning: r }));
  const parts = splitText(text, opts.pieces ?? 3);
  parts.forEach((p, i) => {
    if (i === 1) events.push(PROCESSING); // keep-alives "arrive at any time"
    events.push(chunk(i === 0 ? { role: 'assistant', content: p } : { content: p }));
  });
  events.push(chunk({ content: '', role: 'assistant' }, 'stop'));
  events.push(usageChunk('stop', opts.usage ?? DEFAULT_USAGE));
  events.push(DONE);
  return { events };
}

export interface ScriptedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * An assistant turn that requests tool calls (§2.3), OpenAI-style deltas:
 * each call's `index`/`id`/`type`/`function.name` arrive once, then its
 * `function.arguments` JSON arrives in fragments; the terminal chunk says
 * `finish_reason: "tool_calls"`.
 */
export function toolCallsTurn(calls: ScriptedToolCall[], opts: { reasoningDetails?: unknown[]; usage?: Usage } = {}): Scripted {
  const events: SseEvent[] = [PROCESSING];
  if (opts.reasoningDetails) events.push(chunk({ role: 'assistant', reasoning_details: opts.reasoningDetails }));
  calls.forEach((c, index) => {
    const json = JSON.stringify(c.args);
    events.push(chunk({ role: 'assistant', content: null, tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] }));
    for (const frag of splitText(json, 3)) events.push(chunk({ tool_calls: [{ index, function: { arguments: frag } }] }));
  });
  events.push(chunk({}, 'tool_calls'));
  events.push(usageChunk('tool_calls', opts.usage ?? DEFAULT_USAGE));
  events.push(DONE);
  return { events };
}

/** §2.8 mid-stream error: HTTP stays 200, an `error` chunk with `choices[0].finish_reason: "error"`, after some content. */
export function midStreamError(message: string, code = 429, before = 'partial '): Scripted {
  return {
    events: [
      PROCESSING,
      chunk({ role: 'assistant', content: before }),
      {
        data: envelope({
          error: { code, message, metadata: { error_type: 'rate_limit_exceeded' } },
          choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
        }),
      },
      DONE,
    ],
  };
}

/** §2.8 plain error body: `{ error: { code, message, metadata? } }` with the matching HTTP status. */
export function httpError(status: number, message: string, errorType = 'unmapped'): Scripted {
  return { status, json: { error: { code: status, message, metadata: { error_type: errorType } } } };
}

/** `chunks` streamed one every `delayMs`, so a cancel lands mid-stream. */
export function slowTextTurn(chunks: string[], delayMs: number): Scripted {
  const events: SseEvent[] = chunks.map((c, i) => chunk(i === 0 ? { role: 'assistant', content: c } : { content: c }));
  events.push(chunk({ content: '', role: 'assistant' }, 'stop'), usageChunk('stop'), DONE);
  return { events, delayMs };
}

// ---- the server --------------------------------------------------------------

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  /** Parsed JSON body, or the raw text when it is not JSON, or null when empty. */
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- request bodies are asserted field by field
  at: number;
  /** True when the client dropped the connection before the fake finished writing. */
  aborted: boolean;
}

export interface FakeOpenRouter {
  baseUrl: string;
  requests: RecordedRequest[];
  queue: Scripted[];
  /** Answers /chat/completions when the queue is empty (the "always tool_calls" fake). */
  fallback: ((req: RecordedRequest) => Scripted) | null;
  enqueue: (...scripts: Scripted[]) => void;
  chatRequests: () => RecordedRequest[];
  reset: () => void;
  close: () => Promise<void>;
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer (.+)$/.exec(h);
  return m ? m[1] : null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function sseLine(ev: SseEvent): string {
  if ('comment' in ev) return `: ${ev.comment}\n\n`;
  if ('done' in ev) return 'data: [DONE]\n\n';
  return `data: ${JSON.stringify(ev.data)}\n\n`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function serveScript(script: Scripted, rec: RecordedRequest, res: ServerResponse): Promise<void> {
  if (!script.events) {
    sendJson(res, script.status ?? 200, script.json ?? {});
    return;
  }
  let finished = false;
  res.on('close', () => { if (!finished) rec.aborted = true; });
  res.writeHead(script.status ?? 200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  for (const ev of script.events) {
    if (script.delayMs) await sleep(script.delayMs);
    if (rec.aborted || res.destroyed) return;
    res.write(sseLine(ev));
  }
  finished = true;
  res.end();
}

export async function startFakeOpenRouter(): Promise<FakeOpenRouter> {
  const requests: RecordedRequest[] = [];
  const queue: Scripted[] = [];
  const state: { fallback: FakeOpenRouter['fallback'] } = { fallback: null };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const text = await readBody(req);
    let body: unknown = null;
    if (text.length) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    const rec: RecordedRequest = { method: req.method ?? '', path: url.pathname, query: url.searchParams, headers: req.headers, body, at: Date.now(), aborted: false };
    requests.push(rec);

    if (req.method === 'GET' && url.pathname.endsWith('/key')) {
      if (bearer(req) !== GOOD_KEY) {
        sendJson(res, 401, { error: { code: 401, message: 'Invalid credentials (OAuth session expired, disabled/invalid API key)', metadata: { error_type: 'authentication' } } });
        return;
      }
      sendJson(res, 200, { data: { label: 'sk-or-v1-fak...key', limit: null, limit_remaining: null, limit_reset: null, usage: 0, usage_daily: 0, usage_weekly: 0, usage_monthly: 0, is_free_tier: false, is_management_key: false, is_provisioning_key: false } });
      return;
    }
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      // §3 query params, applied only when present: every listed value must be supported.
      const want = (url.searchParams.get('supported_parameters') ?? '').split(',').filter(Boolean);
      const mods = (url.searchParams.get('input_modalities') ?? '').split(',').filter(Boolean);
      const data = MODELS.filter((m) => want.every((p) => m.supported_parameters.includes(p)) && mods.every((p) => m.input_modalities.includes(p))).map(modelEntry);
      sendJson(res, 200, { data });
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      if (bearer(req) !== GOOD_KEY) {
        sendJson(res, 401, { error: { code: 401, message: 'Invalid credentials (OAuth session expired, disabled/invalid API key)', metadata: { error_type: 'authentication' } } });
        return;
      }
      const script = queue.shift() ?? state.fallback?.(rec);
      if (!script) {
        sendJson(res, 500, { error: { code: 500, message: 'fake-openrouter: no scripted response queued for this request', metadata: { error_type: 'server' } } });
        return;
      }
      await serveScript(script, rec, res);
      return;
    }
    sendJson(res, 404, { error: { code: 404, message: `fake-openrouter: no route for ${req.method} ${url.pathname}`, metadata: { error_type: 'not_found' } } });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: { code: 500, message: String(err) } });
      else res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const fake: FakeOpenRouter = {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    requests,
    queue,
    get fallback() { return state.fallback; },
    set fallback(f) { state.fallback = f; },
    enqueue: (...scripts) => { queue.push(...scripts); },
    chatRequests: () => requests.filter((r) => r.method === 'POST' && r.path.endsWith('/chat/completions')),
    reset: () => { requests.length = 0; queue.length = 0; state.fallback = null; },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
  return fake;
}
