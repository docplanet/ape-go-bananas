// agent-protocol.md §3 (the reverse agent/requestPermission request for the
// embedded agent) and §4's tool loop (read_file / write_file / list_dir, path
// escapes, the 50-round cap, reasoning_details pass-back) against the built
// sidecar and fake-openrouter.ts. Companion to agent-openrouter.test.ts;
// written from the spec by a context that has not seen src/agent/ or
// src/sidecar/agent*.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

import { MODEL_REASONER, startFakeOpenRouter, textTurn, toolCallsTurn, type FakeOpenRouter } from './fake-openrouter.ts';
import { TIMEOUT, sweepSidecars } from './helpers.ts';
import {
  assertKeyHygiene,
  chunkText,
  connectGood,
  expectError,
  expectStop,
  freshId,
  ofKind,
  runPrompt,
  systemBlock,
  text,
  toolResultText,
  type Connected,
  type PermissionRequest,
  type Update,
} from './openrouter-helpers.ts';

let fake: FakeOpenRouter;
before(async () => { fake = await startFakeOpenRouter(); });
beforeEach(() => fake.reset());
after(() => { sweepSidecars(); assertKeyHygiene(); return fake.close(); });

const SYSTEM = 'You are the course assistant.';
const NOTES = 'Mitral valve notes\n\n- two leaflets\n- left AV valve\n';

/** A session whose course folder holds notes.md, other.txt and sub/inner.txt. */
async function connectWithFiles(): Promise<Connected> {
  const c = await connectGood(fake);
  writeFileSync(join(c.cwd, 'notes.md'), NOTES);
  writeFileSync(join(c.cwd, 'other.txt'), 'other\n');
  mkdirSync(join(c.cwd, 'sub'));
  writeFileSync(join(c.cwd, 'sub', 'inner.txt'), 'inner\n');
  return c;
}

/** The `tool_call` and its `tool_call_update` for one toolCallId, asserting the §4 announce-then-patch order. */
function pairFor(updates: Update[], toolCallId: string): { call: Update; update: Update } {
  const call = updates.find((u) => u.sessionUpdate === 'tool_call' && u.toolCallId === toolCallId);
  const update = updates.find((u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId === toolCallId);
  assert.ok(call, `tool_call for ${toolCallId}`);
  assert.ok(update, `tool_call_update for ${toolCallId}`);
  assert.ok(updates.indexOf(call) < updates.indexOf(update), 'tool_call precedes its tool_call_update');
  assert.equal(call.status, 'pending', '§4: announced as pending');
  assert.equal(typeof call.title, 'string');
  assert.ok((call.title as string).length > 0, 'acp #10.1: title is required');
  return { call, update };
}

/** The `role: "tool"` messages of a request body, in order. */
const toolMessages = (body: any): Array<{ role: string; tool_call_id: string; content: unknown }> => body.messages.filter((m: { role: string }) => m.role === 'tool');
const contentText = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? '').join('') : '');

