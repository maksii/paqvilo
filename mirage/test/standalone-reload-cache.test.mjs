import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { SolutionFileCache } from '../lib/solution-cache.mjs';

const entity = (name, label) => `<Entity><Name>${name}</Name><EntityInfo><entity Name="${name}"><LocalizedNames><LocalizedName description="${label}" languagecode="1033"/></LocalizedNames><EntitySetName>${name}s</EntitySetName><PrimaryIdAttribute>${name}id</PrimaryIdAttribute><PrimaryNameAttribute>${name}_name</PrimaryNameAttribute><attributes><attribute PhysicalName="${name}id"><Name>${name}id</Name><Type>primarykey</Type></attribute><attribute PhysicalName="${name}_name"><Name>${name}_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>`;

test('a source save then reload refreshes the standalone Solution with the cache, parsing only the changed file', { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-standalone-reload-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const solution = path.join(root, 'solution');
  const files = {
    'Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedReloadCache</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'Entities/x_alpha/Entity.xml': entity('x_alpha', 'Alpha'),
    'Entities/x_beta/Entity.xml': entity('x_beta', 'Beta'),
    'Entities/x_gamma/Entity.xml': entity('x_gamma', 'Gamma'),
  };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(solution, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const cacheFile = path.join(root, 'state', 'cache', 'solution-sources.json');
  // A stateFile without a dry-run simulation keeps the solution cache on disk, as the startup load does.
  const sim = await createSimulator({ runtime: { kind: 'dataverse-api' }, solutionRoots: [solution], projectRoot: root,
    stateFile: path.join(root, 'state', 'state.json'), port: 0, watch: false,
    dataverse: { enabled: true, tls: false, tds: { enabled: false } } });
  t.after(() => sim.close());
  assert.ok((await fs.stat(cacheFile)).size > 0, 'startup writes the solution cache');

  // Count the parses that were not answered by the cache, from the first reload onward.
  const parse = SolutionFileCache.prototype.parse;
  const misses = [];
  t.mock.method(SolutionFileCache.prototype, 'parse', async function parseCounted(file, ...rest) {
    const result = await parse.call(this, file, ...rest);
    if (!result.cached) misses.push(file);
    return result;
  });
  const changed = await fs.realpath(path.join(solution, 'Entities', 'x_beta', 'Entity.xml'));
  await fs.writeFile(changed, entity('x_beta', 'Beta after save'));
  // Windows paths may differ in casing between the watcher and the scan, so compare normalised keys.
  const key = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  // The explicit reload is the watcher's reload without its debounce timer: it settles before it resolves.
  await sim.reload();
  assert.ok(misses.some(file => key(file) === key(changed)), 'the reload parses the changed Solution file');

  const reparsed = misses.filter(file => key(file) !== key(changed));
  assert.deepEqual(reparsed, [], 'unchanged Solution files are answered by the cache on reload');
});
