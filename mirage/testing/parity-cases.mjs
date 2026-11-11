// Parity replay cases: validation, building from recorded oracle captures, structural diff and replay.
// Pure Node built-ins only. Case files live under mirage/test/parity/cases/<surface>/<suite>.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { after as nodeAfter, test as nodeTest } from 'node:test';

const PARITY_CASES_SCHEMA = 'paqvilo.parity-cases/1';
const ORACLE_KINDS = ['native', 'official-package', 'reference-engine'];
// Stored in place of every value at a volatile pointer: the run-specific value is never kept in a case file.
const VOLATILE = '<volatile>';

const TOP_LEVEL_KEYS = ['schema', 'surface', 'suite', 'oracle', 'captures', 'cases', 'history'];
const CAPTURE_KEYS = ['id', 'sha256', 'capturedAt'];
const NAME_PATTERN = /^[a-z0-9-]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ARRAY_INDEX_PATTERN = /^(0|[1-9]\d*)$/;

/**
 * Key that known-gap files use to name one case of a suite.
 * @param {string} suite suite name, lowercase [a-z0-9-]+
 * @param {string} id case id
 * @returns {string} `<suite>#<id>`
 */
function parityCaseKey(suite, id) {
  return `${suite}#${id}`;
}

// ---------------------------------------------------------------- JSON values and pointers

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function toJson(value) {
  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text);
}

function sameLeaf(actual, expected) {
  return actual === expected || Object.is(actual, expected);
}

