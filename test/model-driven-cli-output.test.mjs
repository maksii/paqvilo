// @test-kind contract: the terminal output of model-driven inspect and of a dev start is Paqvilo's own designed CLI contract, checked on invented sources.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import run from '../lense/commands/model-driven.mjs';
import { startupProgress } from '../lense/startup-progress.mjs';
import { modelDrivenFixture } from '../mirage/test/model-driven-fixture.mjs';
import { captureConsoleOutput } from './helpers/mirage-session-doubles.mjs';

async function project(t) {
  const fx = await modelDrivenFixture(t, { defer: true });
  await fs.mkdir(path.join(fx.solutionDir, 'WebResources'), { recursive: true });
  await fs.writeFile(
    path.join(fx.solutionDir, 'WebResources/x_script.js.data.xml'),
    '<WebResource><Name>x_script.js</Name><WebResourceType>3</WebResourceType><FileName>WebResources/x_script.js</FileName></WebResource>',
  );
  await fs.writeFile(path.join(fx.solutionDir, 'WebResources/x_script.js'), 'window.local = true;');
  const file = path.join(fx.root, 'project.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 2,
      runtime: { kind: 'model-driven' },
      solutions: [{ id: 'invented', path: fx.solutionDir }],
      references: [{ id: 'local', origin: 'http://127.0.0.1:1234' }],
      modelDriven: { targets: [{ reference: 'local' }], trustedExtensions: true },
    }),
  );
  return file;
}

test('model-driven inspect prints a readable summary as text and the report only with --json', async (t) => {
  const file = await project(t);
  const text = captureConsoleOutput();
  try {
    assert.equal(await run({}, { project: file }, ['inspect']), 0);
  } finally {
    text.restore();
  }
  const printed = text.output.logs.join('\n');
  assert.match(printed, /^\d+ declared Solution resources; \d+ require exact native resource mappings\./);
  assert.match(printed, /^Target: local http:\/\/127\.0\.0\.1:1234 \(1 declared\)$/m);
  assert.match(printed, /^Use --json for the full report\.$/m);
  assert.doesNotMatch(printed, /[{}]/, 'text mode prints no JSON');
  const json = captureConsoleOutput();
  try {
    assert.equal(await run({}, { project: file, json: true }, ['inspect']), 0);
  } finally {
    json.restore();
  }
  assert.equal(json.output.logs.length, 1);
  assert.equal(JSON.parse(json.output.logs[0]).selectedTarget, 'local');
});

test('model-driven dev prints the configuration start-up phase once', async (t) => {
  const file = await project(t);
  const lines = [];
  const startup = startupProgress({ write: (line) => lines.push(line) });
  // The stub has no browser context, so the start ends after browser setup; the phases printed until then are asserted.
  const open = async () => ({
    context: null,
    attached: false,
    debugPort: null,
    profile: { kind: 'named', name: 'invented' },
    close: async () => {},
  });
  const output = captureConsoleOutput();
  try {
    await assert.rejects(run({}, { project: file, startup }, ['dev'], { open }));
  } finally {
    output.restore();
    startup.close();
  }
  const phases = lines.filter((line) => line.startsWith('startup     ')).map((line) => line.split(' (')[0]);
  assert.equal(phases.filter((line) => line === 'startup     configuration').length, 1, JSON.stringify(phases));
  assert.ok(phases.includes('startup     browser setup'), JSON.stringify(phases));
});

test('lense model-driven without an action or --project names the default action and the valid ones in one line', async () => {
  const { execFile } = await import('node:child_process');
  const bin = path.resolve(import.meta.dirname, '../bin/paqvilo.mjs');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
  const result = await new Promise((resolve) =>
    execFile(
      process.execPath,
      [bin, 'lense', 'model-driven'],
      { env, encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }),
    ),
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trimEnd().split('\n').length, 1, result.stderr);
  assert.match(result.stderr, /model-driven dev requires --project <file>.*actions: inspect, dev \(default: dev\)/);
});
