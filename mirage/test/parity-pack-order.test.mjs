// @test-kind contract: explicitly registered pack callbacks retain their ordering relative to selected plan files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scenarioSources } from '../parity-suite.mjs';

test('pack matching completes before the next queued microtask can affect plan file selection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paqvilo-pack-order-'));
  try {
    let marked = false;
    const events = [];
    const pack = {
      id: 'invented',
      name: 'Invented',
      description: 'Local fixture',
      presets: () => ({}),
      matches: () => {
        events.push('matches');
        queueMicrotask(() => {
          marked = true;
          events.push('marker');
        });
        return false;
      },
    };
    const files = [null];
    Object.defineProperty(files, 0, {
      get() {
        events.push(`file:${marked}`);
        return marked ? 'later.json' : 'original.json';
      },
    });
    const sources = await scenarioSources({
      core: false,
      packs: 'auto',
      packsRoot: root,
      boundPacks: [pack],
      portal: {},
      files,
    });
    assert.equal(path.basename(sources[0].file), 'original.json');
    assert.deepEqual(events, ['matches', 'file:false', 'marker']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
