// @test-kind tooling: the write recorder attributes file-system writes to the recorded command, so a test that asserts "this command leaves a folder untouched" is not failed by another process writing there (test/helpers/write-recorder.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boundedCommand } from './helpers/bounded-command.mjs';
import { writeRecorder } from './helpers/write-recorder.mjs';
import { tempDirSync } from './fixture.mjs';

function folder(t) {
  const directory = tempDirSync('paqvilo-write-recorder-test-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const script = (t, recorder, code, args) =>
  boundedCommand(t, process.execPath, ['--input-type=module', '-e', code, ...args], { env: recorder.env() });

test('every way a command writes inside a watched folder is recorded', async (t) => {
  const watched = folder(t);
  const recorder = writeRecorder(t, [watched]);
  const result = await script(
    t,
    recorder,
    `import fs, { writeFileSync } from 'node:fs';
     import { mkdir, writeFile } from 'node:fs/promises';
     import path from 'node:path';
     const at = (name) => path.join(process.argv[1], name);
     writeFileSync(at('sync.txt'), 'a');
     await mkdir(at('made'), { recursive: true });
     await writeFile(at('promised.txt'), 'b');
     fs.renameSync(at('sync.txt'), at('renamed.txt'));
     await new Promise((done) => fs.createWriteStream(at('stream.txt')).end('c', done));
     fs.closeSync(fs.openSync(at('opened.txt'), 'w'));
     fs.rmSync(at('promised.txt'));`,
    [watched],
  );
  assert.equal(result.status, 0, result.stderr);
  const seen = recorder.writes().map(({ operation, file }) => `${operation} ${path.basename(file)}`);
  for (const expected of [
    'writeFile sync.txt',
    'mkdir made',
    'writeFile promised.txt',
    'rename renamed.txt',
    'createWriteStream stream.txt',
    'open opened.txt',
    'rm promised.txt',
  ])
    assert.ok(seen.includes(expected), `${expected} in ${JSON.stringify(seen)}`);
});

test('reads, writes elsewhere and the writes of another process are not recorded', async (t) => {
  const watched = folder(t);
  const elsewhere = folder(t);
  fs.writeFileSync(path.join(watched, 'existing.txt'), 'x');
  const recorder = writeRecorder(t, [watched]);
  // Another process (here the test itself, standing in for a validation lane) creates a folder while the command runs.
  fs.mkdirSync(path.join(watched, 'lane-output'));
  const result = await script(
    t,
    recorder,
    `import fs from 'node:fs';
     import path from 'node:path';
     fs.readFileSync(path.join(process.argv[1], 'existing.txt'), 'utf8');
     fs.readdirSync(process.argv[1]);
     fs.closeSync(fs.openSync(path.join(process.argv[1], 'existing.txt'), 'r'));
     fs.writeFileSync(path.join(process.argv[2], 'outside.txt'), 'y');`,
    [watched, elsewhere],
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(elsewhere, 'outside.txt')));
  assert.deepEqual(recorder.writes(), []);
});
