// Two local fakes for test/sidecar/agents-install.test.ts, written from
// docs/research/agent-protocol.md §1 and agent-install-and-auth.md §3 by a
// context that has not seen src/sidecar/agent*.ts or src/agents/.
//
//  - an ACP registry (GET <url>/registry.json) with a request counter and a
//    switchable failure mode, so cache-vs-fetch behaviour is observable;
//  - an npm registry good enough for the real `npm install --registry <url>
//    fake-agent@1.2.3`: one packument at /fake-agent and its tarball, built
//    here with the system `tar` so the shasum/integrity match the bytes served.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';

import { makeTmpDir } from './helpers.ts';

export const FAKE_PACKAGE = 'fake-agent';
export const FAKE_VERSION = '1.2.3';

/**
 * registry.json as the ACP CDN serves it (agent-install-and-auth.md §2:
 * `version`, `agents`, `extensions: []`), with entries per §3's schema.
 * Order matters below: tests assert the mapped providers keep it.
 */
export const REGISTRY_ENTRIES = {
  npx: {
    id: 'fake-npx',
    name: 'Fake npx agent',
    description: 'An npm-distributed agent served by the local fake registry',
    version: FAKE_VERSION,
    distribution: { npx: { package: FAKE_PACKAGE, args: ['--acp'], env: {} } },
  },
  binary: {
    id: 'fake-binary',
    name: 'Fake binary agent',
    description: 'A binary-distributed agent (listed, not installable)',
    version: '2.0.0',
    distribution: {
      binary: {
        'darwin-aarch64': { archive: 'https://example.invalid/fake-binary-darwin-arm64.tar.gz', cmd: './fake-binary', args: ['acp'], env: {} },
        'darwin-x86_64': { archive: 'https://example.invalid/fake-binary-darwin-x64.tar.gz', cmd: './fake-binary', args: ['acp'], env: {} },
        'linux-x86_64': { archive: 'https://example.invalid/fake-binary-linux-x64.tar.gz', cmd: './fake-binary', args: ['acp'], env: {} },
      },
    },
  },
  uvx: {
    id: 'fake-uvx',
    name: 'Fake uvx agent',
    description: 'A uvx-distributed agent (listed, not installable)',
    version: '0.9.0',
    distribution: { uvx: { package: 'fake-uvx-agent', args: ['--acp'], env: {} } },
  },
  /** Fails §3's required set (no `distribution`); §1 says it is skipped. */
  malformed: {
    id: 'fake-malformed',
    name: 'Fake malformed agent',
    description: 'No distribution key at all',
    version: '0.0.1',
  },
  /** The registry's usual form: the version repeated as an `@version` suffix. */
  suffixed: {
    id: 'fake-suffixed',
    name: 'Fake suffixed agent',
    description: 'Package name carries an @version suffix, like claude-acp does',
    version: '4.5.6',
    distribution: { npx: { package: 'fake-suffixed-agent@4.5.6', args: [], env: {} } },
  },
  /** An npx entry whose package the fake npm registry does not have (404). */
  missing: {
    id: 'fake-missing',
    name: 'Fake missing agent',
    description: 'Its packument 404s on the fake npm registry',
    version: '0.0.1',
    distribution: { npx: { package: 'fake-missing-agent', args: [], env: {} } },
  },
} as const;

export function registryDocument(): string {
  return JSON.stringify({ version: '1.0.0', agents: Object.values(REGISTRY_ENTRIES), extensions: [] });
}

export interface FakeAcpRegistry {
  /** The `registryUrl` to hand the sidecar (points straight at registry.json). */
  url: string;
  /** GET requests for registry.json seen so far. */
  requests: () => number;
  /** 'ok' serves the document; 'fail' answers 500 to every request. */
  setMode: (mode: 'ok' | 'fail') => void;
  close: () => Promise<void>;
}

