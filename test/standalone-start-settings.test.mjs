import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile),
  cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));

test(
  'standalone reuse retains effective platform and managed-identity settings in its launch identity',
  { timeout: 120000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-start-settings-'));
    const project = path.join(root, 'project.json');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
    const run = async (action) =>
      JSON.parse(
        (
          await execute(process.execPath, [cli, 'mirage', action, '--project', project, '--port', '0', '--json'], {
            cwd: root,
            env,
            windowsHide: true,
            timeout: 30000,
          })
        ).stdout,
      );
    t.after(async () => {
      try {
        await run('stop');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
    const write = (limit, mode) =>
      fs.writeFile(
        project,
        JSON.stringify({
          version: 2,
          runtime: { kind: 'dataverse-api' },
          simulation: { level: 'dry-run' },
          solutions: [],
          platform: { QueryLinkEntityLimit: limit, evidence: 'Invented settings-reuse regression' },
          dataverse: { tls: false, tds: { enabled: false }, managedIdentity: { mode } },
        }),
      );
    const status = async (session) => await (await fetch(session.url + '/_sim/api/status')).json();
    await write(1, 'imds');
    const first = await run('start'),
      reused = await run('start');
    assert.equal(reused.started, false);
    assert.equal(reused.pid, first.pid);
    await write(50, 'imds');
    const changedPlatform = await run('start');
    assert.equal(changedPlatform.started, true);
    assert.notEqual(changedPlatform.pid, first.pid);
    assert.equal(
      (await status(changedPlatform)).platformSettings.find((item) => item.key === 'QueryLinkEntityLimit').value,
      50,
    );
    assert.equal((await status(first)).platformSettings.find((item) => item.key === 'QueryLinkEntityLimit').value, 1);
    await write(50, 'appservice');
    const changedIdentity = await run('start');
    assert.equal(changedIdentity.started, true);
    assert.notEqual(changedIdentity.pid, changedPlatform.pid);
    assert.equal((await status(changedIdentity)).dataverse.managedIdentity.mode, 'appservice');
    assert.equal((await status(changedPlatform)).dataverse.managedIdentity.mode, 'imds');
  },
);
