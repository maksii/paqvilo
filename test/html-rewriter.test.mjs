import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PortalModel } from '../lense/portal-model.mjs';
import { GitBaseline } from '../lense/git.mjs';
import { pathToFileURL } from 'node:url';
import { HtmlRewriter, pageKey, INLINE_PREFIX, inlineScriptUrl } from '../lense/html-rewriter.mjs';
import { withFileSourceMap } from '../lense/source-map.mjs';
import { createFixture, SITE, ONLINE_HOME } from './fixture.mjs';

let fx;
beforeEach(() => {
  fx = createFixture();
});
afterEach(() => fx.cleanup());

function rewriter(site = SITE) {
  return new HtmlRewriter({ model: new PortalModel(fx.dir), site, baseline: new GitBaseline(fx.dir, 'HEAD') });
}

const CSS = 'web-pages/home/content-pages/Home.en-US.webpage.custom_css.css';
const PAGE_JS = 'web-pages/home/content-pages/Home.en-US.webpage.custom_javascript.js';
const FORM_JS = 'basic-forms/contact/Contact.basicform.custom_javascript.js';
const HEADER = 'web-templates/header/Header.webtemplate.source.html';
const FOOTER = 'content-snippets/footer-text/Footer-Text.en-US.contentsnippet.value.html';

test('a page identical to the local sources is returned untouched', () => {
  const result = rewriter().rewrite(ONLINE_HOME, '/');
  assert.equal(result.html, ONLINE_HOME);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.matched.map((m) => m.kind).sort(), ['basic-form-js', 'page-css']);
  assert.ok(result.matched.every((m) => m.identical));
});

test('page custom CSS: the inline <style> is replaced by the local file', () => {
  fx.write(CSS, fx.read(CSS).replace('color: red', 'color: green'));
  const result = rewriter().rewrite(ONLINE_HOME, '/');
  assert.ok(result.html.includes('color: green'));
  assert.ok(!result.html.includes('color: red'));
  assert.deepEqual(result.applied.map((a) => a.rel), [CSS]);
  // the element and everything around it are intact, in the page's own line endings
  assert.ok(result.html.includes('<style type="text/css">.hero {\r\n  color: green;\r\n}'));
  assert.equal(result.html.replace('color: green', 'color: red'), ONLINE_HOME);
});

test('page custom CSS is only applied on its own page (also under a language prefix)', () => {
  fx.write(CSS, fx.read(CSS).replace('color: red', 'color: green'));
  const r = rewriter();
  assert.equal(r.rewrite(ONLINE_HOME, '/about-us').html.includes('color: green'), false);
  assert.equal(r.rewrite(ONLINE_HOME, '/en-US/').html.includes('color: green'), true);
  assert.equal(pageKey('/en-US/About-Us/', r.model), '/about-us');
  assert.equal(pageKey('/en-US', r.model), '/');
  assert.equal(pageKey('/unknown/'), '/unknown');
});

test('real short routes stay distinct from home and exported language prefixes for blocks and markup', () => {
  for (const slug of ['it', 'ui']) {
    fx.write(`web-pages/${slug}/${slug}.webpage.yml`, `adx_webpageid: route-${slug}\nadx_name: ${slug}\nadx_partialurl: ${slug}\nadx_parentpageid: 00000000-0000-0000-0000-000000000001`);
    fx.write(`web-pages/${slug}/${slug}.webpage.custom_css.css`, fx.read(CSS));
    fx.write(`web-pages/${slug}/${slug}.webpage.copy.html`, '<h2>Original section</h2>');
  }
  fx.write('websitelanguage.yml', '- adx_websitelanguageid: lang-fr\n  adx_name: French - France\n  adx_languagecode: fr-FR');
  fx.commit();
  fx.write(CSS, fx.read(CSS).replace('color: red', 'color: green'));
  fx.write('web-pages/it/it.webpage.custom_css.css', fx.read(CSS).replace('color: green', 'color: navy'));
  fx.write('web-pages/it/it.webpage.copy.html', '<h2>Edited section</h2>');
  const r = rewriter();
  const online = ONLINE_HOME + '<h2>Original section</h2>';
  assert.equal(r.rewrite(online, '/').html.includes('color: green'), true);
  assert.equal(r.rewrite(online, '/it').html.includes('color: navy'), true);
  assert.equal(r.rewrite(online, '/it').html.includes('Edited section'), true);
  assert.equal(r.rewrite(online, '/ui').html.includes('color: green'), false);
  assert.equal(r.rewrite(online, '/ui').html.includes('Edited section'), false);
  assert.equal(r.rewrite(online, '/fr-FR/it').html.includes('color: navy'), true);
  assert.equal(r.rewrite(online, '/fr-FR/ui').html.includes('color: green'), false);
  assert.equal(r.rewrite(online, '/zz-ZZ/').html.includes('color: green'), false);
  assert.equal(pageKey('/it', r.model), '/it');
  assert.equal(pageKey('/ui', r.model), '/ui');
  assert.equal(pageKey('/fr-FR/it', r.model), '/it');
});

