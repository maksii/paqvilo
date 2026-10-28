import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startCodeApp } from './code-app-process.mjs';
import { makeTemporaryDirectory } from 'paqvilo/mirage/testing/owned-fixture.mjs';

test(
  'missing or failed app startup rejects promptly and drains an already-exited child',
  { timeout: 5000 },
  async (t) => {
    const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'code-app-startup-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await assert.rejects(startCodeApp(t, {}, { script: path.join(directory, 'missing.mjs') }), { code: 'ENOENT' });
    const script = path.join(directory, 'failed.mjs');
    await fs.writeFile(script, 'process.exit(7);');
    await assert.rejects(startCodeApp(t, {}, { script }), /exited before startup \(7\)/);
  },
);