test('a tool round: list_dir + read_file announced, executed, fed back as tool messages, then end_turn (§4)', { timeout: TIMEOUT }, async () => {
  const c = await connectWithFiles();
  fake.enqueue(
    toolCallsTurn([
      { id: 'call_ls', name: 'list_dir', args: { path: '.' } },
      { id: 'call_rd', name: 'read_file', args: { path: 'notes.md' } },
    ]),
    textTurn('Read it.'),
  );
  const run = await runPrompt(c.s, c.sessionId, [systemBlock(SYSTEM), text('what is here?')]);
  expectStop(run, 'end_turn');
  assert.equal(run.permissionRequests.length, 0, 'read-only tools never ask');

  const [first, second] = fake.chatRequests();
  assert.equal(fake.chatRequests().length, 2);
  // §4: the three tools are offered, in openrouter-api §2.3's shape.
  assert.ok(Array.isArray(first.body.tools), 'tools[] is sent');
  const toolNames = first.body.tools.map((t: { type: string; function: { name: string; parameters: unknown } }) => {
    assert.equal(t.type, 'function');
    assert.equal(typeof t.function.parameters, 'object', 'parameters is a JSON Schema object');
    return t.function.name;
  }).sort();
  assert.deepEqual(toolNames, ['list_dir', 'read_file', 'write_file']);

  // Updates: announce then patch, per call, in the served order.
  const ids = ofKind(run.updates, 'tool_call').map((u) => u.toolCallId);
  assert.equal(ids.length, 2, 'one tool_call per served call');
  assert.notEqual(ids[0], ids[1]);
  const ls = pairFor(run.updates, ids[0] as string);
  const rd = pairFor(run.updates, ids[1] as string);
  // Reading of §4's `kind: "read" | "edit" | "search"` for three tools: read_file -> read, write_file -> edit, list_dir -> search.
  assert.equal(ls.call.kind, 'search');
  assert.equal(rd.call.kind, 'read');
  assert.equal(ls.update.status, 'completed');
  assert.equal(rd.update.status, 'completed');
  const listing = toolResultText(ls.update);
  for (const name of ['notes.md', 'other.txt', 'sub']) assert.ok(listing.includes(name), `list_dir result names ${name}: ${JSON.stringify(listing)}`);
  assert.ok(!listing.includes('inner.txt'), 'list_dir is not recursive');
  assert.equal(toolResultText(rd.update), NOTES, 'read_file result is the file text');

  // The second request carries the assistant tool_calls and both tool results (openrouter-api §2.3).
  const roles = second.body.messages.map((m: { role: string }) => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'tool']);
  const assistant = second.body.messages[2];
  assert.equal(assistant.tool_calls.length, 2);
  assert.deepEqual(assistant.tool_calls.map((t: { id: string }) => t.id), ['call_ls', 'call_rd']);
  for (const [i, expected] of [[0, { name: 'list_dir', args: { path: '.' } }], [1, { name: 'read_file', args: { path: 'notes.md' } }]] as const) {
    const t = assistant.tool_calls[i];
    assert.equal(t.type, 'function');
    assert.equal(t.function.name, expected.name);
    assert.equal(typeof t.function.arguments, 'string', 'arguments is the concatenated JSON string');
    assert.deepEqual(JSON.parse(t.function.arguments), expected.args, 'fragments were concatenated by index, nothing lost');
  }
  const tools = toolMessages(second.body);
  assert.deepEqual(tools.map((m) => m.tool_call_id), ['call_ls', 'call_rd']);
  assert.equal(contentText(tools[0].content), listing, 'the tool message is what the app was shown');
  assert.equal(contentText(tools[1].content), NOTES);
  assert.equal(chunkText(run.updates, 'agent_message_chunk'), 'Read it.');
  assert.equal(ofKind(run.updates, 'usage_update').length, 2, 'one usage_update per stream');
  assert.equal(await c.s.end(), 0);
});

test('reasoning_details from an assistant tool-call message are passed back verbatim on the next request (§4; openrouter-api §2.6)', { timeout: TIMEOUT }, async () => {
  const c = await connectWithFiles();
  const set = await c.s.request(freshId(), 'agent/setConfigOption', { sessionId: c.sessionId, id: 'model', value: MODEL_REASONER.id });
  assert.ok(!set.error, JSON.stringify(set.error));
  const details = [{ type: 'reasoning.text', text: 'I should list the folder.', id: 'rd-1', format: 'fake-v1', index: 0 }];
  fake.enqueue(toolCallsTurn([{ id: 'call_ls', name: 'list_dir', args: { path: '.' } }], { reasoningDetails: details }), textTurn('Listed.'));
  expectStop(await runPrompt(c.s, c.sessionId, [systemBlock(SYSTEM), text('go')]), 'end_turn');
  const [, second] = fake.chatRequests();
  const assistant = second.body.messages.find((m: { role: string; tool_calls?: unknown }) => m.role === 'assistant' && m.tool_calls);
  assert.ok(assistant, 'the assistant tool-call message is in history');
  assert.deepEqual(assistant.reasoning_details, details, '"Pass back unmodified"');
  assert.deepEqual(second.body.reasoning, { effort: 'medium' });
  assert.equal(await c.s.end(), 0);
});

