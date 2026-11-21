// @test-kind contract: model-driven dev names its browser profile the way portal dev does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import run from '../lense/commands/model-driven.mjs';
import { modelDrivenFixture } from '../mirage/test/model-driven-fixture.mjs';
import { captureConsoleOutput } from './helpers/mirage-session-doubles.mjs';

test('model-driven dev prints the browser and profile it opened', async (t) => {
  const fx = await modelDrivenFixture(t, { defer: true });
  const project = path.join(fx.root, 'project.json');
  await fs.writeFile(
    project,
    JSON.stringify({
      version: 2,
      runtime: { kind: 'model-driven' },
      solutions: [{ id: 'invented', path: fx.solutionDir }],
      references: [{ id: 'local', origin: 'http://127.0.0.1:1234' }],
      modelDriven: { targets: [{ reference: 'local' }], trustedExtensions: true },
    }),
  );
  const startup = { phase() {}, complete() {}, fail() {}, close() {} };
  // The stub has no browser context, so the session ends right after opening; only the line printed on open is asserted.
  const open = async () => ({
    context: null,
    attached: false,
    debugPort: null,
    profile: { kind: 'named', name: 'invented-profile', profileDirectory: null },
    close: async () => {},
  });
  const { output, restore } = captureConsoleOutput();
  try {
    await assert.rejects(run({}, { project, startup }, ['dev'], { open }));
  } finally {
    restore();
  }
  assert.ok(
    output.logs.some((line) => /^browser {5}\S+; toolkit profile invented-profile$/.test(line)),
    JSON.stringify(output.logs),
  );
});
