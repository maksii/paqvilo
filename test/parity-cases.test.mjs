// @test-kind tooling: parity case library and CLI behaviour on invented cases
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  buildParityCases,
  diffParityOutput,
  loadParityCases,
  replayParityCases,
  replayParityDirectory,
  validateParityCases,
} from '../mirage/testing/parity-cases.mjs';
import { main } from '../scripts/parity-cases.mjs';

const SURFACE = 'demo-surface';
const SUITE = 'basic-suite';
const ORACLE = { kind: 'official-package', name: 'Invented.Engine', version: '1.0.0', scope: 'Invented scope.' };
const BASE_RESULTS = [
  { id: 'add', input: { expression: '1+2' }, output: { kind: 'number', value: 3 } },
  {
    id: 'list',
    input: { expression: 'list' },
    output: {
      items: [
        { id: 'a', n: 1 },
        { id: 'b', n: 2 },
      ],
    },
  },
];

function sha(text) {
  return createHash('sha256').update(text).digest('hex');
}

function validFile(overrides = {}) {
  return {
    schema: 'paqvilo.parity-cases/1',
    surface: SURFACE,
    suite: SUITE,
    oracle: { ...ORACLE },
    captures: [
      { id: 'run-1', sha256: sha('one'), capturedAt: '2026-11-08' },
      { id: 'run-2', sha256: sha('two'), capturedAt: '2026-11-08' },
    ],
    cases: [
      { id: 'add', input: { expression: '1+2' }, output: { kind: 'number', value: 3 }, volatile: [] },
      { id: 'list', input: { expression: 'list' }, output: BASE_RESULTS[1].output, volatile: [] },
    ],
    history: [],
    ...overrides,
  };
}

function rawCapture(id, results) {
  return { sha256: sha(id), capture: { id, capturedAt: '2026-11-08' }, results: structuredClone(results) };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-cases-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeCaseFile(root, value) {
  const file = path.join(root, 'cases', value.surface, `${value.suite}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function assertProblem(value, pattern, options) {
  const problems = validateParityCases(value, options);
  assert.ok(
    problems.some((problem) => pattern.test(problem)),
    `expected a problem matching ${pattern}, got: ${problems.join(' | ') || 'none'}`,
  );
}

function outputsWith(changes) {
  return BASE_RESULTS.map((result) => (changes[result.id] ? { ...result, ...changes[result.id] } : result));
}

// Runs every registered replay test and records its outcome (null for a pass).
async function replayOutcomes(file, run, knownGaps = {}) {
  const collected = [];
  replayParityCases(pathToFileURL(file), run, { test: (name, fn) => collected.push({ name, fn }), knownGaps });
  const outcomes = new Map();
  for (const { name, fn } of collected) {
    try {
      await fn();
      outcomes.set(name, null);
    } catch (error) {
      outcomes.set(name, error);
    }
  }
  return outcomes;
}

// Adapter for the invented cases: the adapter sees only the input, so the case is told apart by its expression.
function listRunner(overrides = {}) {
  return (input) => {
    const id = input.expression === 'list' ? 'list' : 'add';
    const outputs = { add: { kind: 'number', value: 3 }, list: BASE_RESULTS[1].output };
    return overrides[id] ? overrides[id](input) : outputs[id];
  };
}

function captureOutput(out) {
  return { write: (text) => out.push(text) };
}

// ---------------------------------------------------------------- validate

test('validate: a valid file has no problems', () => {
  assert.deepEqual(validateParityCases(validFile(), { surface: SURFACE, suite: SUITE }), []);
});

test('validate: schema must be the schema constant', () => {
  assertProblem(validFile({ schema: 'paqvilo.parity-cases/0' }), /schema must be/);
});

test('validate: oracle kind must be a known kind', () => {
  assertProblem(validFile({ oracle: { ...ORACLE, kind: 'guess' } }), /oracle\.kind must be one of/);
});

test('validate: a single capture is not enough', () => {
  assertProblem(validFile({ captures: [validFile().captures[0]] }), /at least two captures/);
});

test('validate: capture ids must be unique', () => {
  const captures = [validFile().captures[0], { ...validFile().captures[1], id: 'run-1' }];
  assertProblem(validFile({ captures }), /duplicate capture id "run-1"/);
});

test('validate: a capture sha256 must be 64 lowercase hex characters', () => {
  const captures = [{ ...validFile().captures[0], sha256: 'ABC' }, validFile().captures[1]];
  assertProblem(validFile({ captures }), /sha256 must be 64 lowercase hex/);
});

test('validate: case ids must be unique', () => {
  const twice = [validFile().cases[0], validFile().cases[0]];
  assertProblem(validFile({ cases: twice }), /duplicate case id "add"/);
});

test('validate: every case needs an output key', () => {
  const cases = [{ id: 'add', input: {}, volatile: [] }];
  assertProblem(validFile({ cases }), /output is required/);
});

test('validate: a volatile pointer must resolve inside the output', () => {
  const cases = [{ id: 'add', input: {}, output: { value: 3 }, volatile: ['/missing'] }];
  assertProblem(validFile({ cases }), /volatile pointer \/missing does not resolve inside output/);
});

test('validate: unknown top-level keys are problems', () => {
  assertProblem(validFile({ extra: true }), /unknown top-level key "extra"/);
});

test('validate: surface and suite must equal the expected names', () => {
  assertProblem(validFile(), /surface "demo-surface" does not match/, { surface: 'other-surface' });
  assertProblem(validFile(), /suite "basic-suite" does not match/, { suite: 'other-suite' });
});

test('loadParityCases: a file under cases/<surface>/<suite>.json loads from a URL and from a path', (t) => {
  const root = tempDir(t);
  const file = writeCaseFile(root, validFile());
  assert.equal(loadParityCases(pathToFileURL(file)).suite, SUITE);
  assert.equal(loadParityCases(file).surface, SURFACE);
});

test('loadParityCases: a file whose surface disagrees with its path throws naming the path', (t) => {
  const dir = path.join(tempDir(t), 'cases', SURFACE);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${SUITE}.json`);
  fs.writeFileSync(file, JSON.stringify(validFile({ surface: 'other-surface' })));
  assert.throws(() => loadParityCases(file), /does not match the path surface/);
});

