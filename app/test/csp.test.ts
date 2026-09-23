// The review frame is srcdoc, so it inherits the window's CSP, and script-src
// has no 'unsafe-inline': the Flag button, the card counter and "go to card"
// all live in one inline script that runs only because its hash is listed.
// Edit the script without the hash and all three go dead in a release build
// while still working in dev -- this is the check that notices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FLAG_SCRIPT_BODY } from '../src/flag-script.ts';

const conf = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as { app: { security: { csp: string } } };

function scriptSrc(csp: string): string[] {
  const directive = csp.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0] === 'script-src');
  assert.ok(directive, 'the CSP has a script-src');
  return directive.slice(1);
}

test('the review frame script is allowed by its sha256, and inline script in general is not', () => {
  const hash = `'sha256-${createHash('sha256').update(FLAG_SCRIPT_BODY, 'utf8').digest('base64')}'`;
  const sources = scriptSrc(conf.app.security.csp);
  assert.ok(sources.includes(hash), `script-src must list ${hash} -- the frame script changed; put the new hash in tauri.conf.json`);
  assert.ok(!sources.includes("'unsafe-inline'"), "script-src must not allow 'unsafe-inline': a card's own <script> would run too");
  assert.equal(sources.filter((s) => s.startsWith("'sha256-")).length, 1, 'one hash, the current script: a stale one is a script nobody reviewed');
});
