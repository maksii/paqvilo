import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { tempDir } from './fixture.mjs';

const helper = new URL('../mirage/testing/owned-fixture.mjs', import.meta.url).href;

for (const mode of [
  'removal-failure',
  'first-close-failure',
  'grouped-first-close-failure',
  'concurrent-first-close-failure',
  'diagnostic-failure',
]) {
  test(`fixture ownership drains actual loopback listeners after ${mode}`, { timeout: 10000 }, async (t) => {
    const directory = await tempDir('paqvilo-owner-lifecycle-');
    const state = path.join(directory, 'state');
    await fs.mkdir(state);
    ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
    const fixture = path.join(directory, 'fixture.test.mjs');
    await fs.writeFile(
      fixture,
      `
      import test from 'node:test';
      import http from 'node:http';
      import fs from 'node:fs/promises';
      import { ownedFixture, drainFixture } from ${JSON.stringify(helper)};
      test('owned listeners', async t => {
        const owner = ownedFixture(t);
        owner.remove(async () => {
          if (${JSON.stringify(mode)} === 'removal-failure') throw new Error('invented-removal-failure');
          await fs.rm(${JSON.stringify(state)}, { recursive: true, force: true });
        });
        if (${JSON.stringify(mode)} === 'diagnostic-failure') owner.add(() => { throw new Error('invented-diagnostic-failure'); });
        const grouped = [];
        let releaseFirst; const secondStarted = new Promise(resolve => { releaseFirst = resolve; });
        for (let index = 0; index < 2; index++) {
          const server = http.createServer((_request, response) => response.end('invented'));
          const close = async () => {
            if (${JSON.stringify(mode)} === 'concurrent-first-close-failure') { if (index === 0) await secondStarted; else releaseFirst(); }
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            console.log('owned-listener-closed:' + index);
            if (index === 0 && ${JSON.stringify(mode)}.endsWith('first-close-failure')) throw new Error('invented-close-failure');
          };
          if (['grouped-first-close-failure','concurrent-first-close-failure'].includes(${JSON.stringify(mode)})) grouped.push(close); else owner.add(close);
          await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        }
        if (grouped.length) owner.add(() => drainFixture(grouped, { concurrent: ${JSON.stringify(mode)} === 'concurrent-first-close-failure' }));
      });
    `,
    );
    const child = spawn(process.execPath, ['--test', fixture], {
      windowsHide: true,
      signal: t.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')),
    });
    let output = '';
    const collect = (chunk) => {
      output = (output + chunk).slice(-12000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const closed = new Promise((resolve) => child.once('close', resolve));
    ownedFixture(t).add(async () => {
      if (!child.killed && child.exitCode === null && child.signalCode === null) assert.ok(child.kill());
      await closed;
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 1, output);
    assert.match(output, /owned-listener-closed:0/);
    assert.match(output, /owned-listener-closed:1/);
    assert.match(
      output,
      mode === 'removal-failure'
        ? /invented-removal-failure/
        : mode === 'diagnostic-failure'
          ? /invented-diagnostic-failure/
          : /invented-close-failure/,
    );
    assert.equal((await fs.stat(state)).isDirectory(), true, 'failed cleanup retains state evidence');
  });
}