// ---------------------------------------------------------------- build

test('build: identical captures produce no volatile pointers', () => {
  const file = buildParityCases({
    surface: SURFACE,
    suite: SUITE,
    oracle: ORACLE,
    captures: [rawCapture('run-1', BASE_RESULTS), rawCapture('run-2', BASE_RESULTS)],
  });
  assert.deepEqual(
    file.cases.map((parityCase) => parityCase.volatile),
    [[], []],
  );
  assert.equal(file.captures.length, 2);
});

test('build: a differing leaf is volatile at its own pointer', () => {
  const changed = structuredClone(BASE_RESULTS);
  changed[1].output.items[1].n = 5;
  const file = buildParityCases({
    surface: SURFACE,
    suite: SUITE,
    oracle: ORACLE,
    captures: [rawCapture('run-1', BASE_RESULTS), rawCapture('run-2', changed)],
  });
  assert.deepEqual(file.cases[1].volatile, ['/items/1/n']);
});

test('build: a differing array length is volatile at the container pointer', () => {
  const changed = structuredClone(BASE_RESULTS);
  changed[1].output.items.push({ id: 'c', n: 3 });
  const file = buildParityCases({
    surface: SURFACE,
    suite: SUITE,
    oracle: ORACLE,
    captures: [rawCapture('run-1', BASE_RESULTS), rawCapture('run-2', changed)],
  });
  assert.deepEqual(file.cases[1].volatile, ['/items']);
});

test('build: a differing root output is not reproducible and throws naming the case', () => {
  const changed = outputsWith({ add: { output: 'three' } });
  assert.throws(
    () =>
      buildParityCases({
        surface: SURFACE,
        suite: SUITE,
        oracle: ORACLE,
        captures: [rawCapture('run-1', BASE_RESULTS), rawCapture('run-2', changed)],
      }),
    /case add: output differs at the root pointer/,
  );
});

test('build: captures that list different case ids throw', () => {
  const swapped = [BASE_RESULTS[1], BASE_RESULTS[0]];
  assert.throws(
    () =>
      buildParityCases({
        surface: SURFACE,
        suite: SUITE,
        oracle: ORACLE,
        captures: [rawCapture('run-1', BASE_RESULTS), rawCapture('run-2', swapped)],
      }),
    /does not list the same cases as run-1: first mismatch at case list/,
  );
});

test('build: a case whose input differs between captures throws naming the case', () => {
  const changed = outputsWith({ add: { input: { expression: '2+1' } } });
  assert.throws(
    () =>
      buildParityCases({
        surface: SURFACE,
        suite: SUITE,
        oracle: ORACLE,
        captures: [rawCapture('run-1', BASE_RESULTS), rawCapture('run-2', changed)],
      }),
    /case add: input differs between captures run-1 and run-2/,
  );
});

test('build: with existing, new case ids are appended after the existing ones', () => {
  const captures = [rawCapture('run-1', BASE_RESULTS), rawCapture('run-2', BASE_RESULTS)];
  const existing = buildParityCases({ surface: SURFACE, suite: SUITE, oracle: ORACLE, captures });
  const extra = { id: 'extra', input: { expression: '0' }, output: { kind: 'number', value: 0 } };
  const grown = [rawCapture('run-3', [...BASE_RESULTS, extra]), rawCapture('run-4', [...BASE_RESULTS, extra])];
  const file = buildParityCases({ surface: SURFACE, suite: SUITE, oracle: ORACLE, captures: grown, existing });
  assert.deepEqual(
    file.cases.map((parityCase) => parityCase.id),
    ['add', 'list', 'extra'],
  );
  assert.deepEqual(file.history, []);
});

