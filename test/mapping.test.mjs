import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { PortalModel, sourceText } from '../lense/portal-model.mjs';
import { Resolver, globToRegExp } from '../lense/resolver.mjs';
import { GitBaseline } from '../lense/git.mjs';
import { diffLines } from '../lense/line-diff.mjs';
import { createFixture, SITE, HOME_ID, ABOUT_ID } from './fixture.mjs';

const fx = createFixture();
after(() => fx.cleanup());

test('page paths follow the parent chain', () => {
  const model = new PortalModel(fx.dir);
  assert.equal(model.pagePath(HOME_ID), '/');
  assert.equal(model.pagePath(ABOUT_ID), '/about-us');
});

test('a web file URL is its parent page path plus the partial URL, not the file name', () => {
  const model = new PortalModel(fx.dir);
  assert.equal(model.findWebFile('/scripts/app.js').file, fx.file('web-files/app.js'));
  assert.equal(model.findWebFile('/Logo.svg').file, fx.file('web-files/Site-Logo'));
  assert.equal(model.findWebFile('/Site-Logo'), null);
});

test('URL lookup ignores case, encoding and a trailing slash', () => {
  const model = new PortalModel(fx.dir);
  assert.ok(model.findWebFile('/SCRIPTS/App.JS'));
  assert.ok(model.findWebFile('/scripts/app%2Ejs'));
  assert.ok(model.findWebFile('/logo.svg/'));
});

test('a web file whose parent page is unknown is reported, not mapped', () => {
  const model = new PortalModel(fx.dir);
  assert.equal(model.findWebFile('/orphan.png'), null);
  assert.ok(model.warnings.some((w) => w.includes('orphan.png') && w.includes('parent page')));
});

test('inline sources know the page they belong to', () => {
  const model = new PortalModel(fx.dir);
  const js = model.inlineSources.find((s) => s.rel.endsWith('About.en-US.webpage.custom_javascript.js'));
  assert.equal(js.kind, 'page-js');
  assert.equal(js.pageUrl, '/about-us');
  assert.equal(model.inlineSources.find((s) => s.kind === 'basic-form-js').pageUrl, null);
});

test('resolver: explicit routes win, passthrough keeps a URL online', () => {
  const model = new PortalModel(fx.dir);
  fx.write('build/out/chunk/a.js', 'built');
  const site = {
    ...SITE,
    routes: [
      { url: '/scripts/app.js', passthrough: true },
      { url: '/assets/**', dir: 'build/out' },
      { url: '/special.js', file: 'web-files/app.js' },
    ],
  };
  const resolver = new Resolver(model, site);
  assert.equal(resolver.resolve('/scripts/app.js'), null);
  assert.equal(resolver.resolve('/assets/chunk/a.js').file, fx.file('build/out/chunk/a.js'));
  assert.equal(resolver.resolve('/special.js').file, fx.file('web-files/app.js'));
  assert.equal(resolver.resolve('/Logo.svg').via, 'web-file');
});

test('resolver: a dir route cannot be escaped with ..', () => {
  const model = new PortalModel(fx.dir);
  const resolver = new Resolver(model, { ...SITE, routes: [{ url: '/assets/**', dir: 'build/out' }] });
  assert.equal(resolver.resolve('/assets/../../web-files/app.js'), null);
  assert.equal(resolver.resolve('/assets/%2e%2e/%2e%2e/website.yml'), null);
});

test('resolver: exclude globs and disabled web files fall back to online', () => {
  const model = new PortalModel(fx.dir);
  assert.equal(new Resolver(model, { ...SITE, webFiles: { enabled: true, exclude: ['/scripts/**'] } }).resolve('/scripts/app.js'), null);
  assert.equal(new Resolver(model, { ...SITE, webFiles: { enabled: false, exclude: [] } }).resolve('/Logo.svg'), null);
});

test("scope 'changed' overrides only files that differ from the baseline", () => {
  const model = new PortalModel(fx.dir);
  const baseline = new GitBaseline(fx.dir, 'HEAD');
  assert.equal(baseline.available, true);
  assert.equal(new Resolver(model, SITE, { changed: baseline.changedFiles() }).resolve('/scripts/app.js'), null);

  const original = fx.read('web-files/app.js');
  fx.write('web-files/app.js', original + '// edit\n');
  fx.write('web-files/new.js', 'new');
  const changed = baseline.changedFiles();
  assert.ok(changed.has(path.resolve(fx.file('web-files/app.js'))));
  assert.ok(changed.has(path.resolve(fx.file('web-files/new.js'))), 'untracked files count as changed');
  assert.ok(new Resolver(model, SITE, { changed }).resolve('/scripts/app.js'));
  assert.equal(new Resolver(model, SITE, { changed }).resolve('/Logo.svg'), null);
  assert.equal(baseline.show(fx.file('web-files/app.js')), original);
  assert.equal(baseline.show(fx.file('web-files/new.js')), null);
  fx.write('web-files/app.js', original);
});

