// Parity case CLI: build case files from raw oracle captures, check every case file, report coverage.
//   node scripts/parity-cases.mjs build --surface <s> --suite <n> --oracle-kind <k> --oracle-name <n>
//     --oracle-version <v> --oracle-scope <text> --capture <file> --capture <file> [...] [--out <file>]
//     [--revise-change <text> --revise-evidence <text>]
//   node scripts/parity-cases.mjs check [<dir>]
//   node scripts/parity-cases.mjs report [<dir>] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildParityCases, loadParityCases } from '../mirage/testing/parity-cases.mjs';

// Report order of the oracle kinds; the library validates `oracle.kind` against the same three values.
const ORACLE_KINDS = ['native', 'official-package', 'reference-engine'];
const DEFAULT_CASES = path.join('mirage', 'test', 'parity', 'cases');
const VALUE_OPTIONS = [
  'surface',
  'suite',
  'oracle-kind',
  'oracle-name',
  'oracle-version',
  'oracle-scope',
  'capture',
  'out',
  'revise-change',
  'revise-evidence',
];
const FLAG_OPTIONS = ['json'];
const USAGE = `usage:
  parity-cases build --surface <s> --suite <n> --oracle-kind <k> --oracle-name <n> --oracle-version <v>
      --oracle-scope <text> --capture <file> --capture <file> [...] [--out <file>]
      [--revise-change <text> --revise-evidence <text>]
  parity-cases check [<dir>]
  parity-cases report [<dir>] [--json]
`;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseArgs(argv) {
  const options = { capture: [] };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
    } else if (FLAG_OPTIONS.includes(token.slice(2))) {
      options[token.slice(2)] = true;
    } else {
      index = readValueOption(argv, index, options);
    }
  }
  return { command: positional[0], args: positional.slice(1), options };
}

// Stores the value of one `--name value` option and returns the index of the value.
function readValueOption(argv, index, options) {
  const name = argv[index].slice(2);
  if (!VALUE_OPTIONS.includes(name)) throw new Error(`unknown option ${argv[index]}`);
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${argv[index]} needs a value`);
  if (name === 'capture') options.capture.push(value);
  else options[name] = value;
  return index + 1;
}

function listJsonFiles(dir, recursive) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return recursive ? listJsonFiles(full, true) : [];
      return entry.name.endsWith('.json') ? [full] : [];
    })
    .sort();
}

function knownGapFile(casesDir, surface) {
  return path.join(casesDir, '..', 'known-gaps', `${surface}.json`);
}

function knownGapsFor(casesDir, surface) {
  const file = knownGapFile(casesDir, surface);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

// ---------------------------------------------------------------- build

function required(options, name) {
  if (options[name] === undefined) throw new Error(`build needs --${name}`);
  return options[name];
}

function oracleFromOptions(options, fallback) {
  const oracle = {
    kind: options['oracle-kind'] ?? fallback?.kind,
    name: options['oracle-name'] ?? fallback?.name,
    version: options['oracle-version'] ?? fallback?.version,
    scope: options['oracle-scope'] ?? fallback?.scope,
  };
  if (Object.values(oracle).some((value) => value === undefined)) {
    throw new Error(
      'build needs --oracle-kind, --oracle-name, --oracle-version and --oracle-scope, or an existing case file',
    );
  }
  return oracle;
}

function reviseFromOptions(options) {
  const change = options['revise-change'];
  const evidence = options['revise-evidence'];
  if (change === undefined && evidence === undefined) return undefined;
  if (change === undefined || evidence === undefined) {
    throw new Error('--revise-change and --revise-evidence must be given together');
  }
  return { date: new Date().toISOString().slice(0, 10), change, evidence };
}

// The capture's own sha256 (the raw record it was extracted from) wins; otherwise the file bytes are hashed.
function readCapture(file, cwd) {
  const bytes = fs.readFileSync(path.resolve(cwd, file));
  let raw;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${file} is not JSON: ${error.message}`, { cause: error });
  }
  if (!isObject(raw?.capture) || !Array.isArray(raw.results)) throw new Error(`${file} is not a raw capture`);
  const declared = Object.hasOwn(raw.capture, 'sha256') ? raw.capture.sha256 : undefined;
  if (declared !== undefined && !/^[0-9a-f]{64}$/.test(declared)) {
    throw new Error(`${file}: capture.sha256 must be 64 lowercase hex characters`);
  }
  return {
    sha256: declared ?? createHash('sha256').update(bytes).digest('hex'),
    capture: { id: raw.capture.id, capturedAt: raw.capture.capturedAt },
    results: raw.results,
  };
}