test('form custom JS: found by similarity on any page, `$` in the code survives', () => {
  fx.write(FORM_JS, fx.read(FORM_JS).replace('validate();', () => 'validate();\n  var total = "$&-$1-$$";'));
  const result = rewriter().rewrite(ONLINE_HOME, '/some/other/page');
  assert.ok(result.html.includes('var total = "$&-$1-$$";'));
  assert.ok(result.html.includes('var price = "$1";'));
  assert.deepEqual(result.applied.map((a) => a.kind), ['basic-form-js']);
});

test('a block is still recognised after a heavy local rewrite, through the baseline', () => {
  fx.write(FORM_JS, 'import("/scripts/app.js").then(function (m) {\n  m.start();\n});\n');
  const result = rewriter().rewrite(ONLINE_HOME, '/');
  assert.ok(result.html.includes('m.start();'));
  assert.ok(!result.html.includes('$("#name")'));
});

test('custom JS emptied locally removes the online block content', () => {
  fx.write(FORM_JS, '');
  const result = rewriter().rewrite(ONLINE_HOME, '/');
  assert.ok(!result.html.includes('$("#name")'));
  assert.ok(result.html.includes('<form><script type="text/javascript"></script></form>'));
});

test('short scripts that only share boilerplate are not mistaken for each other', () => {
  const form = (call) => `var ExampleApp = ExampleApp || {};\n\n$( document ).ready(function() {\n  ${call}\n});\n`;
  fx.write('basic-forms/a/A.basicform.custom_javascript.js', form('ExampleApp.Finalization.paymentContentEdit();'));
  fx.write('basic-forms/b/B.basicform.custom_javascript.js', form('ExampleApp.Finalization.paymentContentAdd();'));
  fx.write('basic-forms/c/C.basicform.custom_javascript.js', form('ExampleApp.Products.load();\n  ExampleApp.Products.sort();\n  ExampleApp.Products.show();'));
  // online: a fourth form, not in the checkout, built from the same boilerplate
  const online = `<html><body><script>${form('ExampleApp.Core.AddControlExtension();')}</script></body></html>`;
  const result = rewriter().rewrite(online, '/any');
  assert.equal(result.html, online);
  assert.deepEqual(result.matched, []);
  // while a real, drifted copy of one of them is still recognised
  const drifted = `<html><body><script>${form('ExampleApp.Products.load();\n  ExampleApp.Products.sort();\n  ExampleApp.Products.show();\n  ExampleApp.Products.newerOnlineCall();')}</script></body></html>`;
  const hit = rewriter().rewrite(drifted, '/any');
  assert.deepEqual(hit.applied.map((a) => a.rel), ['basic-forms/c/C.basicform.custom_javascript.js']);
});

test('non-code script elements and external scripts are never touched', () => {
  fx.write(FORM_JS, '{"keep":"me"}\n');
  const result = rewriter().rewrite(ONLINE_HOME, '/');
  assert.ok(result.html.includes('<script type="application/json">{"keep":"me"}</script>'));
});

test('new page custom JS that is not online yet is injected into its page only', () => {
  fx.write(PAGE_JS, 'window.fresh = 1;\n');
  const r = rewriter();
  const home = r.rewrite(ONLINE_HOME, '/');
  assert.ok(home.html.includes('<script type="text/javascript">\nwindow.fresh = 1;\n\n</script>\n</body>'));
  assert.equal(home.applied[0].action, 'injected (not online yet)');
  assert.ok(!r.rewrite(ONLINE_HOME, '/about-us').html.includes('window.fresh'));
  const off = rewriter({ ...SITE, inline: { ...SITE.inline, injectMissingPageBlocks: false } });
  assert.ok(!off.rewrite(ONLINE_HOME, '/').html.includes('window.fresh'));
});

