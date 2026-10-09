// The enhanced data model layout (unpacked solution): powerpagecomponents/<id>/powerpagecomponent.xml
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PortalModel, detectFormat, sourceText, componentContent, componentContentSpan } from '../lense/portal-model.mjs';
import { GitBaseline } from '../lense/git.mjs';
import { HtmlRewriter } from '../lense/html-rewriter.mjs';
import { SITE } from './fixture.mjs';
import { OverlaySession } from '../lense/session.mjs';
import { editSource } from '../lense/source-edit.mjs';

const HOME = '00000000-0000-0000-0000-0000000000a0';
const HOME_EN = '00000000-0000-0000-0000-0000000000a1';
const NEWS = '00000000-0000-0000-0000-0000000000b0';
const NEWS_EN = '00000000-0000-0000-0000-0000000000b1';

const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function component(id, type, name, content, attachment) {
  return [
    `<powerpagecomponent powerpagecomponentid="${id}">`,
    `  <content>${xmlEscape(JSON.stringify(content, null, 2))}</content>`,
    attachment ? `  <filecontent mimetype="${attachment.mime}">${xmlEscape(attachment.name)}</filecontent>` : null,
    `  <name>${xmlEscape(name)}</name>`,
    `  <powerpagecomponenttype>${type}</powerpagecomponenttype>`,
    '</powerpagecomponent>',
  ]
    .filter(Boolean)
    .join('\n');
}

const NEWS_JS = '$(document).ready(function () {\r\n  if (a < b && c > d) {\r\n    loadNews("latest");\r\n  }\r\n  renderNews();\r\n});';

let dir;
const put = (id, xml) => {
  fs.mkdirSync(path.join(dir, 'powerpagecomponents', id), { recursive: true });
  fs.writeFileSync(path.join(dir, 'powerpagecomponents', id, 'powerpagecomponent.xml'), xml);
};
const xmlOf = (id) => path.join(dir, 'powerpagecomponents', id, 'powerpagecomponent.xml');
const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'ignore', windowsHide: true });

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-enh-')));
  put(HOME, component(HOME, 2, 'Home', { isroot: true, partialurl: '/' }));
  put(HOME_EN, component(HOME_EN, 2, 'Home', { isroot: false, rootwebpageid: HOME, partialurl: '/' }));
  put(NEWS, component(NEWS, 2, 'Newsfeed', { isroot: true, partialurl: 'Newsfeed', parentpageid: HOME }));
  put(NEWS_EN, component(NEWS_EN, 2, 'Newsfeed', { isroot: false, rootwebpageid: NEWS, partialurl: 'Newsfeed', parentpageid: HOME, customjavascript: NEWS_JS, customcss: '.news { color: red; }' }));
  // a web file under the root page, with a disk name that differs from its URL
  put('f1', component('f1', 3, 'Logo', { partialurl: 'portal-logo.svg', parentpageid: HOME }, { mime: 'image/svg+xml', name: 'Example Logo.svg' }));
  fs.mkdirSync(path.join(dir, 'powerpagecomponents', 'f1', 'filecontent'));
  fs.writeFileSync(path.join(dir, 'powerpagecomponents', 'f1', 'filecontent', 'Example Logo.svg'), '<svg/>');
  // one whose parent is the language copy of a page, one without a parent
  put('f2', component('f2', 3, 'robots', { partialurl: 'robots.txt', parentpageid: HOME_EN }, { mime: 'text/plain', name: 'robots.txt' }));
  fs.mkdirSync(path.join(dir, 'powerpagecomponents', 'f2', 'filecontent'));
  fs.writeFileSync(path.join(dir, 'powerpagecomponents', 'f2', 'filecontent', 'robots.txt'), 'User-agent: *');
  put('f3', component('f3', 3, 'orphan', { partialurl: 'orphan.json' }, { mime: 'application/json', name: 'orphan.json' }));
  fs.mkdirSync(path.join(dir, 'powerpagecomponents', 'f3', 'filecontent'));
  fs.writeFileSync(path.join(dir, 'powerpagecomponents', 'f3', 'filecontent', 'orphan.json'), '{}');
  put('t1', component('t1', 8, 'Header', { source: '<header>\n  <a class="brand" href="/">{{ website.name }}</a>\n  <nav>Old menu</nav>\n</header>\n' }));
  put('s1', component('s1', 7, 'Footer/Text', { value: 'All rights reserved by the agency.' }));
  put('x1', component('x1', 9, 'Some/SiteSetting', { value: 'true' }));
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'baseline');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