// Prettier is the repository formatter; plain JSON is written when it cannot be imported.
async function formatJson(value, filepath) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  let prettier;
  try {
    prettier = await import('prettier');
  } catch {
    return text;
  }
  const config = await prettier.resolveConfig(filepath);
  return prettier.format(text, { ...config, filepath });
}

function readExisting(outPath) {
  return fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : undefined;
}

async function runBuild(options, cwd, stdout) {
  const surface = required(options, 'surface');
  const suite = required(options, 'suite');
  const outPath = path.resolve(cwd, options.out ?? path.join(DEFAULT_CASES, surface, `${suite}.json`));
  const existing = readExisting(outPath);
  if (options.capture.length < 2) throw new Error('build needs at least two --capture files');
  const built = buildParityCases({
    surface,
    suite,
    oracle: oracleFromOptions(options, existing?.oracle),
    captures: options.capture.map((file) => readCapture(file, cwd)),
    existing,
    revise: reviseFromOptions(options),
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, await formatJson(built, outPath));
  const priorIds = new Set((existing?.cases ?? []).map((parityCase) => parityCase.id));
  const added = built.cases.filter((parityCase) => !priorIds.has(parityCase.id)).length;
  const volatile = built.cases.reduce((sum, parityCase) => sum + parityCase.volatile.length, 0);
  stdout.write(
    `${outPath}: ${built.cases.length} cases (${added} added), ${volatile} volatile pointers, ` +
      `${built.captures.length} captures\n`,
  );
}

// ---------------------------------------------------------------- check

function recordCase(value, index) {
  if (!index.has(value.surface)) index.set(value.surface, new Map());
  const suites = index.get(value.surface);
  suites.set(value.suite, new Set(value.cases.map((parityCase) => parityCase.id)));
}

function gapEntryProblems(where, key, gap, suites) {
  const separator = key.indexOf('#');
  const suite = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (separator === -1 || !suites.get(suite)?.has(id)) return [`${where} names no recorded case`];
  if (typeof gap === 'string') return gap === '' ? [`${where} needs a non-empty reason`] : [];
  if (!isObject(gap) || Object.keys(gap).length === 0) {
    return [`${where} must be a reason string or an object of pointer to reason`];
  }
  return Object.entries(gap).flatMap(([pointer, reason]) => {
    if (!pointer.startsWith('/')) return [`${where} names ${pointer}, which is not a JSON Pointer`];
    if (typeof reason !== 'string' || reason === '') return [`${where} pointer ${pointer} needs a non-empty reason`];
    return [];
  });
}

function knownGapProblems(file, index) {
  const surface = path.basename(file, '.json');
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return [`${file}: cannot read known gaps: ${error.message}`];
  }
  if (!isObject(value)) return [`${file}: known gaps must be a JSON object`];
  const suites = index.get(surface) ?? new Map();
  return Object.entries(value).flatMap(([key, gap]) => gapEntryProblems(`${file}: ${key}`, key, gap, suites));
}

function runCheck(dirArg, cwd, stdout, stderr) {
  const casesDir = path.resolve(cwd, dirArg ?? DEFAULT_CASES);
  const caseFiles = listJsonFiles(casesDir, true);
  const gapFiles = listJsonFiles(path.join(casesDir, '..', 'known-gaps'), false);
  const problems = [];
  const index = new Map();
  for (const file of caseFiles) {
    try {
      recordCase(loadParityCases(file), index);
    } catch (error) {
      problems.push(error.message);
    }
  }
  for (const file of gapFiles) problems.push(...knownGapProblems(file, index));
  for (const problem of problems) stderr.write(`parity-cases: ${problem}\n`);
  if (problems.length > 0) return 1;
  stdout.write(`parity cases: ${caseFiles.length} case files, ${gapFiles.length} known-gap files: ok\n`);
  return 0;
}

// ---------------------------------------------------------------- report

