// @test-kind contract: where the HTML rewriter may lay a local change: only over what the changed source itself wrote in the served page, in the language the page is served in, and what it reports for a field the page does not carry
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PortalModel } from '../lense/portal-model.mjs';
import { GitBaseline } from '../lense/git.mjs';
import { HtmlRewriter } from '../lense/html-rewriter.mjs';
import { createSourceInspector } from '../lense/source-inspection.mjs';
import { createFixture, SITE, HOME_ID } from './fixture.mjs';

let fx;
beforeEach(() => {
  fx = createFixture();
});
afterEach(() => fx.cleanup());

const rewriter = (site = SITE) =>
  new HtmlRewriter({ model: new PortalModel(fx.dir), site, baseline: new GitBaseline(fx.dir, 'HEAD') });
const indexFor = (route = '/') => createSourceInspector({ sourceDir: fx.dir }).sourceIndexFor(route);
const page = (body, attributes = '') =>
  `<!DOCTYPE html>\n<html${attributes}><head><title>Invented</title></head><body>\n${body}\n</body></html>\n`;
const template = (name, source) => {
  const folder = name.toLowerCase();
  fx.write(`web-templates/${folder}/${name}.webtemplate.yml`, `adx_name: ${name}\nadx_webtemplateid: ${folder}-id\n`);
  fx.write(`web-templates/${folder}/${name}.webtemplate.source.html`, source);
  return `web-templates/${folder}/${name}.webtemplate.source.html`;
};
const FORM_JS = 'basic-forms/contact/Contact.basicform.custom_javascript.js';
// A page with its root record and one language copy, as PAC exports it.
const contactPage = (fields = {}) => {
  fx.write(
    'web-pages/contact/Contact.webpage.yml',
    `adx_webpageid: contact-root\nadx_name: Contact\nadx_partialurl: contact\nadx_parentpageid: ${HOME_ID}\n`,
  );
  fx.write(
    'web-pages/contact/content-pages/Contact.en-US.webpage.yml',
    'adx_webpageid: contact-en\nadx_name: Contact\nadx_rootwebpageid: contact-root\nadx_partialurl: contact\n',
  );
  for (const [suffix, body] of Object.entries(fields))
    fx.write('web-pages/contact/content-pages/Contact.en-US.webpage.' + suffix, body);
  return (suffix) => 'web-pages/contact/content-pages/Contact.en-US.webpage.' + suffix;
};

test('a script a web template writes itself is never taken for a form custom script that shares its lines', async () => {
  const script =
    '$(document).ready(function () {\n  $("#name").attr("required", true);\n  $("#email").attr("required", true);\n  initTooltips();\n});';
  template('Widget', `<div class="widget" id="widget">\n<script>${script}</script>\n</div>`);
  fx.commit();
  const served = page(`<div class="widget" id="widget">\n<script>${script}</script>\n</div>`);
  // Without the export's view of the document the two scripts are close enough to be taken for one another.
  const blind = rewriter().rewrite(served, '/');
  assert.deepEqual(
    blind.matched.map((entry) => entry.rel),
    [FORM_JS],
  );
  const result = rewriter().rewrite(served, '/', { isDocument: true, sourceIndex: await indexFor() });
  assert.deepEqual(result.matched, [], 'the template script is not a form block');
  assert.deepEqual(result.applied, []);
  assert.match(result.html, /initTooltips\(\);/);
  const bound = result.provenance.bindings.find((binding) => binding.tag === 'script');
  assert.equal(bound.mapping, 'literal');
  assert.equal(result.provenance.sourceRefs.find((ref) => ref.id === bound.sourceRefId).name, 'Widget');
});

