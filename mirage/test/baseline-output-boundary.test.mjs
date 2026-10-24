import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeCapture } from '../baseline-capture.mjs';
import { ensureCaptureDestination, validateCaptureLabel, validateScenarioId } from '../baseline-paths.mjs';
import { captureMatrix } from '../baseline-suite.mjs';

const result = () => ({
  summary: { id: 'invented/case', status: 'captured', problems: [] },
  raw: { requests: [], console: [], pageErrors: [], dom: '<main>invented</main>', elements: [] },
});
async function fixture(run) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-output-link-'));
  try {
    const root = path.join(base, 'out'),
      outside = path.join(base, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await run({ base, root, outside });
  } finally {
    assert.ok(path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(base, { recursive: true, force: true });
  }
}
const linkDir = (target, link) => fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');

for (const depth of ['ancestor', 'capture-leaf'])
  test('writeCapture refuses linked ' + depth + ' before any outside write', () =>
    fixture(async ({ root, outside }) => {
      const link = depth === 'ancestor' ? path.join(root, 'invented') : path.join(root, 'invented', 'case', 'native');
      await fs.mkdir(path.dirname(link), { recursive: true });
      await linkDir(outside, link);
      await assert.rejects(
        writeCapture(result(), {
          outDir: path.join(root, 'invented', 'case', 'native'),
          outputRoot: root,
          origin: 'https://invented.invalid',
          side: 'native',
        }),
        /linked/,
      );
      assert.deepEqual(await fs.readdir(outside), []);
    }),
  );

test('all selected destinations are preflighted before persona/reset/capture callbacks', () =>
  fixture(async ({ root, outside }) => {
    await linkDir(outside, path.join(root, 'second'));
    let calls = 0;
    const side = {
      persona: async () => calls++,
      reset: async () => calls++,
      capture: async () => calls++,
      diagnostics: () => [],
    };
    await assert.rejects(
      captureMatrix({
        matrix: {
          version: 1,
          scenarios: [
            { id: 'first', steps: [{ goto: '/invented/' }] },
            { id: 'second/case', steps: [{ goto: '/invented/' }] },
          ],
        },
        side,
        outDir: root,
        label: 'native',
      }),
      /linked/,
    );
    assert.equal(calls, 0);
    assert.deepEqual(await fs.readdir(outside), []);
    assert.deepEqual(await fs.readdir(root), ['second']);
  }));

test('explicit authoritative output root may intentionally be a directory link', () =>
  fixture(async ({ root, outside }) => {
    const authoritative = path.join(root, 'chosen-root');
    await linkDir(outside, authoritative);
    await writeCapture(result(), {
      outDir: path.join(authoritative, 'invented', 'case', 'native'),
      outputRoot: authoritative,
      origin: 'https://invented.invalid',
      side: 'native',
    });
    assert.equal(
      JSON.parse(await fs.readFile(path.join(outside, 'invented', 'case', 'native', 'meta.json'), 'utf8')).status,
      'captured',
    );
  }));

test('a linked child is refused even when it points inside the authoritative root', () =>
  fixture(async ({ root }) => {
    await fs.mkdir(path.join(root, 'real'));
    await linkDir(path.join(root, 'real'), path.join(root, 'alias'));
    await assert.rejects(ensureCaptureDestination(path.join(root, 'alias', 'capture'), root), /linked/);
    assert.deepEqual(await fs.readdir(path.join(root, 'real')), []);
  }));

test('ordinary existing capture directories support repeated evidence writes', () =>
  fixture(async ({ root }) => {
    const outDir = path.join(root, 'invented', 'case', 'native');
    for (let i = 0; i < 2; i++)
      await writeCapture(result(), { outDir, outputRoot: root, origin: 'https://invented.invalid', side: 'native' });
    assert.deepEqual((await fs.readdir(outDir)).sort(), [
      'console.json',
      'dom.html',
      'elements.json',
      'meta.json',
      'requests.json',
    ]);
  }));

test('a file ancestor and lexical escape are refused without creating children', () =>
  fixture(async ({ root, outside }) => {
    await fs.writeFile(path.join(root, 'file'), 'kept');
    await assert.rejects(ensureCaptureDestination(path.join(root, 'file', 'capture'), root), /non-directory/);
    await assert.rejects(ensureCaptureDestination(outside, root), /outside/);
    assert.deepEqual(await fs.readdir(outside), []);
    assert.equal(await fs.readFile(path.join(root, 'file'), 'utf8'), 'kept');
  }));

test('portable reserved Windows names are refused as labels and scenario segments', () => {
  for (const label of ['CONIN$', 'conout$.log', 'COM¹', 'com².log', 'COM³', 'LPT¹', 'lpt².txt', 'LPT³']) {
    assert.throws(() => validateCaptureLabel(label), /capture label must be one portable directory name/, label);
    assert.throws(
      () => validateScenarioId('valid/' + label),
      /scenario id must contain safe nonempty relative directory segments/,
      label,
    );
  }
});

test('reserved-looking ordinary names remain valid', () => {
  for (const value of ['CONIN', 'COM10', 'LPT0', 'computer', 'context.txt'])
    assert.equal(validateCaptureLabel(value), value);
});

test('linked artifact refuses before persisting evidence through a directory alias', () =>
  fixture(async ({ root, outside }) => {
    const outDir = path.join(root, 'invented', 'case', 'native');
    await fs.mkdir(outDir, { recursive: true });
    await linkDir(outside, path.join(outDir, 'requests.json'));
    await assert.rejects(
      writeCapture(result(), { outDir, outputRoot: root, origin: 'https://invented.invalid', side: 'native' }),
      /linked/,
    );
    assert.deepEqual(await fs.readdir(outside), []);
    assert.deepEqual(await fs.readdir(outDir), ['requests.json']);
  }));

test('CLI preflights linked selected output before runtime construction or evidence persistence', () =>
  fixture(async ({ root, outside, base }) => {
    await linkDir(outside, path.join(root, 'invented'));
    const matrixFile = path.join(base, 'matrix.json');
    await fs.writeFile(
      matrixFile,
      JSON.stringify({ version: 1, scenarios: [{ id: 'invented/case', steps: [{ goto: '/invented/' }] }] }),
    );
    const processResult = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../baseline-suite.mjs', import.meta.url)),
        'capture',
        '--matrix',
        matrixFile,
        '--out',
        root,
        '--side',
        'mirage',
        '--label',
        'native',
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    assert.notEqual(processResult.status, 0);
    assert.match(processResult.stderr, /linked/);
    assert.doesNotMatch(processResult.stderr, /configuration|config file|catalogue|browser/i);
    assert.deepEqual(await fs.readdir(outside), []);
    assert.deepEqual(await fs.readdir(root), ['invented']);
  }));
