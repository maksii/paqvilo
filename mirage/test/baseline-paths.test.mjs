// @test-kind contract: the baseline paths refuse labels and destinations that escape the capture root, with the CLI refusal as the observed behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { validateMatrix, scenarioDir, captureMatrix, __testing as baselineSuite } from '../baseline-suite.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

// The CLI refuses within about a second; this bound only stops a hung child (a stopped child fails on its signal).
// hang guard only: a blocked synchronous child cannot be ended by the test runner
const CLI_HANG_MS = 170_000;
const scenario = (id) => ({ id, steps: [{ goto: '/invented/' }] }),
  matrix = (id) => ({ version: 1, scenarios: [scenario(id)] });
const BAD_ID = /scenario id must contain safe nonempty relative directory segments/;
const BAD_LABEL = /capture label must be one portable directory name/;

// @test-kind security: a scenario id cannot traverse, be absolute or be reserved, so it cannot place
// output outside the capture root
test('traversing, absolute, empty-segment and reserved scenario ids are refused by the matrix and the path builder', () => {
  for (const id of [
    'a/../../outside',
    'a/../outside',
    'a/./b',
    'a//b',
    'a/',
    '/absolute',
    'C:/absolute',
    'C:relative',
    'a\\..\\outside',
    '\\\\server\\share',
    'a/.../b',
    'a/.. /b',
    'a/CON/b',
  ]) {
    assert.throws(() => validateMatrix(matrix(id)), BAD_ID, id);
    assert.throws(() => scenarioDir('root', scenario(id), 'native'), BAD_ID, id);
  }
});
// @test-kind security: a capture label cannot traverse, be absolute or be reserved, so it cannot place
// output outside the capture root
test('CLI labels that are not one portable directory name are refused', () => {
  for (const label of [
    '../outside',
    '..',
    '.',
    'a/b',
    'a\\b',
    '/absolute',
    'C:/absolute',
    'C:relative',
    '\\\\server\\share',
    '.. ',
    'trailing.',
    'NUL',
  ])
    assert.throws(() => scenarioDir('root', scenario('valid/nested'), label), BAD_LABEL, label);
});
test('genuine nested IDs and authored labels retain original paths', () => {
  assert.equal(
    scenarioDir('root', scenario('form/test_case.v2/render'), 'native current-2'),
    path.join('root', 'form', 'test_case.v2', 'render', 'native current-2'),
  );
});
// @test-kind security: a traversing scenario id or label fails before any callback runs or any output is written
test('whole matrix and label fail before capture callbacks or output writes', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-case-boundary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let calls = 0;
  const side = {
    persona: async () => {
      calls++;
    },
    reset: async () => {
      calls++;
    },
    capture: async () => {
      calls++;
      return { status: 'captured' };
    },
  };
  await assert.rejects(
    captureMatrix({
      matrix: {
        version: 1,
        scenarios: [scenario('valid'), scenario('a/../../outside')],
      },
      side,
      outDir: path.join(root, 'out'),
      label: 'native',
    }),
    BAD_ID,
  );
  await assert.rejects(
    captureMatrix({
      matrix: matrix('valid'),
      side,
      outDir: path.join(root, 'out'),
      label: '../outside',
    }),
    BAD_LABEL,
  );
  assert.equal(calls, 0);
  assert.deepEqual(await fs.readdir(root), []);
});
// @test-kind security: a traversing CLI label is refused before runtime setup and no evidence is written
test('CLI label rejection precedes browser/runtime setup and any evidence write', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-label-boundary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'matrix.json');
  await fs.writeFile(file, JSON.stringify(matrix('valid/nested')));
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../baseline-suite.mjs', import.meta.url)),
      'capture',
      '--matrix',
      file,
      '--out',
      path.join(root, 'out'),
      '--side',
      'mirage',
      '--label',
      '../outside',
    ],
    { encoding: 'utf8', timeout: CLI_HANG_MS, windowsHide: true },
  );
  assert.equal(result.signal, null, 'the CLI exits on its own rather than being stopped by the hang bound');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /capture label/);
  assert.deepEqual(await fs.readdir(root), ['matrix.json']);
});

// @test-kind contract: a mirage capture without --source or --site is refused up front with the flags it accepts
test('a mirage capture without a portal source names --source or --config --site and writes nothing', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-baseline-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'matrix.json');
  await fs.writeFile(file, JSON.stringify(matrix('valid')));
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../baseline-suite.mjs', import.meta.url)),
      'capture',
      '--matrix',
      file,
      '--out',
      path.join(root, 'out'),
      '--side',
      'mirage',
    ],
    { encoding: 'utf8', timeout: CLI_HANG_MS, windowsHide: true },
  );
  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^A mirage capture needs the portal source: --source DIR or --config FILE --site ID\./);
  assert.doesNotMatch(result.stderr, /paths\[0\]|TypeError/);
  assert.deepEqual(await fs.readdir(root), ['matrix.json']);
});