test('build: with existing, changing a case without revise throws naming the case', () => {
  const captures = [rawCapture('run-1', BASE_RESULTS), rawCapture('run-2', BASE_RESULTS)];
  const existing = buildParityCases({ surface: SURFACE, suite: SUITE, oracle: ORACLE, captures });
  const changed = outputsWith({ add: { output: { kind: 'number', value: 4 } } });
  const next = [rawCapture('run-3', changed), rawCapture('run-4', changed)];
  assert.throws(
    () => buildParityCases({ surface: SURFACE, suite: SUITE, oracle: ORACLE, captures: next, existing }),
    /case add would change; pass revise/,
  );
});

test('build: with existing and revise, the case is replaced and one history entry is appended', () => {
  const captures = [rawCapture('run-1', BASE_RESULTS), rawCapture('run-2', BASE_RESULTS)];
  const existing = buildParityCases({ surface: SURFACE, suite: SUITE, oracle: ORACLE, captures });
  const changed = outputsWith({ add: { output: { kind: 'number', value: 4 } } });
  const next = [rawCapture('run-3', changed), rawCapture('run-4', changed)];
  const revise = { date: '2026-11-09', change: 'Corrected add output', evidence: 'Invented evidence.' };
  const file = buildParityCases({ surface: SURFACE, suite: SUITE, oracle: ORACLE, captures: next, existing, revise });
  assert.equal(file.cases[0].output.value, 4);
  assert.deepEqual(file.history, [revise]);
});

test('build: an existing capture id with a different sha256 throws', () => {
  const captures = [rawCapture('run-1', BASE_RESULTS), rawCapture('run-2', BASE_RESULTS)];
  const existing = buildParityCases({ surface: SURFACE, suite: SUITE, oracle: ORACLE, captures });
  const clash = { ...rawCapture('run-1', BASE_RESULTS), sha256: 'f'.repeat(64) };
  assert.throws(
    () =>
      buildParityCases({
        surface: SURFACE,
        suite: SUITE,
        oracle: ORACLE,
        captures: [clash, rawCapture('run-2', BASE_RESULTS)],
        existing,
      }),
    /capture run-1 is already recorded with a different sha256/,
  );
});

test('build: fewer than two captures throws', () => {
  assert.throws(
    () =>
      buildParityCases({ surface: SURFACE, suite: SUITE, oracle: ORACLE, captures: [rawCapture('a', BASE_RESULTS)] }),
    /at least two captures/,
  );
});

// ---------------------------------------------------------------- diff

test('diff: equal values have no differences', () => {
  assert.deepEqual(diffParityOutput({ a: [1, { b: 'x' }] }, { a: [1, { b: 'x' }] }), []);
});

test('diff: a differing leaf is reported at its pointer', () => {
  assert.deepEqual(diffParityOutput({ a: 1, b: 2 }, { a: 1, b: 3 }), [{ pointer: '/b', actual: 2, expected: 3 }]);
});

test('diff: a missing key is reported with actual undefined', () => {
  assert.deepEqual(diffParityOutput({ a: 1 }, { a: 1, b: 2 }), [{ pointer: '/b', actual: undefined, expected: 2 }]);
});

test('diff: an extra key is reported with expected undefined', () => {
  assert.deepEqual(diffParityOutput({ a: 1, b: 2 }, { a: 1 }), [{ pointer: '/b', actual: 2, expected: undefined }]);
});

test('diff: a volatile pointer is not compared but must be present', () => {
  assert.deepEqual(diffParityOutput({ id: 'x', v: 1 }, { id: 'y', v: 1 }, { volatile: ['/id'] }), []);
  assert.deepEqual(diffParityOutput({ v: 1 }, { id: 'y', v: 1 }, { volatile: ['/id'] }), [
    { pointer: '/id', actual: undefined, expected: 'y' },
  ]);
});

test('diff: -0 equals 0', () => {
  assert.deepEqual(diffParityOutput({ n: -0 }, { n: 0 }), []);
});

test('diff: null is not an object', () => {
  assert.deepEqual(diffParityOutput({ a: null }, { a: { b: 1 } }), [
    { pointer: '/a', actual: null, expected: { b: 1 } },
  ]);
});

test('diff: gap pointers are skipped', () => {
  assert.deepEqual(diffParityOutput({ a: 1, b: 2 }, { a: 9, b: 3 }, { gaps: ['/a'] }), [
    { pointer: '/b', actual: 2, expected: 3 },
  ]);
});

// ---------------------------------------------------------------- replay

test('replay: a matching case passes', async (t) => {
  const file = writeCaseFile(tempDir(t), validFile());
  const outcomes = await replayOutcomes(file, listRunner());
  assert.equal(outcomes.get(`${SURFACE}/${SUITE}#add`), null);
  assert.equal(outcomes.get(`${SURFACE}/${SUITE} known gaps name recorded cases`), null);
});

