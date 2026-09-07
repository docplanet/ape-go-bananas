// Shared plumbing for test/integration/*.test.ts.
//
// Every test in this directory drives the actual built CLI (dist/cli/
// index.js) as a real child process -- never checkDeck/renderReview/
// writeApkg called directly, which is exactly what test/checks and
// test/apkg already do exhaustively. What neither of those suites can
// prove is that src/cli wires argv to those functions correctly and
// surfaces the right stdout/stderr/exit code; that's this directory's only
// job, so it only ever asserts at the process boundary.
//
// Only other test files import this (nothing under src/ needs it), so it
// uses an explicit .ts specifier -- tsconfig.test.json turns on
// allowImportingTsExtensions for exactly that case, matching test/checks/
// helpers.ts and test/apkg/helpers.ts.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_ENTRY = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));
export const REFERENCE_CARDS_FIXTURE = fileURLToPath(new URL('../fixtures/reference-cards.json', import.meta.url));

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the built CLI exactly the way a real user would invoke it --
 * `node dist/cli/index.js <args>` -- except spawned via `process.execPath`
 * rather than a bare "node" on PATH, so this suite is immune to the system
 * default `node` (v20, per this repo's own environment notes) shadowing
 * the pinned v24 toolchain the harness itself is already running on.
 * Synchronous, matching the rest of this project's test helpers
 * (test/apkg/helpers.ts's own execFileSync-based zip inspection) -- a CLI
 * invocation here is a few tens of milliseconds, not worth the ceremony of
 * an async test.
 */
export function runCli(args: string[], opts: { cwd: string; mediaDir?: string; home?: string }): CliResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.mediaDir !== undefined) {
    env.ANKI_MEDIA = opts.mediaDir;
  } else {
    // An inherited ANKI_MEDIA from the calling shell would make a "did the
    // check use MY media dir" assertion flaky by host -- callers that want
    // media resolved always set opts.mediaDir explicitly instead.
    delete env.ANKI_MEDIA;
  }
  if (opts.home !== undefined) {
    // Deleting ANKI_MEDIA alone does NOT guarantee media-dir.ts's own
    // per-OS fallback paths fail to exist -- this repo is developed on a
    // machine with a real, populated Anki profile under the real $HOME, so
    // a test exercising the "no override, default also missing" codepath
    // must override HOME to a directory guaranteed to have no Anki2
    // profile under it, not merely unset ANKI_MEDIA.
    env.HOME = opts.home;
  }
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: opts.cwd,
    env,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A fresh temp directory holding a copy of the seven-reference-card fixture
 * as `deck.json`, plus a media directory containing the `slide.jpg` that
 * ref-06/ref-07 reference. A *copy*, not the fixture path itself, so that
 * `review`'s and `export`'s default (no `-o`) output paths -- both a
 * sibling of deck.json -- land in this throwaway directory rather than
 * inside test/fixtures/.
 */
export function makeReferenceCardsWorkDir(): { dir: string; deckPath: string; mediaDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ape-integration-'));
  const deckPath = join(dir, 'deck.json');
  writeFileSync(deckPath, readFileSync(REFERENCE_CARDS_FIXTURE, 'utf8'));
  const mediaDir = join(dir, 'media');
  mkdirSync(mediaDir);
  // Existence (for the media check) and byte content (for the apkg's own
  // media manifest) are all that matter here -- not a valid JPEG.
  writeFileSync(join(mediaDir, 'slide.jpg'), 'not-a-real-jpeg-just-fixture-bytes');
  return { dir, deckPath, mediaDir };
}

/**
 * Extracts one zip member via the system `unzip` binary -- a real,
 * independent zip reader sharing no code with src/apkg/zip.ts -- to a file
 * under `destDir`, and returns that file's path. Same technique as
 * test/apkg/helpers.ts's extractZipMember, reimplemented locally rather
 * than imported so this directory stays self-contained and does not couple
 * to another module's test-only files.
 */
export function extractZipMember(zipPath: string, memberName: string, destDir: string): string {
  execFileSync('unzip', ['-o', '-q', zipPath, memberName, '-d', destDir]);
  return join(destDir, memberName);
}

/** Reads one zip member's decompressed bytes straight to a Buffer via
 *  `unzip -p`, without writing it to disk. */
export function readZipMember(zipPath: string, memberName: string): Buffer {
  return execFileSync('unzip', ['-p', zipPath, memberName]);
}
