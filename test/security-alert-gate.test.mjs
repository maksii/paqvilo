import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/security.yml', import.meta.url), 'utf8'));
const step = workflow.jobs.gate.steps.find((row) => row.name === 'Require no open CodeQL findings');

test('security gate checks findings with read-only permissions after applicable analysis jobs', () => {
  assert.deepEqual(workflow.jobs.gate.permissions, { contents: 'read', 'security-events': 'read' });
  assert.ok(workflow.jobs.gate.needs.includes('codeql'));
  assert.equal(
    workflow.jobs.codeql.steps.find((row) => row.uses?.startsWith('github/codeql-action/analyze@')).with[
      'wait-for-processing'
    ],
    true,
  );
  assert.equal(step.if, "needs.changes.outputs.codeql == 'true'");
  assert.equal(step.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(
    workflow.jobs.gate.steps.some((row) => row.uses),
    false,
    'the token-bearing job never checks out untrusted sources',
  );
});

test('alert gate rejects findings, unavailable/malformed responses and missing ref; zero findings pass', (t) => {
  let bash = 'bash';
  if (process.platform === 'win32') {
    const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true });
    assert.equal(git.status, 0, git.stderr);
    bash = path.resolve(git.stdout.trim(), '../../..', 'bin/bash.exe');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-alert-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'gate.sh'),
    argsFile = path.join(dir, 'args.txt');
  // Intercept gh as a shell function: these are offline policy tests, never API calls.
  fs.writeFileSync(
    script,
    `gh() { printf '%s\\n' "$@" > "$CASE_ARGUMENT_FILE"; printf '%s' "$CASE_OUTPUT"; return "$CASE_STATUS"; }\n${step.run}`,
  );
  const run = (output, status = 0, ref = 'refs/pull/16/merge') => {
    const env = {
      ...process.env,
      GITHUB_REPOSITORY: 'invented/toolkit',
      GITHUB_REF: ref,
      CASE_ARGUMENT_FILE: argsFile.replaceAll('\\', '/'),
      CASE_OUTPUT: output,
      CASE_STATUS: String(status),
    };
    if (ref === null) delete env.GITHUB_REF;
    return spawnSync(bash, ['--noprofile', '--norc', script.replaceAll('\\', '/')], {
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
  };
  const clear = run('0');
  assert.ifError(clear.error);
  assert.equal(clear.status, 0, clear.stderr);
  const args = fs.readFileSync(argsFile, 'utf8').split('\n');
  for (const expected of [
    'api',
    '--method',
    'GET',
    'repos/invented/toolkit/code-scanning/alerts',
    'ref=refs/pull/16/merge',
    'state=open',
    'tool_name=CodeQL',
    'per_page=1',
  ])
    assert.ok(args.includes(expected), expected);
  assert.ok(
    args.some((arg) => arg.includes('type == "array"') && arg.includes('error(')),
    'non-array API responses are rejected by jq',
  );
  for (const output of ['1', '100', '', 'null', 'unexpected'])
    assert.notEqual(run(output).status, 0, `reject ${JSON.stringify(output)}`);
  assert.notEqual(run('0', 1).status, 0, 'API errors cannot masquerade as zero findings');
  assert.notEqual(run('0', 0, '').status, 0, 'an empty ref must not query the default branch');
  assert.notEqual(run('0', 0, null).status, 0, 'a missing ref cannot pass');
});