/** §3: the exact option set the embedded agent offers before a write. Names are not pinned; ids and kinds are. */
function assertWriteOptions(req: PermissionRequest, path: string, sessionId: string): void {
  assert.equal(typeof req.id, 'number', '§3: reverse request ids are numbers');
  assert.equal(req.params.sessionId, sessionId);
  assert.deepEqual(
    req.params.options.map((o) => ({ optionId: o.optionId, kind: o.kind })),
    [{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'allow-always', kind: 'allow_always' }, { optionId: 'reject', kind: 'reject_once' }],
  );
  for (const o of req.params.options) assert.ok(typeof o.name === 'string' && o.name.length > 0, 'acp #11: every option has a display name');
  assert.equal(typeof req.params.toolCall.toolCallId, 'string');
  assert.ok(String(req.params.toolCall.title ?? '').includes(path), `toolCall.title mentions the path: ${JSON.stringify(req.params.toolCall)}`);
}

test('write_file in default mode raises agent/requestPermission; allow-once writes the exact content (§3, §4)', { timeout: TIMEOUT }, async () => {
  const c = await connectWithFiles();
  const content = '{"notes":[{"fields":{"Text":"{{c1::two}} leaflets"}}]}\n';
  fake.enqueue(toolCallsTurn([{ id: 'call_w', name: 'write_file', args: { path: 'deck.json', content } }]), textTurn('Written.'));
  const run = await runPrompt(c.s, c.sessionId, [systemBlock(SYSTEM), text('write the deck')], { answer: () => ({ outcome: 'selected', optionId: 'allow-once' }) });
  expectStop(run, 'end_turn');
  assert.equal(run.permissionRequests.length, 1, 'exactly one request for one write');
  assertWriteOptions(run.permissionRequests[0], 'deck.json', c.sessionId);

  const { call, update } = pairFor(run.updates, run.permissionRequests[0].params.toolCall.toolCallId);
  assert.equal(call.kind, 'edit');
  assert.equal(update.status, 'completed');
  assert.equal(readFileSync(join(c.cwd, 'deck.json'), 'utf8'), content, 'the file holds exactly the content argument');
  const tools = toolMessages(fake.chatRequests()[1].body);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].tool_call_id, 'call_w');
  assert.equal(await c.s.end(), 0);
});

test('answering reject leaves no file; the tool result says it was denied; the turn still ends (§3, §4)', { timeout: TIMEOUT }, async () => {
  const c = await connectWithFiles();
  fake.enqueue(toolCallsTurn([{ id: 'call_w', name: 'write_file', args: { path: 'deck.json', content: 'nope\n' } }]), textTurn('Understood.'));
  const run = await runPrompt(c.s, c.sessionId, [systemBlock(SYSTEM), text('write')], { answer: () => ({ outcome: 'selected', optionId: 'reject' }) });
  expectStop(run, 'end_turn');
  assert.equal(run.permissionRequests.length, 1);
  assert.ok(!existsSync(join(c.cwd, 'deck.json')), 'reject writes nothing');
  const { update } = pairFor(run.updates, run.permissionRequests[0].params.toolCall.toolCallId);
  assert.match(toolResultText(update), /denied|reject/i, 'the result text says the write was denied');
  const [tool] = toolMessages(fake.chatRequests()[1].body);
  assert.equal(tool.tool_call_id, 'call_w');
  assert.match(contentText(tool.content), /denied|reject/i, 'the model is told the same');
  assert.equal(chunkText(run.updates, 'agent_message_chunk'), 'Understood.');
  assert.equal(await c.s.end(), 0);
});

