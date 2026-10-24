import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parse } from 'parse5';

// /_setup/ and /_sim/ are two areas of one product with one shell, one stylesheet set and the same components.
const read = (file) => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const pages = {
  setup: ['lense/setup/index.html', '/_setup/', 'PROJECT SETUP'],
  sim: ['mirage/admin/index.html', '/__sim/', 'SIMULATOR WORKSPACE'],
};

const attr = (node, name) => node.attrs?.find((attribute) => attribute.name === name)?.value;
const hasClass = (node, name) => (attr(node, 'class') ?? '').split(/\s+/).includes(name);
const descendants = (node) => [node, ...(node.childNodes ?? []).flatMap(descendants)];
const visibleText = (node) =>
  attr(node, 'aria-hidden') === 'true'
    ? ''
    : node.nodeName === '#text'
      ? node.value
      : (node.childNodes ?? []).map(visibleText).join('');
const text = (node) => visibleText(node).replace(/\s+/g, ' ').trim();
function one(nodes, predicate, label) {
  const matches = nodes.filter(predicate);
  assert.equal(matches.length, 1, label);
  return matches[0];
}

test('both areas serve the shared shell markup and cascade the shared sheets before their page sheet', async () => {
  for (const [name, [file, prefix, kind]] of Object.entries(pages)) {
    const html = await read(file);
    const nodes = descendants(parse(html));
    const sheets = nodes
      .filter((node) => node.tagName === 'link' && attr(node, 'rel') === 'stylesheet')
      .map((node) => attr(node, 'href'));
    assert.deepEqual(
      sheets.slice(0, 4),
      ['ui-kit.css', 'shell.css', 'dashboard.css', 'style.css'].map((sheet) => prefix + sheet),
      name,
    );
    const sidebar = one(nodes, (node) => node.tagName === 'aside' && hasClass(node, 'sidebar'), `${name}: sidebar`);
    one(nodes, (node) => node.tagName === 'header' && hasClass(node, 'topbar'), `${name}: topbar`);
    one(descendants(sidebar), (node) => hasClass(node, 'sidebar-bottom'), `${name}: sidebar status`);
    one(nodes, (node) => node.tagName === 'footer', `${name}: footer`);
    const skip = one(nodes, (node) => node.tagName === 'a' && hasClass(node, 'skip-link'), `${name}: skip link`);
    assert.equal(attr(skip, 'href'), '#main');
    assert.equal(
      attr(
        one(nodes, (node) => node.tagName === 'main' && attr(node, 'id') === 'main', `${name}: main`),
        'tabindex',
      ),
      '-1',
    );
    one(descendants(sidebar), (node) => hasClass(node, 'area-label') && text(node) === 'AREAS', `${name}: area label`);
    const areas = one(
      descendants(sidebar),
      (node) => node.tagName === 'nav' && attr(node, 'aria-label') === 'Areas',
      `${name}: areas navigation`,
    );
    const links = descendants(areas).filter((node) => node.tagName === 'a');
    assert.equal(links.length, 2, `${name}: product areas`);
    const setup = one(links, (node) => text(node) === 'Project setup', `${name}: setup area`);
    const simulator = one(links, (node) => text(node).startsWith('Simulator workspace'), `${name}: simulator area`);
    assert.equal(attr(setup, 'href'), '/_setup/');
    assert.equal(
      one(links, (node) => attr(node, 'aria-current') === 'page', `${name}: current area`),
      name === 'setup' ? setup : simulator,
    );
    if (name === 'setup') {
      assert.equal(attr(simulator, 'aria-disabled'), 'true');
      assert.equal(attr(simulator, 'href'), undefined);
    } else assert.equal(attr(simulator, 'href'), '/_sim/');
    const brand = one(
      descendants(sidebar),
      (node) => node.tagName === 'a' && hasClass(node, 'brand'),
      `${name}: brand`,
    );
    assert.equal(attr(brand, 'href'), prefix);
    const symbol = one(descendants(brand), (node) => hasClass(node, 'brand-symbol'), `${name}: brand symbol`);
    assert.equal(attr(symbol, 'aria-hidden'), 'true');
    assert.equal(symbol.childNodes.map((node) => node.value ?? '').join(''), 'P');
    assert.ok(text(brand).startsWith('Paqvilo'), `${name}: product name`);
    one(descendants(brand), (node) => node.tagName === 'small' && text(node) === kind, `${name}: area identity`);
  }
});
