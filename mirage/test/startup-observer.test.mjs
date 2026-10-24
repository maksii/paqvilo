import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performanceFixture } from './runtime-performance-fixture.mjs';
import { withProcessSlot } from './process-slots.mjs';

test('startup observers cannot reject or delay portal, model-driven or API runtime startup', { timeout: 30000 }, async t => {
  const fixture = await performanceFixture({ tables: 1, columns: 2, records: 1 });
  t.after(fixture.cleanup);
  // Each runtime starts in its own child, so the three run concurrently.
  await Promise.all(['power-pages', 'model-driven', 'dataverse-api'].map(async kind => {
    // Keep the rejection audit in a child: an unhandled rejection must fail the
    // contract without crashing the test runner or leaving an owned listener.
    const code = `
      import assert from 'node:assert/strict';
      const { createSimulator } = await import(${JSON.stringify(new URL('../server.mjs', import.meta.url).href)});
      const options = JSON.parse(process.argv[1]), unhandled = [], phases = [], modes = new Set();
      process.on('unhandledRejection', error => unhandled.push(error.message));
      const sim = await createSimulator({ ...options, onStartup(event) {
        const mode = phases.length % 4; phases.push(event.phase); modes.add(mode);
        if (mode === 0) return new Promise(() => {});
        if (mode === 1) throw Error('Invented synchronous observer failure');
        if (mode === 2) return Promise.reject(Error('Invented asynchronous observer failure'));
        return { then(_resolve, reject) { reject(Error('Invented thenable observer failure')); } };
      } });
      try {
        assert.equal((await fetch(sim.url + '/_sim/api/status')).status, 200);
        assert.equal(phases.at(-1), 'listener-ready');
        assert.equal(modes.size, 4);
      } finally { await sim.close(); }
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
      console.log(JSON.stringify({ kind: options.runtime.kind, phases, unhandled }));
    `;
    const options = { runtime: { kind }, ...(kind === 'power-pages' ? { sourceDir: fixture.sourceDir } : {}),
      solutionRoots: fixture.solutionRoots, projectRoot: fixture.root, watch: false,
      dataverse: { enabled: kind === 'dataverse-api', tls: false, tds: { enabled: false } } };
    const { stdout } = await withProcessSlot(() => promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(options)],
      { windowsHide: true, timeout: 10000 }));
    const report = JSON.parse(stdout);
    assert.equal(report.kind, kind); assert.deepEqual(report.unhandled, []);
    assert.equal(report.phases.at(-1), 'listener-ready');
  }));
});
