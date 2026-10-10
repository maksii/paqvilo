import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PortalModel } from '../lense/portal-model.mjs';
import { GitBaseline } from '../lense/git.mjs';
import { describeResources, resourceFilters } from '../lense/commands/resources.mjs';
import { editSource } from '../lense/source-edit.mjs';
import { createFixture, SITE, HOME_ID } from './fixture.mjs';

const cfgFor = (dir, site = SITE) => ({ siteName: 'test', envName: 'local', origin: 'https://portal.invalid', sourceDir: dir, configFile: path.join(dir, 'catalogue.yml'), site });
function describe(dir, args = {}, site = SITE) {
  const model = new PortalModel(dir);
  const baseline = new GitBaseline(dir, site.markup.baseline);
  return describeResources(cfgFor(dir, site), model, baseline, baseline.changedFiles({ refreshRef: false }), resourceFilters(args));
}

test('offline page filtering distinguishes short exported routes from localized routes and home', (t) => {
  const fx = createFixture(); t.after(fx.cleanup);
  fx.write('web-pages/it/IT.webpage.yml', `adx_webpageid: it-page\nadx_name: IT\nadx_partialurl: it\nadx_parentpageid: ${HOME_ID}`);
  fx.write('web-pages/it/IT.webpage.custom_javascript.js', 'window.it = true;');
  fx.write('websitelanguage.yml', '- adx_websitelanguageid: fr\n  adx_name: French - France\n  adx_languagecode: fr-FR');
  const direct = describe(fx.dir, { page: '/it', limit: 500 });
  const localized = describe(fx.dir, { page: '/fr-FR/it', limit: 500 });
  assert.deepEqual(direct.resources.map((row) => row.id), localized.resources.map((row) => row.id));
  assert.equal(direct.resources.some((row) => row.id === 'page:it-page'), true);
  assert.equal(direct.resources.some((row) => row.id === `page:${HOME_ID}`), false);
  assert.equal(describe(fx.dir, { page: '/zz-ZZ/', limit: 500 }).resources.length, 0);
});

test('offline resources expose exact classic paths and only configured page relationships', (t) => {
  const fx = createFixture(); t.after(() => fx.cleanup());
  const formId = '00000000-0000-0000-0000-000000000099';
  fx.write('basic-forms/contact/Contact.basicform.yml', `adx_entityformid: ${formId}\nadx_name: Contact\n`);
  const metadata = 'web-pages/home/content-pages/Home.en-US.webpage.yml';
  fx.write(metadata, fx.read(metadata) + `adx_entityform: ${formId}\n`);
  t.mock.method(globalThis, 'fetch', () => assert.fail('resource discovery must remain offline'));
  const report = describe(fx.dir, { page: '/en-US/', limit: '500' });
  const form = report.resources.find((resource) => resource.kind === 'basic-form-js');
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.writesFiles, false);
  assert.equal(form.path, fx.file('basic-forms/contact/Contact.basicform.custom_javascript.js'));
  assert.equal(form.field, null);
  assert.deepEqual(form.relatedPageUrls, ['/']);
  assert.ok(report.relationships.some((edge) => edge.sourceId === form.id && edge.targetId === `page:${HOME_ID}` && edge.kind === 'configured-on-page'));
  assert.equal(report.resources.some((resource) => resource.kind === 'web-template'), false, 'templates must not be guessed to appear on a page');
  const home = report.resources.find((resource) => resource.id === `page:${HOME_ID}`);
  assert.ok(home.metadataPaths.includes(fx.file(metadata)));
  assert.ok(home.configuredComponentIds.includes(formId), 'language-page configuration contributes to the canonical page');
  assert.ok(report.relationships.find((edge) => edge.sourceId === form.id).evidence.paths.includes(fx.file(metadata)));
  assert.match(report.relationshipScope, /dynamic dependencies are not inferred/);
  assert.ok(report.resources.every((resource) => !Object.hasOwn(resource, 'body') && !Object.hasOwn(resource, 'content')));
});

test('resource IDs and pagination are stable, and changed scope exposes effective explicit routes', (t) => {
  const fx = createFixture(); t.after(() => fx.cleanup());
  fx.write('web-files/app.js', 'changed');
  const site = structuredClone(SITE);
  site.scope = 'changed';
  site.routes = [{ url: '/scripts/app.js', file: 'web-files/Site-Logo' }, { url: '/online/**', passthrough: true }, { url: '/outside.js', file: path.join(fx.dir, '..', 'external.js') }];
  const full = describe(fx.dir, { limit: '500' }, site);
  const first = describe(fx.dir, { limit: '2' }, site);
  const second = describe(fx.dir, { limit: '2', offset: '2' }, site);
  assert.equal(first.pagination.nextOffset, 2);
  assert.deepEqual([...first.resources, ...second.resources].map((resource) => resource.id), full.resources.slice(0, 4).map((resource) => resource.id));
  const changed = describe(fx.dir, { changed: true, kind: ['web-file'] }, site);
  assert.equal(changed.pagination.total, 1);
  assert.equal(changed.resources[0].relativePath, 'web-files/app.js');
  assert.equal(changed.resources[0].preview.selected, false, 'a matching unchanged explicit route keeps this URL online in changed scope');
  const routes = full.resources.filter((resource) => resource.kind === 'route');
  assert.equal(routes[0].path, fx.file('web-files/Site-Logo'));
  assert.equal(routes[1].preview.strategy, 'passthrough');
  assert.equal(routes[2].changed, null, 'files outside the extract are outside the Git change snapshot');
  assert.equal(describe(fx.dir, { search: 'FOOTER-TEXT' }).pagination.total, 1);
});