test('web template: a literal change is patched into the rendered page', () => {
  fx.write(HEADER, fx.read(HEADER).replace('<a href="/about-us">About us</a>', '<a href="/about-us">About</a>\n    <a href="/contact">Contact</a>'));
  const result = rewriter().rewrite(ONLINE_HOME, '/');
  assert.ok(result.html.includes('    <a href="/about-us">About</a>\r\n    <a href="/contact">Contact</a>\r\n  </nav>'));
  assert.deepEqual(result.applied, [{ kind: 'web-template', rel: HEADER, action: 'patched 1 change' }]);
  assert.deepEqual(result.notes, []);
});

test('web template: {{ values }} on a changed line keep what the portal rendered', () => {
  fx.write(HEADER, fx.read(HEADER).replace('<span class="who">Signed in as {{ user.fullname }}</span>', '<b class="who">{{ user.fullname }} is signed in</b>'));
  const result = rewriter().rewrite(ONLINE_HOME, '/');
  assert.ok(result.html.includes('<b class="who">Ada Lovelace is signed in</b>'));
  assert.ok(!result.html.includes('Signed in as'));
});

test('web template: a new {{ snippets[...] }} is filled from the local snippet', () => {
  fx.write(HEADER, fx.read(HEADER).replace('  </nav>', "    <em>{{ snippets['Promo'] }}</em>\n  </nav>"));
  const result = rewriter().rewrite(ONLINE_HOME, '/');
  assert.ok(result.html.includes('<em>Fresh promo text</em>\r\n  </nav>'));
});

test('web template: a new {{ value }} only the portal can evaluate is reported, not guessed', () => {
  fx.write(HEADER, fx.read(HEADER).replace('  </nav>', '    <em>{{ user.email }}</em>\n  </nav>'));
  const result = rewriter().rewrite(ONLINE_HOME, '/');
  assert.equal(result.html, ONLINE_HOME);
  assert.match(result.notes[0].reason, /user\.email.*only the portal can evaluate/);
});

test('web template: a change to Liquid tags is listed as needing a deployment', () => {
  fx.write(HEADER, fx.read(HEADER).replace('{% if user %}', '{% if user and user.roles %}'));
  const r = rewriter();
  assert.equal(r.rewrite(ONLINE_HOME, '/').html, ONLINE_HOME);
  assert.equal(r.unsupported.length, 1);
  assert.match(r.unsupported[0].reason, /Liquid tags/);
});

test('web template: literal and Liquid changes in one file are handled independently', () => {
  fx.write(HEADER, fx.read(HEADER).replace('{% if user %}', '{% if user.roles %}').replace('About us', 'About the agency'));
  const r = rewriter();
  assert.ok(r.rewrite(ONLINE_HOME, '/').html.includes('About the agency'));
  assert.equal(r.unsupported.length, 1);
});

test('web template: removed lines disappear from the page', () => {
  fx.write(HEADER, fx.read(HEADER).replace('  <nav class="main-nav">\n    <a href="/about-us">About us</a>\n  </nav>\n', ''));
  const result = rewriter().rewrite(ONLINE_HOME, '/');
  assert.ok(!result.html.includes('main-nav'));
  assert.ok(result.html.includes('  \r\n</header>'));
});

test('content snippet: changed text is patched wherever the snippet is printed', () => {
  fx.write(FOOTER, 'All rights reserved by the agency, 2026.');
  const twice = ONLINE_HOME.replace('</footer>', '</footer><p>All rights reserved by the agency.</p>');
  const result = rewriter().rewrite(twice, '/');
  assert.equal(result.html.split('All rights reserved by the agency, 2026.').length - 1, 2);
  assert.equal(result.applied[0].action, 'patched 2 changes');
});

