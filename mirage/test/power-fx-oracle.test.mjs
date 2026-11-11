// @test-kind tooling: official-PAC invocation, isolated authentication checks and strict output decoding for the optional evidence runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CORPUS, compareResults, parsePacResults, runOracle } from '../test-support/power-fx-oracle.mjs';
import { makeTemporaryDirectorySync } from '../testing/owned-fixture.mjs';

const output = (expressions, value = '1') =>
  Buffer.concat([
    Buffer.from('PAC banner\r\n'),
    Buffer.from(expressions.map((expression) => `>> ${expression}\r\n${value}\r\n`).join('\r\n'), 'utf16le'),
  ]);
const fake =
  (auth = 'No profiles were found on this computer.') =>
  (exe, args, options) => {
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 45000);
    assert.equal(options.maxBuffer, 1024 * 1024);
    assert.ok(options.env.LOCALAPPDATA && options.env.APPDATA && options.env.USERPROFILE);
    if (!args.length) return { status: 0, stdout: Buffer.from('Version: 2.13.1\n') };
    if (args[0] === 'auth') return { status: 0, stdout: Buffer.from(auth) };
    return {
      status: 0,
      stdout: output(
        fs
          .readFileSync(args[args.indexOf('--file') + 1], 'utf8')
          .trim()
          .split('\n'),
      ),
    };
  };
async function fixture(t) {
  const root = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'paqvilo-oracle-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pac = path.join(root, 'pac.exe');
  fs.writeFileSync(pac, 'fixture');
  return { root, pac };
}
test('mixed-encoding PAC results preserve values and expression errors on exit zero', () => {
  const corpus = [
    { id: 'one', expression: '1+1' },
    { id: 'bad', expression: '1/0' },
  ];
  const bytes = Buffer.concat([
    Buffer.from('banner\r\n'),
    Buffer.from('>> 1+1\r\n2\r\n\r\n>> 1/0\r\n<Error: division by zero>\r\n', 'utf16le'),
  ]);
  assert.deepEqual(parsePacResults(bytes, corpus), [
    { kind: 'value', value: 2 },
    { kind: 'error', message: 'division by zero' },
  ]);
  assert.throws(() => parsePacResults(Buffer.from('>> 1+1\n2\n'), corpus), { code: 'PacOutputInvalid' });
  assert.throws(() => parsePacResults(Buffer.from('>> 1+1\n2\n<Error: hidden>\n>> 1/0\n3\n'), corpus), {
    code: 'PacOutputInvalid',
  });
});

test('PAC Power Fx string literals decode doubled quotes without treating backslashes as JSON escapes', () => {
  const corpus = [
    { id: 'quoted', expression: '"The ""quoted"" text"' },
    { id: 'slash', expression: '"a\\b"' },
  ];
  const bytes = Buffer.from('>> "The ""quoted"" text"\n"The ""quoted"" text"\n\n>> "a\\b"\n"a\\b"\n');
  assert.deepEqual(parsePacResults(bytes, corpus), [
    { kind: 'value', value: 'The "quoted" text' },
    { kind: 'value', value: 'a\\b' },
  ]);
  assert.throws(() => parsePacResults(Buffer.from('>> x\n"bad"quote"\n'), [{ id: 'bad', expression: 'x' }]), {
    code: 'PacOutputInvalid',
  });
});

test('PAC compile diagnostics are distinct from runtime errors and cannot qualify matching values', () => {
  const corpus = [
    { id: 'overflow', expression: 'IfError(1e400, 2)' },
    { id: 'next', expression: '1+1' },
  ];
  const bytes = Buffer.from(
    '>> IfError(1e400, 2)\nLine 1: Error 8-13: Numeric value is too large.\nLine 1: Error 0-7: Invalid arguments.\n\n>> 1+1\n2\n',
  );
  const rows = parsePacResults(bytes, corpus);
  assert.deepEqual(rows[0], {
    kind: 'compile-error',
    messages: ['Line 1: Error 8-13: Numeric value is too large.', 'Line 1: Error 0-7: Invalid arguments.'],
  });
  assert.equal(rows[1].kind, 'value');
  assert.equal(compareResults(rows[0], rows[0]), 'comparison-error');
  assert.equal(compareResults(rows[0], { kind: 'error', message: 'Numeric value is too large.' }), 'comparison-error');
});
test('oracle checks isolated auth before evaluating fixed corpus and reports differences', async (t) => {
  const { root, pac } = await fixture(t);
  const report = await runOracle({ root, pac, spawn: fake() });
  assert.equal(report.ok, false);
  assert.equal(report.cases.length, CORPUS.length);
  assert.equal(report.cases[0].outcome, 'host-difference');
  assert.ok(report.cases.some((row) => row.outcome === 'difference'));
  assert.deepEqual(fs.readdirSync(path.join(root, '.paqvilo', 'power-fx-oracle')), []);
});
test('oracle refuses ambiguous or nonempty profiles without running formulas', async (t) => {
  const { root, pac } = await fixture(t);
  let calls = 0;
  const spawn = (...args) => {
    calls++;
    return fake('Index Active\n 1 * profile')(...args);
  };
  await assert.rejects(runOracle({ root, pac, spawn }), { code: 'PacAuthNotEmpty' });
  assert.equal(calls, 2);
});
test('oracle reports timeout and unavailable PAC explicitly', async (t) => {
  const { root, pac } = await fixture(t);
  await assert.rejects(
    runOracle({ root, pac, spawn: () => ({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }) }),
    { code: 'PacTimeout' },
  );
  await assert.rejects(runOracle({ root, pac: path.join(root, 'missing.exe') }), { code: 'PacUnavailable' });
  await assert.rejects(runOracle({ root, pac, spawn: () => ({ status: 1, stdout: Buffer.from('<Error: fake>') }) }), {
    code: 'PacProcessFailed',
  });
});