export async function startAcpRegistry(): Promise<FakeAcpRegistry> {
  let count = 0;
  let mode: 'ok' | 'fail' = 'ok';
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/registry.json') count += 1;
    if (mode === 'fail') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('fake registry: simulated outage');
      return;
    }
    if (req.method === 'GET' && req.url === '/registry.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(registryDocument());
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  const base = await listen(server);
  return {
    url: `${base}/registry.json`,
    requests: () => count,
    setMode: (m) => { mode = m; },
    close: () => closeServer(server),
  };
}

export interface FakePackage {
  tarball: Buffer;
  shasum: string;
  integrity: string;
}

/**
 * Builds fake-agent-1.2.3.tgz from a temp dir holding package/package.json
 * and package/index.js. `bin` is the sole entry, named after the package,
 * so §1's "bin: the sole entry, or the one named after the package's
 * unscoped name" resolves the same way by either rule.
 */
export function buildFakePackage(): FakePackage {
  const work = makeTmpDir('ape-fake-pkg-');
  const pkgDir = join(work, 'package');
  mkdirSync(pkgDir);
  writeFileSync(join(pkgDir, 'package.json'), `${JSON.stringify({
    name: FAKE_PACKAGE,
    version: FAKE_VERSION,
    description: 'fake ACP agent for the sidecar install oracle',
    license: 'MIT',
    bin: { [FAKE_PACKAGE]: 'index.js' },
  }, null, 2)}\n`);
  writeFileSync(join(pkgDir, 'index.js'), '#!/usr/bin/env node\nconsole.log("fake-agent " + process.argv.slice(2).join(" "));\n');
  const out = join(work, `${FAKE_PACKAGE}-${FAKE_VERSION}.tgz`);
  // COPYFILE_DISABLE keeps macOS bsdtar from adding ._* AppleDouble members.
  execFileSync('tar', ['-czf', out, '-C', work, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const tarball = readFileSync(out);
  return {
    tarball,
    shasum: createHash('sha1').update(tarball).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
  };
}

export interface FakeNpmRegistry {
  /** Pass as `npm: { registry }` on agents/install. */
  url: string;
  /** Every `METHOD /path` seen, in order. */
  requests: string[];
  close: () => Promise<void>;
}

export async function startNpmRegistry(pkg: FakePackage): Promise<FakeNpmRegistry> {
  const requests: string[] = [];
  let base = '';
  const tarballPath = `/${FAKE_PACKAGE}/-/${FAKE_PACKAGE}-${FAKE_VERSION}.tgz`;
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    requests.push(`${req.method} ${path}`);
    if (req.method === 'GET' && path === `/${FAKE_PACKAGE}`) {
      const manifest = {
        name: FAKE_PACKAGE,
        version: FAKE_VERSION,
        description: 'fake ACP agent for the sidecar install oracle',
        license: 'MIT',
        bin: { [FAKE_PACKAGE]: 'index.js' },
        dist: { tarball: `${base}${tarballPath}`, shasum: pkg.shasum, integrity: pkg.integrity },
      };
      const packument = {
        name: FAKE_PACKAGE,
        'dist-tags': { latest: FAKE_VERSION },
        versions: { [FAKE_VERSION]: manifest },
        time: { created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z', [FAKE_VERSION]: '2026-01-01T00:00:00.000Z' },
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(packument));
      return;
    }
    if (req.method === 'GET' && path === tarballPath) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(pkg.tarball.length) });
      res.end(pkg.tarball);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  base = await listen(server);
  return { url: base, requests, close: () => closeServer(server) };
}

/**
 * The npm-cli.js of the Node that runs the tests (the pinned v24 via nvm),
 * resolved from process.execPath exactly as §1 describes the sidecar's own
 * fallback: `<dir>/../lib/node_modules/npm/bin/npm-cli.js`. Handed to the
 * sidecar as APE_NPM_CLI so the test does not depend on PATH.
 */
export function resolveNpmCli(): string {
  const p = resolve(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(p)) throw new Error(`npm-cli.js not found beside ${process.execPath}: ${p}`);
  return p;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') { reject(new Error('fake server: no port')); return; }
      resolvePort(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((done) => { server.closeAllConnections(); server.close(() => done()); });
}