test('replay: a differing case fails with an AssertionError', async (t) => {
  const file = writeCaseFile(tempDir(t), validFile());
  const outcomes = await replayOutcomes(file, listRunner({ add: () => ({ kind: 'number', value: 4 }) }));
  const error = outcomes.get(`${SURFACE}/${SUITE}#add`);
  assert.ok(error instanceof assert.AssertionError);
});

test('replay: a whole-case known gap passes while the case differs', async (t) => {
  const file = writeCaseFile(tempDir(t), validFile());
  const run = listRunner({ add: () => ({ kind: 'number', value: 4 }) });
  const outcomes = await replayOutcomes(file, run, { [`${SUITE}#add`]: 'Invented gap.' });
  assert.equal(outcomes.get(`${SURFACE}/${SUITE}#add`), null);
});

test('replay: a whole-case known gap passes when run throws', async (t) => {
  const file = writeCaseFile(tempDir(t), validFile());
  const run = listRunner({
    add: () => {
      throw new Error('renderer unavailable');
    },
  });
  const outcomes = await replayOutcomes(file, run, { [`${SUITE}#add`]: 'Invented gap.' });
  assert.equal(outcomes.get(`${SURFACE}/${SUITE}#add`), null);
});

test('replay: a whole-case known gap fails with known gap closed when the case matches', async (t) => {
  const file = writeCaseFile(tempDir(t), validFile());
  const outcomes = await replayOutcomes(file, listRunner(), { [`${SUITE}#add`]: 'Invented gap.' });
  const error = outcomes.get(`${SURFACE}/${SUITE}#add`);
  assert.ok(error instanceof assert.AssertionError);
  assert.match(error.message, /known gap closed: remove basic-suite#add/);
});

test('replay: a pointer-scoped gap passes while only that pointer differs', async (t) => {
  const file = writeCaseFile(tempDir(t), validFile());
  const run = listRunner({
    list: () => ({
      items: [
        { id: 'a', n: 1 },
        { id: 'b', n: 5 },
      ],
    }),
  });
  const gap = { [`${SUITE}#list`]: { '/items/1/n': 'Invented gap.' } };
  const outcomes = await replayOutcomes(file, run, gap);
  assert.equal(outcomes.get(`${SURFACE}/${SUITE}#list`), null);
});

test('replay: a pointer-scoped gap fails when another field differs', async (t) => {
  const file = writeCaseFile(tempDir(t), validFile());
  const run = listRunner({
    list: () => ({
      items: [
        { id: 'z', n: 1 },
        { id: 'b', n: 5 },
      ],
    }),
  });
  const gap = { [`${SUITE}#list`]: { '/items/1/n': 'Invented gap.' } };
  const outcomes = await replayOutcomes(file, run, gap);
  const error = outcomes.get(`${SURFACE}/${SUITE}#list`);
  assert.ok(error instanceof assert.AssertionError);
  assert.match(error.message, /\/items\/0\/id/);
});

test('replay: a pointer-scoped gap fails with known gap closed when the pointer matches', async (t) => {
  const file = writeCaseFile(tempDir(t), validFile());
  const gap = { [`${SUITE}#list`]: { '/items/1/n': 'Invented gap.' } };
  const outcomes = await replayOutcomes(file, listRunner(), gap);
  const error = outcomes.get(`${SURFACE}/${SUITE}#list`);
  assert.ok(error instanceof assert.AssertionError);
  assert.ok(error.message.includes('known gap closed: remove basic-suite#list /items/1/n'));
});

test('replay: a stale known-gap key produces a failing registered test', async (t) => {
  const file = writeCaseFile(tempDir(t), validFile());
  const outcomes = await replayOutcomes(file, listRunner(), { [`${SUITE}#gone`]: 'Invented gap.' });
  const error = outcomes.get(`${SURFACE}/${SUITE} known gaps name recorded cases`);
  assert.ok(error instanceof assert.AssertionError);
  assert.match(error.message, /basic-suite#gone/);
});

test('replay: a run that throws fails the case with that error', async (t) => {
  const file = writeCaseFile(tempDir(t), validFile());
  const run = () => {
    throw new Error('renderer exploded');
  };
  const outcomes = await replayOutcomes(file, run);
  assert.equal(outcomes.get(`${SURFACE}/${SUITE}#add`).message, 'renderer exploded');
});

test('replay: the adapter gets a copy of the input and a frozen context of exactly surface and suite', async (t) => {
  const file = writeCaseFile(tempDir(t), validFile());
  const contexts = [];
  const run = (input, context) => {
    contexts.push(context);
    input.expression = 'mutated';
    return context.surface === SURFACE ? { kind: 'number', value: 3 } : null;
  };
  await replayOutcomes(file, run);
  assert.equal(contexts.length, 2);
  for (const context of contexts) {
    assert.ok(Object.isFrozen(context));
    assert.deepEqual(Object.keys(context).sort(), ['suite', 'surface']);
    assert.deepEqual(context, { surface: SURFACE, suite: SUITE });
  }
});

test('replay: a volatile pointer is not compared but must be present in actual', async (t) => {
  const output = {
    items: [
      { id: '<volatile>', n: 1 },
      { id: 'b', n: 2 },
    ],
  };
  const cases = [
    validFile().cases[0],
    { id: 'list', input: { expression: 'list' }, output, volatile: ['/items/0/id'] },
  ];
  const file = writeCaseFile(tempDir(t), validFile({ cases }));
  const other = listRunner({
    list: () => ({
      items: [
        { id: 'run-specific', n: 1 },
        { id: 'b', n: 2 },
      ],
    }),
  });
  const outcomes = await replayOutcomes(file, other);
  assert.equal(outcomes.get(`${SURFACE}/${SUITE}#list`), null);
  const absent = listRunner({ list: () => ({ items: [{ n: 1 }, { id: 'b', n: 2 }] }) });
  const missing = await replayOutcomes(file, absent);
  assert.ok(missing.get(`${SURFACE}/${SUITE}#list`) instanceof assert.AssertionError);
});

// ---------------------------------------------------------------- CLI

const BUILD_FLAGS = [
  '--surface',
  SURFACE,
  '--suite',
  SUITE,
  '--oracle-kind',
  'official-package',
  '--oracle-name',
  'Invented.Engine',
  '--oracle-version',
  '1.0.0',
  '--oracle-scope',
  'Invented scope.',
];

function writeRawCapture(root, name, capture) {
  const file = path.join(root, name);
  fs.writeFileSync(file, `${JSON.stringify(capture, null, 2)}\n`);
  return name;
}

function captureFlags(files) {
  return files.flatMap((file) => ['--capture', file]);
}

async function runCli(argv, cwd) {
  const out = [];
  const err = [];
  const code = await main(argv, { stdout: captureOutput(out), stderr: captureOutput(err), cwd });
  return { code, out: out.join(''), err: err.join('') };
}

function rawFiles(root) {
  const a = { capture: { id: 'run-1', capturedAt: '2026-11-08' }, results: BASE_RESULTS };
  const b = { capture: { id: 'run-2', capturedAt: '2026-11-08' }, results: BASE_RESULTS };
  return [writeRawCapture(root, 'a.json', a), writeRawCapture(root, 'b.json', b)];
}

test('cli: build writes a case file that check accepts', async (t) => {
  const root = tempDir(t);
  const files = rawFiles(root);
  const built = await runCli(['build', ...BUILD_FLAGS, ...captureFlags(files)], root);
  assert.equal(built.code, 0, built.err);
  assert.match(built.out, /2 cases \(2 added\), 0 volatile pointers, 2 captures/);
  const checked = await runCli(['check'], root);
  assert.equal(checked.code, 0, checked.err);
});

test('cli: build records a declared capture sha256, or the file hash when none is declared', async (t) => {
  const root = tempDir(t);
  const declared = 'a'.repeat(64);
  const withSha = { capture: { id: 'run-1', capturedAt: '2026-11-08', sha256: declared }, results: BASE_RESULTS };
  const plain = { capture: { id: 'run-2', capturedAt: '2026-11-08' }, results: BASE_RESULTS };
  const files = [writeRawCapture(root, 'a.json', withSha), writeRawCapture(root, 'b.json', plain)];
  const built = await runCli(['build', ...BUILD_FLAGS, ...captureFlags(files)], root);
  assert.equal(built.code, 0, built.err);
  const written = loadParityCases(path.join(root, 'mirage/test/parity/cases', SURFACE, `${SUITE}.json`));
  assert.equal(written.captures[0].sha256, declared);
  const plainBytes = fs.readFileSync(path.join(root, 'b.json'));
  assert.equal(written.captures[1].sha256, createHash('sha256').update(plainBytes).digest('hex'));
});

test('cli: a malformed declared capture sha256 is an error', async (t) => {
  const root = tempDir(t);
  const bad = { capture: { id: 'run-1', capturedAt: '2026-11-08', sha256: 'ABC' }, results: BASE_RESULTS };
  const files = [writeRawCapture(root, 'a.json', bad), writeRawCapture(root, 'b.json', bad)];
  const built = await runCli(['build', ...BUILD_FLAGS, ...captureFlags(files)], root);
  assert.equal(built.code, 1);
  assert.match(built.err, /parity-cases: a\.json: capture\.sha256 must be 64 lowercase hex characters/);
});

test('cli: build with an existing oracle change fails without revise and succeeds with it', async (t) => {
  const root = tempDir(t);
  const files = rawFiles(root);
  assert.equal((await runCli(['build', ...BUILD_FLAGS, ...captureFlags(files)], root)).code, 0);
  const flags = BUILD_FLAGS.map((flag, index) => (BUILD_FLAGS[index - 1] === '--oracle-version' ? '2.0.0' : flag));
  const refused = await runCli(['build', ...flags, ...captureFlags(files)], root);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /oracle would change; pass revise/);
  const revised = [...flags, '--revise-change', 'Oracle version bumped.', '--revise-evidence', 'Invented evidence.'];
  assert.equal((await runCli(['build', ...revised, ...captureFlags(files)], root)).code, 0);
  const written = loadParityCases(path.join(root, 'mirage/test/parity/cases', SURFACE, `${SUITE}.json`));
  assert.equal(written.history.length, 1);
  assert.equal(written.oracle.version, '2.0.0');
});

test('cli: check reports an invalid case file with exit code 1', async (t) => {
  const root = tempDir(t);
  writeCaseFile(path.join(root, 'mirage/test/parity'), validFile({ schema: 'wrong' }));
  const checked = await runCli(['check'], root);
  assert.equal(checked.code, 1);
  assert.match(checked.err, /parity-cases: .*schema must be/);
});

test('cli: check fails a known-gaps file that names a missing case', async (t) => {
  const root = tempDir(t);
  writeCaseFile(path.join(root, 'mirage/test/parity'), validFile());
  const gaps = path.join(root, 'mirage/test/parity/known-gaps');
  fs.mkdirSync(gaps, { recursive: true });
  fs.writeFileSync(path.join(gaps, `${SURFACE}.json`), JSON.stringify({ [`${SUITE}#missing`]: 'Invented gap.' }));
  const checked = await runCli(['check', path.join('mirage/test/parity/cases')], root);
  assert.equal(checked.code, 1);
  assert.match(checked.err, /names no recorded case/);
});

test('cli: report --json totals cases and declared gaps per oracle kind', async (t) => {
  const root = tempDir(t);
  const files = rawFiles(root);
  assert.equal((await runCli(['build', ...BUILD_FLAGS, ...captureFlags(files)], root)).code, 0);
  const gaps = path.join(root, 'mirage/test/parity/known-gaps');
  fs.mkdirSync(gaps, { recursive: true });
  const declared = {
    [`${SUITE}#add`]: 'Invented whole-case gap.',
    [`${SUITE}#list`]: { '/items/0/n': 'Invented pointer gap.' },
  };
  fs.writeFileSync(path.join(gaps, `${SURFACE}.json`), JSON.stringify(declared));
  const reported = await runCli(['report', '--json'], root);
  assert.equal(reported.code, 0, reported.err);
  const { kinds } = JSON.parse(reported.out);
  const official = kinds.find((entry) => entry.kind === 'official-package');
  assert.deepEqual(official.totals, { suites: 1, cases: 2, casesWithGaps: 2, wholeCaseGaps: 1, pointerGaps: 1 });
  assert.deepEqual(kinds.find((entry) => entry.kind === 'native').totals, {
    suites: 0,
    cases: 0,
    casesWithGaps: 0,
    wholeCaseGaps: 0,
    pointerGaps: 0,
  });
});

test('cli: help prints usage with exit 0 and an unknown command is an error', async (t) => {
  const root = tempDir(t);
  const help = await runCli(['--help'], root);
  assert.equal(help.code, 0);
  assert.match(help.out, /usage:/);
  const unknown = await runCli(['frobnicate'], root);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /parity-cases: unknown command frobnicate/);
});

