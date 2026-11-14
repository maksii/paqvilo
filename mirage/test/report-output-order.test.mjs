// @test-kind security: report output protection evaluates the supplied source roots before later queued work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertReportOutput } from '../lib/report-output.mjs';

test('source-root protection is evaluated without an extra input-filter microtask', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'paqvilo-report-order-'));
  try {
    let marked = false;
    const events = [];
    const inputFiles = [null];
    Object.defineProperty(inputFiles, 0, {
      get() {
        events.push('input');
        queueMicrotask(() => {
          marked = true;
          events.push('marker');
        });
        return null;
      },
    });
    const sourceRoots = [null];
    Object.defineProperty(sourceRoots, 0, {
      get() {
        events.push(`root:${marked}`);
        return marked ? path.join(directory, 'other') : directory;
      },
    });
    await assert.rejects(assertReportOutput(path.join(directory, 'report.json'), { inputFiles, sourceRoots }), {
      message: 'Report output must be outside portal and solution sources',
    });
    assert.deepEqual(events, ['input', 'root:false', 'marker']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