function escapeToken(token) {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapeToken(token) {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function childPointer(pointer, key) {
  return `${pointer}/${escapeToken(key)}`;
}

function pointerTokens(pointer) {
  return pointer === '' ? [] : pointer.slice(1).split('/').map(unescapeToken);
}

function isPointer(value) {
  return typeof value === 'string' && value.startsWith('/') && !/~(?![01])/.test(value);
}

function hasToken(node, token) {
  if (Array.isArray(node)) return ARRAY_INDEX_PATTERN.test(token) && Number(token) < node.length;
  return isObject(node) && Object.hasOwn(node, token);
}

function resolvePointer(root, pointer) {
  let node = root;
  for (const token of pointerTokens(pointer)) {
    if (!hasToken(node, token)) return { found: false };
    node = node[token];
  }
  return { found: true, value: node };
}

// Copy of `value` where the value at each pointer is replaced by VOLATILE. Used to store case outputs and to
// mask both sides of a failure diff to the same placeholder.
function maskVolatile(value, pointers) {
  const copy = structuredClone(value);
  for (const pointer of pointers) {
    const cut = pointer.lastIndexOf('/');
    const parent = resolvePointer(copy, pointer.slice(0, cut));
    const token = unescapeToken(pointer.slice(cut + 1));
    if (parent.found && hasToken(parent.value, token)) parent.value[token] = VOLATILE;
  }
  return copy;
}

// ---------------------------------------------------------------- validation

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function matches(pattern, value) {
  return typeof value === 'string' && pattern.test(value);
}

function nonJsonProblems(value, pointer) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return [];
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [`${pointer || '/'} is not a finite number`];
  if (Array.isArray(value)) return value.flatMap((item, index) => nonJsonProblems(item, `${pointer}/${index}`));
  if (isObject(value)) {
    return Object.entries(value).flatMap(([key, item]) => nonJsonProblems(item, childPointer(pointer, key)));
  }
  return [`${pointer || '/'} is not a JSON value`];
}

function headerProblems(value, surface, suite) {
  const problems = [];
  if (value.schema !== PARITY_CASES_SCHEMA) problems.push(`schema must be "${PARITY_CASES_SCHEMA}"`);
  if (!matches(NAME_PATTERN, value.surface)) problems.push('surface must match [a-z0-9-]+');
  if (!matches(NAME_PATTERN, value.suite)) problems.push('suite must match [a-z0-9-]+');
  if (surface !== undefined && value.surface !== surface) {
    problems.push(`surface "${value.surface}" does not match the path surface "${surface}"`);
  }
  if (suite !== undefined && value.suite !== suite) {
    problems.push(`suite "${value.suite}" does not match the path suite "${suite}"`);
  }
  return problems;
}

function oracleProblems(oracle) {
  if (!isObject(oracle)) return ['oracle must be an object'];
  const problems = [];
  if (!ORACLE_KINDS.includes(oracle.kind)) problems.push(`oracle.kind must be one of ${ORACLE_KINDS.join(', ')}`);
  for (const field of ['name', 'version', 'scope']) {
    if (!nonEmptyString(oracle[field])) problems.push(`oracle.${field} must be a non-empty string`);
  }
  return problems;
}

function captureEntryProblems(capture, where) {
  if (!isObject(capture)) return [`${where} must be an object`];
  const problems = Object.keys(capture)
    .filter((key) => !CAPTURE_KEYS.includes(key))
    .map((key) => `${where} has unknown key "${key}"`);
  if (!nonEmptyString(capture.id)) problems.push(`${where}.id must be a non-empty string`);
  if (!matches(SHA256_PATTERN, capture.sha256)) problems.push(`${where}.sha256 must be 64 lowercase hex characters`);
  if (!matches(DATE_PATTERN, capture.capturedAt)) problems.push(`${where}.capturedAt must be YYYY-MM-DD`);
  return problems;
}

function captureProblems(captures) {
  if (!Array.isArray(captures) || captures.length < 2) return ['captures must list at least two captures'];
  const problems = captures.flatMap((capture, index) => captureEntryProblems(capture, `captures[${index}]`));
  const ids = captures.map((capture) => capture?.id).filter(nonEmptyString);
  for (const id of new Set(ids.filter((id, index) => ids.indexOf(id) !== index))) {
    problems.push(`duplicate capture id "${id}"`);
  }
  return problems;
}

function isVolatilePointerValid(pointer, output) {
  if (!isPointer(pointer)) return 'volatile entries must be non-empty JSON Pointers starting with "/"';
  const found = resolvePointer(output, pointer);
  if (!found.found) return `volatile pointer ${pointer} does not resolve inside output`;
  if (found.value !== VOLATILE) return `volatile pointer ${pointer} must hold the placeholder "${VOLATILE}"`;
  return null;
}

function caseShapeProblems(parityCase, where) {
  if (!isObject(parityCase)) return [`${where} must be an object`];
  const problems = [];
  if (!nonEmptyString(parityCase.id)) problems.push(`${where}.id must be a non-empty string`);
  if (!Object.hasOwn(parityCase, 'input')) problems.push(`${where}.input is required`);
  if (!Object.hasOwn(parityCase, 'output')) problems.push(`${where}.output is required`);
  if (!Array.isArray(parityCase.volatile)) {
    problems.push(`${where}.volatile must be an array of JSON Pointers`);
    return problems;
  }
  for (const pointer of parityCase.volatile) {
    const problem = isVolatilePointerValid(pointer, parityCase.output);
    if (problem) problems.push(`${where}: ${problem}`);
  }
  return problems;
}

function caseProblems(cases) {
  if (!Array.isArray(cases) || cases.length === 0) return ['cases must be a non-empty array'];
  const problems = [];
  const seen = new Set();
  cases.forEach((parityCase, index) => {
    const where = `cases[${index}]`;
    problems.push(...caseShapeProblems(parityCase, where));
    if (nonEmptyString(parityCase?.id)) {
      if (seen.has(parityCase.id)) problems.push(`duplicate case id "${parityCase.id}"`);
      seen.add(parityCase.id);
    }
  });
  return problems;
}

function historyProblems(history) {
  if (!Array.isArray(history)) return ['history must be an array'];
  return history.flatMap((entry, index) => {
    const where = `history[${index}]`;
    if (!isObject(entry)) return [`${where} must be an object`];
    const problems = [];
    if (!matches(DATE_PATTERN, entry.date)) problems.push(`${where}.date must be YYYY-MM-DD`);
    if (!nonEmptyString(entry.change)) problems.push(`${where}.change must be a non-empty string`);
    if (!nonEmptyString(entry.evidence)) problems.push(`${where}.evidence must be a non-empty string`);
    return problems;
  });
}

/**
 * Lists every problem of a parity case file.
 * @param {unknown} value parsed case file
 * @param {{ surface?: string, suite?: string }} [expected] names the file path implies; checked when given
 * @returns {string[]} human-readable problems, empty when valid
 */
export function validateParityCases(value, { surface, suite } = {}) {
  if (!isObject(value)) return ['file must be a JSON object'];
  const problems = Object.keys(value)
    .filter((key) => !TOP_LEVEL_KEYS.includes(key))
    .map((key) => `unknown top-level key "${key}"`);
  return [
    ...problems,
    ...nonJsonProblems(value, ''),
    ...headerProblems(value, surface, suite),
    ...oracleProblems(value.oracle),
    ...captureProblems(value.captures),
    ...caseProblems(value.cases),
    ...historyProblems(value.history),
  ];
}

function namesFromPath(filePath) {
  const parts = filePath.split(/[\\/]/);
  if (parts.at(-3) !== 'cases') return {};
  return { surface: parts.at(-2), suite: parts.at(-1).replace(/\.json$/, '') };
}

function toFilePath(fileUrlOrPath) {
  if (fileUrlOrPath instanceof URL) return fileURLToPath(fileUrlOrPath);
  if (typeof fileUrlOrPath === 'string' && fileUrlOrPath.startsWith('file:')) return fileURLToPath(fileUrlOrPath);
  return path.resolve(fileUrlOrPath);
}

/**
 * Reads and validates one case file. Surface and suite must match its path cases/<surface>/<suite>.json.
 * @param {URL|string} fileUrlOrPath file URL, `file:` URL string or filesystem path
 * @returns {object} the parsed case file
 * @throws {Error} `<path>: <problems>` when the file is not valid
 */
export function loadParityCases(fileUrlOrPath) {
  const filePath = toFilePath(fileUrlOrPath);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${filePath}: cannot read case file: ${error.message}`, { cause: error });
  }
  const problems = validateParityCases(value, namesFromPath(filePath));
  if (problems.length > 0) throw new Error(`${filePath}: ${problems.join('; ')}`);
  return value;
}

// ---------------------------------------------------------------- building

function captureRecord(capture) {
  return { id: capture.capture?.id, sha256: capture.sha256, capturedAt: capture.capture?.capturedAt };
}

function collectArrayVolatile(base, other, pointer, out) {
  if (base.length !== other.length) {
    out.add(pointer);
    return;
  }
  base.forEach((item, index) => collectVolatile(item, other[index], childPointer(pointer, index), out));
}

function collectObjectVolatile(base, other, pointer, out) {
  const keys = Object.keys(base);
  if (keys.length !== Object.keys(other).length || keys.some((key) => !Object.hasOwn(other, key))) {
    out.add(pointer);
    return;
  }
  for (const key of keys) collectVolatile(base[key], other[key], childPointer(pointer, key), out);
}

// Adds to `out` the most specific pointers at which `other` differs from `base`.
function collectVolatile(base, other, pointer, out) {
  if (kindOf(base) !== kindOf(other)) {
    out.add(pointer);
  } else if (Array.isArray(base)) {
    collectArrayVolatile(base, other, pointer, out);
  } else if (isObject(base)) {
    collectObjectVolatile(base, other, pointer, out);
  } else if (!sameLeaf(base, other)) {
    out.add(pointer);
  }
}

function assertSameCorpus(base, other) {
  const baseId = captureRecord(base).id;
  const otherId = captureRecord(other).id;
  const count = Math.max(base.results.length, other.results.length);
  for (let index = 0; index < count; index += 1) {
    const expected = base.results[index];
    const actual = other.results[index];
    if (!expected || !actual || expected.id !== actual.id) {
      const id = actual?.id ?? expected?.id;
      throw new Error(`capture ${otherId} does not list the same cases as ${baseId}: first mismatch at case ${id}`);
    }
    if (diffParityOutput(actual.input, expected.input).length > 0) {
      throw new Error(`case ${expected.id}: input differs between captures ${baseId} and ${otherId}`);
    }
  }
}

function buildCase(result, index, captures) {
  const volatile = new Set();
  for (const other of captures.slice(1)) {
    collectVolatile(result.output, other.results[index].output, '', volatile);
  }
  if (volatile.has('')) {
    throw new Error(`case ${result.id}: output differs at the root pointer between captures; not reproducible`);
  }
  const volatilePointers = [...volatile].sort();
  return {
    id: result.id,
    input: structuredClone(result.input),
    output: maskVolatile(result.output, volatilePointers),
    volatile: volatilePointers,
  };
}

function sameCase(existing, fresh) {
  return (
    diffParityOutput(fresh.input, existing.input).length === 0 &&
    diffParityOutput(fresh.output, existing.output).length === 0 &&
    JSON.stringify([...existing.volatile].sort()) === JSON.stringify(fresh.volatile)
  );
}

// Returns the existing cases with changed ones replaced, plus the fresh cases whose ids are new.
function mergeCases(existingCases, built) {
  const changed = [];
  const cases = structuredClone(existingCases);
  for (const fresh of built) {
    const index = cases.findIndex((parityCase) => parityCase.id === fresh.id);
    if (index === -1) {
      cases.push(fresh);
    } else if (!sameCase(cases[index], fresh)) {
      changed.push(fresh.id);
      cases[index] = fresh;
    }
  }
  return { cases, changed };
}

function mergeCaptures(existingCaptures, captures) {
  const merged = structuredClone(existingCaptures);
  for (const capture of captures.map(captureRecord)) {
    const prior = merged.find((entry) => entry.id === capture.id);
    if (!prior) merged.push(capture);
    else if (prior.sha256 !== capture.sha256) {
      throw new Error(`capture ${capture.id} is already recorded with a different sha256`);
    }
  }
  return merged;
}

function revisedHistory(existing, changes, revise) {
  const history = structuredClone(existing.history);
  if (changes.length > 0) history.push({ date: revise.date, change: revise.change, evidence: revise.evidence });
  return history;
}

function changeNames(changed, oracleChanged) {
  return [...changed.map((id) => `case ${id}`), ...(oracleChanged ? ['oracle'] : [])];
}

// Merges freshly built cases into an existing file; a change needs `revise` and records one history entry.
function mergeIntoExisting(existing, { surface, suite, oracle, captures, built, revise }) {
  const problems = validateParityCases(existing, { surface, suite });
  if (problems.length > 0) throw new Error(`existing case file is not valid: ${problems.join('; ')}`);
  const { cases, changed } = mergeCases(existing.cases, built);
  const oracleChanged = diffParityOutput(oracle, existing.oracle).length > 0;
  const changes = changeNames(changed, oracleChanged);
  if (changes.length > 0 && !revise) {
    throw new Error(`${changes.join(', ')} would change; pass revise { date, change, evidence } to record it`);
  }
  return {
    schema: PARITY_CASES_SCHEMA,
    surface,
    suite,
    oracle: structuredClone(oracleChanged ? oracle : existing.oracle),
    captures: mergeCaptures(existing.captures, captures),
    cases,
    history: revisedHistory(existing, changes, revise),
  };
}

/**
 * Builds a case file from two or more captures of the same corpus. Volatile pointers are the pointers at
 * which a later capture differs from the first. With `existing`, new ids are appended; a change to an
 * existing case needs `revise` and appends one history entry.
 * @param {object} options
 * @param {string} options.surface surface name
 * @param {string} options.suite suite name
 * @param {{ kind: string, name: string, version: string, scope: string }} options.oracle recorded oracle
 * @param {Array<{ sha256: string, capture: { id: string, capturedAt: string }, results: object[] }>} options.captures
 * @param {object} [options.existing] previously built case file for the same surface and suite
 * @param {{ date: string, change: string, evidence: string }} [options.revise] needed to change existing cases
 * @returns {object} the case file; it has passed validateParityCases
 * @throws {Error} when captures disagree, a root pointer differs, or an existing case would change unrevised
 */
export function buildParityCases({ surface, suite, oracle, captures, existing, revise } = {}) {
  if (!Array.isArray(captures) || captures.length < 2) throw new Error('at least two captures are required');
  if (captures.some((capture) => !Array.isArray(capture?.results))) throw new Error('every capture needs results');
  const [first, ...later] = captures;
  for (const capture of later) assertSameCorpus(first, capture);
  const built = first.results.map((result, index) => buildCase(result, index, captures));
  const file = existing
    ? mergeIntoExisting(existing, { surface, suite, oracle, captures, built, revise })
    : {
        schema: PARITY_CASES_SCHEMA,
        surface,
        suite,
        oracle: structuredClone(oracle),
        captures: captures.map(captureRecord),
        cases: built,
        history: [],
      };
  const problems = validateParityCases(file, { surface, suite });
  if (problems.length > 0) throw new Error(`built case file is not valid: ${problems.join('; ')}`);
  return file;
}

// ---------------------------------------------------------------- diff

function walkArray(actual, expected, pointer, ctx) {
  if (actual.length !== expected.length) {
    ctx.out.push({ pointer, actual, expected });
    return;
  }
  expected.forEach((item, index) => walkDiff(actual[index], item, childPointer(pointer, index), ctx));
}

function walkObject(actual, expected, pointer, ctx) {
  for (const key of Object.keys(expected)) {
    const value = Object.hasOwn(actual, key) ? actual[key] : undefined;
    walkDiff(value, expected[key], childPointer(pointer, key), ctx);
  }
  for (const key of Object.keys(actual)) {
    const extra = childPointer(pointer, key);
    // A key the recording lacks is a difference at its own pointer; `volatile` only covers recorded pointers.
    if (!Object.hasOwn(expected, key) && !ctx.gaps.has(extra)) {
      ctx.out.push({ pointer: extra, actual: actual[key], expected: undefined });
    }
  }
}

function walkDiff(actual, expected, pointer, ctx) {
  if (ctx.gaps.has(pointer)) return;
  if (ctx.volatile.has(pointer)) {
    if (actual === undefined) ctx.out.push({ pointer, actual, expected });
    return;
  }
  if (actual === undefined || kindOf(actual) !== kindOf(expected)) {
    ctx.out.push({ pointer, actual, expected });
  } else if (Array.isArray(expected)) {
    walkArray(actual, expected, pointer, ctx);
  } else if (isObject(expected)) {
    walkObject(actual, expected, pointer, ctx);
  } else if (!sameLeaf(actual, expected)) {
    ctx.out.push({ pointer, actual, expected });
  }
}

/**
 * Structural comparison of a run output with a recorded output. `actual` is round-tripped through JSON.
 * @param {unknown} actual value produced by Mirage
 * @param {unknown} expected recorded output
 * @param {{ volatile?: string[], gaps?: string[] }} [options] volatile pointers must be present but are not
 *   compared; a gap pointer suppresses differences at that pointer and beneath it, including an extra key in
 *   `actual` at exactly that pointer and a missing key
 * @returns {Array<{ pointer: string, actual: unknown, expected: unknown }>} differences in document order
 */
export function diffParityOutput(actual, expected, { volatile = [], gaps = [] } = {}) {
  const ctx = { volatile: new Set(volatile), gaps: new Set(gaps), out: [] };
  walkDiff(toJson(actual), expected, '', ctx);
  return ctx.out;
}

// ---------------------------------------------------------------- replay

// Node prints the masked actual-vs-expected diff; the differing pointers are prepended to its message.
function failOnDiffs(actual, expected, masked, diffs) {
  const pointers = diffs.map((diff) => diff.pointer).join(', ');
  try {
    assert.deepStrictEqual(maskVolatile(actual, masked), maskVolatile(expected, masked));
  } catch (error) {
    error.message = `output differs at ${pointers}\n${error.message}`;
    throw error;
  }
  assert.fail(`output differs at ${pointers}`);
}

function assertMatches(actual, expected, volatile) {
  const diffs = diffParityOutput(actual, expected, { volatile });
  if (diffs.length > 0) failOnDiffs(actual, expected, volatile, diffs);
}

function assertWholeCaseGap(actual, expected, volatile, key) {
  if (diffParityOutput(actual, expected, { volatile }).length === 0) assert.fail(`known gap closed: remove ${key}`);
}

function assertPointerGaps(actual, expected, volatile, gap, key) {
  const pointers = Object.keys(gap);
  const undeclared = diffParityOutput(actual, expected, { volatile, gaps: pointers });
  if (undeclared.length > 0) failOnDiffs(actual, expected, [...volatile, ...pointers], undeclared);
  const all = diffParityOutput(actual, expected, { volatile });
  for (const pointer of pointers) {
    const differs = all.some((diff) => diff.pointer === pointer || diff.pointer.startsWith(`${pointer}/`));
    if (!differs) assert.fail(`known gap closed: remove ${key} ${pointer}`);
  }
}

// Shape only: a pointer need not exist in the recording, because an extra key in the run output is a difference
// at a pointer the recording lacks.
function checkGapShape(gap, key) {
  if (gap === undefined || (typeof gap === 'string' && gap !== '')) return;
  if (!isObject(gap) || Object.keys(gap).length === 0) {
    assert.fail(`known gap ${key} must be a non-empty reason string or an object of pointer to reason`);
  }
  for (const [pointer, reason] of Object.entries(gap)) {
    if (!isPointer(pointer)) {
      assert.fail(`known gap ${key} names ${JSON.stringify(pointer)}, not a non-empty JSON Pointer`);
    }
    if (!nonEmptyString(reason)) assert.fail(`known gap ${key} pointer ${pointer} needs a non-empty reason`);
  }
}

async function replayCase(parityCase, run, gap, key, context) {
  const expected = structuredClone(parityCase.output);
  const volatile = [...parityCase.volatile];
  checkGapShape(gap, key);
  let actual;
  try {
    actual = toJson(await run(structuredClone(parityCase.input), context));
  } catch (error) {
    if (typeof gap === 'string') return;
    throw error;
  }
  if (typeof gap === 'string') return assertWholeCaseGap(actual, expected, volatile, key);
  if (gap !== undefined) return assertPointerGaps(actual, expected, volatile, gap, key);
  return assertMatches(actual, expected, volatile);
}

/**
 * Registers one test per recorded case, plus a check that every known-gap key of this suite names a case.
 * Each case is run with a clone of its input and a frozen context `{ surface, suite }`; the adapter never sees
 * the expected output or the case id.
 *
 * Known gaps are looked up as `knownGaps['<suite>#<id>']`. A non-empty string declares the whole case a gap. An
 * object `{ "<pointer>": "<reason>" }` declares only those pointers; every other difference still fails the case.
 * A declared pointer must name a node that differs from the recording: the difference is at that pointer or beneath
 * it (`diffParityOutput` without gaps). A pointer that never differs fails with `known gap closed`, and a difference
 * above a declared pointer (the declared node is a descendant of a node that differs as a whole) is undeclared.
 * The pointer need not exist in the recording: an extra key in the run output is a difference at its own pointer.
 * @param {URL|string} fileUrlOrPath case file
 * @param {(input: object, context: { surface: string, suite: string }) => unknown} run adapter: recorded input to
 *   oracle-shaped output
 * @param {{ test?: Function, knownGaps?: Record<string, string | Record<string, string>> }} [options]
 * @returns {object} the loaded case file
 */
export function replayParityCases(fileUrlOrPath, run, { test = nodeTest, knownGaps = {} } = {}) {
  const file = loadParityCases(fileUrlOrPath);
  const context = Object.freeze({ surface: file.surface, suite: file.suite });
  const ids = new Set(file.cases.map((parityCase) => parityCase.id));
  const prefix = `${file.suite}#`;
  const stale = Object.keys(knownGaps).filter((key) => key.startsWith(prefix) && !ids.has(key.slice(prefix.length)));
  test(`${file.surface}/${file.suite} known gaps name recorded cases`, () => {
    if (stale.length > 0) assert.fail(`known gaps name no recorded case: ${stale.join(', ')}`);
  });
  for (const parityCase of file.cases) {
    const key = parityCaseKey(file.suite, parityCase.id);
    test(`${file.surface}/${key}`, () => replayCase(parityCase, run, knownGaps[key], key, context));
  }
  return file;
}

function listCaseFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return listCaseFiles(full);
      return entry.name.endsWith('.json') ? [full] : [];
    })
    .sort();
}

