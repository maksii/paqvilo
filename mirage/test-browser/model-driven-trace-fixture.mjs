import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';
import { writeFiles } from '../test/support/trace-staff-hosts.mjs';

// Writes the invented solution, starts a model-driven simulator over it at summary tracing and opens the record page of
// item in a page from chrome. The simulator and the workspace close with the test. Resolves to the simulator, the page,
// the page errors so far and the shell's answer.
export async function openModelDrivenRecord(t, chrome, { tempPrefix, solution, item }) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), tempPrefix));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  await writeFiles(path.join(root, 'solution'), solution);
  const sim = await createSimulator({
    runtime: { kind: 'model-driven' },
    solutionRoots: [path.join(root, 'solution')],
    projectRoot: root,
    port: 0,
    watch: false,
    simulation: { level: 'dry-run' },
    initial: { tables: { x_item: [{ x_itemid: item, x_name: 'Copper' }] } },
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
    trace: { level: 'summary' },
  });
  ownedFixture(t).add(() => sim.close());
  const page = await chrome.page(t);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const response = await page.goto(sim.url + '/main.aspx?appname=x_trace&pagetype=entityrecord&etn=x_item&id=' + item);
  return { sim, page, errors, response };
}