test('a short snippet is only replaced where it stands on its own', () => {
  fx.write('content-snippets/save/Save.en-US.contentsnippet.yml', 'adx_name: Buttons/Save\n');
  fx.write('content-snippets/save/Save.en-US.contentsnippet.value.html', 'Save');
  fx.commit();
  fx.write('content-snippets/save/Save.en-US.contentsnippet.value.html', 'Save draft');
  const page =
    '<button id="SaveButton" onclick="SaveForm()">Save</button>\n<input value="Save">\n<p>Save your work often</p>\n<script>function SaveForm(){ $("#SaveButton").click(); var label = "Save"; }</script>';
  const result = rewriter().rewrite(page, '/');
  assert.equal(
    result.html,
    '<button id="SaveButton" onclick="SaveForm()">Save draft</button>\n<input value="Save draft">\n<p>Save your work often</p>\n<script>function SaveForm(){ $("#SaveButton").click(); var label = "Save draft"; }</script>',
  );
});

test('a template change and a change to the snippet printed on that line both apply', () => {
  const tpl = 'web-templates/foot/Foot.webtemplate.source.html';
  fx.write(tpl, '<main>\n<footer>{{ snippets["Footer/Text"] }}</footer>\n</main>\n');
  fx.commit();
  fx.write(tpl, '<main>\n<footer class="dark">{{ snippets["Footer/Text"] }}</footer>\n</main>\n');
  fx.write(FOOTER, 'Copyright 2026.');
  const page = '<main>\n<footer>All rights reserved by the agency.</footer>\n</main>\n';
  const result = rewriter().rewrite(page, '/');
  assert.equal(result.html, '<main>\n<footer class="dark">Copyright 2026.</footer>\n</main>\n');
});

test('a line with several {{ values }} is matched in linear time on a large page', () => {
  const tpl = 'web-templates/menu/Menu.webtemplate.source.html';
  fx.write(tpl, '<ul>\n<li><a href="{{ link.url }}">{{ link.title }}</a></li>\n</ul>\n');
  fx.commit();
  fx.write(tpl, '<ul>\n<li class="item"><a href="{{ link.url }}">{{ link.title }}</a></li>\n</ul>\n');
  // thousands of lines that start like the changed one but never complete it
  const noise = '<li><a href="/x">x</a> <span>y</span>\n'.repeat(12_000);
  const page = `${noise}<ul>\n<li><a href="/about">About</a></li>\n</ul>\n${noise}`;
  const started = Date.now();
  const result = rewriter().rewrite(page, '/');
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.ok(result.html.includes('<li class="item"><a href="/about">About</a></li>'));
});

test('data responses (JSON) only take web template changes, never snippet text', () => {
  fx.write(FOOTER, 'All "rights" reserved.');
  const json = '{"footer":"All rights reserved by the agency."}';
  assert.equal(rewriter().rewrite(json, '/api', { html: false }).html, json);
});

test("scope 'changed': an edited form does not take over the script of a similar, untouched form", () => {
  const body = (extra) => `$(document).ready(function () {\n  setup("${extra}");\n  bindLookup();\n  bindDates();\n  bindTotals();\n  validateAll();\n});\n`;
  fx.write('basic-forms/order/Order.basicform.custom_javascript.js', body('order'));
  fx.write('basic-forms/quote/Quote.basicform.custom_javascript.js', body('quote'));
  fx.commit();
  fx.write('basic-forms/quote/Quote.basicform.custom_javascript.js', body('quote') + 'quoteOnly();\n');
  const orderPage = `<html><body><script>${body('order')}</script></body></html>`;
  const quotePage = `<html><body><script>${body('quote')}</script></body></html>`;
  const r = rewriter({ ...SITE, scope: 'changed' });
  assert.equal(r.rewrite(orderPage, '/order').html, orderPage);
  assert.ok(r.rewrite(quotePage, '/quote').html.includes('quoteOnly();'));
});

test('one local script never replaces two different online scripts', () => {
  const a = '$(function () {\n  alpha();\n  beta();\n  gamma();\n  delta();\n});';
  const b = '$(function () {\n  alpha();\n  beta();\n  gamma();\n  epsilon();\n});';
  fx.write(FORM_JS, '$(function () {\n  alpha();\n  beta();\n  gamma();\n  delta();\n  local();\n});\n');
  const page = `<html><body><script>${a}</script><script>${b}</script></body></html>`;
  const result = rewriter().rewrite(page, '/');
  assert.equal(result.html.split('local();').length - 1, 1);
  assert.ok(result.html.includes('epsilon();'));
});

test('a page that does not use the changed template is left alone, silently', () => {
  fx.write(HEADER, fx.read(HEADER).replace('About us', 'About'));
  const other = '<html><body><p>nothing of the header here</p></body></html>';
  const result = rewriter().rewrite(other, '/');
  assert.equal(result.html, other);
  assert.deepEqual(result.notes, []);
});