// ---------------------------------------------------------------- pointer gaps below and beside the recording

test('diff: a gap pointer suppresses an extra key in actual and a missing key', () => {
  assert.deepEqual(diffParityOutput({ a: 1, extra: 2 }, { a: 1 }, { gaps: ['/extra'] }), []);
  assert.deepEqual(diffParityOutput({ a: 1 }, { a: 1, b: 2 }, { gaps: ['/b'] }), []);
});

test('replay: a pointer gap on an extra key passes while the key is present and closes when it disappears', async (t) => {
  const file = writeCaseFile(tempDir(t), validFile());
  const gap = { [`${SUITE}#list`]: { '/note': 'Invented gap.' } };
  const withNote = listRunner({ list: () => ({ items: BASE_RESULTS[1].output.items, note: 'run-only' }) });
  assert.equal((await replayOutcomes(file, withNote, gap)).get(`${SURFACE}/${SUITE}#list`), null);
  const closed = (await replayOutcomes(file, listRunner(), gap)).get(`${SURFACE}/${SUITE}#list`);
  assert.ok(closed instanceof assert.AssertionError);
  assert.ok(closed.message.includes('known gap closed: remove basic-suite#list /note'));
});

test('replay: a pointer gap on a missing key passes while the key is absent and closes when it is present', async (t) => {
  const output = { items: BASE_RESULTS[1].output.items, flag: true };
  const cases = [validFile().cases[0], { id: 'list', input: { expression: 'list' }, output, volatile: [] }];
  const file = writeCaseFile(tempDir(t), validFile({ cases }));
  const gap = { [`${SUITE}#list`]: { '/flag': 'Invented gap.' } };
  assert.equal((await replayOutcomes(file, listRunner(), gap)).get(`${SURFACE}/${SUITE}#list`), null);
  const present = listRunner({ list: () => ({ items: BASE_RESULTS[1].output.items, flag: true }) });
  const closed = (await replayOutcomes(file, present, gap)).get(`${SURFACE}/${SUITE}#list`);
  assert.ok(closed instanceof assert.AssertionError);
  assert.ok(closed.message.includes('known gap closed: remove basic-suite#list /flag'));
});

