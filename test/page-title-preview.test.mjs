// @test-kind unproven: Lense previews a page title change where the document shell writes it HTML-encoded, as Mirage's shell does (lib/liquid.mjs htmlEscape(page.title)); no hosted capture of a title holding markup exists, so the encoding is inferred.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PortalModel } from '../lense/portal-model.mjs';
import { GitBaseline } from '../lense/git.mjs';
import { HtmlRewriter } from '../lense/html-rewriter.mjs';
import { auditResources } from '../lense/resource-audit.mjs';
import { editSource } from '../lense/source-edit.mjs';
import { createSourceInspector } from '../lense/source-inspection.mjs';
import { createFixture, SITE, HOME_ID } from './fixture.mjs';

// The default configuration enables metadata-markup previews (lense/config.mjs markup.kinds); the test SITE does not.
const site = { ...SITE, markup: { ...SITE.markup, kinds: [...SITE.markup.kinds, 'metadata-markup'] } };
let fx;
beforeEach(() => {
  fx = createFixture();
});
afterEach(() => fx.cleanup());

const TITLE_FILE = 'web-pages/contact/content-pages/Contact.en-US.webpage.yml';
const OLD = 'Contact <em>us</em> & "more"';
const NEW = "Write <b>to</b> Ada's desk";
const encoded = (text) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const served = (title) =>
  `<!DOCTYPE html>\n<html><head><title>\r\n\t\r\n\t\t${encoded(title)}\r\n\t\t\r\n</title></head><body>\n<main>Contact</main>\n</body></html>\n`;

function contactPage(title = OLD) {
  fx.write(
    'web-pages/contact/Contact.webpage.yml',
    `adx_webpageid: contact-root\nadx_name: Contact\nadx_partialurl: contact\nadx_parentpageid: ${HOME_ID}\n`,
  );
  fx.write(
    TITLE_FILE,
    `adx_webpageid: contact-en\nadx_name: Contact\nadx_rootwebpageid: contact-root\nadx_partialurl: contact\nadx_title: ${JSON.stringify(title)}\n`,
  );
}

const titleSource = (model) =>
  model.inlineSources.find((source) => source.file === fx.file(TITLE_FILE) && source.field === 'adx_title');
const rewriter = () =>
  new HtmlRewriter({ model: new PortalModel(fx.dir), site, baseline: new GitBaseline(fx.dir, 'HEAD') });

test('an HTML-shaped page title is a mapped page source, not deployment-only metadata', () => {
  contactPage();
  fx.commit();
  const model = new PortalModel(fx.dir);
  const source = titleSource(model);
  assert.equal(source.kind, 'metadata-markup');
  assert.equal(source.encoding, 'html-text');
  assert.equal(source.pageUrl, '/contact');
  const row = auditResources(model, site).resources.find(
    (item) => item.relativePath === TITLE_FILE && item.field === 'adx_title',
  );
  assert.equal(row.status, 'mapped');
  assert.equal(row.strategy, 'baseline-patch');
  assert.equal(row.deploymentCode, undefined);
});

test('a title edit is laid over the encoded <title> text of its own page only', () => {
  contactPage();
  fx.commit();
  editSource(titleSource(new PortalModel(fx.dir)), () => NEW);
  const baseline = new GitBaseline(fx.dir, 'HEAD');
  assert.deepEqual(new PortalModel(fx.dir).deploymentChanges(baseline, baseline.changedFiles()), []);
  const result = rewriter().rewrite(served(OLD), '/contact/');
  assert.deepEqual(
    result.applied.map((entry) => entry.rel),
    [`${TITLE_FILE}#adx_title`],
  );
  assert.equal(result.html, served(NEW));
  // Another page that happens to print the same text keeps it.
  const other = rewriter().rewrite(served(OLD), '/');
  assert.equal(other.html, served(OLD));
  assert.deepEqual(other.applied, []);
});

test('with the export index the title edit still lands in <title>', async () => {
  contactPage();
  fx.commit();
  editSource(titleSource(new PortalModel(fx.dir)), () => NEW);
  const sourceIndex = await createSourceInspector({ sourceDir: fx.dir }).sourceIndexFor('/contact/');
  const result = rewriter().rewrite(served(OLD), '/contact/', { isDocument: true, sourceIndex });
  assert.match(result.html, new RegExp(`<title[^>]*>\\r\\n\\t\\r\\n\\t\\t${encoded(NEW)}\\r\\n`));
  assert.ok(!result.html.includes(encoded(OLD)));
});

test('a title of a page whose URL cannot be resolved is blocked, not laid over every page', () => {
  fx.write(
    'web-pages/lost/Lost.webpage.yml',
    'adx_webpageid: lost-root\nadx_name: Lost\nadx_partialurl: lost\nadx_parentpageid: missing-parent\nadx_title: "<i>Lost</i>"\n',
  );
  fx.commit();
  const model = new PortalModel(fx.dir);
  const source = model.inlineSources.find((item) => item.field === 'adx_title' && item.file.includes('Lost'));
  assert.equal(source.pageUrl, null);
  const row = auditResources(model, site).resources.find((item) => item.field === 'adx_title');
  assert.equal(row.status, 'blocked');
  assert.equal(row.deploymentCode, 'unresolved-page-url');
  editSource(source, () => '<i>Found</i>');
  const result = rewriter().rewrite(served('<i>Lost</i>'), '/');
  assert.equal(result.html, served('<i>Lost</i>'));
  assert.ok(
    result.notes.concat(rewriter().unsupported).some((note) => /page URL cannot be resolved/.test(note.reason)),
  );
});
