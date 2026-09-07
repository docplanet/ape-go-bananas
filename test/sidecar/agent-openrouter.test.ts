// agent-protocol.md §2 (the `openrouter` paths of agent/connect, agent/prompt,
// agent/cancel, agent/setMode, agent/setConfigOption) and §4 (the embedded
// loop: messages, blocks, reasoning, streaming, usage, errors, cancel) against
// the built sidecar and the in-process fake in fake-openrouter.ts. Tool calls
// and permissions are in agent-openrouter-tools.test.ts. Written from the spec
// by a context that has not seen src/agent/ or src/sidecar/agent*.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

import {
  MODEL_REASONER,
  MODEL_VISION,
  DEFAULT_USAGE,
  httpError,
  midStreamError,
  slowTextTurn,
  startFakeOpenRouter,
  textTurn,
  type FakeOpenRouter,
} from './fake-openrouter.ts';
import { TIMEOUT, sweepSidecars } from './helpers.ts';
import {
  GOOD_KEY,
  assertKeyHygiene,
  chunkText,
  connectGood,
  expectError,
  expectStop,
  freshId,
  makeSessionDirs,
  ofKind,
  runPrompt,
  spawnOpenRouterSidecar,
  systemBlock,
  text,
  textOf,
  updatesOf,
  waitFor,
  type ConnectResult,
  type SelectOption,
} from './openrouter-helpers.ts';

let fake: FakeOpenRouter;
before(async () => { fake = await startFakeOpenRouter(); });
beforeEach(() => fake.reset());
after(() => { sweepSidecars(); assertKeyHygiene(); return fake.close(); });

// §2: option name is "<name> · $<prompt>/M in · $<completion>/M out", prices
// per token ("0.000003") shown per million ("$3/M").
const perM = (perToken: string) => `$${Number(perToken) * 1e6}/M`;
const optionName = (m: { name: string; pricing: { prompt: string; completion: string } }) => `${m.name} · ${perM(m.pricing.prompt)} in · ${perM(m.pricing.completion)} out`;

/** §2, verbatim: the two selects an openrouter session exposes at connect time. */
const EXPECTED_CONFIG_OPTIONS: SelectOption[] = [
  {
    id: 'model',
    type: 'select',
    name: 'Model',
    // Filtered to tools + image (drops beta/chatty and gamma/text-tools),
    // sorted by name: "Alpha: ..." before "Zeta: ...". The spec's default
    // `anthropic/claude-sonnet-4.5` is not listed, so the first is current.
    currentValue: MODEL_VISION.id,
    options: [
      { value: MODEL_VISION.id, name: optionName(MODEL_VISION) },
      { value: MODEL_REASONER.id, name: optionName(MODEL_REASONER) },
    ],
  },
  {
    id: 'effort',
    type: 'select',
    name: 'Reasoning effort',
    currentValue: 'medium',
    options: [{ value: 'none', name: 'None' }, { value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }],
  },
];
const EXPECTED_MODES = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Manual', description: 'Always ask before writing files' },
    { id: 'acceptEdits', name: 'Accept edits', description: 'Write files without asking' },
  ],
};

const SYSTEM = 'You are the course assistant. Answer from the material.';

test('agent/connect openrouter without apiKey is -32602 naming the field (§2)', { timeout: TIMEOUT }, async () => {
  const { cwd, dataDir } = makeSessionDirs();
  const s = spawnOpenRouterSidecar(fake, cwd);
  await s.ready;
  const err = expectError(await s.request(1, 'agent/connect', { provider: 'openrouter', dataDir, cwd }), -32602, 'no apiKey');
  assert.match(err.message, /apiKey/, 'sidecar-protocol §3: -32602 names the field');
  assert.equal(fake.requests.length, 0, 'nothing is fetched without a key');
  assert.equal(await s.end(), 0);
});