/** Edits one field of a component the way a developer would: in the XML, keeping its escaping. */
function editField(id, field, change) {
  const file = xmlOf(id);
  const xml = fs.readFileSync(file, 'utf8');
  const m = /<content>([\s\S]*?)<\/content>/.exec(xml);
  const content = JSON.parse(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  content[field] = change(content[field]);
  fs.writeFileSync(file, xml.replace(m[0], () => `<content>${xmlEscape(JSON.stringify(content, null, 2))}</content>`));
}

const rewriter = (site = SITE) => new HtmlRewriter({ model: new PortalModel(dir), site, baseline: new GitBaseline(dir, 'HEAD'), sourceMaps: true });

test('known enhanced XML saves refresh page code and metadata asynchronously', async () => {
  const session = new OverlaySession({ sourceDir: dir, site: structuredClone(SITE) });
  editField(NEWS_EN, 'customjavascript', () => 'window.latestEnhancedCode = true;');
  await session.refreshAsync([xmlOf(NEWS_EN)], { deferChangeTracking: true });
  assert.ok(session.rewriter.blocks.some((block) => block.text === 'window.latestEnhancedCode = true;'));
  editField(NEWS, 'partialurl', () => 'renamed-news');
  await session.refreshAsync([xmlOf(NEWS)]);
  assert.equal(session.model.pagePath(NEWS_EN), '/renamed-news');
});

test('language fields of inactive enhanced root pages are excluded', () => {
  put(NEWS, fs.readFileSync(xmlOf(NEWS), 'utf8').replace('</powerpagecomponent>', '<statecode>1</statecode></powerpagecomponent>'));
  assert.equal(new PortalModel(dir).inlineSources.some((source) => source.file === xmlOf(NEWS_EN)), false);
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'inactive root');
  assert.equal(rewriter().unsupported.length, 0);
  editField(NEWS_EN, 'customjavascript', () => 'window.inactiveEdit = true;');
  assert.ok(rewriter().unsupported.some((entry) => entry.rel.includes(NEWS_EN) && /inactive/.test(entry.reason)));
});

test('the format is detected from the folder', () => {
  assert.equal(detectFormat(dir), 'enhanced');
  assert.equal(detectFormat(path.join(dir, 'powerpagecomponents')), null);
  assert.equal(new PortalModel(dir).format, 'enhanced');
});

test('web files map by parent page and partial URL to the file under filecontent/', () => {
  const model = new PortalModel(dir);
  assert.equal(model.findWebFile('/portal-logo.svg').file, path.join(dir, 'powerpagecomponents', 'f1', 'filecontent', 'Example Logo.svg'));
  assert.equal(model.findWebFile('/portal-logo.svg').mimeType, 'image/svg+xml');
  // parent given as the language copy of the page
  assert.ok(model.findWebFile('/robots.txt'));
  assert.equal(model.findWebFile('/orphan.json'), null);
  assert.ok(model.warnings.some((w) => w.includes('orphan') && w.includes('no parent page')));
});

test('page code, templates and snippets are read out of the component XML', () => {
  const model = new PortalModel(dir);
  const js = model.inlineSources.find((s) => s.kind === 'page-js' && s.pageUrl === '/Newsfeed' && sourceText(s));
  assert.equal(sourceText(js), NEWS_JS);
  assert.equal(js.file, xmlOf(NEWS_EN));
  assert.ok(js.rel.endsWith('/powerpagecomponent.xml#customjavascript'));
  assert.equal(sourceText(model.inlineSources.find((s) => s.kind === 'web-template')).includes('{{ website.name }}'), true);
  assert.equal(sourceText(model.inlineSources.find((s) => s.kind === 'content-snippet')), 'All rights reserved by the agency.');
  // components that are neither pages, files, templates nor snippets are ignored
  assert.ok(!model.inlineSources.some((s) => s.rel.includes('/x1/')));
});

const PAGE = [
  '<html><head><style type="text/css">.news { color: red; }</style></head><body>',
  '<header>',
  '  <a class="brand" href="/">Example</a>',
  '  <nav>Old menu</nav>',
  '</header>',
  `<script type="text/javascript">${NEWS_JS}</script>`,
  '<footer>All rights reserved by the agency.</footer>',
  '</body></html>',
].join('\r\n');