test('a changed line is laid over the page only where its own file wrote it', async () => {
  const card = (title) =>
    `<div class="card" id="news">\n  <h3 class="card-title">${title}</h3>\n  <p class="card-text">Read all about it</p>\n</div>\n`;
  const first = template('First', `<section class="first" id="first-area">\n${card('Latest news')}</section>\n`);
  template('Second', `<section class="second" id="second-area">\n${card('Latest news')}</section>\n`);
  fx.commit();
  fx.write(first, fx.read(first).replace('Latest news', 'Breaking news'));
  const index = await indexFor();
  // A page the unchanged template rendered: its card is not the changed file's.
  const other = rewriter().rewrite(
    page(`<section class="second" id="second-area">\n${card('Latest news')}</section>`),
    '/',
    {
      isDocument: true,
      sourceIndex: index,
    },
  );
  assert.doesNotMatch(other.html, /Breaking news/);
  assert.deepEqual(other.applied, []);
  // The page shows nothing of the changed file: there is no place for its change, and nothing to say about it.
  assert.deepEqual(other.notes, []);
  // A page that shows both templates gets the change in the changed file's card only.
  const both = rewriter().rewrite(
    page(
      `<section class="second" id="second-area">\n${card('Latest news')}</section>` +
        `<section class="first" id="first-area">\n${card('Latest news')}</section>`,
    ),
    '/',
    { isDocument: true, sourceIndex: index },
  );
  assert.match(both.html, /second-area[\s\S]*Latest news[\s\S]*first-area[\s\S]*Breaking news/);
  assert.equal(both.html.match(/Breaking news/g).length, 1);
  assert.deepEqual(
    both.applied.map((entry) => entry.rel),
    [first],
  );
  // A page the changed template rendered gets the change, bound to the changed file.
  const own = rewriter().rewrite(
    page(`<section class="first" id="first-area">\n${card('Latest news')}</section>`),
    '/',
    {
      isDocument: true,
      sourceIndex: index,
    },
  );
  assert.match(own.html, /<h3 class="card-title"[^>]*>Breaking news<\/h3>/);
  assert.deepEqual(
    own.applied.map((entry) => entry.rel),
    [first],
  );
  assert.deepEqual(own.notes, []);
});

test('the copy of the language a page is served in is the one laid over it', () => {
  const root = 'web-pages/contact/Contact.webpage.custom_javascript.js';
  const english = 'web-pages/contact/content-pages/Contact.en-US.webpage.custom_javascript.js';
  const french = 'web-pages/contact/content-pages/Contact.fr-FR.webpage.custom_javascript.js';
  const code = 'console.log("contact one");\nconsole.log("contact two");\nconsole.log("contact three");\n';
  fx.write(
    'web-pages/contact/Contact.webpage.yml',
    `adx_webpageid: contact-root\nadx_partialurl: contact\nadx_parentpageid: ${HOME_ID}\n`,
  );
  fx.write(
    'web-pages/contact/content-pages/Contact.en-US.webpage.yml',
    'adx_webpageid: contact-en\nadx_rootwebpageid: contact-root\nadx_partialurl: contact\n',
  );
  fx.write(
    'web-pages/contact/content-pages/Contact.fr-FR.webpage.yml',
    'adx_webpageid: contact-fr\nadx_rootwebpageid: contact-root\nadx_partialurl: contact\n',
  );
  for (const file of [root, english, french]) fx.write(file, code);
  fx.commit();
  fx.write(english, code.replace('contact two', 'contact two, edited'));
  const served = (language) => page(`<script>${code.trimEnd()}</script>`, ` lang="${language}"`);
  const result = rewriter().rewrite(served('en-US'), '/en-US/contact');
  assert.deepEqual(
    result.applied.map((entry) => entry.rel),
    [english],
    'identical copies do not make the English page ambiguous',
  );
  assert.match(result.html, /contact two, edited/);
  assert.deepEqual(result.notes, []);
  // The French page keeps what the portal served, by its address and by what the document declares.
  assert.doesNotMatch(rewriter().rewrite(served('fr-FR'), '/fr-FR/contact').html, /edited/);
  assert.doesNotMatch(rewriter().rewrite(served('fr-FR'), '/contact').html, /edited/);
  assert.match(rewriter().rewrite(served('en-US'), '/contact').html, /contact two, edited/);
});