test('agent/connect with a rejected key is -32000 "OpenRouter rejected the API key" after GET /key (§2)', { timeout: TIMEOUT }, async () => {
  const { cwd, dataDir } = makeSessionDirs();
  const s = spawnOpenRouterSidecar(fake, cwd);
  await s.ready;
  const err = expectError(await s.request(1, 'agent/connect', { provider: 'openrouter', dataDir, cwd, apiKey: 'bad-key' }), -32000, 'bad key');
  assert.equal(err.message, 'OpenRouter rejected the API key');
  const keyReq = fake.requests.find((r) => r.path.endsWith('/key'));
  assert.ok(keyReq, 'the key is validated with GET /api/v1/key (openrouter-api §1)');
  assert.equal(keyReq.method, 'GET');
  assert.equal(keyReq.headers.authorization, 'Bearer bad-key', 'openrouter-api §1: Authorization: Bearer <key>');
  assert.equal(await s.end(), 0);
});

test('agent/connect with the good key returns the §2 api-session shape; status/login/disconnect follow §2', { timeout: TIMEOUT }, async () => {
  const c = await connectGood(fake);
  const r: ConnectResult = c.result;
  assert.equal(typeof r.connectionId, 'string');
  assert.equal(r.provider, 'openrouter');
  assert.equal(r.kind, 'api');
  assert.deepEqual(r.authMethods, [], '§2: "[] for api providers"');
  assert.equal(r.authRequired, false);
  assert.ok(r.session);
  assert.equal(typeof r.session.sessionId, 'string');
  assert.deepEqual(r.session.modes, EXPECTED_MODES);
  assert.deepEqual(r.session.configOptions, EXPECTED_CONFIG_OPTIONS);
  assert.deepEqual(r.session.commands, []);
  const keyReq = fake.requests.find((req) => req.path.endsWith('/key'));
  assert.equal(keyReq?.headers.authorization, `Bearer ${GOOD_KEY}`);
  assert.ok(fake.requests.some((req) => req.method === 'GET' && req.path.endsWith('/models')), 'options come from GET /api/v1/models');

  const status = await c.s.request(freshId(), 'agent/status', { connectionId: c.connectionId });
  assert.ok(!status.error, JSON.stringify(status.error));
  const st = status.result as { connectionId: string; provider: string; kind: string; authMethods: unknown[]; sessions: string[] };
  assert.equal(st.connectionId, c.connectionId);
  assert.equal(st.provider, 'openrouter');
  assert.equal(st.kind, 'api');
  assert.deepEqual(st.authMethods, []);
  assert.deepEqual(st.sessions, [c.sessionId]);

  expectError(await c.s.request(freshId(), 'agent/login', { connectionId: c.connectionId, methodId: 'anything' }), -32602, '§2: agent/login on an api provider');

  const disc = await c.s.request(freshId(), 'agent/disconnect', { connectionId: c.connectionId });
  assert.deepEqual(disc.result, {});
  assert.equal(await c.s.end(), 0);
});

