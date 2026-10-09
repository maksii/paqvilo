import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lense/config.mjs';
import { detectFormat, PortalModel, portalSourceDir, unsupportedSourceLayout, yamlKeyStyle } from '../lense/portal-model.mjs';

// The toolkit reads .powerpages-site short-key exports like PAC YAML, and a code-site project
// through its .powerpages-site/ folder (`mirage init/dev/start`, `dev`, `doctor` and the other
// catalogue commands resolve sources through loadConfig). A layout it cannot read (mspp_ YAML) is
// refused with its layout named (ecosystem review docs/runtime-evidence.md, X1).

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-browser', 'fixtures', 'code-site');
const write = (root, files) => {
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
};

test('short-key exports and code-site projects are portal sources; mspp_ YAML is refused; adx_ exports and unpacked Solutions are unchanged', async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-layout-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, {
    'code/.powerpages-site/website.yml': 'id: 6a0f0c2e-0000-4000-8000-000000000004\nname: Synthetic Code Site\nwebsite_language: 1033\n',
    'code/.powerpages-site/web-pages/home/Home.webpage.yml': 'id: 6a0f0c2e-0000-4000-8000-000000000010\nisroot: true\nname: Home\npartialurl: /\n',
    'code/lense/main.js': 'export {};\n',
    'empty-project/.powerpages-site/readme.txt': 'not a site yet',
    'mspp/website.yml': 'mspp_name: Site\nmspp_websiteid: 6a0f0c2e-0000-4000-8000-000000000099\n',
    'mspp/web-pages/home/Home.webpage.yml': 'mspp_name: Home\n',
    'classic/website.yml': 'adx_name: Classic\nadx_websiteid: 6a0f0c2e-0000-4000-8000-000000000098\n',
    'classic/web-pages/home/Home.webpage.yml': 'adx_name: Home\nadx_partialurl: /\n',
    'enhanced/powerpagecomponents/6a0f0c2e-0000-4000-8000-000000000097/powerpagecomponent.xml': '<powerpagecomponent />',
    'paqvilo.config.yml': [
      'sourceRoot: .',
      'sites:',
      ...['code:code/.powerpages-site', 'project:code', 'empty:empty-project', 'mspp:mspp', 'classic:classic'].flatMap((entry) => {
        const [name, source] = entry.split(':');
        return [`  ${name}:`, `    source: ${source}`, '    environments:', `      dev: https://${name}-dev.example.com`];
      }),
      '',
    ].join('\n'),
  });
  fs.mkdirSync(path.join(root, 'bare', 'web-files'), { recursive: true });
  const site = path.join(root, 'code', '.powerpages-site');
  assert.equal(detectFormat(site), 'classic');
  assert.equal(yamlKeyStyle(site), 'short');
  assert.equal(unsupportedSourceLayout(site), null);
  assert.equal(portalSourceDir(path.join(root, 'code')), site);
  assert.equal(portalSourceDir(path.join(root, 'classic')), path.join(root, 'classic'));
  assert.equal(unsupportedSourceLayout(path.join(root, 'mspp'))?.dialect, 'enhanced-yaml');
  // A project folder whose .powerpages-site/ holds no site is named, never served empty.
  assert.equal(unsupportedSourceLayout(path.join(root, 'empty-project'))?.dialect, 'code-site-project');
  assert.equal(detectFormat(path.join(root, 'classic')), 'classic');
  assert.equal(yamlKeyStyle(path.join(root, 'classic')), 'adx');
  assert.equal(detectFormat(path.join(root, 'enhanced')), 'enhanced');
  // A folder with only web-files/ (no records yet) keeps the classic layout.
  assert.equal(detectFormat(path.join(root, 'bare')), 'classic');
  const config = path.join(root, 'paqvilo.config.yml');
  assert.equal((await loadConfig({ config, site: 'code' }, {})).sourceDir, site);
  assert.equal((await loadConfig({ config, site: 'project' }, {})).sourceDir, site);
  await assert.rejects(loadConfig({ config, site: 'empty' }, {}), /source of site "empty"\) is a code-site project folder whose \.powerpages-site\/ folder holds short-key YAML/);
  await assert.rejects(
    loadConfig({ config, site: 'mspp' }, {}),
    /source of site "mspp"\) is PAC YAML with mspp_ keys, which the toolkit does not treat as a portal: use a PAC YAML export with adx_ keys, a \.powerpages-site export or the site's unpacked Solution \(powerpagecomponents\/\)/,
  );
  assert.equal((await loadConfig({ config, site: 'classic' }, {})).sourceDir, path.join(root, 'classic'));
});