test('an unchanged page is left as it is (no script file to load from: the code lives in XML)', () => {
  const result = rewriter().rewrite(PAGE, '/Newsfeed');
  assert.equal(result.html, PAGE);
  assert.deepEqual(result.matched.map((m) => `${m.kind}:${m.identical}`).sort(), ['page-css:true', 'page-js:true']);
});

test('editing page JS and CSS inside the XML shows on the page', () => {
  editField(NEWS_EN, 'customjavascript', (js) => js.replace('renderNews();', 'renderNews();\r\n  trackVisit("a<b");'));
  editField(NEWS_EN, 'customcss', () => '.news { color: green; }');
  const result = rewriter().rewrite(PAGE, '/Newsfeed');
  assert.ok(result.html.includes('trackVisit("a<b");'));
  assert.ok(result.html.includes('if (a < b && c > d) {'));
  assert.ok(result.html.includes('.news { color: green; }'));
  assert.ok(!result.html.includes('src="/__paqvilo'));
  assert.equal(result.applied.length, 2);
  // and only on its own page
  assert.ok(!rewriter().rewrite(PAGE, '/').html.includes('trackVisit'));
});

test('editing a template and a snippet inside the XML is patched into the page', () => {
  editField('t1', 'source', (s) => s.replace('<nav>Old menu</nav>', '<nav>New menu</nav>'));
  editField('s1', 'value', () => 'All rights reserved, 2026.');
  const result = rewriter().rewrite(PAGE, '/Newsfeed');
  assert.ok(result.html.includes('  <nav>New menu</nav>\r\n</header>'));
  assert.ok(result.html.includes('<footer>All rights reserved, 2026.</footer>'));
  assert.deepEqual(result.applied.map((a) => a.kind).sort(), ['content-snippet', 'web-template']);
});

test('XML that is broken mid-edit is reported, the page is left alone', () => {
  const file = xmlOf(NEWS_EN);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"customcss"', '"customcss'));
  const r = rewriter();
  assert.equal(r.rewrite(PAGE, '/Newsfeed').html, PAGE);
  assert.equal(r.unsupported.length, 1);
  assert.match(r.unsupported[0].reason, /source field.*metadata/);
});

test('enhanced basic-form scripts are indexed with their configured page usage', () => {
  put('form1', component('form1', 15, 'Contact', { customjavascript: 'console.log("contact");' }));
  editField(NEWS_EN, 'entityform', () => 'form1');
  const model = new PortalModel(dir);
  const source = model.inlineSources.find((s) => s.kind === 'basic-form-js');
  assert.equal(source.field, 'customjavascript');
  assert.equal(sourceText(source), 'console.log("contact");');
  assert.deepEqual(source.usedOn, ['/Newsfeed']);
});

test('enhanced list and multistep form scripts have editable fields and language-page associations', () => {
  put('list1', component('list1', 17, 'Applications', { customjavascript: 'window.listLoaded = true;' }));
  put('form1', component('form1', 19, 'Wizard', { startstep: 'step1' }));
  put('step1', component('step1', 20, 'Details', { webform: 'FORM1', customjavascript: 'window.stepLoaded = true;' }));
  editField(NEWS_EN, 'entitylist', () => 'LIST1');
  editField(NEWS_EN, 'webform', () => 'form1');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'list and wizard baseline');
  const baseline = new GitBaseline(dir, 'HEAD');
  for (const [id, kind, original] of [['list1', 'list-js', 'window.listLoaded = true;'], ['step1', 'advanced-form-step-js', 'window.stepLoaded = true;']]) {
    const source = new PortalModel(dir).inlineSources.find((entry) => entry.kind === kind);
    assert.equal(source.field, 'customjavascript');
    assert.equal(source.tag, 'script');
    assert.equal(sourceText(source), original);
    assert.deepEqual(source.usedOn, ['/Newsfeed']);
    editField(id, 'customjavascript', (text) => text.replace('true', 'false'));
  }
  const model = new PortalModel(dir);
  assert.equal(model.inlineSources.some((entry) => entry.file === xmlOf('form1')), false);
  assert.deepEqual(model.deploymentChanges(baseline, baseline.changedFiles()), []);
  const result = rewriter().rewrite('<html><body><script>window.listLoaded = true;</script><script>window.stepLoaded = true;</script></body></html>', '/Newsfeed');
  assert.ok(result.html.includes('window.listLoaded = false;'));
  assert.ok(result.html.includes('window.stepLoaded = false;'));
  assert.deepEqual(result.applied.map((entry) => entry.kind).sort(), ['advanced-form-step-js', 'list-js']);
  editField('step1', 'webform', () => 'other-form');
  assert.ok(new PortalModel(dir).deploymentChanges(baseline, baseline.changedFiles()).some((change) => /webform/.test(change.reason)));
});

