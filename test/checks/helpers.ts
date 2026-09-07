// Shared plumbing for the differential and render-review suites: spawning the real
// Python originals and giving them/the TS port the same scratch files. Deliberately
// depends on nothing from src/checks — if that module is missing or broken, these
// helpers must still load, so a differential test fails on the actual comparison line,
// not on an unrelated import at the top of the file.
//
// Only other test/checks/*.test.ts files import this, so it stays a plain .ts import
// (tsconfig.test.json's allowImportingTsExtensions exists for exactly this case) rather
// than something that has to survive the src/ -> dist/ build.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// The engine repo is read-only reference material for this task: never write into it,
// only spawn its two tools as child processes and read what they print/produce.
//
// This pointed at a `.claude/worktrees/` path, which git garbage-collects: when that
// worktree went away it would have taken the entire differential suite -- the repo's
// only evidence that the port is faithful -- down with it. Point at the main checkout,
// and let APE_ENGINE_REPO override it for anyone whose clone lives elsewhere.
export const ENGINE_REPO =
  process.env.APE_ENGINE_REPO ?? `${process.env.HOME ?? ''}/Dev/Anki`;
export const CHECK_DECK_PY = join(ENGINE_REPO, 'tools', 'check_deck.py');
export const RENDER_REVIEW_PY = join(ENGINE_REPO, 'tools', 'render_review.py');

export interface PyResult {
  stdout: string;
  stderr: string;
  status: number;
}

function runPython(scriptPath: string, args: string[], env?: Record<string, string>): PyResult {
  const result = spawnSync('python3', [scriptPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (result.error) {
    throw new Error(`failed to spawn python3 for ${scriptPath}: ${result.error.message}`);
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? -1 };
}

// A fresh directory per call (never reused across cases) so parallel test files, and
// parallel cases within one file, never see each other's deck.json/transcript/media.
export function makeScratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'ape-checks-'));
}

export function writeScratchFile(dir: string, name: string, content: string): string {
  const full = join(dir, name);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

// A real media directory with real (empty) files, so both check_deck.py's os.path.exists
// and the port's fs.existsSync are answering the identical, real filesystem question -
// no injected/mocked existence check on either side of the diff.
export function makeMediaDir(presentFiles: string[]): string {
  const dir = makeScratchDir();
  for (const name of presentFiles) {
    writeScratchFile(dir, name, '');
  }
  return dir;
}

export interface CheckDeckPyInput {
  /** Written verbatim as a bare-list deck.json - shape-unwrapping itself is out of
   *  scope here (see differential.test.ts's header comment). */
  notes: unknown[];
  noMedia?: boolean;
  /** Sets ANKI_MEDIA for the child process. Omit only when deliberately exercising the
   *  "media dir not found" stderr note path is NOT the point of the case - every case in
   *  this suite either passes --no-media or a mediaDir that actually exists, so that note
   *  never fires and stderr stays empty for every "successful run" comparison. */
  mediaDir?: string;
  /** Raw text of each --transcript source file, in the order they should be passed. */
  transcripts?: string[];
  /** Raw text of the --inventory markdown file. */
  inventoryText?: string;
}

export function runCheckDeckPython(input: CheckDeckPyInput): PyResult {
  const dir = makeScratchDir();
  const deckPath = writeScratchFile(dir, 'deck.json', JSON.stringify(input.notes));
  const args: string[] = [];
  if (input.noMedia) args.push('--no-media');
  (input.transcripts ?? []).forEach((text, i) => {
    const p = writeScratchFile(dir, `transcript-${i}.txt`, text);
    args.push('--transcript', p);
  });
  if (input.inventoryText !== undefined) {
    const p = writeScratchFile(dir, 'inventory.md', input.inventoryText);
    args.push('--inventory', p);
  }
  args.push(deckPath);
  const env: Record<string, string> = {};
  if (input.mediaDir !== undefined) env.ANKI_MEDIA = input.mediaDir;
  return runPython(CHECK_DECK_PY, args, env);
}

export interface RenderReviewPyInput {
  /** The full top-level JSON value written as deck.json - a bare list or a dict, exactly
   *  as JSON.stringify renders it (so a case can add a snake_case deck_name key that the
   *  strictly-typed DeckNote[] on the TS side has no field for - see render-review.test.ts). */
  payload: unknown;
  mediaDir?: string;
}

export interface RenderReviewPyResult extends PyResult {
  /** null when the run did not produce an output file (non-zero exit before the write). */
  html: string | null;
}

export function runRenderReviewPython(input: RenderReviewPyInput): RenderReviewPyResult {
  const dir = makeScratchDir();
  const deckPath = writeScratchFile(dir, 'deck.json', JSON.stringify(input.payload));
  const outPath = join(dir, 'out.html');
  const env: Record<string, string> = {};
  if (input.mediaDir !== undefined) env.ANKI_MEDIA = input.mediaDir;
  const result = runPython(RENDER_REVIEW_PY, [deckPath, outPath], env);
  let html: string | null = null;
  try {
    html = readFileSync(outPath, 'utf8');
  } catch {
    html = null;
  }
  return { ...result, html };
}
