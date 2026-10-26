// Optional, pure-expression differential check. PAC is never a runtime dependency.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPowerFxEvaluator } from '../lib/canvas-power-fx.mjs';

export const CORPUS = Object.freeze([
  { id: 'language', category: 'host', expression: 'Language()', hostDifference: true },
  { id: 'text', category: 'text', expression: 'Upper("hello")' },
  { id: 'unicode', category: 'text', expression: 'Upper("\u00e9")' },
  { id: 'math', category: 'math', expression: 'Round(2.345,2)' },
  { id: 'date', category: 'date', expression: 'Text(Date(2026,1,2),"yyyy-mm-dd","en-US")' },
  { id: 'table', category: 'table', expression: 'Concat(["a","b"],Value)' },
  { id: 'filter', category: 'table', expression: 'CountRows(Filter([1,2,3],Value > 1))' },
  { id: 'record', category: 'record', expression: 'First([{n: 3}]).n' },
  { id: 'with', category: 'record', expression: 'With({n: 3},n + 2)' },
  { id: 'coercion', category: 'coercion', expression: 'Value("2.5","en-US")' },
  { id: 'decimal', category: 'math', expression: 'Text(1234567890123456789012345678,"0","en-US")' },
  { id: 'numeric-fallback', category: 'coercion', expression: 'IfError(1/0,"2")' },
  { id: 'boolean-fallback', category: 'coercion', expression: 'IfError(true,1/0,false)' },
  {
    id: 'date-fallback',
    category: 'date',
    expression: 'Text(IfError(Date(2026,1,2),Date(2020,1,1)),"yyyy-mm-dd","en-US")',
  },
  { id: 'error', category: 'error', expression: 'IfError(1/0,"x")' },
  { id: 'explicit-error', category: 'error', expression: 'Error({Kind: ErrorKind.Div0, Message: "fixture"})' },
  { id: 'handled-error', category: 'error', expression: 'IfError(Text(1/0),"x")' },
]);
const fail = (code, message) => Object.assign(new Error(message), { code });

