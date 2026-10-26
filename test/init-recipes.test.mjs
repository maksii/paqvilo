import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareProject } from '../lense/project-scaffold.mjs';
import { loadCatalogue, loadConfig, resolveMirageConfig } from '../lense/config.mjs';
import { createMirageContext } from '../mirage/api.mjs';
import { tempDir } from './fixture.mjs';

const write = async (directory, file, text) => {
  await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
  await fs.writeFile(path.join(directory, file), text);
};
async function project(t) {
  const base = await tempDir('paqvilo-recipes-');
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const directory = path.join(base, 'project');
  await prepareProject(directory, { name: 'sample-data', packs: ['sample-data'], noVscode: true });
  // The optional example is copied beside the active catalogue before adapting it.
  const optional = await fs.readFile(path.join(directory, 'docs/configuration.example.yml'), 'utf8');
  await write(directory, 'fixture.config.yml', optional);
  return { base, directory, config: path.join(directory, 'fixture.config.yml') };
}

test('optional two-site recipe uses production schema and remains inactive with independent export/Solution/settings bases', async (t) => {
  const { base, directory, config } = await project(t);
  const active = loadCatalogue({ config: path.join(directory, 'paqvilo.config.yml') }, {});
  assert.deepEqual(Object.keys(active.sites), ['portal']);
  assert.equal(active.sourceRoot, path.join(directory, 'sources'));
  const catalogue = loadCatalogue({ config }, {});
  assert.deepEqual(Object.keys(catalogue.sites), ['customer', 'partner']);
  assert.equal(catalogue.sourceRoot, path.join(base, 'checkouts'));
  const customer = resolveMirageConfig(catalogue.sites.customer.mirage, {
    ...catalogue,
    sourceDir: catalogue.sites.customer.sourceDir,
  });
  const partner = resolveMirageConfig(catalogue.sites.partner.mirage, {
    ...catalogue,
    sourceDir: catalogue.sites.partner.sourceDir,
  });
  assert.deepEqual(
    customer.solutionRoots,
    ['Core', 'Feature'].map((name) => path.join(base, 'checkouts/solutions', name)),
  );
  assert.equal(customer.dataPacks[0].module, path.join(directory, 'pack/pack.mjs'));
  await fs.access(customer.dataPacks[0].module);
  assert.deepEqual(partner.dataPacks, [], 'site ownership is explicit rather than Cartesian in this optional recipe');
  for (const settings of [customer, partner]) {
    assert.deepEqual(settings.deploymentProfiles.profiles.local.environmentVariables, [
      path.join(base, 'checkouts/settings/local.json'),
    ]);
    assert.deepEqual(settings.deploymentProfiles.profiles.local.connectionReferences, [
      path.join(base, 'checkouts/settings/local.json'),
    ]);
    assert.equal(settings.deploymentProfiles.default, 'local');
    assert.equal(settings.confinePortalPages, true);
    assert.equal(settings.observed, null, 'an example must not invent observed platform evidence');
  }
  assert.equal(
    customer.deploymentProfiles.profiles.local.pages,
    path.join(base, 'checkouts/customer-export/deployment-profiles/local.yml'),
  );
  assert.equal(partner.deploymentProfiles.profiles.local.pages, undefined);
  const dev = await loadConfig({ config, site: 'customer', env: 'dev' }, {}, { checkSource: false });
  const production = await loadConfig({ config, site: 'customer', env: 'production' }, {}, { checkSource: false });
  assert.notEqual(dev.origin, production.origin);
  assert.deepEqual(dev.mirageConfig.deploymentProfiles, production.mirageConfig.deploymentProfiles);
});

