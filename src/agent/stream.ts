// SSE decoding for `POST /chat/completions` with `stream: true`
// (docs/research/openrouter-api.md §2.4, §2.6, §2.8): `data:` lines,
// `: OPENROUTER PROCESSING` keep-alive comments skipped, `[DONE]` ends;
// plus the per-turn accumulator that folds a chunk sequence into one
// assistant message -- text, reasoning, `reasoning_details` merged by
// index, and tool-call fragments merged by `index` (a later fragment may
// omit `id`). Pure data handling: no fetch, no history, no callbacks.
import { randomUUID } from 'node:crypto';

/** One `reasoning_details[]` entry (openrouter-api.md §2.6); passed back to the model verbatim, so kept loose. */
export interface ReasoningDetail {
  type?: string;
  id?: string;
  format?: string;
  index?: number;
  text?: string;
  summary?: string;
  data?: string;
  signature?: string;
  [key: string]: unknown;
}

export interface ToolCallFragment {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface StreamDelta {
  role?: string;
  content?: string | null;
  reasoning?: string | null;
  reasoning_details?: ReasoningDetail[];
  tool_calls?: ToolCallFragment[];
}

export interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  cost?: number;
}

export interface StreamChunk {
  id?: string;
  choices?: Array<{ index?: number; delta?: StreamDelta; finish_reason?: string | null; native_finish_reason?: string | null }>;
  usage?: StreamUsage;
  error?: { code?: number; message?: string; metadata?: Record<string, unknown> };
}

/** Yields the JSON payload of each `data:` line; comments and blank lines are skipped; stops at `[DONE]` or end of body. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).replace(/\r$/, '');
      pending = pending.slice(nl + 1);
      const data = dataOf(line);
      if (data === undefined) continue;
      if (data === '[DONE]') return;
      yield data;
    }
  }
  pending += decoder.decode();
  const last = dataOf(pending.replace(/\r$/, ''));
  if (last !== undefined && last !== '[DONE]') yield last;
}

function dataOf(line: string): string | undefined {
  if (line.length === 0 || line.startsWith(':')) return undefined;
  if (!line.startsWith('data:')) return undefined;
  const data = line.slice(5).trim();
  return data.length ? data : undefined;
}

/** A completed tool call as the model asked for it. */
export interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Folds streamed deltas into one assistant message. */
export class TurnAccumulator {
  text = '';
  reasoning = '';
  finishReason: string | null = null;
  readonly reasoningDetails: ReasoningDetail[] = [];
  private readonly toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

  /** Returns the text and reasoning deltas this chunk carried, so the caller can emit them as updates. */
  apply(chunk: StreamChunk): { content: string; reasoning: string } {
    let content = '';
    let reasoning = '';
    const choice = chunk.choices?.[0];
    if (!choice) return { content, reasoning };
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) return { content, reasoning };
    if (typeof delta.content === 'string' && delta.content.length) {
      content = delta.content;
      this.text += content;
    }
    if (typeof delta.reasoning === 'string' && delta.reasoning.length) {
      reasoning = delta.reasoning;
      this.reasoning += reasoning;
    }
    if (Array.isArray(delta.reasoning_details)) for (const d of delta.reasoning_details) this.mergeReasoningDetail(d);
    if (Array.isArray(delta.tool_calls)) delta.tool_calls.forEach((f, i) => this.mergeToolCall(f, i));
    return { content, reasoning };
  }

  private mergeReasoningDetail(d: ReasoningDetail): void {
    if (typeof d !== 'object' || d === null) return;
    const existing = typeof d.index === 'number' ? this.reasoningDetails.find((e) => e.index === d.index && e.type === d.type) : undefined;
    if (!existing) {
      this.reasoningDetails.push({ ...d });
      return;
    }
    if (typeof d.text === 'string') existing.text = (existing.text ?? '') + d.text;
    if (typeof d.summary === 'string') existing.summary = (existing.summary ?? '') + d.summary;
    if (typeof d.data === 'string') existing.data = d.data;
    if (typeof d.signature === 'string') existing.signature = d.signature;
    if (typeof d.id === 'string' && !existing.id) existing.id = d.id;
    if (typeof d.format === 'string' && !existing.format) existing.format = d.format;
  }

  private mergeToolCall(f: ToolCallFragment, position: number): void {
    if (typeof f !== 'object' || f === null) return;
    const index = typeof f.index === 'number' ? f.index : position;
    let cur = this.toolCalls.get(index);
    if (!cur) {
      cur = { id: '', name: '', arguments: '' };
      this.toolCalls.set(index, cur);
    }
    if (typeof f.id === 'string' && f.id.length && !cur.id) cur.id = f.id;
    const name = f.function?.name;
    if (typeof name === 'string' && name.length) {
      if (!cur.name) cur.name = name;
      else if (name !== cur.name) cur.name += name;
    }
    const args = f.function?.arguments;
    if (typeof args === 'string') cur.arguments += args;
  }

  /** Tool calls in index order; a call that never received an `id` gets a minted one so the `tool` reply can reference it. */
  completedToolCalls(): AccumulatedToolCall[] {
    return [...this.toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => ({ id: c.id || `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`, name: c.name, arguments: c.arguments }));
  }
}