test('replay: a pointer that resolves nowhere and never differs fails as known gap closed', async (t) => {
  const file = writeCaseFile(tempDir(t), validFile());
  const gap = { [`${SUITE}#list`]: { '/nowhere': 'Invented gap.' } };
  const error = (await replayOutcomes(file, listRunner(), gap)).get(`${SURFACE}/${SUITE}#list`);
  assert.ok(error instanceof assert.AssertionError);
  assert.ok(error.message.includes('known gap closed: remove basic-suite#list /nowhere'));
});

test('replay: a gap below a node that differs as a whole does not excuse the difference', async (t) => {
  const shape = { id: 'shape', input: { expression: 'shape' }, output: { a: 'text' }, volatile: [] };
  const file = writeCaseFile(tempDir(t), validFile({ cases: [...validFile().cases, shape] }));
  const run = (input) => (input.expression === 'shape' ? { a: { b: 1 } } : listRunner()(input));
  const beneath = { [`${SUITE}#shape`]: { '/a/b': 'Invented gap.' } };
  const error = (await replayOutcomes(file, run, beneath)).get(`${SURFACE}/${SUITE}#shape`);
  assert.ok(error instanceof assert.AssertionError);
  assert.ok(error.message.startsWith('output differs at /a\n'));
  const node = { [`${SUITE}#shape`]: { '/a': 'Invented gap.' } };
  assert.equal((await replayOutcomes(file, run, node)).get(`${SURFACE}/${SUITE}#shape`), null);
});

