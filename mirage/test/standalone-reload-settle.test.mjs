// Standalone reload settles backend work before it takes the host change queue: a pending job that itself calls the
// organization's change() completes, and so does the reload.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

test('a reload while a job that calls change() is pending completes', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'standalone-reload-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const solution = path.join(root, 'solution');
  await fs.mkdir(path.join(solution, 'Other'), { recursive: true });
  await fs.writeFile(
    path.join(solution, 'Other', 'Solution.xml'),
    '<ImportExportXml><SolutionManifest><UniqueName>InventedReload</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  );
  const sim = await createSimulator({
    runtime: { kind: 'dataverse-api' },
    solutionRoots: [solution],
    projectRoot: root,
    port: 0,
    watch: false,
    simulation: { level: 'dry-run' },
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
  });
  ownedFixture(t).add(() => sim.close());

  let ran = false;
  const reloading = sim.reload();
  // Queued after the reload asked for the host queue: the job's own change() must not wait behind a reload that waits on it.
  sim.store.scheduler.schedule(
    () =>
      sim.organization.change(async () => {
        ran = true;
      }),
    0,
    { name: 'invented-job' },
  );
  // A deadlock never settles and fails at the test timeout; a wall-clock race would also fail a slow, correct reload.
  await reloading;
  assert.equal(ran, true);
});
