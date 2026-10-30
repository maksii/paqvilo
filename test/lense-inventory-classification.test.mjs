import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { importModelDrivenProject } from '../lense/model-driven.mjs';
import { writeSolutionAssetEntries } from '../mirage/lib/dataverse-solution-assets.mjs';
import { tempDirSync } from './fixture.mjs';
import { settledClockEnv } from '../mirage/test/support/file-times.mjs';

const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
const runIn = (env, ...args) =>
  spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
    env,
  });
const run = (...args) => runIn(environment, ...args);
// A reuse assertion about fixtures written moments ago runs the CLI with its clock past the racy window.
const runSettled = (...args) => runIn(settledClockEnv(environment), ...args);

function fixture(t) {
  const root = tempDirSync('lense-inventory-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    'portal/website.yml': 'adx_websiteid: site\nadx_name: Invented',
    'portal/web-pages/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /',
    'portal/web-files/.keep': '',
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedLense</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Other/Customizations.xml':
      '<ImportExportXml><Entities/><Connectors><Connector><name>x_lenseconnector</name></Connector></Connectors></ImportExportXml>',
    'solution/CanvasApps/x_lenseapp_DocumentUri.msapp': writeSolutionAssetEntries([
      { name: 'Src/App.pa.yaml', data: Buffer.from('App:\n  Properties:\n    OnStart: =1\n') },
    ]),
  };
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  const catalogue = (mirage) => {
    const file = path.join(root, 'catalogue.yml');
    fs.writeFileSync(
      file,
      YAML.stringify({
        sourceRoot: root,
        sites: {
          invented: {
            source: 'portal',
            environments: { local: 'http://127.0.0.1:8787' },
            ...(mirage ? { mirage } : {}),
          },
        },
      }),
    );
    return file;
  };
  return { root, catalogue };
}

test('lense list reuses the Solution cache, so a second run parses nothing that did not change', (t) => {
  const { root, catalogue } = fixture(t);
  const config = catalogue({ solutionRoots: ['solution'] });
  const inventoryOf = () =>
    JSON.parse(runSettled('lense', 'list', '--json', '--config', config).stdout).sites.find(
      (item) => item.name === 'invented',
    ).inventory;
  const first = inventoryOf();
  assert.ok(first.cache.misses > 0, JSON.stringify(first));
  assert.ok(fs.existsSync(path.join(root, '.paqvilo', 'simulator', 'cache', 'solution-discovery.json')));
  const second = inventoryOf();
  assert.equal(second.cache.misses, 0, JSON.stringify(second));
  assert.ok(second.cache.hits > 0, JSON.stringify(second));
  assert.deepEqual(second.counts, first.counts);
});

test('lense list shows Solution inventory kinds with counts, and strict audit is unaffected by them', async (t) => {
  const { root, catalogue } = fixture(t);
  const baseline = JSON.parse(run('lense', 'audit', '--strict', '--json', '--config', catalogue(null)).stdout);
  const config = catalogue({ solutionRoots: ['solution'] });
  const listed = JSON.parse(run('lense', 'list', '--json', '--config', config).stdout);
  const site = listed.sites.find((item) => item.name === 'invented');
  assert.equal(site.inventory.level, 'inventory');
  assert.deepEqual(site.inventory.counts, { canvasapp: { inventory: 1 }, connector: { inventory: 1 } });
  const audited = JSON.parse(run('lense', 'audit', '--strict', '--json', '--config', config).stdout);
  assert.equal(audited.complete, baseline.complete);
  assert.equal(audited.ok, baseline.ok);
  assert.ok(baseline.reports[0].totals, JSON.stringify(baseline));
  assert.deepEqual(audited.reports[0].totals, baseline.reports[0].totals);
  assert.ok(!JSON.stringify(audited).includes('x_lenseapp'), 'inventory never appears as audited coverage');

  const project = await importModelDrivenProject({
    solutionRoots: [path.join(root, 'solution')],
    solutionOrder: 'explicit',
  });
  assert.deepEqual(project.inventoryCounts, { canvasapp: { inventory: 1 }, connector: { inventory: 1 } });
  assert.ok(project.resources.every((resource) => !/msapp/i.test(resource.name)));
});
