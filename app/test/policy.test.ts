// permission-policy.ts: the page answers reads and in-folder edits itself
// and asks about everything else. Pinned here because a wrong "allow" is a
// file the agent should not have touched, and a wrong "ask" is the prompt
// storm the policy exists to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, inside } from '../src/agent/permission-policy.ts';
import type { PermissionRequest } from '../src/engine/client.ts';

const COURSE = '/Users/someone/Desktop/ape-test';
const OPTS = [
  { optionId: 'allow', name: 'Yes', kind: 'allow_once' },
  { optionId: 'always', name: 'Yes, always', kind: 'allow_always' },
  { optionId: 'reject', name: 'No', kind: 'reject_once' },
];

function req(kind: string | undefined, locations?: { path: string }[], options = OPTS): PermissionRequest {
  return { id: 1, method: 'agent/requestPermission', params: { sessionId: 's', toolCall: { title: 't', ...(kind ? { kind } : {}), ...(locations ? { locations } : {}) }, options } };
}

test('inside: same dir, beneath, separator-agnostic, never a sibling with a shared prefix', () => {
  assert.equal(inside(COURSE, COURSE), true);
  assert.equal(inside(COURSE, `${COURSE}/inventory.md`), true);
  assert.equal(inside(`${COURSE}/`, `${COURSE}/a/b.md`), true);
  assert.equal(inside('C:\\Users\\x\\course', 'C:/Users/x/course/deck.json'), true);
  assert.equal(inside(COURSE, `${COURSE}-other/deck.json`), false);
  assert.equal(inside(COURSE, '/Users/someone/Desktop'), false);
  assert.equal(inside(COURSE, '/etc/passwd'), false);
});

test('reads, searches, thinking and fetches are allowed with the one-time option', () => {
  for (const kind of ['read', 'search', 'think', 'fetch']) {
    const d = decide(req(kind), COURSE);
    assert.equal(d?.optionId, 'allow', kind);
  }
  assert.equal(decide(req('read'), null)?.optionId, 'allow', 'reads need no course folder');
});

test('edits are allowed only when every location is in the course folder', () => {
  assert.equal(decide(req('edit', [{ path: `${COURSE}/inventory.md` }]), COURSE)?.optionId, 'allow');
  assert.equal(decide(req('edit', [{ path: `${COURSE}/inventory.md` }, { path: `${COURSE}/plan.md` }]), COURSE)?.optionId, 'allow');
  assert.equal(decide(req('edit', [{ path: `${COURSE}/a.md` }, { path: '/Users/someone/.zshrc' }]), COURSE), null);
  assert.equal(decide(req('edit', [{ path: '/Users/someone/.zshrc' }]), COURSE), null);
  assert.equal(decide(req('edit', []), COURSE), null, 'an edit that names no path is asked');
  assert.equal(decide(req('edit'), COURSE), null);
  assert.equal(decide(req('edit', [{ path: `${COURSE}/a.md` }]), null), null, 'no course folder, no auto edit');
});

test('commands, deletes, moves, mode switches and unknown kinds are asked', () => {
  for (const kind of ['execute', 'delete', 'move', 'switch_mode', 'other', undefined, 'made-up']) {
    assert.equal(decide(req(kind, [{ path: `${COURSE}/a.md` }]), COURSE), null, String(kind));
  }
});

test('with no allow option offered there is nothing to auto-select', () => {
  assert.equal(decide(req('read', undefined, [{ optionId: 'r', name: 'No', kind: 'reject_once' }]), COURSE), null);
  assert.equal(decide(req('read', undefined, [{ optionId: 'a', name: 'Always', kind: 'allow_always' }]), COURSE)?.optionId, 'a', 'allow_always is the fallback when no allow_once is offered');
});