test('replay: a known-gap pointer that is not a non-empty JSON Pointer is rejected', async (t) => {
  const file = writeCaseFile(tempDir(t), validFile());
  const gap = { [`${SUITE}#list`]: { '': 'Invented gap.' } };
  const error = (await replayOutcomes(file, listRunner(), gap)).get(`${SURFACE}/${SUITE}#list`);
  assert.ok(error instanceof assert.AssertionError);
  assert.match(error.message, /not a non-empty JSON Pointer/);
});

// ---------------------------------------------------------------- volatile placeholder

test('validate: a volatile pointer must hold the placeholder in the stored output', () => {
  const stored = [{ id: 'add', input: {}, output: { value: 3 }, volatile: ['/value'] }];
  assertProblem(validFile({ cases: stored }), /volatile pointer \/value must hold the placeholder/);
  const placeholder = [{ id: 'add', input: {}, output: { value: '<volatile>' }, volatile: ['/value'] }];
  assert.deepEqual(validateParityCases(validFile({ cases: placeholder }), { surface: SURFACE, suite: SUITE }), []);
});

test('build: a volatile value is stored as the placeholder, not as the first capture value', () => {
  const changed = structuredClone(BASE_RESULTS);
  changed[1].output.items[1].n = 5;
  const file = buildParityCases({
    surface: SURFACE,
    suite: SUITE,
    oracle: ORACLE,
    captures: [rawCapture('run-1', BASE_RESULTS), rawCapture('run-2', changed)],
  });
  assert.deepEqual(file.cases[1].volatile, ['/items/1/n']);
  assert.equal(file.cases[1].output.items[1].n, '<volatile>');
  assert.equal(file.cases[1].output.items[0].n, 1);
  assert.equal(BASE_RESULTS[1].output.items[1].n, 2);
});

test('build: rebuilding from the same captures is a no-op', () => {
  const changed = structuredClone(BASE_RESULTS);
  changed[1].output.items[1].n = 5;
  const captures = [rawCapture('run-1', BASE_RESULTS), rawCapture('run-2', changed)];
  const existing = buildParityCases({ surface: SURFACE, suite: SUITE, oracle: ORACLE, captures });
  const again = buildParityCases({ surface: SURFACE, suite: SUITE, oracle: ORACLE, captures, existing });
  assert.deepEqual(again, existing);
});

// ---------------------------------------------------------------- directory runner

const STATELESS_ADAPTER = `export default async function run(input, context) {
  if (Object.keys(context).sort().join() !== 'suite,surface') throw new Error('unexpected context');
  return input.expression === 'list' ? { items: [{ id: 'a', n: 1 }, { id: 'b', n: 2 }] } : { kind: 'number', value: 3 };
}
`;