function caseRows(file, casesDir) {
  const value = loadParityCases(file);
  const gaps = knownGapsFor(casesDir, value.surface);
  return value.cases.map((parityCase) => {
    // Known-gap files name a case as `<suite>#<id>`.
    const gap = gaps[`${value.suite}#${parityCase.id}`];
    const whole = typeof gap === 'string' ? 1 : 0;
    const pointers = isObject(gap) ? Object.keys(gap).length : 0;
    return {
      kind: value.oracle.kind,
      surface: value.surface,
      suite: value.suite,
      cases: 1,
      casesWithGaps: whole + pointers > 0 ? 1 : 0,
      wholeCaseGaps: whole,
      pointerGaps: pointers,
    };
  });
}

const SUM_FIELDS = ['cases', 'casesWithGaps', 'wholeCaseGaps', 'pointerGaps'];

function addInto(target, row) {
  for (const field of SUM_FIELDS) target[field] += row[field];
  return target;
}

function summarizeKind(kind, rows) {
  const ofKind = rows.filter((row) => row.kind === kind);
  const bySurface = new Map();
  for (const row of ofKind) {
    if (!bySurface.has(row.surface)) {
      bySurface.set(row.surface, { surface: row.surface, suites: new Set(), ...zeroTotals() });
    }
    const entry = bySurface.get(row.surface);
    entry.suites.add(row.suite);
    addInto(entry, row);
  }
  const surfaces = [...bySurface.values()]
    .map((entry) => ({ ...entry, suites: entry.suites.size }))
    .sort((a, b) => a.surface.localeCompare(b.surface));
  const totals = surfaces.reduce((sum, entry) => addInto(sum, entry), { suites: 0, ...zeroTotals() });
  totals.suites = surfaces.reduce((sum, entry) => sum + entry.suites, 0);
  return { kind, totals, surfaces };
}

function zeroTotals() {
  return { cases: 0, casesWithGaps: 0, wholeCaseGaps: 0, pointerGaps: 0 };
}

function renderTable(kinds) {
  const lines = [];
  const header = ['surface', 'suites', 'cases', 'with gaps', 'case gaps', 'pointer gaps'];
  for (const { kind, surfaces } of kinds) {
    lines.push(`${kind}`);
    if (surfaces.length === 0) {
      lines.push('  (no case files)');
      continue;
    }
    const rows = surfaces.map((entry) => [
      entry.surface,
      entry.suites,
      entry.cases,
      entry.casesWithGaps,
      entry.wholeCaseGaps,
      entry.pointerGaps,
    ]);
    for (const row of [header, ...rows]) {
      lines.push(
        `  ${row
          .map((cell, i) => String(cell).padEnd(i ? 11 : 24))
          .join('')
          .trimEnd()}`,
      );
    }
  }
  for (const { kind, totals } of kinds) {
    lines.push(
      `${kind} total: ${totals.suites} suites, ${totals.cases} cases, ` +
        `${totals.casesWithGaps} with declared gaps (${totals.wholeCaseGaps} whole-case, ${totals.pointerGaps} pointer)`,
    );
  }
  const native = kinds.find((entry) => entry.kind === 'native').totals;
  lines.push(`native cases: ${native.cases} (${native.casesWithGaps} with declared gaps)`);
  return `${lines.join('\n')}\n`;
}

function runReport(dirArg, json, cwd, stdout) {
  const casesDir = path.resolve(cwd, dirArg ?? DEFAULT_CASES);
  const rows = listJsonFiles(casesDir, true).flatMap((file) => caseRows(file, casesDir));
  const kinds = ORACLE_KINDS.map((kind) => summarizeKind(kind, rows));
  stdout.write(json ? `${JSON.stringify({ kinds }, null, 2)}\n` : renderTable(kinds));
  return 0;
}

// ---------------------------------------------------------------- entry

/**
 * Runs one CLI command.
 * @param {string[]} argv arguments after the script name
 * @param {{ stdout?: { write(text: string): unknown }, stderr?: { write(text: string): unknown }, cwd?: string }} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd() } = {}) {
  try {
    if (argv.includes('--help')) {
      stdout.write(USAGE);
      return 0;
    }
    const { command, args, options } = parseArgs(argv);
    switch (command) {
      case 'build':
        await runBuild(options, cwd, stdout);
        return 0;
      case 'check':
        return runCheck(args[0], cwd, stdout, stderr);
      case 'report':
        return runReport(args[0], options.json === true, cwd, stdout);
      default:
        throw new Error(command ? `unknown command ${command}` : 'missing command (build, check or report)');
    }
  } catch (error) {
    stderr.write(`parity-cases: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