test('a new template is reported: it does not exist online', () => {
  fx.write('web-templates/new/New.webtemplate.source.html', '<div>new</div>\n');
  const r = rewriter();
  assert.match(r.unsupported.find((u) => u.rel.includes('New.webtemplate')).reason, /does not exist online yet/);
});

test("scope 'changed': unchanged local blocks do not override the online ones", () => {
  // online is ahead of the checkout for the form script; the developer only edits the CSS
  const ahead = ONLINE_HOME.replace('  validate();', '  validate();\r\n  newerOnlineCall();');
  fx.write(CSS, fx.read(CSS).replace('color: red', 'color: green'));
  const all = rewriter({ ...SITE, scope: 'all' }).rewrite(ahead, '/');
  assert.ok(!all.html.includes('newerOnlineCall'), "scope 'all' puts the local form script over the newer online one");
  const changed = rewriter({ ...SITE, scope: 'changed' }).rewrite(ahead, '/');
  assert.ok(changed.html.includes('newerOnlineCall'));
  assert.ok(changed.html.includes('color: green'));
});

test('sourceMaps: a recognised inline script is loaded from its local file, in place', () => {
  const r = new HtmlRewriter({ model: new PortalModel(fx.dir), site: SITE, baseline: new GitBaseline(fx.dir, 'HEAD'), sourceMaps: true });
  const result = r.rewrite(ONLINE_HOME.replace('<script type="text/javascript">$(', '<script defer type="text/javascript">$('), '/');
  assert.ok(result.html.includes(`<form><script type="text/javascript" src="${INLINE_PREFIX}basic-forms/contact/Contact.basicform.custom_javascript.js"></script></form>`));
  // not an override: the script is the same as online, only where it is loaded from changed
  assert.deepEqual(result.applied, []);
  // styles and data blocks stay inline
  assert.ok(result.html.includes('<style type="text/css">.hero {'));
  assert.ok(result.html.includes('<script type="application/json">{"keep":"me"}</script>'));
});

test('sourceMaps: new page JS is injected as a script file too', () => {
  fx.write(PAGE_JS, 'window.fresh = 1;\n');
  const r = new HtmlRewriter({ model: new PortalModel(fx.dir), site: SITE, baseline: new GitBaseline(fx.dir, 'HEAD'), sourceMaps: true });
  const html = r.rewrite(ONLINE_HOME, '/').html;
  assert.ok(html.includes(`<script type="text/javascript" src="${inlineScriptUrl(PAGE_JS)}"></script>\n</body>`));
});

test('the source map of a served file points every line at the same line of the local file', () => {
  const file = fx.file('web-files/app.js');
  const body = Buffer.from('one();\r\ntwo();\r\nthree();');
  const served = withFileSourceMap(body, file).toString();
  assert.ok(served.startsWith('one();\r\ntwo();\r\nthree();\n//# sourceMappingURL=data:application/json'));
  const map = JSON.parse(Buffer.from(served.split('base64,')[1].trim(), 'base64').toString());
  assert.deepEqual(map.sources, [pathToFileURL(file).href]);
  assert.equal(map.mappings, 'AAAA;AACA;AACA');
  // a file that brings its own map is served as it is
  const own = Buffer.from('x();\n//# sourceMappingURL=app.js.map\n');
  assert.equal(withFileSourceMap(own, file), own);
});

test('disabled kinds are ignored', () => {
  fx.write(CSS, fx.read(CSS).replace('color: red', 'color: green'));
  fx.write(FOOTER, 'changed');
  const site = { ...SITE, inline: { ...SITE.inline, kinds: ['page-js'] }, markup: { ...SITE.markup, enabled: false } };
  assert.equal(rewriter(site).rewrite(ONLINE_HOME, '/').html, ONLINE_HOME);
});

test('refresh() picks up edits made after construction', () => {
  const r = rewriter();
  assert.equal(r.rewrite(ONLINE_HOME, '/').html, ONLINE_HOME);
  fx.write(FOOTER, 'Edited footer.');
  r.refresh();
  assert.ok(r.rewrite(ONLINE_HOME, '/').html.includes('<footer>Edited footer.</footer>'));
});
