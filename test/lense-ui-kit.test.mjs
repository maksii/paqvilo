// @test-kind contract: Lense is one component; the dev panel, X-ray, the evidence renderer and the model-driven Actions draw with one kit (lense/ui-kit.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { lenseUiKit } from '../lense/ui-kit.mjs';
import { panelUi } from '../lense/panel-ui.mjs';
import { xrayUi } from '../lense/xray-ui.mjs';
import { renderInspectionEvidence } from '../lense/inspection-evidence-ui.mjs';

const kit = lenseUiKit();
const read = (file) => fs.readFileSync(new URL(`../lense/${file}`, import.meta.url), 'utf8');
// Every file that draws Lense in the page.
const UI_FILES = [
  'panel-ui.mjs',
  'xray-ui.mjs',
  'inspection-evidence-ui.mjs',
  'model-driven-actions-ui.mjs',
  'model-driven-inspector-ui.mjs',
];
// The files with a style sheet of their own besides the kit.
const SHEET_FILES = ['panel-ui.mjs', 'xray-ui.mjs', 'inspection-evidence-ui.mjs', 'model-driven-actions-ui.mjs'];

/** The template literal that starts at the first backtick after `from`, without its ${...} parts. */
const templateAt = (source, from) => {
  let at = source.indexOf('`', from) + 1,
    out = '';
  while (at < source.length && source[at] !== '`') {
    if (source[at] === '\\') {
      out += source.slice(at, at + 2);
      at += 2;
    } else if (source.startsWith('${', at)) {
      let depth = 0;
      for (; at < source.length; at++) {
        if (source[at] === '{') depth++;
        else if (source[at] === '}' && --depth === 0) break;
      }
      at++;
    } else out += source[at++];
  }
  return out;
};
/** The CSS a file adds besides the kit: its constructed sheets and the evidence renderer's styles part. */
const cssOf = (file) => {
  const source = read(file);
  const css = [];
  for (const marker of /** @type {const} */ (['replaceSync(`', 'const CSS = `', "options.part === 'styles')"])) {
    for (let at = source.indexOf(marker); at >= 0; at = source.indexOf(marker, at + 1))
      css.push(templateAt(source, at + marker.length - (marker.endsWith('`') ? 1 : 0)));
  }
  return css.join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
};
/** [selector, declarations] of every innermost rule (rules inside @media included). */
const rules = (css) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => [
    selector.trim(),
    body.trim(),
  ]);

