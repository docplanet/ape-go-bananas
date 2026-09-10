// The program that runs inside the container beside the sidecar.
//
// It exists for one reason: WebContainer hands a spawned process a
// pseudo-terminal, and a pty is free to echo, wrap and rewrite the bytes
// crossing it -- fatal for newline-delimited JSON-RPC. This wrapper owns the
// real pipes to the sidecar and speaks the base64 line protocol in
// framing.ts to the page, which a terminal cannot corrupt.
//
// It is source, not a file in the repo, because it has to be mounted into
// the container's filesystem at run time.

export const WRAPPER_PATH = 'ape-wrapper.mjs';

export const WRAPPER_SOURCE = [
  "import { spawn } from 'node:child_process';",
  "import { createInterface } from 'node:readline';",
  '',
  'const cwd = process.cwd();',
  'const env = {',
  '  ...process.env,',
  "  APE_METHOD_DIR: cwd + '/method',",
  "  APE_DATA_DIR: cwd + '/data',",
  "  HOME: cwd + '/home',",
  '  // The adapters read this to decide which claude executable to drive; the',
  '  // page installs the last JavaScript build there (see host.ts).',
  "  CLAUDE_CODE_EXECUTABLE: cwd + '/claude-js/node_modules/@anthropic-ai/claude-code/cli.js',",
  '  // Inherited by every npm the sidecar runs: the per-platform native',
  '  // packages are optional dependencies and cannot execute in here.',
  "  npm_config_omit: 'optional',",
  '};',
  '',
  "const child = spawn('node', ['dist/sidecar/index.js'], { stdio: ['pipe', 'pipe', 'pipe'], env });",
  '',
  'const relay = (stream, tag) =>',
  '  createInterface({ input: stream }).on(\'line\', (line) => {',
  "    process.stdout.write(tag + ' ' + Buffer.from(line, 'utf8').toString('base64') + '\\n');",
  '  });',
  "relay(child.stdout, 'OUT');",
  "relay(child.stderr, 'ERR');",
  '',
  "createInterface({ input: process.stdin }).on('line', (line) => {",
  '  const match = /^IN (.*)$/.exec(line.trim());',
  "  if (match) child.stdin.write(Buffer.from(match[1], 'base64').toString('utf8') + '\\n');",
  '});',
  '',
  "child.on('exit', (code) => {",
  "  process.stdout.write('EXIT ' + (code === null ? '' : code) + '\\n');",
  '  process.exit(0);',
  '});',
  '',
].join('\n');
