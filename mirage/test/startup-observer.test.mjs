import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulator } from '../server.mjs';
import { performanceFixture } from './runtime-performance-fixture.mjs';

test('startup observers cannot reject or delay portal, model-driven or API runtime startup', async (t) => {
  const fixture = await performanceFixture({ tables: 1, columns: 2, records: 1 });
  t.after(fixture.cleanup);
  // An observer rejection the runtime leaves unhandled is reported here; node:test would also fail the file.
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error?.message ?? String(error));
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  // The three runtimes start concurrently in this process; each observer cycles through every failure mode.
  const reports = await Promise.all(
    ['power-pages', 'model-driven', 'dataverse-api'].map(async (kind) => {
      const phases = [],
        modes = new Set();
      const sim = await createSimulator({
        runtime: { kind },
        ...(kind === 'power-pages' ? { sourceDir: fixture.sourceDir } : {}),
        solutionRoots: fixture.solutionRoots,
        projectRoot: fixture.root,
        watch: false,
        dataverse: { enabled: kind === 'dataverse-api', tls: false, tds: { enabled: false } },
        onStartup(event) {
          const mode = phases.length % 4;
          phases.push(event.phase);
          modes.add(mode);
          if (mode === 0) return new Promise(() => {});
          if (mode === 1) throw Error('Invented synchronous observer failure');
          if (mode === 2) return Promise.reject(Error('Invented asynchronous observer failure'));
          return {
            then(_resolve, reject) {
              reject(Error('Invented thenable observer failure'));
            },
          };
        },
      });
      try {
        assert.equal((await fetch(sim.url + '/_sim/api/status')).status, 200);
      } finally {
        await sim.close();
      }
      return { kind, phases, modes };
    }),
  );
  // Rejections are reported after the microtask queue drains; one macrotask turn covers the last observer call.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
  for (const report of reports) {
    assert.equal(report.phases.at(-1), 'listener-ready', report.kind);
    assert.equal(report.modes.size, 4, report.kind);
  }
});