// Redirected PAC output can switch from a UTF-8 banner to UTF-16LE for the echoed formulas.
function decodePac(buffer) {
  const bytes = Buffer.from(buffer);
  const marker = Buffer.from([62, 0, 62, 0, 32, 0]);
  const index = bytes.indexOf(marker);
  return index < 0
    ? bytes.toString('utf8').replace(/^\uFEFF/, '')
    : bytes.subarray(0, index).toString('utf8').replace(/\0/g, '') + bytes.subarray(index).toString('utf16le');
}
export function parsePacResults(buffer, corpus = CORPUS) {
  const text = decodePac(buffer).replace(/\r/g, '');
  const lines = text.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('>> ')) {
      if (!found.length && /^\s*(?:<Error:|Error(?:\s+\d+(?::\d+)?)?:)/i.test(lines[i]))
        throw fail('PacOutputInvalid', 'PAC reported an error before the first result.');
      if (found.length && lines[i].trim()) throw fail('PacOutputInvalid', 'Unexpected text after a PAC result.');
      continue;
    }
    const row = corpus[found.length];
    if (!row || lines[i].slice(3).trim() !== row.expression)
      throw fail('PacOutputInvalid', 'Unexpected or out-of-order echoed expression.');
    const value = lines[++i]?.trim();
    if (!value) throw fail('PacOutputInvalid', `Missing result for ${row.id}.`);
    let result;
    if (/^<Error:.*>$/.test(value)) result = { kind: 'error', message: value.slice(7, -1).trim() };
    else if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
      try {
        result = { kind: 'value', value: JSON.parse(value) };
      } catch {
        throw fail('PacOutputInvalid', `Invalid string result for ${row.id}.`);
      }
    } else if (/^-?(?:\d+)(?:\.\d+)?$/.test(value)) result = { kind: 'value', value: Number(value) };
    else if (/^(true|false)$/i.test(value)) result = { kind: 'value', value: value.toLowerCase() === 'true' };
    else if (/^(blank|\(blank\))$/i.test(value)) result = { kind: 'value', value: null };
    else throw fail('PacOutputInvalid', `Unsupported output for ${row.id}.`);
    found.push(result);
  }
  if (found.length !== corpus.length) throw fail('PacOutputInvalid', 'PAC did not return every corpus result.');
  return found;
}
export function compareResults(reference, actual, pacProbe, mirageProbe) {
  if (reference.kind !== actual.kind) return 'difference';
  if (reference.kind !== 'error') return Object.is(reference.value, actual.value) ? 'match' : 'difference';
  const kind = (probe) =>
    probe?.kind === 'value' && typeof probe.value === 'string' && /^\d+$/.test(probe.value) ? probe.value : null;
  const pacKind = kind(pacProbe),
    mirageKind = kind(mirageProbe);
  if (pacKind === null || mirageKind === null) return 'comparison-error';
  reference.errorKind = pacKind;
  actual.errorKind = mirageKind;
  return pacKind === mirageKind ? 'match' : 'difference';
}
function findPac(explicit, env = process.env) {
  if (explicit)
    return fs.statSync(explicit, { throwIfNoEntry: false })?.isFile() && /\.exe$/i.test(explicit)
      ? path.resolve(explicit)
      : null;
  for (const folder of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    const candidate = path.join(folder || '.', 'pac.exe');
    if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return path.resolve(candidate);
  }
  return null;
}
function command(executable, args, env, spawn = spawnSync) {
  const result = spawn(executable, args, {
    env,
    shell: false,
    windowsHide: true,
    timeout: 45000,
    maxBuffer: 1024 * 1024,
    encoding: 'buffer',
  });
  if (result.error)
    throw fail(
      result.error.code === 'ETIMEDOUT' ? 'PacTimeout' : 'PacProcessFailed',
      'PAC could not complete within process limits.',
    );
  if (result.status !== 0) throw fail('PacProcessFailed', `PAC exited with status ${result.status}.`);
  return result.stdout;
}
export async function runOracle({ pac, root = process.cwd(), spawn = spawnSync } = {}) {
  const executable = findPac(pac);
  if (!executable) throw fail('PacUnavailable', 'PAC executable was not found; provide --pac with a pac.exe path.');
  const base = path.join(root, '.paqvilo', 'power-fx-oracle');
  fs.mkdirSync(base, { recursive: true });
  const run = fs.mkdtempSync(path.join(base, 'run-'));
  try {
    const env = { ...process.env };
    for (const [key, sub] of [
      ['LOCALAPPDATA', 'local'],
      ['APPDATA', 'roaming'],
      ['USERPROFILE', 'profile'],
    ]) {
      env[key] = path.join(run, sub);
      fs.mkdirSync(env[key]);
    }
    const versionText = decodePac(command(executable, [], env, spawn));
    const version = /\bVersion:\s*([^\r\n]+)/i.exec(versionText)?.[1]?.trim();
    if (!version) throw fail('PacVersionInvalid', 'PAC version could not be identified.');
    const auth = decodePac(command(executable, ['auth', 'list'], env, spawn)).trim();
    if (
      !/^No profiles were found on this computer\.(?: Please run 'pac auth create' to create one\.)?$/i.test(auth) ||
      /(?:^|\n)\s*\*?\s*\d+\s/m.test(auth)
    )
      throw fail('PacAuthNotEmpty', 'PAC did not confirm an empty isolated authentication profile list.');
    const input = path.join(run, 'corpus.fx');
    const probes = CORPUS.map((row) => ({
      id: `${row.id}-kind`,
      expression: `IfError(Text(${row.expression}),Text(FirstError.Kind))`,
    }));
    const execution = [...CORPUS, ...probes];
    fs.writeFileSync(input, execution.map((row) => row.expression).join('\n') + '\n', 'utf8');
    const expected = parsePacResults(
      command(executable, ['power-fx', 'run', '--file', input, '--echo'], env, spawn),
      execution,
    );
    const evaluator = createPowerFxEvaluator();
    const cases = [];
    for (const [index, row] of CORPUS.entries()) {
      let actual;
      try {
        actual = { kind: 'value', value: (await evaluator.evaluate(row.expression)).value };
      } catch (error) {
        actual = { kind: 'error', message: error.message };
      }
      const reference = expected[index];
      let mirageProbe;
      if (reference.kind === 'error' && actual.kind === 'error') {
        try {
          mirageProbe = { kind: 'value', value: (await evaluator.evaluate(probes[index].expression)).value };
        } catch (error) {
          mirageProbe = { kind: 'error', message: error.message };
        }
      }
      const result = compareResults(reference, actual, expected[CORPUS.length + index], mirageProbe);
      cases.push({
        ...row,
        pac: reference,
        mirage: actual,
        outcome:
          row.hostDifference && result === 'difference' && reference.kind === 'value' && actual.kind === 'value'
            ? 'host-difference'
            : result,
      });
    }
    return {
      ok: cases.every((row) => row.outcome === 'match' || row.outcome === 'host-difference'),
      pacVersion: version,
      culture: 'en-US for culture-sensitive cases',
      timezone: 'date-only cases',
      cases,
    };
  } finally {
    fs.rmSync(run, { recursive: true, force: true });
  }
}