test('an error response or a cancelled outcome to the permission request denies the write (§3)', { timeout: TIMEOUT }, async () => {
  const c = await connectWithFiles();
  fake.enqueue(toolCallsTurn([{ id: 'call_1', name: 'write_file', args: { path: 'a.txt', content: 'a' } }]), textTurn('ok'));
  const errRun = await runPrompt(c.s, c.sessionId, [text('write a')], { answer: () => ({ error: { code: -32000, message: 'app declined' } }) });
  expectStop(errRun, 'end_turn');
  assert.equal(errRun.permissionRequests.length, 1);
  assert.ok(!existsSync(join(c.cwd, 'a.txt')), 'an error response denies');

  fake.enqueue(toolCallsTurn([{ id: 'call_2', name: 'write_file', args: { path: 'b.txt', content: 'b' } }]), textTurn('ok'));
  const cancelRun = await runPrompt(c.s, c.sessionId, [text('write b')], { answer: () => ({ outcome: 'cancelled' }) });
  expectStop(cancelRun, 'end_turn');
  assert.equal(cancelRun.permissionRequests.length, 1);
  assert.ok(!existsSync(join(c.cwd, 'b.txt')), 'a cancelled outcome denies');
  assert.match(contentText(toolMessages(fake.chatRequests()[3].body)[0].content), /denied|reject|cancel/i);
  assert.equal(await c.s.end(), 0);
});

test('allow-always writes, switches the session to acceptEdits (current_mode_update), and later writes ask nothing (§3)', { timeout: TIMEOUT }, async () => {
  const c = await connectWithFiles();
  fake.enqueue(
    toolCallsTurn([{ id: 'call_a', name: 'write_file', args: { path: 'a.txt', content: 'A\n' } }]),
    toolCallsTurn([{ id: 'call_b', name: 'write_file', args: { path: 'b.txt', content: 'B\n' } }]),
    textTurn('Both written.'),
  );
  const run = await runPrompt(c.s, c.sessionId, [systemBlock(SYSTEM), text('write a then b')], { answer: () => ({ outcome: 'selected', optionId: 'allow-always' }) });
  expectStop(run, 'end_turn');
  assert.equal(run.permissionRequests.length, 1, 'the second write in the same session asks nothing');
  assertWriteOptions(run.permissionRequests[0], 'a.txt', c.sessionId);
  assert.equal(readFileSync(join(c.cwd, 'a.txt'), 'utf8'), 'A\n');
  assert.equal(readFileSync(join(c.cwd, 'b.txt'), 'utf8'), 'B\n');
  assert.equal(ofKind(run.updates, 'tool_call_update').filter((u) => u.status === 'completed').length, 2);

  // Strict reading of §3 "switches the session to `acceptEdits`": the mode
  // change is a session-state change the app must see, and §2 lists
  // `current_mode_update` among the update kinds a turn may emit -- so one
  // arrives, after allow-always, carrying acceptEdits. acp-protocol #8 names
  // the field `currentModeId` while its #17.1 example says `modeId`
  // (src/acp/protocol.ts reads either); both spellings are accepted here.
  const modeUpdates = ofKind(run.updates, 'current_mode_update');
  assert.equal(modeUpdates.length, 1, 'exactly one current_mode_update for one switch');
  assert.equal(modeUpdates[0].currentModeId ?? modeUpdates[0].modeId, 'acceptEdits');
  const kinds = run.updates.map((u) => u.sessionUpdate);
  assert.ok(kinds.indexOf('current_mode_update') < kinds.lastIndexOf('tool_call'), 'the switch is announced before the second write runs');

  // And it persists past the turn: a later write in a fresh prompt asks nothing.
  fake.enqueue(toolCallsTurn([{ id: 'call_c', name: 'write_file', args: { path: 'c.txt', content: 'C\n' } }]), textTurn('done'));
  const later = await runPrompt(c.s, c.sessionId, [systemBlock(SYSTEM), text('write c')], { answer: () => ({ outcome: 'selected', optionId: 'reject' }) });
  expectStop(later, 'end_turn');
  assert.equal(later.permissionRequests.length, 0);
  assert.equal(readFileSync(join(c.cwd, 'c.txt'), 'utf8'), 'C\n');
  assert.equal(await c.s.end(), 0);
});