test('a text turn: stream:true, system + user messages, ordered chunks, usage_update with cost, end_turn (§4)', { timeout: TIMEOUT }, async () => {
  const c = await connectGood(fake);
  const served = 'The mitral valve has two leaflets.';
  fake.enqueue(textTurn(served, { pieces: 4 }));
  const run = await runPrompt(c.s, c.sessionId, [systemBlock(SYSTEM), text('How many leaflets?')]);
  expectStop(run, 'end_turn');
  assert.equal(run.permissionRequests.length, 0);

  const [req] = fake.chatRequests();
  assert.ok(req, 'one POST /chat/completions');
  assert.equal(req.headers.authorization, `Bearer ${GOOD_KEY}`);
  assert.equal(req.body.stream, true, '§4: "with stream: true"');
  assert.equal(req.body.model, MODEL_VISION.id, 'the current model option is what is requested');
  assert.equal(req.body.messages[0].role, 'system');
  assert.equal(textOf(req.body.messages[0].content), SYSTEM, '§4: the ape://system block is the system prompt, verbatim');
  assert.equal(req.body.messages[1].role, 'user');
  assert.equal(textOf(req.body.messages[1].content), 'How many leaflets?');
  assert.equal(req.body.messages.length, 2, 'messages = [system, …history]; nothing else on a first turn');
  assert.ok(!('reasoning' in req.body), `alpha/vision-tools has no reasoning support; body must omit it: ${JSON.stringify(req.body.reasoning)}`);

  assert.equal(chunkText(run.updates, 'agent_message_chunk'), served, 'delta.content chunks arrive in order as agent_message_chunk');
  assert.ok(ofKind(run.updates, 'agent_message_chunk').length >= 2, 'streamed as more than one chunk');
  assert.equal(ofKind(run.updates, 'agent_thought_chunk').length, 0);
  assert.equal(ofKind(run.updates, 'tool_call').length, 0);

  const usage = ofKind(run.updates, 'usage_update');
  assert.equal(usage.length, 1, 'exactly one usage chunk per stream (openrouter-api §2.4) -> one usage_update');
  assert.equal(usage[0].used, DEFAULT_USAGE.total_tokens, '§4: used = total_tokens');
  assert.equal(usage[0].size, MODEL_VISION.context_length, '§4: size = the model context_length');
  assert.deepEqual(usage[0]._meta, {
    cost: DEFAULT_USAGE.cost,
    promptTokens: DEFAULT_USAGE.prompt_tokens,
    completionTokens: DEFAULT_USAGE.completion_tokens,
    cachedTokens: DEFAULT_USAGE.prompt_tokens_details.cached_tokens,
    reasoningTokens: DEFAULT_USAGE.completion_tokens_details.reasoning_tokens,
  });
  // The usage update belongs to the same turn: it precedes the response and follows the text.
  const lastText = run.updates.map((u) => u.sessionUpdate).lastIndexOf('agent_message_chunk');
  assert.ok(run.updates.indexOf(usage[0]) > lastText, 'usage_update comes after the message chunks (the usage chunk is the last frame before [DONE])');
  assert.equal(await c.s.end(), 0);
});

test('history accumulates: the second turn resends the first exchange before the new user message (§4)', { timeout: TIMEOUT }, async () => {
  const c = await connectGood(fake);
  fake.enqueue(textTurn('First answer.'), textTurn('Second answer.'));
  expectStop(await runPrompt(c.s, c.sessionId, [systemBlock(SYSTEM), text('one')]), 'end_turn');
  expectStop(await runPrompt(c.s, c.sessionId, [systemBlock(SYSTEM), text('two')]), 'end_turn');
  const [, second] = fake.chatRequests();
  const roles = second.body.messages.map((m: { role: string }) => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'user']);
  assert.equal(textOf(second.body.messages[2].content), 'First answer.');
  assert.equal(textOf(second.body.messages[3].content), 'two');
  assert.equal(await c.s.end(), 0);
});

test('without an ape://system block the system message is still first, a non-empty single line (§4)', { timeout: TIMEOUT }, async () => {
  const c = await connectGood(fake);
  fake.enqueue(textTurn('ok'));
  expectStop(await runPrompt(c.s, c.sessionId, [text('hello')]), 'end_turn');
  const [req] = fake.chatRequests();
  assert.equal(req.body.messages[0].role, 'system');
  const sys = textOf(req.body.messages[0].content);
  assert.ok(sys.trim().length > 0, '§4: "a one-line identity string"');
  assert.ok(!sys.trim().includes('\n'), `one line, got: ${JSON.stringify(sys)}`);
  assert.equal(req.body.messages[1].role, 'user');
  assert.equal(await c.s.end(), 0);
});