// The kit's controls and rows: no host restyles their look. A host may lay them out (margin, flex, width, padding,
// position, wrapping); colour, type, borders, backgrounds and focus rings are the kit's.
const SHARED = ['btn', 'seg', 'search', 'empty', 'banner', 'n', 'ib', 'f', 'gh', 'row', 'main', 'name', 'sub', 'c'];
const SHARED_ELEMENTS = ['kbd', 'button', 'select', 'svg'];
const LOOK = /^(?:font|color|background|border|box-shadow|outline|text-decoration|line-height|letter-spacing)/;
const lastCompound = (selector) => selector.split(/\s*[>+~\s]\s*/).at(-1);
const touchesShared = (selector) =>
  selector.split(',').some((part) => {
    const compound = lastCompound(part.trim());
    const classes = [...compound.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
    const element = /^[a-z]+/.exec(compound)?.[0];
    return classes.some((name) => SHARED.includes(name)) || SHARED_ELEMENTS.includes(element);
  });

test('the panel embeds the kit and draws its icons from it', () => {
  const source = panelUi.toString();
  assert.match(source, /const lenseUiKit=\(function lenseUiKit\(\)/);
  const own = read('panel-ui.mjs');
  assert.match(own, /const \{ ICON, icon, kindLabel, displayPath \} = kit;/);
  assert.doesNotMatch(own, /const ICON = \{/, 'the panel keeps no icon set of its own');
  assert.doesNotMatch(own, /const KIND = \{/, 'row kinds come from the kit');
  assert.match(own, /\$\{kit\.tokens\}/, 'the panel theme is the kit tokens');
  assert.match(own, /kit\.css \+/, 'the panel style sheet starts with the kit');
});

test('no Lense style sheet defines a kit control or row again', () => {
  const BASE = [
    ...SHARED.map((name) => `.${name}`),
    '.ib:hover',
    '.f.on',
    '.btn:hover',
    '.btn.sec',
    '.row:hover',
    '.ico',
    '.acts',
    '.what',
    '.c.edited',
    '.c.diff',
    '.c.st',
    ...SHARED_ELEMENTS,
    'button:disabled',
  ];
  for (const file of SHEET_FILES)
    for (const [selector] of rules(cssOf(file)))
      for (const part of selector.split(',').map((item) => item.trim()))
        assert.ok(!BASE.includes(part), `${file}: "${part}" is the kit's`);
});

test('no Lense style sheet restyles a kit control, row or chip; only the kit draws them', () => {
  for (const file of SHEET_FILES) {
    const css = cssOf(file);
    assert.ok(css.length > 100, `${file}: its style sheet is found`);
    for (const [selector, body] of rules(css)) {
      if (!touchesShared(selector)) continue;
      const look = body
        .split(';')
        .map((declaration) => declaration.split(':')[0].trim())
        .filter((property) => LOOK.test(property));
      assert.deepEqual(look, [], `${file}: "${selector}" restyles a kit class`);
    }
    // The focus ring is the kit's too.
    for (const [selector, body] of rules(css))
      if (/:focus-visible/.test(selector)) assert.doesNotMatch(body, /outline\s*:/, `${file}: "${selector}"`);
  }
});

test('the kit defines the shared controls once: buttons, segmented control, search, banner, empty state, counts', () => {
  const kitRules = rules(kit.css).map(([selector]) => selector);
  for (const selector of ['.btn', '.btn.sec', '.seg', '.search', '.banner', '.empty', 'kbd', '.n', '.ico'])
    assert.ok(kitRules.includes(selector), selector);
  for (const tone of ['ok', 'warn', 'bad', 'muted'])
    assert.ok(
      kitRules.some((selector) => selector.split(',').some((s) => s.trim() === `.c.${tone}`)),
      tone,
    );
  // Dark mode is a token set, so every host follows it.
  assert.match(kit.tokens, /color-scheme: light dark/);
  assert.match(kit.tokens, /--bg: light-dark\(/);
  // One kind, one label; the label is a word, its tooltip names the kind in full.
  assert.deepEqual(kit.kindLabel('web-template'), ['Template', 'Web template']);
  assert.deepEqual(kit.kindLabel('advanced-form'), ['Multistep form', 'Multistep form']);
  assert.equal(kit.kindLabel('invented-kind'), null);
  // A Solution file named by an ID shows "{…}" in its place; the full path stays for the tooltip and copying.
  assert.equal(
    kit.displayPath('solution/Entities/fxw_project/FormXml/main/{1a2b3c4d-0000-4000-8000-00000000abcd}.xml'),
    'solution/Entities/fxw_project/FormXml/main/{…}.xml',
  );
  assert.equal(kit.displayPath('web-files/fxw.css'), 'web-files/fxw.css');
  assert.ok(kit.ICON.locate && kit.ICON.locate !== kit.ICON.go, 'finding on the page is not navigating');
});

test('no Lense UI file draws a symbol character where a kit icon or a word belongs', () => {
  const GLYPHS = /[⎇≠↳→←↑↓⇒⇐×✓✔✗✘★☆◉⊘▼▲▶◀▸▾]|&(?:times|rarr|larr|uarr|darr|check);|&#(?:215|8592|8594|8593|8595);/;
  for (const file of UI_FILES) {
    const code = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
    const lines = code.split('\n').filter((line) => GLYPHS.test(line));
    assert.deepEqual(lines, [], file);
  }
});

test('X-ray and the evidence renderer embed the kit instead of their own icons and tokens', () => {
  const xray = xrayUi.toString();
  assert.match(xray, /const lenseUiKit=\(function lenseUiKit\(\)/);
  for (const file of UI_FILES) {
    assert.doesNotMatch(read(file), /const ICON = \{/, `${file} keeps no icon set of its own`);
    assert.doesNotMatch(read(file), /--primary\s*:/, `${file} defines no theme token`);
  }
  // Its buttons, selects and icon buttons are the kit's: no base rule or size of its own.
  const own = read('xray-ui.mjs');
  for (const rule of [
    /(?:^|[\s}])button\{/m,
    /(?:^|[\s}])button:hover\{/m,
    /\.bar \.ib\{/,
    /\.bar select\{[^}]*border/,
  ])
    assert.doesNotMatch(own, rule, String(rule));
  assert.match(xray, /\.ui\{\$\{kit\.tokens\}/);
  const styles = renderInspectionEvidence(null, { part: 'styles' });
  assert.ok(styles.includes(kit.css), 'the renderer brings the kit controls and rows');
  // Icon buttons in evidence rows are the panel's: the code icon opens, the copy icon copies.
  const row = renderInspectionEvidence(null, {
    part: 'row',
    context: 'xray',
    row: {
      name: 'Invented',
      path: 'a/b.html',
      actions: [{ act: 'open', icon: 'code', title: 'Open Invented in the editor' }],
    },
  });
  assert.match(
    row,
    /<div class="row ie-row"><div class="main"><div class="name"><span>Invented<\/span><\/div><div class="sub path" title="a\/b.html"><bdi>a\/b.html<\/bdi><\/div><\/div><div class="acts"><button class="ib" data-action="open"/,
  );
  assert.ok(row.includes(kit.icon('code')));
});
