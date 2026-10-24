import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeCapture } from '../baseline-capture.mjs';
import { ensureCaptureDestination } from '../baseline-paths.mjs';

async function fixture(run) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-hardlink-boundary-'));
  const outDir = path.join(base, 'out'),
    outside = path.join(base, 'outside');
  await fs.mkdir(outDir);
  await fs.mkdir(outside);
  try {
    await run({ base, outDir, outside });
  } finally {
    assert.ok(path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(base, { recursive: true, force: true });
  }
}

test('writeCapture refuses a hard-linked artifact before changing foreign bytes', () =>
  fixture(async ({ outDir, outside }) => {
    const folder = path.join(outDir, 'invented', 'case', 'native'),
      foreign = path.join(outside, 'foreign.json');
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(foreign, 'foreign marker');
    await fs.link(foreign, path.join(folder, 'requests.json'));
    const result = {
      summary: { id: 'invented/case', status: 'captured', problems: [] },
      raw: { requests: [], console: [], pageErrors: [], dom: '<main>invented</main>', elements: [] },
    };
    await assert.rejects(
      writeCapture(result, { outDir: folder, outputRoot: outDir, origin: 'https://invented.invalid', side: 'native' }),
      /linked/,
    );
    assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign marker');
    assert.deepEqual(await fs.readdir(folder), ['requests.json']);
  }));

test('noncreating output preflight rejects hardlinks without persisting anything', () =>
  fixture(async ({ outDir, outside }) => {
    const foreign = path.join(outside, 'foreign.json');
    await fs.writeFile(foreign, 'foreign marker');
    await fs.link(foreign, path.join(outDir, 'run-native.json'));
    await assert.rejects(
      ensureCaptureDestination(outDir, outDir, { create: false, files: ['run-native.json'] }),
      /linked/,
    );
    assert.deepEqual(await fs.readdir(outDir), ['run-native.json']);
    assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign marker');
  }));

async function cliFixture({ base, outDir, outside }, kind) {
  const marker = path.join(base, 'bridge-started.txt'),
    bridge = path.join(base, 'bridge.mjs'),
    clock = path.join(base, 'clock.mjs');
  const instant = '2030-01-02T03:04:05.000Z';
  await fs.writeFile(
    clock,
    `const NativeDate=Date;globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[${JSON.stringify(instant)}]));}static now(){return NativeDate.parse(${JSON.stringify(instant)});}};`,
  );
  await fs.writeFile(bridge, `import fs from 'node:fs';fs.writeFileSync(process.argv[2],'started');process.exit(3);`);
  const file = kind === 'history-hardlink' ? `run-native-${instant.replace(/:/g, '')}.json` : 'run-native.json';
  const foreign = path.join(outside, 'foreign.json');
  await fs.writeFile(foreign, 'foreign marker');
  if (kind === 'latest-hardlink' || kind === 'history-hardlink') await fs.link(foreign, path.join(outDir, file));
  if (kind === 'index-junction')
    await fs.symlink(outside, path.join(outDir, file), process.platform === 'win32' ? 'junction' : 'dir');
  const matrixFile = path.join(base, 'matrix.json');
  await fs.writeFile(
    matrixFile,
    JSON.stringify({
      version: 1,
      origin: 'https://invented.invalid',
      live: { command: process.execPath, args: [bridge, marker] },
      scenarios: [{ id: 'invented/case', steps: [{ goto: '/invented/' }] }],
    }),
  );
  const script = fileURLToPath(new URL('../baseline-suite.mjs', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      pathToFileURL(clock).href,
      script,
      'capture',
      '--matrix',
      matrixFile,
      '--out',
      outDir,
      '--side',
      'live',
      '--label',
      'native',
    ],
    { encoding: 'utf8', timeout: 8000, windowsHide: true },
  );
  assert.notEqual(result.status, 0);
  if (kind === 'ordinary')
    assert.equal(await fs.readFile(marker, 'utf8'), 'started', 'ordinary output must reach bridge initialization');
  else {
    assert.match(result.stderr, /linked/);
    await assert.rejects(
      fs.stat(marker),
      (error) => error.code === 'ENOENT',
      'output refusal must precede any bridge or trusted hook initialization',
    );
    assert.deepEqual(await fs.readdir(outDir), [file]);
  }
  assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign marker');
}
for (const kind of ['latest-hardlink', 'history-hardlink', 'index-junction', 'ordinary'])
  test('CLI output admission precedes bridge setup: ' + kind, () => fixture((parts) => cliFixture(parts, kind)));