test('globToRegExp: * stays inside a segment, ** crosses them', () => {
  assert.ok(globToRegExp('/a/*.js').test('/a/b.js'));
  assert.ok(!globToRegExp('/a/*.js').test('/a/b/c.js'));
  assert.ok(globToRegExp('/a/**').test('/a/b/c.js'));
  assert.ok(globToRegExp('/a/**/*.js').test('/a/c.js'));
  assert.ok(globToRegExp('/a/**/*.js').test('/a/b/c.js'));
  assert.ok(globToRegExp('/A/x.js').test('/a/X.JS'));
  assert.ok(!globToRegExp('/a.js').test('/aXjs'));
});

test('diffLines reports minimal hunks', () => {
  const a = ['one', 'two', 'three', 'four'];
  assert.deepEqual(diffLines(a, a), []);
  assert.deepEqual(diffLines(a, ['one', 'TWO', 'three', 'four']), [{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }]);
  assert.deepEqual(diffLines(a, ['one', 'two', 'new', 'three', 'four']), [{ aStart: 2, aEnd: 2, bStart: 2, bEnd: 3 }]);
  assert.deepEqual(diffLines(a, ['one', 'four']), [{ aStart: 1, aEnd: 3, bStart: 1, bEnd: 1 }]);
  assert.deepEqual(diffLines(a, ['ONE', 'two', 'three', 'FOUR']), [
    { aStart: 0, aEnd: 1, bStart: 0, bEnd: 1 },
    { aStart: 3, aEnd: 4, bStart: 3, bEnd: 4 },
  ]);
  assert.deepEqual(diffLines([], ['x']), [{ aStart: 0, aEnd: 0, bStart: 0, bEnd: 1 }]);
});

test('language metadata supplies page aliases and form usage', (t) => {
  const local = createFixture();
  t.after(() => local.cleanup());
  const languageId = '00000000-0000-0000-0000-0000000000a1';
  local.write('web-pages/home/content-pages/Home.en-US.webpage.yml', `adx_webpageid: ${languageId}\nadx_rootwebpageid: ${HOME_ID}\nadx_entityform: contact-form\n`);
  local.write('basic-forms/contact/Contact.basicform.yml', 'adx_name: Contact\nadx_entityformid: contact-form\n');
  local.write('web-files/language.js', 'local');
  local.write('web-files/language.js.webfile.yml', `adx_name: language.js\nadx_partialurl: language.js\nadx_parentpageid: ${languageId}\n`);
  const model = new PortalModel(local.dir);
  assert.equal(model.pagePath(languageId), '/');
  assert.ok(model.findWebFile('/language.js'));
  assert.deepEqual(model.pagesShowing('CONTACT-FORM'), ['/']);
  assert.deepEqual(model.inlineSources.find((s) => s.kind === 'basic-form-js').usedOn, ['/']);
});

test('classic multistep form scripts use their metadata relationship before folder placement', (t) => {
  const local = createFixture();
  t.after(() => local.cleanup());
  local.write('web-pages/about/About.webpage.yml', local.read('web-pages/about/About.webpage.yml') + 'adx_webform: actual-form\n');
  local.write('advanced-forms/wrong-folder/Wizard.advancedform.yml', 'adx_webformid: unrelated-form\n');
  local.write('advanced-forms/wrong-folder/advanced-form-steps/details/Details.advancedformstep.yml', 'adx_webform: ACTUAL-FORM\n');
  local.write('advanced-forms/wrong-folder/advanced-form-steps/details/Details.advancedformstep.custom_javascript.js', 'window.step = true;');
  const model = new PortalModel(local.dir);
  assert.deepEqual(model.inlineSources.find((source) => source.kind === 'advanced-form-step-js').usedOn, ['/about-us']);
});

