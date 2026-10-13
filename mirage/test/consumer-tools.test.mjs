import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveReportInputs, bootstrapReport } from '../bootstrap-report.mjs';
import { resolveTarget } from '../render-sweep.mjs';
import { TOOL_OPTIONS, parseToolArgs } from '../tool-options.mjs';
import { MIRAGE_TOOLS } from '../tool-registry.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-tool-project-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'portal/web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n',
    'portal/web-pages/home/Home.webpage.copy.html': '<html><head></head><body><p>Fixture</p></body></html>',
    'solution/Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>Synthetic</UniqueName></SolutionManifest></ImportExportXml>',
    'solution/Entities/sample_item/Entity.xml': '<Entity><Name>sample_item</Name><EntityInfo><entity Name="sample_item"><attributes><attribute PhysicalName="sample_name"><Type>nvarchar</Type><LogicalName>sample_name</LogicalName></attribute></attributes></entity></EntityInfo></Entity>',
    'paqvilo.config.yml': 'sourceRoot: .\nsites:\n  synthetic:\n    source: portal\n    environments: { dev: https://synthetic.example.test }\n    mirage:\n      solutionRoots: [./solution]\n',
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), body);
  }
  return { root, config: path.join(root, 'paqvilo.config.yml') };
}

test('catalogue reports reuse their project cache and sweep selects the same project state', async t => {
  const { root, config } = await fixture(t);
  const input = await resolveReportInputs({ config, site: 'synthetic' });
  assert.equal(input.cacheFile, path.join(root, '.paqvilo/simulator/synthetic/cache/solution-sources.json'));
  const first = await bootstrapReport(input);
  const second = await bootstrapReport(await resolveReportInputs({ config, site: 'synthetic' }));
  assert.ok(first.summary.timings.cache.misses > 0);
  assert.ok(second.summary.timings.cache.hits > 0);
  assert.equal(second.summary.timings.cache.misses, 0);
  assert.deepEqual(second.tables, first.tables);
  const target = await resolveTarget({ config, site: 'synthetic' });
  assert.equal(target.stateFile, path.join(root, '.paqvilo/simulator/synthetic/state.json'));
  const uncached = await bootstrapReport(input, { noCache: true });
  assert.equal(uncached.summary.timings.cache.file, null);
  assert.equal(uncached.summary.timings.cache.hits, 0);
});

test('catalogue option tables produce registry help accepted by each parser and execute outside the project cwd', async t => {
  const { root, config } = await fixture(t);
  const bin = fileURLToPath(new URL('../../bin/paqvilo.mjs', import.meta.url));
  for (const [name, definitions] of Object.entries(TOOL_OPTIONS)) {
    const help = MIRAGE_TOOLS[name];
    for (const [key, definition] of Object.entries(definitions)) {
      if (key === 'help') continue;
      assert.ok(help.includes(`--${key}`), `${name}: ${key}`);
      const value = definition.label === 'SITE=ENV' ? 'synthetic=dev' : definition.label === 'PORTAL=NAME' ? 'synthetic=fixture' : 'fixture';
      assert.doesNotThrow(() => parseToolArgs(name, [`--${key}`, ...(definition.type === 'string' ? [value] : [])]));
    }
    const args = ['mirage', name, '--config', config, '--json'];
    if (name !== 'portal-matrix') args.push('--site', 'synthetic');
    if (name === 'portal-matrix') args.push('--only', 'import,bootstrap,liquid,webapi');
    const result = spawnSync(process.execPath, [bin, ...args], { cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(result.status, 0, `${name}: ${result.stdout}\n${result.stderr}`);
    assert.ok(JSON.parse(result.stdout));
  }
  assert.ok((await fs.readdir(path.join(root, '.paqvilo/portal-matrix'))).length);
});