test('in acceptEdits (via agent/setMode) write_file asks nothing; back in default it asks again (§2, §4)', { timeout: TIMEOUT }, async () => {
  const c = await connectWithFiles();
  const set = await c.s.request(freshId(), 'agent/setMode', { sessionId: c.sessionId, modeId: 'acceptEdits' });
  assert.equal((set.result as { modes: { currentModeId: string } }).modes.currentModeId, 'acceptEdits');
  fake.enqueue(toolCallsTurn([{ id: 'call_w', name: 'write_file', args: { path: 'quiet.txt', content: 'q\n' } }]), textTurn('done'));
  const run = await runPrompt(c.s, c.sessionId, [systemBlock(SYSTEM), text('write')], { answer: () => ({ outcome: 'selected', optionId: 'reject' }) });
  expectStop(run, 'end_turn');
  assert.equal(run.permissionRequests.length, 0, 'no reverse request in acceptEdits');
  assert.equal(readFileSync(join(c.cwd, 'quiet.txt'), 'utf8'), 'q\n');
  const { update } = pairFor(run.updates, ofKind(run.updates, 'tool_call')[0].toolCallId as string);
  assert.equal(update.status, 'completed');

  const back = await c.s.request(freshId(), 'agent/setMode', { sessionId: c.sessionId, modeId: 'default' });
  assert.equal((back.result as { modes: { currentModeId: string } }).modes.currentModeId, 'default');
  fake.enqueue(toolCallsTurn([{ id: 'call_w2', name: 'write_file', args: { path: 'loud.txt', content: 'l\n' } }]), textTurn('done'));
  const run2 = await runPrompt(c.s, c.sessionId, [systemBlock(SYSTEM), text('write again')], { answer: () => ({ outcome: 'selected', optionId: 'reject' }) });
  expectStop(run2, 'end_turn');
  assert.equal(run2.permissionRequests.length, 1, 'default mode asks again');
  assert.ok(!existsSync(join(c.cwd, 'loud.txt')));
  assert.equal(await c.s.end(), 0);
});

test('a path escaping cwd is refused with an error result, no permission request, and the loop continues (§4)', { timeout: TIMEOUT }, async () => {
  const c = await connectWithFiles();
  const outside = join(dirname(c.cwd), 'outside.txt');
  writeFileSync(outside, 'SECRET-OUTSIDE\n');
  const evil = join(dirname(c.cwd), 'evil.txt');
  fake.enqueue(
    toolCallsTurn([
      { id: 'call_r1', name: 'read_file', args: { path: '../outside.txt' } },
      { id: 'call_r2', name: 'read_file', args: { path: outside } },
      { id: 'call_ls', name: 'list_dir', args: { path: '..' } },
      { id: 'call_w', name: 'write_file', args: { path: '../evil.txt', content: 'pwned' } },
      { id: 'call_ok', name: 'read_file', args: { path: 'sub/inner.txt' } },
    ]),
    textTurn('Refused.'),
  );
  const run = await runPrompt(c.s, c.sessionId, [systemBlock(SYSTEM), text('escape')], { answer: () => ({ outcome: 'selected', optionId: 'allow-once' }) });
  expectStop(run, 'end_turn');
  // The escaping write may or may not consult the app first (§4 does not
  // order the checks); what is pinned is that an escape is refused even when
  // allowed, and that read-only escapes never ask.
  assert.ok(run.permissionRequests.length <= 1, 'at most the write could have asked');
  assert.ok(run.permissionRequests.every((r) => String(r.params.toolCall.title).includes('evil.txt')));
  assert.ok(!existsSync(evil), 'nothing is written outside cwd');

  const tools = toolMessages(fake.chatRequests()[1].body);
  assert.deepEqual(tools.map((m) => m.tool_call_id), ['call_r1', 'call_r2', 'call_ls', 'call_w', 'call_ok']);
  for (const m of tools.slice(0, 4)) {
    const t = contentText(m.content);
    assert.ok(!t.includes('SECRET-OUTSIDE'), `no outside content leaks: ${t}`);
    assert.ok(!t.includes('data'), `no outside listing leaks (the parent holds course/ and data/): ${t}`);
    assert.match(t, /error|escape|outside|not allowed|denied|refus/i, `an error string: ${JSON.stringify(t)}`);
  }
  assert.equal(contentText(tools[4].content), 'inner\n', 'an in-cwd path after the refusals still works');
  const ids = ofKind(run.updates, 'tool_call').map((u) => u.toolCallId as string);
  assert.equal(ids.length, 5, 'every call is announced, refused or not');
  // Reading of §4's `status: "completed" | "failed"`: a tool that returned an error string failed.
  for (const id of ids.slice(0, 4)) assert.equal(pairFor(run.updates, id).update.status, 'failed');
  assert.equal(pairFor(run.updates, ids[4]).update.status, 'completed');
  assert.equal(await c.s.end(), 0);
});