test('recipe relocation and personal worktree overrides retain documented path bases and precedence', async (t) => {
  const { base, directory, config } = await project(t);
  const relocated = path.join(base, 'relocated/project');
  await fs.mkdir(relocated, { recursive: true });
  await fs.copyFile(config, path.join(relocated, 'fixture.config.yml'));
  const first = loadCatalogue({ config }, {}),
    second = loadCatalogue({ config: path.join(relocated, 'fixture.config.yml') }, {});
  assert.equal(path.relative(path.dirname(config), first.sourceRoot), path.relative(relocated, second.sourceRoot));
  await write(
    directory,
    'paqvilo.config.local.yml',
    'sourceRoot: ../personal-checkouts\nbrowser:\n  channel: chrome\n',
  );
  const local = loadCatalogue({ config }, {}),
    localConfig = await loadConfig({ config, site: 'customer' }, {}, { checkSource: false });
  assert.equal(local.sourceRoot, path.join(base, 'personal-checkouts'));
  assert.equal(localConfig.browser.channel, 'chrome');
  assert.equal(localConfig.mirageConfig.dataPacks[0].module, path.join(directory, 'pack/pack.mjs'));
  assert.equal(
    localConfig.mirageConfig.deploymentProfiles.profiles.local.pages,
    path.join(base, 'personal-checkouts/customer-export/deployment-profiles/local.yml'),
  );
  assert.deepEqual(localConfig.mirageConfig.deploymentProfiles.profiles.local.environmentVariables, [
    path.join(base, 'personal-checkouts/settings/local.json'),
  ]);
  await write(directory, '.env', 'PAQVILO_REPO=../dotenv-checkouts\nPAQVILO_BROWSER=chromium\n');
  const dotenv = loadCatalogue({ config }, {});
  assert.equal(dotenv.sourceRoot, path.join(base, 'dotenv-checkouts'));
  const shell = await loadConfig(
    { config, site: 'customer' },
    { PAQVILO_REPO: '../shell-checkouts', PAQVILO_BROWSER: 'msedge' },
    { checkSource: false },
  );
  assert.equal(shell.sourceRoot, path.join(base, 'shell-checkouts'));
  assert.equal(shell.browser.channel, 'msedge');
  const cli = await loadConfig(
    { config, site: 'customer', repo: path.join(base, 'cli-checkouts'), browser: 'chrome' },
    { PAQVILO_REPO: '../shell-checkouts', PAQVILO_BROWSER: 'msedge' },
    { checkSource: false },
  );
  assert.equal(cli.sourceRoot, path.join(base, 'cli-checkouts'));
  assert.equal(cli.browser.channel, 'chrome');
});

test('site-owned and shared pack matching keep positive/negative identity boundaries while source-free binding remains usable', async (t) => {
  const { base, directory, config } = await project(t);
  await write(
    directory,
    'pack/pack.mjs',
    `export default {
    id: 'sample-data', name: 'Owned fixture', description: 'Invented website-specific fixture',
    matches: ({ portal }) => portal?.website?.adx_websiteid === 'fixture-customer',
    presets: () => ({ 'sample-data-empty': { name: 'Owned empty fixture', tables: {} } }),
  };\n`,
  );
  // No exports, Solution roots or deployment files exist: source-free pack tests still bind.
  const sourceFree = await createMirageContext({ config });
  assert.deepEqual(
    sourceFree.packs.map((pack) => pack.id),
    ['sample-data'],
  );
  const empty = new sourceFree.DataStore();
  await empty.applyPreset('sample-data-empty');
  assert.deepEqual(empty.snapshot().tables, {});
  const shared = {
    id: 'shared-fixture',
    name: 'Shared fixture',
    description: 'Two explicitly intended website identities',
    matches: ({ portal }) => ['fixture-customer', 'fixture-partner'].includes(portal?.website?.adx_websiteid),
    presets: () => ({ 'shared-empty': { name: 'Shared empty fixture', tables: {} } }),
  };
  for (const site of ['customer', 'partner']) {
    await write(
      base,
      `checkouts/${site}-export/website.yml`,
      `adx_websiteid: fixture-${site}\nadx_name: Invented ${site}`,
    );
    await write(
      base,
      `checkouts/${site}-export/web-pages/Home.webpage.yml`,
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /',
    );
  }
  for (const name of ['Core', 'Feature'])
    await write(
      base,
      `checkouts/solutions/${name}/Other/Solution.xml`,
      '<ImportExportXml><SolutionManifest><UniqueName>Fixture</UniqueName></SolutionManifest></ImportExportXml>',
    );
  await write(base, 'checkouts/settings/local.json', '{"EnvironmentVariables":[],"ConnectionReferences":[]}');
  await write(base, 'checkouts/customer-export/deployment-profiles/local.yml', 'adx_contentsnippet: []');
  const customer = await createMirageContext({ config, site: 'customer', packs: [shared] });
  const partner = await createMirageContext({ config, site: 'partner', packs: [shared, sourceFree.packs[0]] });
  assert.deepEqual(customer.packs.map((pack) => pack.id).sort(), ['sample-data', 'shared-fixture']);
  assert.deepEqual(
    partner.packs.map((pack) => pack.id),
    ['shared-fixture'],
  );
  assert.throws(() => partner.resolvePreset('sample-data-empty'), /Unknown preset/);
  const unrelated = await createMirageContext({
    packs: [shared, sourceFree.packs[0]],
    portal: { website: { adx_websiteid: 'fixture-unrelated' } },
  });
  assert.deepEqual(unrelated.packs, []);
  assert.throws(() => unrelated.resolvePreset('shared-empty'), /Unknown preset/);
});