test('classic steps of inactive multistep forms are excluded and reported when edited', (t) => {
  const local = createFixture();
  t.after(() => local.cleanup());
  local.write('advanced-forms/wizard/Wizard.advancedform.yml', 'adx_webformid: inactive-form\nstatecode: 1\n');
  local.write('advanced-forms/wizard/advanced-form-steps/details/Details.advancedformstep.yml', 'adx_webform: inactive-form\n');
  const rel = 'advanced-forms/wizard/advanced-form-steps/details/Details.advancedformstep.custom_javascript.js';
  local.write(rel, 'window.step = true;');
  local.commit();
  const baseline = new GitBaseline(local.dir, 'HEAD');
  local.write(rel, 'window.step = false;');
  const model = new PortalModel(local.dir);
  assert.equal(model.inlineSources.some((source) => source.file === local.file(rel)), false);
  assert.ok(model.deploymentChanges(baseline, baseline.changedFiles()).some((change) => change.rel === rel && /inactive/.test(change.reason)));
});

test('metadata parse failures are visible and repaired metadata invalidates the model cache', (t) => {
  const local = createFixture();
  t.after(() => local.cleanup());
  const rel = 'web-pages/about/About.webpage.yml';
  const original = local.read(rel);
  local.write(rel, 'adx_webpageid: [broken');
  const model = new PortalModel(local.dir);
  assert.equal(model.pagePath(ABOUT_ID), null);
  assert.ok(model.warnings.some((warning) => warning.includes('About.webpage.yml') && warning.includes('cannot read YAML')));
  local.write(rel, original.replace('about-us', 'changed-about'));
  model.load();
  assert.equal(model.pagePath(ABOUT_ID), '/changed-about');
  assert.ok(!model.warnings.some((warning) => warning.includes('About.webpage.yml')));
});

test('ambiguous web-file URLs disable every duplicate instead of serving an arbitrary source', (t) => {
  const local = createFixture();
  t.after(() => local.cleanup());
  for (const name of ['duplicate-a.js', 'duplicate-b.js']) {
    local.write(`web-files/${name}`, name);
    local.write(`web-files/${name}.webfile.yml`, `adx_name: ${name}\nadx_partialurl: SCRIPTS/APP.JS\nadx_parentpageid: ${HOME_ID}\n`);
  }
  const model = new PortalModel(local.dir);
  assert.equal(model.findWebFile('/scripts/app.js'), null);
  assert.equal(model.webFiles.filter((file) => file.problem?.includes('duplicate URL')).length, 3);
});

test('resolver decodes paths once and honors changed scope on explicit routes', () => {
  const model = new PortalModel(fx.dir);
  assert.equal(new Resolver(model, SITE).resolve('/scripts/app%252Ejs'), null);
  assert.ok(new Resolver(model, SITE).resolve('/scripts/app%2Ejs'));
  const site = { ...SITE, routes: [{ url: '/special.js', file: 'web-files/app.js' }] };
  assert.equal(new Resolver(model, site, { changed: new Set() }).resolve('/special.js'), null);
  assert.ok(new Resolver(model, site, { changed: new Set([fx.file('web-files/app.js')]) }).resolve('/special.js'));
});