test('steps of inactive enhanced multistep forms are excluded', () => {
  put('wizard', component('wizard', 19, 'Wizard', {}).replace('</powerpagecomponent>', '<statecode>1</statecode></powerpagecomponent>'));
  put('step1', component('step1', 20, 'Details', { webform: 'WIZARD', customjavascript: 'window.inactiveStep = true;' }));
  put('metadata1', component('metadata1', 21, 'Details hint', { webformstep: 'step1', description: '<p>Inactive hint</p>' }));
  const model = new PortalModel(dir);
  assert.equal(model.inlineSources.some((entry) => entry.file === xmlOf('step1')), false);
  assert.ok(model.inactiveSources.some((entry) => entry.file === xmlOf('step1')));
  assert.equal(model.inlineSources.some((entry) => entry.file === xmlOf('metadata1')), false);
});

test('enhanced broken page hierarchies report route warnings and retain source discovery', () => {
  editField(NEWS, 'parentpageid', () => 'unknown');
  const model = new PortalModel(dir);
  assert.equal(model.pagePath(NEWS_EN), null);
  assert.ok(model.warnings.some((warning) => warning.includes(NEWS) && /missing parent page/.test(warning)));
  assert.equal(model.inlineSources.find((source) => source.file === xmlOf(NEWS_EN) && source.kind === 'page-js').pageUrl, null);
});

test('enhanced link descriptions and localized form metadata preserve configuration while previewing literal values', () => {
  put('link1', component('link1', 5, 'Guidance', { description: '<a href="/guide.pdf">Old guidance</a>', weblinksetid: 'links' }));
  put('metadata1', component('metadata1', 16, 'Form hint', { entityform: 'form1', description: JSON.stringify([{ LCID: 1033, Value: '<p>Old hint</p>' }, { LCID: 1045, Value: '<p>Wskazowka</p>' }]) }));
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'rendered metadata');
  const baseline = new GitBaseline(dir, 'HEAD');
  const model = new PortalModel(dir);
  const sources = model.inlineSources.filter((source) => source.kind === 'metadata-markup');
  assert.equal(sources.length, 3);
  for (const source of sources.filter((entry) => entry.lcid !== 1045)) editSource(source, (text) => text.replace('Old', 'New'));
  assert.deepEqual(new PortalModel(dir).deploymentChanges(baseline, baseline.changedFiles()), []);
  const site = { ...SITE, markup: { ...SITE.markup, kinds: [...SITE.markup.kinds, 'metadata-markup'] } };
  const result = rewriter(site).rewrite('<html><body><a href="/guide.pdf">Old guidance</a><p>Old hint</p></body></html>', '/');
  assert.equal(result.applied.length, 2);
  assert.ok(result.html.includes('New guidance'));
  assert.ok(result.html.includes('New hint'));
  editField('metadata1', 'description', (text) => text.replace('1033', '1031'));
  assert.ok(new PortalModel(dir).deploymentChanges(baseline, baseline.changedFiles()).some((change) => change.rel.includes('metadata1') && change.reason.includes('description')));
});

test('enhanced attachment names cannot leave filecontent or point to directories', () => {
  fs.writeFileSync(path.join(dir, 'outside.js'), 'private local file');
  put('escape', component('escape', 3, 'Escape', { partialurl: 'escape.js', parentpageid: HOME }, { mime: 'application/javascript', name: '../../../outside.js' }));
  fs.mkdirSync(path.join(dir, 'powerpagecomponents', 'escape', 'filecontent'));
  put('directory', component('directory', 3, 'Directory', { partialurl: 'directory.js', parentpageid: HOME }, { mime: 'application/javascript', name: 'folder' }));
  fs.mkdirSync(path.join(dir, 'powerpagecomponents', 'directory', 'filecontent', 'folder'), { recursive: true });
  const model = new PortalModel(dir);
  assert.equal(model.findWebFile('/escape.js'), null);
  assert.equal(model.findWebFile('/directory.js'), null);
  assert.ok(model.warnings.some((w) => w.includes('Escape') && w.includes('filecontent')));
});