const STATEFUL_ADAPTER = `export async function open(context) {
  globalThis.parityTestLog.push(['open', context.surface]);
  return {
    run(input) {
      globalThis.parityTestLog.push(['run', input.expression]);
      return input.expression === 'list' ? { items: [{ id: 'a', n: 1 }, { id: 'b', n: 2 }] } : { kind: 'number', value: 3 };
    },
    close() {
      globalThis.parityTestLog.push(['close']);
    },
  };
}
export default async function run() {
  throw new Error('default run must not be used when open is exported');
}
`;

const FAILING_OPEN_ADAPTER = `export async function open() {
  globalThis.parityTestLog.push(['open']);
  throw new Error('session unavailable');
}
export default async function run() {
  return {};
}
`;

function writeAdapter(root, surface, source) {
  const file = path.join(root, 'adapters', `${surface}.mjs`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
}

// Fake node:test registrar: collects tests and hooks; runAll executes them as node:test would, in order.
function collectHooks() {
  const tests = [];
  const hooks = [];
  return {
    tests,
    hooks,
    test: (name, fn) => tests.push({ name, fn }),
    after: (fn) => hooks.push(fn),
    async runAll() {
      const outcomes = new Map();
      for (const { name, fn } of tests) {
        try {
          await fn();
          outcomes.set(name, null);
        } catch (error) {
          outcomes.set(name, error);
        }
      }
      for (const hook of hooks) await hook();
      return outcomes;
    },
  };
}

function directoryOptions(root, collector) {
  return {
    cases: pathToFileURL(`${path.join(root, 'cases')}${path.sep}`),
    adapters: pathToFileURL(`${path.join(root, 'adapters')}${path.sep}`),
    knownGaps: pathToFileURL(`${path.join(root, 'known-gaps')}${path.sep}`),
    test: collector.test,
    after: collector.after,
  };
}

test('replayParityDirectory: a stateless default-export adapter runs every case', async (t) => {
  const root = tempDir(t);
  writeCaseFile(root, validFile());
  writeAdapter(root, SURFACE, STATELESS_ADAPTER);
  const collector = collectHooks();
  assert.deepEqual(await replayParityDirectory(directoryOptions(root, collector)), { files: 1, cases: 2 });
  assert.equal(collector.hooks.length, 0);
  const outcomes = await collector.runAll();
  assert.equal(outcomes.get(`${SURFACE}/${SUITE}#add`), null);
  assert.equal(outcomes.get(`${SURFACE}/${SUITE}#list`), null);
});

test('replayParityDirectory: a stateful adapter is opened once per file, shared by its cases, then closed', async (t) => {
  globalThis.parityTestLog = [];
  t.after(() => {
    delete globalThis.parityTestLog;
  });
  const root = tempDir(t);
  writeCaseFile(root, validFile());
  writeAdapter(root, SURFACE, STATEFUL_ADAPTER);
  const collector = collectHooks();
  await replayParityDirectory(directoryOptions(root, collector));
  assert.equal(collector.hooks.length, 1);
  assert.deepEqual(globalThis.parityTestLog, []);
  const outcomes = await collector.runAll();
  assert.equal(outcomes.get(`${SURFACE}/${SUITE}#add`), null);
  assert.equal(outcomes.get(`${SURFACE}/${SUITE}#list`), null);
  assert.deepEqual(globalThis.parityTestLog, [['open', SURFACE], ['run', '1+2'], ['run', 'list'], ['close']]);
});

test('replayParityDirectory: a rejected open fails every case of the file without reopening', async (t) => {
  globalThis.parityTestLog = [];
  t.after(() => {
    delete globalThis.parityTestLog;
  });
  const root = tempDir(t);
  writeCaseFile(root, validFile());
  writeAdapter(root, SURFACE, FAILING_OPEN_ADAPTER);
  const collector = collectHooks();
  await replayParityDirectory(directoryOptions(root, collector));
  const outcomes = await collector.runAll();
  assert.equal(outcomes.get(`${SURFACE}/${SUITE}#add`).message, 'session unavailable');
  assert.equal(outcomes.get(`${SURFACE}/${SUITE}#list`).message, 'session unavailable');
  assert.deepEqual(globalThis.parityTestLog, [['open']]);
});

test('replayParityDirectory: an adapter exporting neither run nor open is an error', async (t) => {
  const root = tempDir(t);
  writeCaseFile(root, validFile());
  writeAdapter(root, SURFACE, 'export const other = 1;\n');
  await assert.rejects(
    replayParityDirectory(directoryOptions(root, collectHooks())),
    /adapter demo-surface exports neither a default run nor open/,
  );
});

test('replayParityDirectory: a missing or empty cases directory registers nothing', async (t) => {
  const root = tempDir(t);
  const collector = collectHooks();
  assert.deepEqual(await replayParityDirectory(directoryOptions(root, collector)), { files: 0, cases: 0 });
  fs.mkdirSync(path.join(root, 'cases'));
  assert.deepEqual(await replayParityDirectory(directoryOptions(root, collector)), { files: 0, cases: 0 });
  assert.equal(collector.tests.length, 0);
  assert.equal(collector.hooks.length, 0);
});