// A 1x1 transparent PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('image, pdf, markdown and png resource_link blocks map per §4 (native pdf engine on a file-capable model)', { timeout: TIMEOUT }, async () => {
  const c = await connectGood(fake);
  // zeta/omni-reasoner lists `file` in input_modalities -> engine "native".
  const set = await c.s.request(freshId(), 'agent/setConfigOption', { sessionId: c.sessionId, id: 'model', value: MODEL_REASONER.id });
  assert.ok(!set.error, JSON.stringify(set.error));

  const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
  const pdfPath = join(c.cwd, 'lecture.pdf');
  writeFileSync(pdfPath, pdfBytes);
  const mdText = '# Notes\n\nThe mitral valve is bicuspid.\n';
  const mdPath = join(c.cwd, 'notes.md');
  writeFileSync(mdPath, mdText);
  const pngPath = join(c.cwd, 'slide.png');
  writeFileSync(pngPath, Buffer.from(PNG_B64, 'base64'));

  fake.enqueue(textTurn('seen'));
  const run = await runPrompt(c.s, c.sessionId, [
    systemBlock(SYSTEM),
    text('Look at these.'),
    { type: 'image', mimeType: 'image/png', data: PNG_B64 },
    { type: 'resource_link', uri: `file://${pdfPath}`, name: 'lecture.pdf', mimeType: 'application/pdf' },
    { type: 'resource_link', uri: `file://${mdPath}`, name: 'notes.md', mimeType: 'text/markdown' },
    { type: 'resource_link', uri: `file://${pngPath}`, name: 'slide.png', mimeType: 'image/png' },
  ]);
  expectStop(run, 'end_turn');

  const [req] = fake.chatRequests();
  assert.equal(req.body.model, MODEL_REASONER.id);
  const user = req.body.messages[1];
  assert.equal(user.role, 'user');
  assert.ok(Array.isArray(user.content), 'a multimodal user message is a parts array (openrouter-api §2.2)');
  const parts = user.content as Array<Record<string, any>>;

  const images = parts.filter((p) => p.type === 'image_url');
  assert.equal(images.length, 2, 'the image block and the png resource_link both become image_url parts');
  for (const img of images) {
    assert.equal(typeof img.image_url?.url, 'string');
    assert.ok(img.image_url.url.startsWith('data:image/png;base64,'), `data URL with the mime type: ${img.image_url.url.slice(0, 40)}`);
    assert.equal(img.image_url.url.slice('data:image/png;base64,'.length), PNG_B64, 'the base64 payload is the file/block bytes verbatim');
  }

  const files = parts.filter((p) => p.type === 'file');
  assert.equal(files.length, 1, 'the pdf becomes one `file` part');
  assert.equal(files[0].file.filename, 'lecture.pdf');
  const prefix = 'data:application/pdf;base64,';
  assert.ok(String(files[0].file.file_data).startsWith(prefix), 'openrouter-api §2.2: file_data is a base64 data URL');
  assert.equal(String(files[0].file.file_data).slice(prefix.length), pdfBytes.toString('base64'));
  assert.deepEqual(req.body.plugins, [{ id: 'file-parser', pdf: { engine: 'native' } }], '§4: engine native when the model lists `file`');

  const texts = parts.filter((p) => p.type === 'text').map((p) => String(p.text));
  assert.ok(texts.includes('Look at these.'), 'the text block is a text part');
  const mdPart = texts.find((t) => t.includes('The mitral valve is bicuspid.'));
  assert.ok(mdPart, '§4: a non-pdf, non-image resource_link is sent as its text');
  assert.ok(mdPart.includes(mdPath) || mdPart.includes('notes.md'), `with the path as a heading: ${JSON.stringify(mdPart)}`);
  assert.equal(await c.s.end(), 0);
});

test('a pdf on a model without `file` input uses the mistral-ocr engine (§4)', { timeout: TIMEOUT }, async () => {
  const c = await connectGood(fake); // alpha/vision-tools: image only
  const pdfPath = join(c.cwd, 'x.pdf');
  writeFileSync(pdfPath, '%PDF-1.4\n%%EOF\n');
  fake.enqueue(textTurn('seen'));
  expectStop(await runPrompt(c.s, c.sessionId, [text('pdf'), { type: 'resource_link', uri: `file://${pdfPath}`, name: 'x.pdf', mimeType: 'application/pdf' }]), 'end_turn');
  const [req] = fake.chatRequests();
  assert.deepEqual(req.body.plugins, [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }]);
  assert.equal(await c.s.end(), 0);
});

