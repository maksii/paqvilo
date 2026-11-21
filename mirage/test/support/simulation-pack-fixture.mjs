// A Power Pages simulator over the deployment-profile fixture with invented Solution and pack files written into it.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSimulator } from '../../api.mjs';
import { profileFixture } from '../fixtures/deployment-profiles.mjs';
import { ownedFixture } from '../../testing/owned-fixture.mjs';

/** The exported x_item table both pack fixtures own through `pack/data.json`. */
export const ITEM_ENTITY =
  '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>';

/** Writes `files` (path relative to the fixture root: text) and starts a simulator that loads `pack/pack.mjs`. */
export async function startPackSimulator(t, files, options = {}) {
  // The profile fixture removes its directory only after the runtime below has closed.
  const fixture = await profileFixture({ after: (fn) => ownedFixture(t).remove(fn) });
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(fixture.root, name)), { recursive: true });
    await fs.writeFile(path.join(fixture.root, name), text);
  }
  const sim = await createSimulator({
    sourceDir: fixture.sourceDir,
    solutionRoots: fixture.solutionRoots,
    projectRoot: fixture.root,
    deploymentProfiles: fixture.deploymentProfiles,
    stateFile: fixture.stateFile,
    port: 0,
    watch: false,
    packs: [path.join(fixture.root, 'pack', 'pack.mjs')],
    ...options,
  });
  ownedFixture(t).add(() => sim.close());
  return { sim, fixture };
}
