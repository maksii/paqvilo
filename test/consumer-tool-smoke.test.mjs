import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyConsumerToolOwnership } from '../scripts/consumer-tool-smoke.mjs';
import { makeTemporaryDirectorySync } from '../mirage/testing/owned-fixture.mjs';

function fixture(t, { externalState = false, secondState } = {}) {
  const root = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'paqvilo-consumer-ownership-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'physical project with a long name'),
    toolkit = path.join(root, 'toolkit');
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(toolkit, 'bin'), { recursive: true });
  if (externalState) {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(project, '.paqvilo'), process.platform === 'win32' ? 'junction' : 'dir');
  } else fs.mkdirSync(path.join(project, '.paqvilo'));
  const file = path.join(project, '.paqvilo', 'cache.json');
  fs.writeFileSync(file, '{}');
  let secondFile = file;
  if (secondState) {
    const directory = secondState === 'outside' ? path.join(root, 'outside') : path.join(project, '.paqvilo');
    fs.mkdirSync(directory, { recursive: true });
    secondFile = path.join(directory, 'other-cache.json');
    fs.writeFileSync(secondFile, '{}');
  }
  const bin = path.join(toolkit, 'bin', 'fixture.mjs');
  const reports = [file, secondFile].map((location) => ({
    summary: { timings: { cache: { file: location, hits: 1, misses: 0 }, solutionsMs: 0 } },
  }));
  const counter = path.join(root, 'report-counter');
  fs.writeFileSync(
    bin,
    `import fs from 'node:fs';const counter=${JSON.stringify(counter)};const count=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0;fs.writeFileSync(counter,String(count+1));console.log(JSON.stringify(${JSON.stringify(reports)}[count%2]));\n`,
  );
  return { root, project, bin };
}

test('consumer ownership accepts the same physical project through a real directory alias', (t) => {
  const { root, project, bin } = fixture(t);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.doesNotThrow(() => verifyConsumerToolOwnership(bin, alias));
  if (process.platform === 'win32') {
    const otherDriveCase = project[0].toLowerCase() + project.slice(1);
    assert.doesNotThrow(() => verifyConsumerToolOwnership(bin, otherDriveCase));
    const short = spawnSync(
      'cmd.exe',
      ['/d', '/v:off', '/s', '/c', '"for %I in ("%PAQ_CONSUMER_PROJECT%") do @echo %~sI"'],
      {
        encoding: 'utf8',
        windowsHide: true,
        windowsVerbatimArguments: true,
        env: { ...process.env, PAQ_CONSUMER_PROJECT: project },
      },
    );
    assert.equal(short.status, 0);
    assert.equal(fs.realpathSync.native(short.stdout.trim()), project);
    assert.doesNotThrow(() => verifyConsumerToolOwnership(bin, short.stdout.trim()));
    t.diagnostic(
      /~\d/.test(short.stdout)
        ? 'Verified an actual Windows 8.3 consumer project.'
        : 'The volume returned a long path; junction and drive-case identity checks still ran.',
    );
  }
});

test('consumer ownership rejects a lexical state child whose junction escapes the actual project', (t) => {
  const { project, bin } = fixture(t, { externalState: true });
  assert.throws(() => verifyConsumerToolOwnership(bin, project), /cache escaped the consumer project/);
});

test('consumer ownership rejects an escaped warm cache even when the cold report is owned', (t) => {
  const { project, bin } = fixture(t, { secondState: 'outside' });
  assert.throws(() => verifyConsumerToolOwnership(bin, project), /cache escaped the consumer project/);
});

test('cache hits cannot qualify reuse when the warm report switches to another owned cache file', (t) => {
  const { project, bin } = fixture(t, { secondState: 'different-owned' });
  assert.throws(() => verifyConsumerToolOwnership(bin, project), /same consumer cache file/);
});