test('directory routes preserve wildcard suffixes and cannot escape through junctions', (t) => {
  const local = createFixture();
  t.after(() => local.cleanup());
  local.write('build/out/a.js', 'local');
  local.write('build/out/chunk/b.js', 'nested');
  local.write('outside/secret.js', 'secret');
  fs.symlinkSync(local.file('outside'), local.file('build/out/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const model = new PortalModel(local.dir);
  const resolver = new Resolver(model, { ...SITE, routes: [{ url: '/assets/*.js', dir: 'build/out' }, { url: '/nested/**', dir: 'build/out' }] });
  assert.equal(resolver.resolve('/assets/a.js').file, local.file('build/out/a.js'));
  assert.equal(resolver.resolve('/nested/chunk/b.js').file, local.file('build/out/chunk/b.js'));
  assert.equal(resolver.resolve('/nested/escape/secret.js'), null);
  assert.equal(resolver.resolve('/nested/%00'), null);
});

test('replacing indexed source folders with junctions cannot expose files outside the extract', (t) => {
  const local = createFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-outside-'));
  t.after(() => { local.cleanup(); fs.rmSync(outside, { recursive: true, force: true }); });
  const model = new PortalModel(local.dir);
  const resolver = new Resolver(model, SITE);
  const source = model.inlineSources.find((item) => item.rel.endsWith('About.en-US.webpage.custom_javascript.js'));
  fs.writeFileSync(path.join(outside, 'app.js'), 'private outside asset');
  fs.writeFileSync(path.join(outside, path.basename(source.file)), 'private outside script');
  fs.renameSync(local.file('web-files'), local.file('original-web-files'));
  fs.symlinkSync(outside, local.file('web-files'), process.platform === 'win32' ? 'junction' : 'dir');
  const sourceFolder = path.dirname(source.file);
  fs.renameSync(sourceFolder, sourceFolder + '-original');
  fs.symlinkSync(outside, sourceFolder, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(resolver.resolve('/scripts/app.js'), null);
  assert.equal(sourceText(source), null);
  const explicit = new Resolver(model, { ...SITE, routes: [{ url: '/intentional.js', file: path.join(outside, 'app.js') }] });
  assert.equal(explicit.resolve('/intentional.js').file, path.join(outside, 'app.js'));
});

test('Git batch baseline reads handle unicode, missing blobs, nested extracts and HEAD changes', (t) => {
  const local = createFixture();
  t.after(() => local.cleanup());
  local.write('nested/paportal/space name ü.js', 'é\nsecond\n');
  local.commit();
  const file = local.file('nested/paportal/space name ü.js');
  const missing = local.file('nested/paportal/missing.js');
  const baseline = new GitBaseline(local.file('nested/paportal'), 'HEAD');
  baseline.preload([file, missing, file]);
  assert.equal(baseline.cache.size, 2, 'batch must populate its cache rather than silently falling back');
  assert.equal(baseline.show(file), 'é\nsecond\n');
  assert.equal(baseline.show(missing), null);
  assert.equal(baseline.show(local.file('website.yml')), null, 'files outside the extract are not baseline sources');
  local.write('nested/paportal/space name ü.js', 'updated\n');
  assert.ok(baseline.changedFiles().has(file));
  local.commit();
  assert.equal(baseline.changedFiles().size, 0);
  baseline.preload([file]);
  assert.equal(baseline.show(file), 'updated\n');
});

test('Git baseline ignores inherited repository routing and rejects option-like refs', () => {
  const previous = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = fx.file('not-a-git-directory');
    const baseline = new GitBaseline(fx.dir, 'HEAD');
    assert.equal(baseline.available, true);
    baseline.preload([fx.file('web-files/app.js')]);
    assert.equal(baseline.show(fx.file('web-files/app.js')), fx.read('web-files/app.js'));
    assert.equal(new GitBaseline(fx.dir, '--help').available, false);
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
});

test('baseline polling observes moving merge bases and reports unavailable refs until recovered', async (t) => {
  const local = createFixture();
  t.after(() => local.cleanup());
  const git = (...args) => execFileSync('git', args, { cwd: local.dir, stdio: 'ignore', windowsHide: true });
  git('branch', 'deployed');
  const baseline = new GitBaseline(local.dir, 'merge-base:deployed');
  const first = baseline.commit;
  assert.equal(await baseline.checkForUpdate(), false);
  local.write('web-files/app.js', 'new baseline');
  local.commit();
  git('branch', '-f', 'deployed', 'HEAD');
  assert.equal(await baseline.checkForUpdate(), true);
  assert.notEqual(baseline.commit, first);
  assert.equal(baseline.show(local.file('web-files/app.js')), 'new baseline');
  git('branch', '-D', 'deployed');
  assert.equal(await baseline.checkForUpdate(), true);
  assert.equal(baseline.available, false);
  assert.match(baseline.error, /Cannot read baseline/);
  assert.equal(await baseline.checkForUpdate(), false);
  git('branch', 'deployed');
  assert.equal(await baseline.checkForUpdate(), true);
  assert.equal(baseline.available, true);
});

test('changed classic portal metadata reports deployment needs without flagging comments or unrelated YAML', (t) => {
  const local = createFixture();
  t.after(() => local.cleanup());
  const baseline = new GitBaseline(local.dir, 'HEAD');
  local.write('web-pages/about/About.webpage.yml', local.read('web-pages/about/About.webpage.yml').replace('about-us', 'new-about'));
  local.write('website.yml', local.read('website.yml') + '# documentation only\n');
  local.write('notes.yml', 'local: notes\n');
  const model = new PortalModel(local.dir);
  const changes = model.deploymentChanges(baseline, baseline.changedFiles());
  assert.equal(changes.length, 1);
  assert.equal(changes[0].rel, 'web-pages/about/About.webpage.yml');
  assert.match(changes[0].reason, /require deployment/);
});