test('reasoning: sent as { effort } only when the model supports it and effort != none; delta.reasoning -> agent_thought_chunk (§4)', { timeout: TIMEOUT }, async () => {
  const c = await connectGood(fake);
  const setModel = await c.s.request(freshId(), 'agent/setConfigOption', { sessionId: c.sessionId, id: 'model', value: MODEL_REASONER.id });
  assert.ok(!setModel.error, JSON.stringify(setModel.error));
  const opts1 = (setModel.result as { configOptions: SelectOption[] }).configOptions;
  assert.equal(opts1.find((o) => o.id === 'model')?.currentValue, MODEL_REASONER.id, '§2: setConfigOption returns the full option state');
  assert.equal(opts1.find((o) => o.id === 'effort')?.currentValue, 'medium');

  fake.enqueue(textTurn('Answer.', { reasoning: ['Let me ', 'think.'] }));
  const run1 = await runPrompt(c.s, c.sessionId, [systemBlock(SYSTEM), text('q1')]);
  expectStop(run1, 'end_turn');
  assert.deepEqual(fake.chatRequests()[0].body.reasoning, { effort: 'medium' });
  assert.equal(chunkText(run1.updates, 'agent_thought_chunk'), 'Let me think.', 'delta.reasoning -> agent_thought_chunk, in order');
  assert.equal(chunkText(run1.updates, 'agent_message_chunk'), 'Answer.');
  const kinds = run1.updates.map((u) => u.sessionUpdate);
  assert.ok(kinds.lastIndexOf('agent_thought_chunk') < kinds.indexOf('agent_message_chunk'), 'thoughts were served first and arrive first');

  const setEffort = await c.s.request(freshId(), 'agent/setConfigOption', { sessionId: c.sessionId, id: 'effort', value: 'none' });
  assert.ok(!setEffort.error, JSON.stringify(setEffort.error));
  assert.equal((setEffort.result as { configOptions: SelectOption[] }).configOptions.find((o) => o.id === 'effort')?.currentValue, 'none');
  fake.enqueue(textTurn('Answer 2.'));
  expectStop(await runPrompt(c.s, c.sessionId, [systemBlock(SYSTEM), text('q2')]), 'end_turn');
  assert.ok(!('reasoning' in fake.chatRequests()[1].body), 'effort none -> no reasoning key');

  const setHigh = await c.s.request(freshId(), 'agent/setConfigOption', { sessionId: c.sessionId, id: 'effort', value: 'high' });
  assert.ok(!setHigh.error, JSON.stringify(setHigh.error));
  fake.enqueue(textTurn('Answer 3.'));
  expectStop(await runPrompt(c.s, c.sessionId, [systemBlock(SYSTEM), text('q3')]), 'end_turn');
  assert.deepEqual(fake.chatRequests()[2].body.reasoning, { effort: 'high' });

  const backToVision = await c.s.request(freshId(), 'agent/setConfigOption', { sessionId: c.sessionId, id: 'model', value: MODEL_VISION.id });
  assert.ok(!backToVision.error, JSON.stringify(backToVision.error));
  fake.enqueue(textTurn('Answer 4.'));
  expectStop(await runPrompt(c.s, c.sessionId, [systemBlock(SYSTEM), text('q4')]), 'end_turn');
  assert.equal(fake.chatRequests()[3].body.model, MODEL_VISION.id);
  assert.ok(!('reasoning' in fake.chatRequests()[3].body), 'a model whose supported_parameters lack `reasoning` gets no reasoning key even at effort high');
  assert.equal(await c.s.end(), 0);
});

