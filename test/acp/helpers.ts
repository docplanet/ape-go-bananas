// Shared plumbing for the ACP client test suite: a process-leak-proof
// timeout wrapper, a pidfile-based kill sweep, and the manual
// async-generator drain every *.test.ts file uses to read a prompt turn's
// streamed updates plus its final stop reason.
//
// Pure functions and constants only -- no top-level test()/after() calls --
// so this file is inert if node --test's bare discovery imports it as a
// candidate test file in its own right (it lives under test/, so it will;
// confirmed by hand against a real hung subprocess before writing any of
// the real *.test.ts files, not assumed).

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AcpClient, PromptTurnResult, SessionUpdate } from '../../dist/acp/index.js';

export const MOCK_AGENT_PATH = fileURLToPath(new URL('./mock-agent.ts', import.meta.url));
export const RAW_AGENT_PATH = fileURLToPath(new URL('./raw-agent.ts', import.meta.url));

/**
 * Rejects with `label` in the message if `p` has not settled within `ms`.
 * Unlike Promise.race alone, this always clears its timer, so a slow test
 * file doesn't accumulate armed timers across many calls.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls until `pid` is no longer alive, or `ms` elapses (then returns false). */
export async function waitForExit(pid: number, ms = 2000): Promise<boolean> {
  const step = 20;
  for (let waited = 0; waited < ms; waited += step) {
    if (!pidIsAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  return !pidIsAlive(pid);
}

const trackedPidFiles: string[] = [];
const trackedTmpDirs: string[] = [];

/**
 * Call right after spawning an agent whose ConnectOptions.env sets
 * ACP_TEST_PIDFILE, so sweepLeaks() can find and kill it later even if the
 * test never got far enough to obtain an AcpClient to call close() on.
 */
export function trackPidFile(pidFilePath: string): void {
  trackedPidFiles.push(pidFilePath);
}

export function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  trackedTmpDirs.push(dir);
  return dir;
}

/**
 * Kills anything still running under a tracked pidfile and removes tracked
 * tmp dirs. Register once per test file with `after(sweepLeaks)` from
 * 'node:test'.
 *
 * This is a safety net, not a substitute for a real assertion: it exists
 * for the case where connect() hangs so completely the test never got a
 * client to call close() on, so nothing in the test itself could have
 * asserted the process was gone. Individual tests that specifically care
 * about "did close()/cancel() actually terminate the agent" should still
 * assert that directly with pidIsAlive()/waitForExit(), the same pidfile
 * this sweep uses.
 */
export async function sweepLeaks(): Promise<void> {
  for (const f of trackedPidFiles) {
    if (!existsSync(f)) continue;
    const pid = Number(readFileSync(f, 'utf8').trim());
    if (Number.isFinite(pid) && pidIsAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone between the check and the kill; fine
      }
    }
  }
  trackedPidFiles.length = 0;
  for (const d of trackedTmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort only
    }
  }
  trackedTmpDirs.length = 0;
}

/**
 * Reads the agent's pid from `pidFile`, calls client.close(), then asserts
 * (by polling, not by trusting close()'s promise alone) that the process
 * actually exited -- the direct, per-test version of the no-leaked-process
 * requirement, as opposed to sweepLeaks()'s end-of-file safety net.
 */
export async function closeAndAssertExit(client: AcpClient, pidFile: string, withinMs = 2000): Promise<void> {
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  await client.close();
  const exited = await waitForExit(pid, withinMs);
  if (!exited) {
    throw new Error(`agent pid ${pid} was still alive ${withinMs}ms after client.close() resolved`);
  }
}

export interface DrainedPrompt {
  updates: SessionUpdate[];
  result: PromptTurnResult;
}

/**
 * Manually drives session.prompt()'s AsyncGenerator to completion via
 * next(), since `for await` alone discards a generator's `return` value --
 * and the PromptTurnResult (the stop reason, docs/research/acp-protocol.md
 * #7.3) only ever arrives as that return value. This is the consumption
 * pattern the pinned API expects a caller to use whenever it needs the stop
 * reason, not just the streamed updates.
 */
export async function drainPrompt(
  iterator: AsyncGenerator<SessionUpdate, PromptTurnResult, void>,
): Promise<DrainedPrompt> {
  const updates: SessionUpdate[] = [];
  for (;;) {
    const step = await iterator.next();
    if (step.done) {
      return { updates, result: step.value };
    }
    updates.push(step.value);
  }
}

/**
 * Same as drainPrompt, but stops after collecting `count` updates and
 * returns without exhausting the generator -- for tests that need to
 * observe streaming in progress (e.g. to send session/cancel mid-turn)
 * rather than waiting for the turn to resolve.
 */
export async function takeUpdates(
  iterator: AsyncGenerator<SessionUpdate, PromptTurnResult, void>,
  count: number,
): Promise<SessionUpdate[]> {
  const updates: SessionUpdate[] = [];
  while (updates.length < count) {
    const step = await iterator.next();
    if (step.done) {
      throw new Error(`prompt turn resolved after only ${updates.length}/${count} updates`);
    }
    updates.push(step.value);
  }
  return updates;
}