test('a page field with local text that the served page does not carry is reported, and new form code says it needs a deployment', () => {
  const js = 'web-pages/about/content-pages/About.en-US.webpage.custom_javascript.js';
  const result = rewriter().rewrite(page('<main>No script here</main>'), '/about-us');
  assert.deepEqual(result.absent, [{ kind: 'page-js', rel: js, file: fx.file(js) }]);
  assert.deepEqual(rewriter().rewrite(page('<main>Elsewhere</main>'), '/scripts').absent, []);
});

test('an injected page style carries the nonce of the page and is bound to its field', async () => {
  const field = contactPage({ 'custom_css.css': '' });
  fx.commit();
  fx.write(
    field('custom_css.css'),
    '.contact-banner { color: teal; }\n.contact-note { margin: 0; }\n.contact-end { padding: 0; }\n',
  );
  const served = page('<main>Contact</main><script nonce="n-1">window.ready = true;</script>');
  const result = rewriter().rewrite(served, '/contact', { isDocument: true, sourceIndex: await indexFor('/contact') });
  assert.match(result.html, /<style type="text\/css" nonce="n-1"[^>]*>\.contact-banner/);
  const style = result.provenance.bindings.find((binding) => binding.tag === 'style');
  assert.deepEqual([style.mapping, style.origin], ['derived', 'served']);
  assert.equal(result.provenance.sourceRefs.find((ref) => ref.id === style.sourceRefId).fieldPath[0], 'customcss');
});

test('custom code with Liquid in it is recognised in the served page by its literal parts', async () => {
  contactPage({
    'custom_javascript.js':
      'const visitor = "{{ user.fullname }}";\nconsole.log("contact page for", visitor);\nwindow.contactReady = true;\n',
  });
  fx.commit();
  const served = page(
    '<script>const visitor = "Ada Lovelace";\nconsole.log("contact page for", visitor);\nwindow.contactReady = true;\n</script>',
  );
  const result = rewriter().rewrite(served, '/contact', { isDocument: true, sourceIndex: await indexFor('/contact') });
  const script = result.provenance.bindings.find((binding) => binding.tag === 'script');
  assert.deepEqual([script.mapping, script.origin], ['derived', 'served']);
  assert.equal(
    result.provenance.sourceRefs.find((ref) => ref.id === script.sourceRefId).fieldPath[0],
    'customjavascript',
  );
  // Another page's script with other text is not that field.
  const foreign = rewriter().rewrite(
    page('<script>const visitor = "Ada";\nconsole.log("other page");\n</script>'),
    '/contact',
    {
      isDocument: true,
      sourceIndex: await indexFor('/contact'),
    },
  );
  assert.equal(foreign.provenance.bindings.find((binding) => binding.tag === 'script').mapping, 'platform');
});

test('a change of a line whose text stands twice in the page goes to the place that line wrote', async () => {
  const note = (text) => `<p class="note" id="terms">${text}</p>`;
  const source = (second) =>
    `{% if first %}\n${note('Read the invented terms')}\n{% endif %}\n<hr class="rule" id="rule">\n{% if second %}\n${note(second)}\n{% endif %}\n`;
  const file = template('Notes', source('Read the invented terms'));
  fx.commit();
  fx.write(file, source('Read the changed terms'));
  const served = page(
    `${note('Read the invented terms')}\n<hr class="rule" id="rule">\n${note('Read the invented terms')}`,
  );
  // Without the export's view of the page the two places cannot be told apart.
  const blind = rewriter().rewrite(served, '/');
  assert.deepEqual(blind.applied, []);
  assert.match(blind.notes[0].reason, /occurs 2 times in the page, change not applied/);
  const result = rewriter().rewrite(served, '/', {
    isDocument: true,
    sourceIndex: await indexFor(),
    provenance: false,
  });
  assert.deepEqual(
    result.applied.map((entry) => entry.rel),
    [file],
  );
  assert.deepEqual(result.notes, []);
  assert.equal(
    result.html,
    served.replace(/Read the invented terms(?![\s\S]*Read the invented terms)/, 'Read the changed terms'),
    'only the second place, the one the changed line wrote, shows the change',
  );
});