test('agent/setConfigOption with an unknown id or value, and agent/setMode with an unknown mode, are -32602 (§2)', { timeout: TIMEOUT }, async () => {
  const c = await connectGood(fake);
  expectError(await c.s.request(freshId(), 'agent/setConfigOption', { sessionId: c.sessionId, id: 'temperature', value: '0' }), -32602, 'unknown option id');
  expectError(await c.s.request(freshId(), 'agent/setConfigOption', { sessionId: c.sessionId, id: 'effort', value: 'max' }), -32602, 'value outside the option list');
  expectError(await c.s.request(freshId(), 'agent/setConfigOption', { sessionId: c.sessionId, id: 'model', value: 'beta/chatty' }), -32602, 'a filtered-out model is not a legal value');
  expectError(await c.s.request(freshId(), 'agent/setConfigOption', { sessionId: c.sessionId, id: 'model' }), -32602, 'missing value');
  expectError(await c.s.request(freshId(), 'agent/setMode', { sessionId: c.sessionId, modeId: 'plan' }), -32602, 'unknown mode');
  expectError(await c.s.request(freshId(), 'agent/setMode', { sessionId: c.sessionId }), -32602, 'missing modeId');
  expectError(await c.s.request(freshId(), 'agent/prompt', { sessionId: 'no-such-session', blocks: [text('x')] }), -32602, 'unknown session');
  // The session is intact afterwards.
  const mode = await c.s.request(freshId(), 'agent/setMode', { sessionId: c.sessionId, modeId: 'acceptEdits' });
  assert.deepEqual(mode.result, { modes: { ...EXPECTED_MODES, currentModeId: 'acceptEdits' } });
  const back = await c.s.request(freshId(), 'agent/setMode', { sessionId: c.sessionId, modeId: 'default' });
  assert.deepEqual(back.result, { modes: EXPECTED_MODES });
  assert.equal(await c.s.end(), 0);
});

test('a mid-stream error chunk ends the turn with -32000 carrying error.message (§4; openrouter-api §2.8)', { timeout: TIMEOUT }, async () => {
  const c = await connectGood(fake);
  fake.enqueue(midStreamError('Provider returned error: upstream overloaded', 502));
  const run = await runPrompt(c.s, c.sessionId, [systemBlock(SYSTEM), text('q')]);
  const err = expectError(run.response, -32000, 'error chunk');
  assert.ok(err.message.includes('Provider returned error: upstream overloaded'), `message carries the chunk's error.message: ${err.message}`);
  // The sidecar survives (sidecar-protocol §2.5): a following turn works.
  fake.enqueue(textTurn('fine now'));
  expectStop(await runPrompt(c.s, c.sessionId, [systemBlock(SYSTEM), text('again')]), 'end_turn');
  assert.equal(await c.s.end(), 0);
});

test('HTTP 402, 401 and other non-2xx bodies map to -32000 per §4', { timeout: TIMEOUT }, async () => {
  const c = await connectGood(fake);
  fake.enqueue(httpError(402, 'Your account or API key has insufficient credits. Add more credits and retry the request.', 'payment_required'));
  assert.equal(expectError((await runPrompt(c.s, c.sessionId, [text('a')])).response, -32000, '402').message, 'OpenRouter: insufficient credits');

  fake.enqueue(httpError(401, 'Invalid credentials', 'authentication'));
  assert.equal(expectError((await runPrompt(c.s, c.sessionId, [text('b')])).response, -32000, '401').message, 'OpenRouter rejected the API key');

  fake.enqueue(httpError(503, 'There is no available model provider that meets your routing requirements', 'provider_overloaded'));
  const other = expectError((await runPrompt(c.s, c.sessionId, [text('c')])).response, -32000, '503');
  assert.ok(other.message.includes('There is no available model provider that meets your routing requirements'), `other non-2xx carries error.message: ${other.message}`);
  assert.equal(fake.chatRequests().length, 3, 'none of these are retried');
  assert.equal(await c.s.end(), 0);
});

test('429 is retried once after 2 s: 429-then-200 succeeds with exactly two requests; 429-twice is -32000 (§4)', { timeout: 15_000 }, async () => {
  const c = await connectGood(fake);
  fake.enqueue(httpError(429, 'You are being rate limited', 'rate_limit_exceeded'), textTurn('after retry'));
  const run = await runPrompt(c.s, c.sessionId, [systemBlock(SYSTEM), text('q')], { timeout: 12_000 });
  expectStop(run, 'end_turn');
  assert.equal(chunkText(run.updates, 'agent_message_chunk'), 'after retry');
  const reqs = fake.chatRequests();
  assert.equal(reqs.length, 2, 'exactly one retry');
  assert.ok(reqs[1].at - reqs[0].at >= 1900, `§4: "retry once after 2 s" (gap was ${reqs[1].at - reqs[0].at} ms)`);
  assert.deepEqual(reqs[1].body.messages, reqs[0].body.messages, 'the retry resends the same conversation');

  fake.reset();
  fake.enqueue(httpError(429, 'You are being rate limited', 'rate_limit_exceeded'), httpError(429, 'You are being rate limited', 'rate_limit_exceeded'));
  const run2 = await runPrompt(c.s, c.sessionId, [systemBlock(SYSTEM), text('q2')], { timeout: 12_000 });
  expectError(run2.response, -32000, 'second 429');
  assert.equal(fake.chatRequests().length, 2, 'one retry, then give up');
  assert.equal(await c.s.end(), 0);
});