function readKnownGaps(dir, surface) {
  const file = dir === undefined ? undefined : path.join(dir, `${surface}.json`);
  return file !== undefined && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

// One session per case file: the first case opens it, the rest share it, and a failed open fails every case.
function statefulRunner(open) {
  let opened = null;
  return {
    run: (input, context) => {
      opened ??= (async () => open(context))();
      return opened.then((session) => session.run(input, context));
    },
    close: async () => {
      if (opened === null) return;
      const session = await opened.catch(() => undefined);
      await session?.close?.();
    },
  };
}

function adapterRunner(surface, adapter) {
  if (typeof adapter.open === 'function') return statefulRunner(adapter.open);
  if (typeof adapter.default === 'function') return { run: adapter.default, close: null };
  throw new Error(`adapter ${surface} exports neither a default run nor open`);
}

/**
 * Registers the recorded cases of every case file under `cases`. Each file's surface is its parent directory
 * name; its adapter is `<adapters>/<surface>.mjs`, imported once per surface. An adapter exports either a default
 * stateless `run(input, context)`, or `open(context)` resolving to `{ run(input, context), close() }`; `open` wins
 * when both are exported. A stateful session is closed by an `after` hook registered once per case file.
 * @param {object} options
 * @param {URL|string} options.cases directory of case files (searched recursively)
 * @param {URL|string} options.adapters directory of adapter modules
 * @param {URL|string} [options.knownGaps] directory of `<surface>.json` known-gap files
 * @param {Function} [options.test] test registrar, default node:test `test`
 * @param {Function} [options.after] hook registrar, default node:test `after`
 * @returns {Promise<{ files: number, cases: number }>} case files and cases registered
 * @throws {Error} when an adapter cannot be imported or exports neither `run` nor `open`
 */
export async function replayParityDirectory({ cases, adapters, knownGaps, test = nodeTest, after = nodeAfter } = {}) {
  const adapterDir = toFilePath(adapters);
  const gapDir = knownGaps === undefined ? undefined : toFilePath(knownGaps);
  const files = listCaseFiles(toFilePath(cases));
  const modules = new Map();
  let registered = 0;
  for (const file of files) {
    const surface = path.basename(path.dirname(file));
    if (!modules.has(surface)) {
      modules.set(surface, await import(pathToFileURL(path.join(adapterDir, `${surface}.mjs`)).href));
    }
    const adapter = adapterRunner(surface, modules.get(surface));
    const loaded = replayParityCases(file, adapter.run, { test, knownGaps: readKnownGaps(gapDir, surface) });
    if (adapter.close) after(adapter.close);
    registered += loaded.cases.length;
  }
  return { files: files.length, cases: registered };
}
