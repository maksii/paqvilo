import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runMirageReplayShards } from '../portal-harness/mirage-replay-shards.mjs';
import { replayCellShard } from '../portal-harness/mirage-campaign-replay.mjs';
test('actual process workers own separate cell/cache/receipt namespaces and unqualified evidence stays unqualified', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-sharded-replay-'));
  try {
    const module = new URL('../portal-harness/mirage-campaign-replay.mjs', import.meta.url).href,
      script = path.join(directory, 'fixture.mjs');
    await fs.writeFile(
      script,
      `import fs from'node:fs/promises';import{runMirageReplayCampaign}from${JSON.stringify(module)};const job=JSON.parse(await fs.readFile(process.argv[2]));const summary=await runMirageReplayCampaign(job,{replay:async()=>({physicalReads:1,qualifiedReads:0,allQualified:false})});console.log(JSON.stringify(summary));`,
    );
    const fixture = path.join(directory, 'fixture.json');
    await fs.writeFile(fixture, '{}');
    const spec = { file: fixture, sha256: createHash('sha256').update('{}').digest('hex') },
      inputs = Object.fromEntries(
        [
          'schema',
          'catalogue',
          'observed',
          'serviceProfiles',
          'assemblyReceipt',
          'snapshotBefore',
          'snapshotAfter',
          'capture',
          'registrationBefore',
          'registrationAfter',
          'siteBefore',
          'siteAfter',
        ].map((key) => [key, spec]),
      );
    // Eight cells hash onto all four shards, so every worker owns real work.
    const workers = 4,
      cells = Array.from({ length: 8 }, (_, index) => ({ id: 'cell-' + index, inputs: {} })),
      job = {
        schemaVersion: 1,
        inputs,
        cells,
        outputRoot: path.join(directory, 'results'),
        cacheRoot: path.join(directory, 'cache'),
      },
      pids = [];
    assert.equal(new Set(cells.map((cell) => replayCellShard(cell.id, workers))).size, workers);
    const runWorker = (jobFile) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, jobFile], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          }),
          started = Date.now();
        let out = '',
          err = '';
        child.stdout.on('data', (chunk) => {
          out += chunk;
        });
        child.stderr.on('data', (chunk) => {
          err += chunk;
        });
        child.on('error', reject);
        child.on('exit', (code) => {
          if (code !== 0) reject(new Error(err));
          else {
            pids.push(child.pid);
            resolve({ pid: child.pid, durationMs: Date.now() - started, summary: JSON.parse(out) });
          }
        });
      });
    const result = await runMirageReplayShards(job, { workers, runWorker });
    assert.equal(new Set(pids).size, workers);
    assert.equal(result.processes, workers);
    assert.equal(result.cells, 8);
    assert.equal(result.physicalReads, 8);
    assert.equal(result.qualified, 0);
    assert.equal(result.allQualified, false);
    const receipt = JSON.parse(await fs.readFile(result.receiptFile));
    assert.equal(receipt.workers.length, workers);
    assert.deepEqual(receipt.cells.map((cell) => cell.id).sort(), cells.map((cell) => cell.id).sort());
    for (const cell of receipt.cells) assert.equal(cell.shard, replayCellShard(cell.id, workers));
    assert.equal(new Set(receipt.workers.map((row) => path.dirname(row.ledgerFile))).size, workers);
    const ledger = JSON.parse(
      await fs.readFile(receipt.workers.find((row) => row.index === receipt.cells[0].shard).ledgerFile),
    );
    await fs.appendFile(ledger.cells[0].resultFile, 'corrupt');
    await assert.rejects(runMirageReplayShards(job, { workers, runWorker }), /Parallel replay failed/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});