test('agent/cancel mid-stream: prompt resolves cancelled, the fetch is aborted, partial text stays in history; a concurrent prompt is -32000 (§2, §4)', { timeout: 20_000 }, async () => {
  const c = await connectGood(fake);
  const chunks = Array.from({ length: 20 }, (_, i) => `w${i} `);
  fake.enqueue(slowTextTurn(chunks, 200));

  const start = c.s.lines.length;
  const promptId = freshId();
  const pending = c.s.request(promptId, 'agent/prompt', { sessionId: c.sessionId, blocks: [systemBlock(SYSTEM), text('slow')] });
  await waitFor(() => (ofKind(updatesOf(c.s, c.sessionId, start), 'agent_message_chunk').length >= 3 ? true : undefined), 'three chunks');

  const busy = await c.s.request(freshId(), 'agent/prompt', { sessionId: c.sessionId, blocks: [text('again')] });
  assert.equal(expectError(busy, -32000, 'second prompt mid-turn').message, `session ${c.sessionId} has a turn in progress`);

  const cancel = await c.s.request(freshId(), 'agent/cancel', { sessionId: c.sessionId });
  assert.deepEqual(cancel.result, {});
  const res = await pending;
  assert.deepEqual(res.result, { stopReason: 'cancelled' });
  const seen = chunkText(updatesOf(c.s, c.sessionId, start), 'agent_message_chunk');
  assert.ok(seen.startsWith('w0 w1 w2 '), `saw at least the first three chunks: ${JSON.stringify(seen)}`);
  assert.ok(!seen.includes('w19 '), 'the stream was not consumed to the end');
  const first = fake.chatRequests()[0];
  await waitFor(() => (first.aborted ? true : undefined), '§4: "agent/cancel aborts the fetch" (the fake sees the connection drop)', 5_000);

  fake.enqueue(textTurn('next'));
  expectStop(await runPrompt(c.s, c.sessionId, [systemBlock(SYSTEM), text('after cancel')]), 'end_turn');
  const second = fake.chatRequests()[1];
  const assistant = second.body.messages.filter((m: { role: string }) => m.role === 'assistant');
  assert.equal(assistant.length, 1, '§4: "the partial assistant text is kept in history"');
  const kept = textOf(assistant[0].content);
  assert.ok(kept.startsWith('w0 w1 w2 '), `history carries the partial text: ${JSON.stringify(kept)}`);
  assert.equal(kept, seen, 'exactly the text that was streamed to the app');
  assert.equal(second.body.messages.at(-1).role, 'user');
  assert.equal(textOf(second.body.messages.at(-1).content), 'after cancel');
  assert.equal(await c.s.end(), 0);
});

test('agent/cancel on a session with no turn in progress is harmless, and a sessionless cancel is -32602 (§2)', { timeout: TIMEOUT }, async () => {
  const c = await connectGood(fake);
  assert.deepEqual((await c.s.request(freshId(), 'agent/cancel', { sessionId: c.sessionId })).result, {});
  expectError(await c.s.request(freshId(), 'agent/cancel', {}), -32602, 'missing sessionId');
  fake.enqueue(textTurn('still here'));
  expectStop(await runPrompt(c.s, c.sessionId, [text('x')]), 'end_turn');
  assert.equal(await c.s.end(), 0);
  // §2: apiKey is "never written". Whatever the session left under dataDir
  // or the course folder, none of it holds the key.
  for (const dir of [c.dataDir, c.cwd]) {
    for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!f.isFile()) continue;
      const p = join(f.parentPath, f.name);
      assert.ok(!readFileSync(p, 'utf8').includes(GOOD_KEY), `API key written to ${p}`);
    }
  }
});