test('a missing file is a failed read with an error result, not a turn error (§4)', { timeout: TIMEOUT }, async () => {
  const c = await connectWithFiles();
  fake.enqueue(toolCallsTurn([{ id: 'call_m', name: 'read_file', args: { path: 'absent.md' } }]), textTurn('No file.'));
  const run = await runPrompt(c.s, c.sessionId, [text('read absent')]);
  expectStop(run, 'end_turn');
  const { update } = pairFor(run.updates, ofKind(run.updates, 'tool_call')[0].toolCallId as string);
  assert.equal(update.status, 'failed');
  assert.match(toolResultText(update), /ENOENT|no such|not found|does not exist|error/i);
  assert.equal(await c.s.end(), 0);
});

test('a model that never stops calling tools is cut off at 50 rounds with stopReason max_turn_requests (§4)', { timeout: 60_000 }, async () => {
  const c = await connectWithFiles();
  let served = 0;
  fake.fallback = () => { served++; return toolCallsTurn([{ id: `call_${served}`, name: 'list_dir', args: { path: '.' } }]); };
  const run = await runPrompt(c.s, c.sessionId, [systemBlock(SYSTEM), text('loop')], { timeout: 55_000 });
  expectStop(run, 'max_turn_requests');
  assert.equal(run.permissionRequests.length, 0);
  // "At most 50 tool rounds per prompt": fifty tool-call responses were
  // executed; whether the cap is checked before or after a 51st request is
  // not pinned, so both counts are accepted.
  const n = fake.chatRequests().length;
  assert.ok(n === 50 || n === 51, `50 tool rounds, got ${n} requests`);
  assert.equal(ofKind(run.updates, 'tool_call').length, 50);
  assert.equal(ofKind(run.updates, 'tool_call_update').filter((u) => u.status === 'completed').length, 50);
  // Every round fed the previous result back: the last body holds 50 tool messages.
  assert.equal(toolMessages(fake.chatRequests()[n - 1].body).length, n - 1);

  // The session is still usable afterwards.
  fake.fallback = null;
  fake.enqueue(textTurn('calm'));
  expectStop(await runPrompt(c.s, c.sessionId, [text('ok?')]), 'end_turn');
  assert.equal(await c.s.end(), 0);
});

test('a second prompt while a tool permission is outstanding is -32000; answering then ends the first turn (§2, §3)', { timeout: TIMEOUT }, async () => {
  const c = await connectWithFiles();
  fake.enqueue(toolCallsTurn([{ id: 'call_w', name: 'write_file', args: { path: 'late.txt', content: 'late\n' } }]), textTurn('done'));
  let release!: (a: { outcome: 'selected'; optionId: string }) => void;
  const gate = new Promise<{ outcome: 'selected'; optionId: string }>((r) => { release = r; });
  const pending = runPrompt(c.s, c.sessionId, [text('write late')], { answer: () => gate });
  // Wait until the permission request is on the wire, then poke the session.
  await new Promise<void>((resolve) => {
    const tick = () => (c.s.lines.some((l) => l.json?.method === 'agent/requestPermission') ? resolve() : setTimeout(tick, 15));
    tick();
  });
  const busy = await c.s.request(freshId(), 'agent/prompt', { sessionId: c.sessionId, blocks: [text('again')] });
  assert.equal(expectError(busy, -32000, 'prompt while a permission is outstanding').message, `session ${c.sessionId} has a turn in progress`);
  release({ outcome: 'selected', optionId: 'allow-once' });
  const run = await pending;
  expectStop(run, 'end_turn');
  assert.equal(readFileSync(join(c.cwd, 'late.txt'), 'utf8'), 'late\n');
  assert.equal(await c.s.end(), 0);
});