test('enhanced discovery separates physical XML path from editable field and excludes inactive records', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-resource-enhanced-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const component = (id, type, content, inactive = false) => {
    const file = path.join(dir, 'powerpagecomponents', id, 'powerpagecomponent.xml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `<powerpagecomponent powerpagecomponentid="${id}"><powerpagecomponenttype>${type}</powerpagecomponenttype><statecode>${inactive ? 1 : 0}</statecode><name>${id}</name><content><![CDATA[${JSON.stringify(content)}]]></content></powerpagecomponent>`);
    return file;
  };
  const file = component('home', 2, { partialurl: '/', customjavascript: 'console.log("hello")', copy: '<p>Hello</p>' });
  component('inactive', 2, { partialurl: 'inactive', customjavascript: 'hidden' }, true);
  const report = describe(dir, { kind: ['page-js', 'page-copy'] });
  assert.equal(report.baseline.available, false);
  assert.equal(report.resources.length, 2);
  assert.ok(report.resources.every((resource) => resource.path === file && resource.relativePath.endsWith('.xml')));
  assert.deepEqual(report.resources.map((resource) => resource.field).sort(), ['copy', 'customjavascript']);
  assert.equal(report.resources.find((resource) => resource.kind === 'page-copy').preview.eligible, false);
  assert.throws(() => describe(dir, { changed: true }), /baseline is unavailable/);
});

test('resource query validation rejects ambiguous paths and unbounded result limits', () => {
  for (const args of [{ limit: '0' }, { limit: '501' }, { offset: '-1' }, { offset: '9007199254740992' }, { page: '//other.invalid' }, { page: '/page?secret=1' }, { kind: ['unknown'] }]) assert.throws(() => resourceFilters(args));
  assert.deepEqual(resourceFilters({ kind: ['page-js', 'page-js'] }).kinds, ['page-js']);
});

test('resources CLI JSON is deterministic and does not create mapping files or personal settings', (t) => {
  const fx = createFixture(); t.after(() => fx.cleanup());
  const config = fx.file('catalogue.yml');
  fs.writeFileSync(config, 'sites:\n  test:\n    source: .\n    environments:\n      local: https://portal.invalid\n');
  const cli = fileURLToPath(new URL('../lense/cli.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PAQVILO_|GIT_)/.test(key)));
  const args = [cli, 'resources', '--config', config, '--site', 'test', '--env', 'local', '--kind', 'page-js', '--json'];
  const run = () => spawnSync(process.execPath, args, { env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const first = run(); const second = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.stdout, first.stdout);
  const report = JSON.parse(first.stdout);
  assert.equal(report.command, 'resources');
  assert.ok(report.resources.every((resource) => resource.kind === 'page-js'));
  assert.equal(fs.existsSync(fx.file('.paqvilo')), false);
  assert.equal(fs.existsSync(fx.file('.env')), false);
});

test('large piped resource reports drain completely before the CLI exits', (t) => {
  const fx = createFixture(); t.after(() => fx.cleanup());
  for (let i = 0; i < 120; i++) fx.write(`web-pages/about/content-pages/Resource-${String(i).padStart(3, '0')}.webpage.custom_javascript.js`, '');
  const config = fx.file('catalogue.yml');
  fs.writeFileSync(config, 'sites:\n  test:\n    source: .\n    environments:\n      local: https://portal.invalid\n');
  const cli = fileURLToPath(new URL('../lense/cli.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PAQVILO_|GIT_)/.test(key)));
  const result = spawnSync(process.execPath, [cli, 'resources', '--config', config, '--kind', 'page-js', '--limit', '500', '--json'], { env, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.length > 64 * 1024, 'exercise more than a pipe buffer');
  const report = JSON.parse(result.stdout);
  assert.equal(report.resources.length, 122);
  assert.equal(report.pagination.nextOffset, null);
});

test('discovered YAML and localized descriptors can be edited without losing field or identity context', (t) => {
  const fx = createFixture(); t.after(() => fx.cleanup());
  fx.write('weblink-sets/footer/Footer.weblinkset.yml', 'adx_name: Footer\nadx_copy: <p>Footer before</p>\n');
  const metadata = 'basic-forms/contact/Contact.basicform.basicformmetadata.yml';
  fx.write(metadata, '- adx_entityformmetadataid: record-one\n  adx_description: \'[{"LCID":1033,"Value":"<p>Description before</p>"},{"LCID":1045,"Value":"<p>Other language</p>"}]\'\n');
  const report = describe(fx.dir, { kind: ['metadata-markup'], limit: '500' });
  const footer = report.resources.find((item) => item.field === 'adx_copy');
  assert.equal(footer.format, 'yaml');
  assert.deepEqual(footer.fieldPath, ['adx_copy']);
  assert.equal(footer.sourceDir, fx.dir);
  const localized = report.resources.find((item) => item.lcid === 1033);
  assert.equal(localized.recordId, 'record-one');
  assert.equal(localized.recordIdField, 'adx_entityformmetadataid');
  assert.deepEqual(localized.fieldPath, [0, 'adx_description']);
  assert.deepEqual(localized.jsonPath, [0, 'Value']);
  editSource(footer, (text) => text.replace('before', 'after'));
  editSource(localized, (text) => text.replace('before', 'after'));
  assert.match(fx.read(metadata), /Description after/);
  assert.match(fx.read(metadata), /Other language/);
  assert.match(fx.read('weblink-sets/footer/Footer.weblinkset.yml'), /Footer after/);
});
