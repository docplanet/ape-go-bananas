// Signing in to a subscription, as a console.
//
// The ACP adapters advertise `authMethods: []` -- Claude's sign-in is not a
// protocol method, it is a command the CLI owns (`claude setup-token`, which
// its own help describes as "Set up a long-lived authentication token
// (requires Claude subscription)"). So the shell runs that command and relays its console verbatim: whatever it prints is shown,
// and whatever the user types goes back to its stdin. Nothing here knows the
// shape of the flow, which is the point -- when Anthropic changes it, this
// keeps working because it was never a reimplementation.
//
// Written for the in-tab host, which had no browser to hand the OAuth step
// to; kept for any host that provides `signIn` (engine/host.ts). Neither
// current one does.

import type { EngineHost } from '../engine/host.js';

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/**
 * The CLI draws with escape sequences. Stripping them all ran the words
 * together -- "Pastecodehereifprompted" -- because a terminal program spaces
 * with cursor-forward rather than with spaces, so those become spaces here.
 * The splash banner is block-drawing characters carrying no information, so
 * lines made only of them are dropped.
 */
function plain(text: string): string {
  const BANNER = /^[\s*\u00b7\u2026\u2500-\u259f\u2726\u2736\u273b\u273d\u2727]+$/;
  return text
    .replace(/\u001b\[(\d+)C/g, (_m, n: string) => ' '.repeat(Math.min(Number(n), 200)))
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/\u001b[\[\]()#;?]*[0-9;?]*[a-zA-Z><=]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => line.trim() === '' || !BANNER.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}


/** The URL the command prints is the whole point of the flow, so make it clickable. */
function linkify(text: string): string {
  return esc(text).replace(/https?:\/\/[^\s<>"']+/g, (url) => `<a href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>`);
}

export interface SignIn {
  dispose(): void;
}

/**
 * Mounts the sign-in console. `onFinished` is called with the command's exit
 * code -- zero means the token was written and an agent can be connected.
 */
export function mountSignIn(host: HTMLElement, engine: EngineHost, say: (text: string, isError?: boolean) => void, onFinished: (code: number) => void): SignIn | null {
  if (!engine.signIn) return null;

  const box = document.createElement('section');
  box.className = 'signin';
  box.innerHTML = `
    <header class="bar"><strong>Sign in to Claude</strong><span class="grow"></span><button type="button" data-close="1" class="quiet">Close</button></header>
    <pre class="console" id="signin-console"></pre>
    <form class="composer" id="signin-form">
      <input id="signin-input" autocomplete="off" spellcheck="false" placeholder="Type what it asks for, then Send">
      <button type="submit">Send</button>
    </form>`;
  host.prepend(box);

  const console_ = box.querySelector<HTMLPreElement>('#signin-console')!;
  const input = box.querySelector<HTMLInputElement>('#signin-input')!;
  let buffer = '';

  const session = engine.signIn((chunk) => {
    buffer = (buffer + plain(chunk)).slice(-8000);
    console_.innerHTML = linkify(buffer);
    console_.scrollTop = console_.scrollHeight;
  });
  if (!session) return null;

  const dispose = (): void => {
    session.cancel();
    box.remove();
  };

  box.querySelector<HTMLButtonElement>('button[data-close]')!.addEventListener('click', dispose);
  box.querySelector<HTMLFormElement>('#signin-form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const line = input.value;
    if (!line) return;
    input.value = '';
    // Echoed locally: the command is reading a raw line and will not print it
    // back, and a flow with no visible record of what you answered is worse.
    buffer += `\n> ${line.length > 12 ? `${line.slice(0, 6)}… (${line.length} characters)` : line}\n`;
    console_.innerHTML = linkify(buffer);
    session.write(line);
  });

  void session.done.then(
    (code) => {
      say(code === 0 ? 'signed in — pick Claude Agent below and connect' : `sign-in ended with code ${code}`, code !== 0);
      if (code === 0) box.remove();
      onFinished(code);
    },
    (err: unknown) => say(err instanceof Error ? err.message : String(err), true),
  );

  input.focus();
  return { dispose };
}