test('the toolkit model indexes a code site: pages from id:, language copies, per-folder web files, snippets and web link markup', async () => {
  const site = portalSourceDir(FIXTURE);
  const model = await PortalModel.create(site);
  assert.deepEqual([model.format, model.shortKey, model.warnings], ['classic', true, []]);
  assert.deepEqual([...model.pages.values()].map((page) => [page.name, model.pagePath(page.id)]).sort(), [['About', '/about'], ['Home', '/']]);
  // Language copies (content-pages/<language>/) resolve to their root page.
  const copies = model.inlineSources.filter((source) => source.kind === 'page-copy').map((source) => [source.rel, source.pageUrl]).sort();
  assert.deepEqual(copies, [
    ['web-pages/about/About.webpage.copy.html', '/about'],
    ['web-pages/about/content-pages/en-US/About.webpage.copy.html', '/about'],
    ['web-pages/home/Home.webpage.copy.html', '/'],
    ['web-pages/home/content-pages/en-US/Home.webpage.copy.html', '/'],
    ['web-pages/home/content-pages/fr-CA/Home.webpage.copy.html', '/'],
  ]);
  // One folder per web file.
  assert.deepEqual(model.webFiles.map((file) => [file.url, path.relative(site, file.file).split(path.sep).join('/'), file.problem]), [['/app.js', 'web-files/app.js/app.js', null], ['/theme.css', 'web-files/theme.css/theme.css', null]]);
  assert.equal(model.findWebFile('/app.js').id, '5c0de51e-0000-4000-8000-000000000040');
  assert.deepEqual(model.inlineSources.filter((source) => source.kind === 'content-snippet').map((source) => source.snippetName), ['Site Name', 'Site Name']);
  // Web link markup with unprefixed keys, one link per file.
  const link = model.inlineSources.find((source) => source.kind === 'metadata-markup');
  assert.deepEqual([link.rel, link.fieldPath, link.label], ['weblink-sets/primary-navigation/en-US/About.weblink.yml#name', ['name'], 'About (name)']);
  assert.equal(link.extract(fs.readFileSync(link.file, 'utf8')), 'About');
});

test('a catalogue site sets the data model of a code site: mirage init writes it, and invalid values are refused', async (t) => {
  const { initProject } = await import('../lense/commands/mirage.mjs');
  const { mirageSettings } = await import('../lense/config-schema.mjs');
  const YAML = (await import('yaml')).default;
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-code-site-')));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const config = path.join(work, 'paqvilo.config.yml');
  fs.writeFileSync(config, JSON.stringify({ defaultSite: 'code', sites: { code: { source: FIXTURE, environments: { dev: 'https://code.example.com' }, mirage: { project: path.join(work, 'code.project.yml'), solutionRoots: [], dataModel: 'standard' } } } }, null, 2));
  const cfg = await loadConfig({ config }, {});
  assert.equal(cfg.sourceDir, path.join(FIXTURE, '.powerpages-site'));
  assert.equal(cfg.mirageConfig.dataModel, 'standard');
  const written = await initProject(cfg, {});
  const document = YAML.parse(fs.readFileSync(written.file, 'utf8'));
  assert.equal(document.portals[0].dataModel, 'standard');
  assert.throws(() => mirageSettings({ dataModel: 'classic' }, 'sites.code.mirage'), /sites\.code\.mirage\.dataModel must be standard or enhanced/);
});

test('a strict audit of a code site accounts for every source; server logic code needs deployment', async () => {
  const { auditResources } = await import('../lense/resource-audit.mjs');
  const { SITE } = await import('./fixture.mjs');
  const report = auditResources(new PortalModel(portalSourceDir(FIXTURE)), SITE);
  assert.deepEqual([report.totals.gaps, report.totals.blocked, report.coverage.complete], [0, 0, true]);
  const serverLogic = report.resources.find((item) => item.relativePath === 'server-logic/order-summary/order-summary.js');
  assert.equal(serverLogic.status, 'deployment');
  assert.match(serverLogic.reason, /runs on the Power Pages server/);
  assert.ok(report.resources.some((item) => item.relativePath === 'web-files/app.js/app.js' && item.status === 'mapped'));
});
