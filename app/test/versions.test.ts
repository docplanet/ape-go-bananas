// versions.ts: when the picker offers "Update to x". A false "newer" offers a
// downgrade; a missed one leaves an install on last month's models forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer } from '../src/agent/versions.ts';

test('isNewer: numeric parts compare as numbers, not text', () => {
  assert.equal(isNewer('0.81.1', '0.76.0'), true);
  assert.equal(isNewer('0.10.0', '0.9.9'), true, '10 > 9, though "1" < "9"');
  assert.equal(isNewer('1.0', '0.99.99'), true);
  assert.equal(isNewer('2.0.0', '2.0'), false, 'a missing part is zero');
});

test('isNewer: the same or an older version is not an update', () => {
  assert.equal(isNewer('0.76.0', '0.76.0'), false);
  assert.equal(isNewer('0.75.1', '0.76.0'), false);
  assert.equal(isNewer('v0.81.1', '0.81.1'), false, 'a leading v is the same version');
});

test('isNewer: a release is after its prerelease; prereleases compare in order', () => {
  assert.equal(isNewer('1.0.0', '1.0.0-rc.1'), true);
  assert.equal(isNewer('1.0.0-rc.1', '1.0.0'), false);
  assert.equal(isNewer('1.0.0-rc.10', '1.0.0-rc.2'), true);
});

test('isNewer: anything that is not a version is never newer', () => {
  for (const [a, b] of [['', '1.0.0'], ['1.0.0', ''], [null, '1.0.0'], ['1.0.0', null], ['latest', '1.0.0'], ['^1.2.0', '1.0.0'], ['1.2.0', 'git+https://x']] as const) {
    assert.equal(isNewer(a, b), false, `${String(a)} vs ${String(b)}`);
  }
});