test('error comparisons require matching numeric kinds, never just messages or syntax failures', () => {
  const error = () => ({ kind: 'error', message: 'anything' });
  const probe = (value) => ({ kind: 'value', value });
  assert.equal(compareResults(error(), error(), probe('13'), probe('25')), 'difference');
  assert.equal(compareResults(error(), error(), probe('13'), probe('13')), 'match');
  assert.equal(compareResults(error(), error(), error(), error()), 'comparison-error');
  assert.equal(compareResults(error(), error(), probe('syntax error'), probe('13')), 'comparison-error');
});

test('PAC syntax failure in kind probe cannot pass as the same runtime error', async (t) => {
  const { root, pac } = await fixture(t);
  const spawn = (exe, args, options) => {
    if (args[0] !== 'power-fx') return fake()(exe, args, options);
    const expressions = fs
      .readFileSync(args[args.indexOf('--file') + 1], 'utf8')
      .trim()
      .split('\n');
    const text = expressions
      .map((expression) => {
        const explicit = expression.includes('Error({Kind: ErrorKind.Div0');
        return `>> ${expression}\r\n${explicit ? '<Error: syntax error>' : '1'}\r\n`;
      })
      .join('\r\n');
    return { status: 0, stdout: Buffer.from(text, 'utf16le') };
  };
  const report = await runOracle({ root, pac, spawn });
  assert.equal(report.ok, false);
  assert.equal(report.cases.find((row) => row.id === 'explicit-error').outcome, 'comparison-error');
});

test('PAC error preambles fail even when all echoed results follow', () => {
  const corpus = [{ id: 'one', expression: '1+1' }];
  for (const line of ['<Error: invalid>', 'Error: invalid', 'Error 3:4: invalid']) {
    assert.throws(() => parsePacResults(Buffer.from(`${line}\n>> 1+1\n2\n`), corpus), { code: 'PacOutputInvalid' });
  }
  assert.deepEqual(parsePacResults(Buffer.from('Microsoft banner mentions errors\n>> 1+1\n2\n'), corpus), [
    { kind: 'value', value: 2 },
  ]);
});

test('PAC numeric parsing preserves exact digits and recognizes Blank()', () => {
  const corpus = [
    { id: 'large', expression: 'x' },
    { id: 'blank', expression: 'y' },
  ];
  const [large, blank] = parsePacResults(Buffer.from('>> x\n9007199254740993\n>> y\nBlank()\n'), corpus);
  assert.equal(large.value.value, '9007199254740993');
  assert.equal(blank.value, null);
  assert.equal(compareResults(large, { kind: 'value', value: 9007199254740992 }), 'difference');
  assert.equal(
    compareResults(large, {
      kind: 'value',
      value: { $type: 'DataverseNumeric', numericType: 'Decimal', value: '9007199254740993' },
    }),
    'match',
  );
});

test('scientific PAC numeric output is parsed without double rounding', () => {
  const [result] = parsePacResults(Buffer.from('>> x\n1E+100\n'), [{ id: 'float', expression: 'x' }]);
  assert.equal(compareResults(result, { kind: 'value', value: 1e100 }), 'match');
  assert.throws(() => parsePacResults(Buffer.from('>> x\n1E+999\n'), [{ id: 'float', expression: 'x' }]), {
    code: 'PacOutputInvalid',
  });
});