test('enhanced CDATA content is parsed and inactive components are not overlaid', () => {
  const js = 'console.log("< & >");';
  put('cdata', `<powerpagecomponent powerpagecomponentid="cdata"><content><![CDATA[${JSON.stringify({ source: js })}]]></content><name>CDATA</name><powerpagecomponenttype>8</powerpagecomponenttype></powerpagecomponent>`);
  put('inactive', component('inactive', 8, 'Deleted', { source: 'deleted source' }).replace('</powerpagecomponent>', '<statecode>1</statecode></powerpagecomponent>'));
  const model = new PortalModel(dir);
  assert.equal(sourceText(model.inlineSources.find((s) => s.rel.includes('/cdata/'))), js);
  assert.ok(!model.inlineSources.some((s) => s.rel.includes('/inactive/')));
});

test('enhanced content parsing respects CDATA boundaries, comments and split CDATA', () => {
  const value = 'const closing = "</content>"; const split = "]]>"; const entity = "&amp;";';
  const json = JSON.stringify({ source: value });
  const xml = `<powerpagecomponent><!-- <content>fake</content> --><content><![CDATA[${json.replaceAll(']]>', ']]]]><![CDATA[>')}]]></content><name>Real</name></powerpagecomponent>`;
  assert.equal(componentContent(xml).source, value);
  const span = componentContentSpan(xml);
  assert.ok(xml.slice(span.contentStart, span.contentEnd).startsWith('<![CDATA['));
  assert.equal(xml.slice(span.contentEnd, span.closeEnd), '</content>');
  assert.equal(componentContent('<content>{"source":"a"}</content><content>{"source":"b"}</content>'), null, 'duplicate content is ambiguous');
  assert.equal(componentContent('<content><![CDATA[{"source":"</content>"}</content>'), null, 'unterminated CDATA is not a closing element');
  assert.equal(componentContent('<content>{"source":"a"}<!-- </content> --></content>').source, 'a');
});

test('enhanced deployment diagnostics distinguish previewable source fields from portal metadata', () => {
  const baseline = new GitBaseline(dir, 'HEAD');
  editField(NEWS_EN, 'customjavascript', (text) => text + '\nconsole.log("preview");');
  let model = new PortalModel(dir);
  assert.deepEqual(model.deploymentChanges(baseline, baseline.changedFiles()), []);
  editField(NEWS_EN, 'title', () => 'Server-rendered title');
  model = new PortalModel(dir);
  const changes = model.deploymentChanges(baseline, baseline.changedFiles());
  assert.equal(changes.length, 1);
  assert.match(changes[0].reason, /title.*require deployment/);
  editField('x1', 'value', () => 'false');
  assert.ok(model.deploymentChanges(baseline, baseline.changedFiles()).some((change) => change.rel.includes('/x1/') && change.reason.includes('value')));
});

test('async enhanced indexing matches sync sources and cached XML refreshes only changed components', async (t) => {
  const synchronous = new PortalModel(dir);
  const model = await PortalModel.create(dir);
  assert.deepEqual(model.webFiles, synchronous.webFiles);
  assert.deepEqual(model.inlineSources.map((source) => [source.rel, source.pageUrl, sourceText(source)]), synchronous.inlineSources.map((source) => [source.rel, source.pageUrl, sourceText(source)]));
  const original = fs.readFileSync;
  let xmlReads = 0;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (String(file).endsWith('powerpagecomponent.xml')) xmlReads++;
    return original.call(this, file, ...args);
  });
  model.load();
  assert.equal(xmlReads, 0, 'unchanged XML metadata is reused after current path/stat validation');
  editField(NEWS_EN, 'customjavascript', () => 'console.log("changed");');
  xmlReads = 0;
  model.load();
  assert.equal(xmlReads, 1);
  const changed = model.inlineSources.find((source) => source.file === xmlOf(NEWS_EN) && source.field === 'customjavascript');
  assert.equal(sourceText(changed), 'console.log("changed");');
  fs.unlinkSync(xmlOf('s1'));
  model.load();
  assert.equal(model.xmlCache.has(xmlOf('s1')), false);
});
