// What the page answers on the user's behalf, and what it still asks.
//
// The first run from the website put five prompts in front of the user
// before the agent had read a single page of the lecture: "check available
// PDF tooling", "look for SETUP.md", and so on. A student with a Claude
// subscription should not be clicking Yes to the agent reading its own
// instructions. But the repository's stance (docs/WORK.md, "bypassPermissions")
// stands: an agent that can run anything with no gate is not something this
// page hands out. So the line is drawn by what the request is, not by mode:
//
//   reads, searches, thinking, fetching a URL   -> allowed, always
//   edits whose every path is in the course folder -> allowed
//   commands, deletes, moves, anything else      -> asked, as before
//
// Once the extract stage ships its own PDF text (APP.md, Stage 3 findings),
// the commands mostly stop being asked for at all.

import type { PermissionRequest } from '../engine/bridge-client.js';

export interface Decision {
  optionId: string;
  reason: string; // shown in the pane, so an auto-answer is never invisible
}

const READ_KINDS = new Set(['read', 'search', 'think', 'fetch']);

function norm(p: string): string {
  const s = p.replace(/\\/g, '/');
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

/** True when `path` is `dir` or lies beneath it. Separator-agnostic; case-exact. */
export function inside(dir: string, path: string): boolean {
  const d = norm(dir);
  const p = norm(path);
  return p === d || p.startsWith(d.endsWith('/') ? d : `${d}/`);
}

/** The option to select without asking, or null to put the prompt in front of the user. */
export function decide(req: PermissionRequest, courseDir: string | null): Decision | null {
  const { toolCall, options } = req.params;
  const allow = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_always');
  if (!allow) return null; // nothing to allow with: the agent decides what it offers
  const kind = toolCall.kind ?? 'other';
  if (READ_KINDS.has(kind)) return { optionId: allow.optionId, reason: `${kind}: allowed` };
  if (kind === 'edit') {
    const paths = (toolCall.locations ?? []).map((l) => l.path);
    if (courseDir && paths.length > 0 && paths.every((p) => inside(courseDir, p))) {
      return { optionId: allow.optionId, reason: 'edit in the course folder: allowed' };
    }
  }
  return null;
}