// @test-kind contract: a missing --state is refused in one line naming the option and the path, before any runtime starts
test('a mirage capture with a missing --state names --state and the path, not a raw copyfile error', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-baseline-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'matrix.json');
  await fs.writeFile(file, JSON.stringify(matrix('valid')));
  await fs.mkdir(path.join(root, 'source'));
  const missing = path.join(root, 'missing-state.json');
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../baseline-suite.mjs', import.meta.url)),
      'capture',
      '--matrix',
      file,
      '--out',
      path.join(root, 'out'),
      '--side',
      'mirage',
      '--source',
      path.join(root, 'source'),
      '--work-dir',
      path.join(root, 'work'),
      '--state',
      missing,
    ],
    { encoding: 'utf8', timeout: CLI_HANG_MS, windowsHide: true },
  );
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, `--state file not found: ${missing}. Pass an existing file.\n`);
  assert.deepEqual((await fs.readdir(root)).sort(), ['matrix.json', 'source']);
});

// @test-kind contract: everything a Mirage-side capture writes goes under --work-dir; the catalogue folder gains no file
test('a catalogue Mirage side keeps its solution cache and state under --work-dir', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-baseline-workdir-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalogue = path.join(root, 'catalogue');
  // An invented catalogue whose portal repository has two sibling Solution roots, so root discovery scans and caches.
  const files = {
    'paqvilo.config.yml':
      'sourceRoot: .\ndefaultSite: lab\nsites:\n  lab:\n    source: repo/portal\n    environments:\n      dev: { url: "https://lab.example.invalid" }\n    mirage: {}\n',
    'repo/.git/HEAD': 'ref: refs/heads/main\n',
    'repo/portal/website.yml': 'adx_websiteid: invented\nadx_name: Invented fixture\n',
    'repo/portal/web-pages/.keep': '',
    ...Object.fromEntries(
      ['one', 'two'].map((name) => [
        `${name}/Other/Solution.xml`,
        `<ImportExportXml><SolutionManifest><UniqueName>${name}</UniqueName></SolutionManifest></ImportExportXml>`,
      ]),
    ),
  };
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(catalogue, name)), { recursive: true });
    await fs.writeFile(path.join(catalogue, name), text);
  }
  const before = (await fs.readdir(catalogue, { recursive: true })).sort();
  t.mock.method(chromium, 'launch', async () => ({ newContext: async () => ({}), close: async () => {} }));
  const workDir = path.join(root, 'work');
  const side = await baselineSuite.mirageSide({
    matrix: { version: 1, scenarios: [] },
    config: path.join(catalogue, 'paqvilo.config.yml'),
    site: 'lab',
    workDir,
  });
  await side.close();
  assert.deepEqual((await fs.readdir(catalogue, { recursive: true })).sort(), before);
  await fs.access(path.join(workDir, 'cache', 'solution-sources.json'));
});

// @test-kind contract: unresolvable record aliases are refused in one line before any mutating hook or browser work
test('a live capture with an undefined record alias is refused before its persona and reset hooks run', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-baseline-alias-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'hook-ran');
  const hook = `node -e "require('fs').writeFileSync(process.argv[1], 'x')" ${JSON.stringify(marker)}`;
  const file = path.join(root, 'matrix.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      origin: 'https://portal.invalid',
      hooks: { livePersona: hook, liveReset: hook },
      personas: { anonymous: { anonymous: true } },
      scenarios: [{ id: 'form/edit', persona: 'anonymous', steps: [{ goto: '/edit/?id={id:item1}' }] }],
    }),
  );
  const ids = path.join(root, 'ids.json');
  await fs.writeFile(ids, JSON.stringify({ item2: 'b' }));
  const run = (...extra) =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../baseline-suite.mjs', import.meta.url)),
        'capture',
        '--matrix',
        file,
        '--out',
        path.join(root, 'out'),
        '--side',
        'live',
        '--allow-writes',
        '--only',
        'form/edit',
        ...extra,
      ],
      { encoding: 'utf8', timeout: CLI_HANG_MS, windowsHide: true },
    );
  let result = run();
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    'The scenario form/edit uses record alias {id:item1}, which needs --ids FILE with the fixture record ids.\n',
  );
  result = run('--ids', ids);
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    `The scenario form/edit uses record alias {id:item1}, which --ids ${ids} does not define.\n`,
  );
  assert.deepEqual((await fs.readdir(root)).sort(), ['ids.json', 'matrix.json']);
});
