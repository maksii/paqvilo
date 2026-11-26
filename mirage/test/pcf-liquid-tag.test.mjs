// @test-kind observation: codecomponent tag name forms, argument names, ControlProperties coercion and host markup follow one live capture of a Power Pages site (paqvilo-developer pcf-parity summary-D, r1 lq-* pages); invented control and portal
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { observedConfig } from '../lib/project-config.mjs';
import { codeComponentGuid, liquidControlProperty } from '../lib/code-components.mjs';
import { codeComponentReferences, createSourceInspector } from '../../lense/source-inspection.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const ID = '1a2b3c4d-0000-4000-8000-00000000000a';
const P = 'inv_Invented.Probe';
const PROPERTIES = [
  ['textValue', 'SingleLine.Text'],
  ['wholeValue', 'Whole.None'],
  ['decimalValue', 'Decimal'],
  ['floatValue', 'FP'],
  ['moneyValue', 'Currency'],
  ['flagValue', 'TwoOptions'],
  ['dayValue', 'DateAndTime.DateOnly'],
  ['momentValue', 'DateAndTime.DateAndTime'],
  ['MixedCaseArg', 'SingleLine.Text'],
]
  .map(([name, type]) => `<property name="${name}" of-type="${type}" usage="input"/>`)
  .join('');
const MANIFEST = `<manifest><control namespace="Invented" constructor="Probe" version="1.0.0" control-type="standard">${PROPERTIES}<property name="flavour" of-type="Enum" usage="input"><value name="One">1</value><value name="Two">2</value><value name="Three">3</value></property><property name="boundText" of-type="SingleLine.Text" usage="bound"/><resources><code path="bundle.js" order="1"/><css path="probe.css" order="1"/></resources></control></manifest>`;

async function writeFiles(root, files) {
  for (const [relative, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), text);
  }
}

// A page whose layout includes the page copy, with a tail after it: the live page loses both after a failing tag.
// `language` ({ id, code, lcid }) makes the site's one website language and its default: every page is in it.
async function site(t, copy, { observed, language, layout, files = {} } = {}) {
  const dir = await fs.realpath(await makeTemporaryDirectory(path.join(os.tmpdir(), 'pcf-tag-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const solution = path.join(dir, 'solution');
  await writeFiles(path.join(solution, 'Controls', P), {
    'ControlManifest.xml': MANIFEST,
    'ControlManifest.xml.data.xml': `<CustomControl><Name>${P}</Name></CustomControl>`,
    'bundle.js': `window.ComponentFramework.registerControl('Invented.Probe', class { init() {} updateView() {} getOutputs() { return {}; } destroy() {} });`,
    'probe.css': '.probe{}',
  });
  await writeFiles(path.join(solution, 'Controls', 'inv_Invented.Required'), {
    'ControlManifest.xml':
      '<manifest><control namespace="Invented" constructor="Required" control-type="standard"><property name="needed" of-type="SingleLine.Text" usage="input" required="true"/><property name="optional" of-type="SingleLine.Text" usage="input"/><resources><code path="bundle.js" order="1"/></resources></control></manifest>',
    'ControlManifest.xml.data.xml': '<CustomControl><Name>inv_Invented.Required</Name></CustomControl>',
    'bundle.js': '/* */',
  });
  const portal = path.join(dir, 'portal');
  await writeFiles(portal, {
    'website.yml':
      'adx_websiteid: invented\nadx_name: Invented\n' + (language ? `adx_defaultlanguage: ${language.id}\n` : ''),
    ...(language
      ? {
          'websitelanguage.yml': `adx_websitelanguageid: ${language.id}\nadx_name: ${language.code}\nadx_languagecode: ${language.code}\nadx_lcid: ${language.lcid}\n`,
        }
      : {}),
    'web-pages/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main\n',
    'web-pages/Home.webpage.copy.html': copy,
    'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main\n',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main\n',
    'Main.webtemplate.source.html':
      layout ??
      '<html><body><main id="layout">{% include \'Page Copy\' %}<p id="layout-tail">layout tail</p></main></body></html>',
    ...files,
  });
  const runtime = await createSimulator({
    sourceDir: portal,
    solutionRoots: [solution],
    observed,
    watch: false,
    port: 0,
  });
  t.after(() => runtime.close());
  const html = await fetch(runtime.url).then((response) => response.text());
  const { diagnostics } = await (await fetch(runtime.url + '/_sim/api/diagnostics')).json();
  return { runtime, html, diagnostics, portal, solution };
}
const decode = (text) =>
  text.replace(
    /&(quot|amp|lt|gt|#39|#32);/g,
    (_, name) => ({ quot: '"', amp: '&', lt: '<', gt: '>', '#39': "'", '#32': ' ' })[name],
  );
const hosts = (html) =>
  [
    ...html.matchAll(
      /<span id="PcfControlConfig_([0-9a-f-]{36})" data-pcf-control="([^"]*)" pcf-controlcontext="([^"]*)"><\/span>/g,
    ),
  ].map((match) => ({ id: match[1], config: JSON.parse(decode(match[2])), context: JSON.parse(decode(match[3])) }));

test('only an unquoted name or bare GUID renders a host; the rest of the page copy and layout follow it', async (t) => {
  const observed = observedConfig({ codeComponents: { [ID]: P }, evidence: 'invented mapping for the bare GUID case' });
  for (const copy of [
    `<h3>unquoted</h3>{% codecomponent name:${P} textValue:'x' %}<p id="after">after the tag</p>`,
    `<h3>spaced</h3>{% codecomponent name: ${P} textValue: 'x' %}<p id="after">after the tag</p>`,
    `<h3>guid-bare</h3>{% codecomponent name:${ID} textValue:'x' %}<p id="after">after the tag</p>`,
    // r2: the tag key is case-insensitive, and an unquoted dotted name is literal even when its root is assigned.
    `<h3>name-capital</h3>{% codecomponent Name:${P} textValue:'x' %}<p id="after">after the tag</p>`,
    `<h3>name-upper</h3>{% codecomponent NAME:${P} textValue:'x' %}<p id="after">after the tag</p>`,
    `{% assign inv_Invented = 'shadow' %}<h3>assign-shadow</h3>{% codecomponent name:${P} textValue:'x' %}<p id="after">after the tag</p>`,
  ]) {
    const { html } = await site(t, copy, { observed });
    assert.equal(hosts(html).length, 1, copy);
    assert.match(html, /<p id="after">after the tag<\/p>/);
    assert.match(html, /<p id="layout-tail">layout tail<\/p>/);
  }
});

test('a quoted name, a quoted GUID or a missing control renders nothing and ends the page copy and the layout there', async (t) => {
  const cases = [
    [`'${P}'`, 'PCF_LIQUID_NAME_QUOTED'],
    [`"${P}"`, 'PCF_LIQUID_NAME_QUOTED'],
    [`'${ID}'`, 'PCF_LIQUID_NAME_QUOTED'],
    [`'${ID.toUpperCase()}'`, 'PCF_LIQUID_NAME_QUOTED'],
    [`'${ID.replaceAll('-', '')}'`, 'PCF_LIQUID_NAME_QUOTED'],
    [`'{${ID}}'`, 'PCF_LIQUID_NAME_QUOTED'],
    ['inv_Invented.NoSuchControl', 'PCF_LIQUID_CONTROL_NOT_FOUND'],
    // Only Pages.* is an evidenced environment control: another name without a prefix is a missing control.
    ['Other.Control', 'PCF_LIQUID_CONTROL_NOT_FOUND'],
  ];
  for (const [name, code] of cases) {
    const { html, diagnostics } = await site(
      t,
      `<h3>case</h3>{% codecomponent name:${name} textValue:'x' %}<p id="after">after</p>`,
    );
    assert.equal(hosts(html).length, 0, name);
    // The copy keeps what came before the tag, inside its still-open wrappers; nothing after the tag is written.
    assert.match(html, /<div class="page-copy"><div[^>]*><div class="xrm-attribute-value"><h3>case<\/h3>/, name);
    assert.doesNotMatch(html, /id="after"|id="layout-tail"/, name);
    // The open wrappers, the layout and the document close right after it, before Mirage's own scripts (raw r1
    // lq-quoted: the wrappers close before the platform scripts).
    assert.match(html, /<h3>case<\/h3><\/div><\/div><\/div><\/main><\/body><\/html>/, name);
    assert.ok(
      diagnostics.some((entry) => entry.code === code && /ends the rest of the template/.test(entry.message)),
      name,
    );
  }
});

// Regression: every braced name was reported as a braced control id, although only braced GUIDs are captured.
// @test-kind unproven: only braced GUIDs are captured (paqvilo-developer pcf-parity summary-F section 3); a braced name that is no GUID is looked up as a name and, absent, halts as a missing control
test('a braced name that is no GUID is a missing control, not a braced control id', async (t) => {
  const { html, diagnostics } = await site(
    t,
    `<h3>case</h3>{% codecomponent name:{notaguid} %}<p id="after">after</p>`,
  );
  assert.equal(hosts(html).length, 0);
  assert.doesNotMatch(html, /id="after"/);
  assert.ok(diagnostics.some((entry) => entry.code === 'PCF_LIQUID_CONTROL_NOT_FOUND'));
  assert.ok(!diagnostics.some((entry) => entry.code === 'PCF_LIQUID_NAME_BRACED'));
});

// Regression: the halted copy's open elements were found with a case-sensitive tag regex, so an upper-case raw-text
// end tag, an end tag with whitespace and attributes or a --!> comment end let markup inside them close the wrappers.
// @test-kind compatibility: the open elements of the halted text are read by the WHATWG HTML tokenization rules (ASCII case-insensitive tag names, raw-text end tags followed by whitespace, '/' or '>', comments ending at --> or --!>, '>' inside a quoted attribute value)
test('a halted copy closes the elements it left open whatever the case and spacing of its tags', async (t) => {
  const { html } = await site(
    t,
    [
      '<h3>case</h3><STYLE>/* </div> */</style >',
      `<SCRIPT type="text/x-invented">var s = '</main>';</SCRIPT\n data-x>`,
      '<!-- </div> --!><Section data-x="a>b" id="open"><TextArea></div></TEXTAREA>',
      `{% codecomponent name:'${P}' %}<p id="after">after</p>`,
    ].join(''),
  );
  assert.equal(hosts(html).length, 0);
  assert.doesNotMatch(html, /id="after"|id="layout-tail"/);
  assert.match(
    html,
    /<TextArea><\/div><\/TEXTAREA><\/section><\/div><\/div><\/div><\/main><\/body><\/html>/,
    'the open section, the copy wrappers, the layout and the document close; tags in raw text and comments do not count',
  );
});

test('two tags of the same control render neither host and end the copy at the first (r1 to r3)', async (t) => {
  const { html, diagnostics } = await site(
    t,
    `<h3>two</h3>{% codecomponent name:${P} textValue:'first' %}{% codecomponent name:${P} textValue:'second' %}<p id="after">after</p>`,
  );
  assert.equal(hosts(html).length, 0);
  assert.match(html, /<h3>two<\/h3>/);
  assert.doesNotMatch(html, /_Container|id="after"|id="layout-tail"/);
  assert.ok(diagnostics.some((entry) => entry.code === 'PCF_LIQUID_DUPLICATE_CONTROL'));
});

test('arguments reach ControlProperties by exact property name, coerced as the live server writes them', async (t) => {
  const typed = await site(
    t,
    `{% codecomponent name:${P} textValue:'typed' wholeValue:42 decimalValue:12.5 floatValue:1.25 moneyValue:99.99 flagValue:true dayValue:'2026-03-15' momentValue:'2026-03-15T14:05:09Z' flavour:3 MixedCaseArg:'mixed' boundText:'bound' %}`,
  );
  const [host] = hosts(typed.html);
  assert.deepEqual(host.context.ControlProperties, {
    textValue: 'typed',
    wholeValue: 42,
    floatValue: '1.25',
    moneyValue: '99.99',
    flagValue: true,
    dayValue: '2026-03-15T00:00:00',
    momentValue: '2026-03-15T14:05:09',
    flavour: '3',
    MixedCaseArg: 'mixed',
    boundText: 'bound',
  });
  assert.ok(
    typed.diagnostics.some((entry) => entry.code === 'PCF_ARGUMENT_DROPPED' && entry.property === 'decimalValue'),
  );
  // The client receives the same values as its parameter input.
  const spec = JSON.parse(/__paqviloPcf\.mount\((.*), document\.currentScript/.exec(typed.html)[1]);
  assert.deepEqual(spec.args, host.context.ControlProperties);
  // Argument names match case-sensitively; unknown arguments are ignored.
  const cased = await site(
    t,
    `{% codecomponent name:${P} textvalue:'lower' WHOLEVALUE:5 mixedcasearg:'lower' FlagValue:false nosuch:'x' %}`,
  );
  assert.deepEqual(hosts(cased.html)[0].context.ControlProperties, {});
  assert.equal(cased.diagnostics.filter((entry) => entry.code === 'PCF_ARGUMENT_IGNORED').length, 5);
  // Bad values are dropped; an undeclared Enum value is accepted; variables and drops are resolved first.
  const bad = await site(
    t,
    `{% assign pq_n = 7 %}{% codecomponent name:${P} textValue:page.title wholeValue:pq_n decimalValue:'x' flagValue:'maybe' dayValue:'not a date' momentValue:'2026-03-15 14:05' flavour:9 %}`,
  );
  const properties = hosts(bad.html)[0].context.ControlProperties;
  assert.deepEqual(
    { ...properties, textValue: typeof properties.textValue },
    { textValue: 'string', wholeValue: 7, momentValue: '2026-03-15T14:05:00', flavour: '9' },
  );
  assert.equal(liquidControlProperty('Whole.None', 'abc'), undefined);
  assert.equal(liquidControlProperty('Whole.None', '42'), 42);
  assert.equal(liquidControlProperty('FP', '1.25'), '1.25');
  assert.equal(liquidControlProperty('TwoOptions', 'true'), true);
  assert.equal(liquidControlProperty('TwoOptions', null), undefined);
});

// @test-kind observation: the host markup follows paqvilo-developer pcf-parity summary-D (r1 lq-* pages); the Resources entries of a control without RESX files follow raw r2 lq-dependency-ny, lq-two-datasets-ny and d1 subgrid-denied-ny (2026-11-26)
test('the host markup has the live structure, a fresh id per render and serves its bundle at the native address', async (t) => {
  const copy = `{% codecomponent name:${P} textValue:'typed' %}`;
  const { html, runtime } = await site(t, copy);
  const [host] = hosts(html);
  const container = new RegExp(
    `<span id="${host.id}_Container" class="flexbox"><script type="text/javascript" src="(/_pcfwebresource/[0-9a-f-]{36})\\?\\d+"></script><span id="PcfControlConfig_${host.id}" [^>]*></span><div id="${host.id}_ControlView" class="flexbox"[^>]*></div></span>`,
  );
  const match = container.exec(html);
  assert.ok(match, html);
  assert.deepEqual(Object.keys(host.config), [
    'SubscribedFunctionalities',
    'DataConnectors',
    'AuthConfigPropertiesGroups',
    'Resources',
    'DataSets',
    'Properties',
    'IncludedProperties',
    'PropertyDependencies',
    'Events',
    'CommonEvents',
    'Conversions',
    'Name',
    'IsCdnControl',
  ]);
  assert.equal(host.config.Name, P);
  // A control without RESX files has no null Type 2 placeholder (raw r2 lq-dependency-ny, lq-two-datasets-ny and d1
  // subgrid-denied-ny: every captured control without RESX; the r1 probe had one RESX file and one placeholder).
  assert.deepEqual(
    host.config.Resources.map((resource) => resource.Type),
    [3, 0, 1],
  );
  assert.equal(host.config.Resources[1].Path, match[1].split('/').at(-1));
  assert.deepEqual(Object.keys(host.context), [
    'UniqueId',
    'ControlId',
    'GridDataControlId',
    'ControlName',
    'ControlProperties',
    'IsDisabled',
    'PcfControlHiddenValueId',
    'PcfDynamicProperyName',
  ]);
  assert.equal(host.context.UniqueId, `${host.id}_ControlView`);
  assert.equal(host.context.PcfControlHiddenValueId, host.id);
  // The tag arguments are not part of the control configuration.
  assert.doesNotMatch(decode(/data-pcf-control="([^"]*)"/.exec(html)[1]), /typed/);
  // The bundle and the style are served at their native addresses; each render has its own id.
  const bundle = await fetch(runtime.url + match[1]);
  assert.equal(bundle.status, 200);
  assert.match(await bundle.text(), /registerControl\('Invented\.Probe'/);
  const style = await fetch(`${runtime.url}/_pcfwebresource/${host.config.Resources[2].Path}`);
  assert.equal(await style.text(), '.probe{}');
  const again = hosts(await fetch(runtime.url).then((response) => response.text()));
  assert.notEqual(again[0].id, host.id);
});

test('Lense inspection reads codecomponent names by the same rule', async (t) => {
  const references = codeComponentReferences(
    [
      `{% codecomponent name:${P} %}`,
      `{% codecomponent name:'${P}' %}`,
      `{% codecomponent name:${ID} %}`,
      `{% codecomponent name:${P} %}`,
      '{% codecomponent name:page.component %}',
      "{% comment %}{% codecomponent name:'inv_Commented.Out' %}{% endcomment %}",
    ].join(''),
  );
  assert.deepEqual(
    references.map((reference) => [reference.name, Boolean(reference.quoted), Boolean(reference.duplicate)]),
    [
      [P, false, false],
      [P, true, false],
      [ID, false, false],
      [P, false, true],
      ['page.component', false, false],
    ],
  );
  const { portal, solution } = await site(t, `{% codecomponent name:'${P}' %}`);
  const { report } = await createSourceInspector({
    sourceDir: portal,
    mirageConfig: { solutionRoots: [solution] },
  }).inspect('/');
  assert.equal(report.codeComponents[0].refused, 'PCF_LIQUID_NAME_QUOTED');
  assert.ok(report.unresolved.some((row) => /quoted control name/.test(row.reason)));
  assert.equal(codeComponentGuid('not-a-guid'), null);
});

// @test-kind contract: a platform control the environment provides (no publisher prefix, not in an export) is reported locally without ending the page
test('a platform control name outside the sources keeps the page rendering', async (t) => {
  const { html, diagnostics } = await site(t, `{% codecomponent name:Pages.SearchSummary %}<p id="after">after</p>`);
  assert.match(html, /role="alert" data-mirage-component="codecomponent"/);
  assert.match(html, /id="after"/);
  assert.ok(diagnostics.some((entry) => entry.code === 'PCF_HOST_UNSUPPORTED'));
});

// @test-kind observation: paqvilo-developer pcf-parity summary-E de-DE k1/k2 lq-typed-de (server ControlProperties on a de-DE page, two loads), compared with the en-US r1 lq-typed capture
test('on a de-DE page the server reads numbers with the page culture: a dot is a group separator', async (t) => {
  const german = await site(
    t,
    `{% codecomponent name:${P} textValue:'typed' wholeValue:42 decimalValue:12.5 floatValue:1.25 moneyValue:99.99 flagValue:true dayValue:'2026-03-15' momentValue:'2026-03-15T14:05:09Z' flavour:3 MixedCaseArg:'mixed' boundText:'bound' %}`,
    { language: { id: 'german', code: 'de-DE', lcid: 1031 } },
  );
  const [host] = hosts(german.html);
  assert.deepEqual(host.context.ControlProperties, {
    textValue: 'typed',
    wholeValue: 42,
    decimalValue: 125,
    floatValue: '125',
    moneyValue: '9999',
    flagValue: true,
    dayValue: '2026-03-15T00:00:00',
    momentValue: '2026-03-15T14:05:09',
    flavour: '3',
    MixedCaseArg: 'mixed',
    boundText: 'bound',
  });
  assert.equal(
    german.diagnostics.some((entry) => entry.code === 'PCF_ARGUMENT_DROPPED'),
    false,
  );
  const spec = JSON.parse(/__paqviloPcf\.mount\((.*), document\.currentScript/.exec(german.html)[1]);
  assert.deepEqual(spec.args, host.context.ControlProperties);
  assert.deepEqual(spec.language, { code: 'de-DE', lcid: 1031, isRTL: false });
  // The coercion per culture: the same arguments on an en-US page keep Decimal dropped and FP and Currency as given.
  assert.equal(liquidControlProperty('Decimal', '12.5', 'de-DE'), 125);
  assert.equal(liquidControlProperty('FP', '1.25', 'de-DE'), '125');
  assert.equal(liquidControlProperty('Currency', '99.99', 'de-DE'), '9999');
  assert.equal(liquidControlProperty('Decimal', '12.5', 'en-US'), undefined);
  assert.equal(liquidControlProperty('FP', '1.25', 'en-US'), '1.25');
  assert.equal(liquidControlProperty('Currency', '99.99', 'en-US'), '99.99');
});

// @test-kind unproven: de-DE decimal commas, a misplaced separator and a culture with a space group separator are not in any capture; the reading follows the de-DE capture's group-separator rule
test('unobserved culture number spellings follow the page culture separators', () => {
  assert.equal(liquidControlProperty('Decimal', '12,5', 'de-DE'), 12.5);
  assert.equal(liquidControlProperty('FP', '1.234,5', 'de-DE'), '1234.5');
  assert.equal(liquidControlProperty('FP', '1,2,3', 'de-DE'), undefined);
  assert.equal(liquidControlProperty('Currency', '1,2.5', 'de-DE'), undefined);
  assert.equal(liquidControlProperty('FP', '1 234,5', 'fr-FR'), '1234.5');
  assert.equal(liquidControlProperty('Whole.None', '42', 'de-DE'), 42);
});

test('round 2: arrays, fractions, drops, date-only text and 1 coerce as the live server writes them', async (t) => {
  const { html } = await site(
    t,
    `{% assign pq_list = 'a,b' | split: ',' %}{% codecomponent name:${P} textValue:pq_list wholeValue:'1.5' decimalValue:page dayValue:'2026-01-31' momentValue:'2026-01-31' flagValue:1 %}`,
  );
  assert.deepEqual(hosts(html)[0].context.ControlProperties, {
    textValue: 'System.String[]',
    dayValue: '2026-01-31T00:00:00',
    momentValue: '2026-01-31T00:00:00',
  });
});

// @test-kind observation: paqvilo-developer pcf-parity r2/r3 lq-coercion (two loads): the page drop passed as an argument in the stock Default studio template copy (editable page adx_copy, liquid) still renders one host and drops the argument
test('a Liquid drop argument in an editable page copy is dropped and the host still renders', async (t) => {
  const { html } = await site(
    t,
    `{% assign pq_list = 'a,b' | split: ',' %}{% codecomponent name:${P} textValue:pq_list wholeValue:'1.5' decimalValue:page dayValue:'2026-01-31' momentValue:'2026-01-31' flagValue:1 %}<p id="after-drop">after</p>`,
    {
      layout:
        '<div id="mainContent" class="wrapper-body" role="main"><div class="page-copy">{% editable page \'adx_copy\' type: \'html\', liquid: true %}</div></div>',
      // A child page: the page drop's children refer back to it, as on a site with more than one page.
      files: {
        'web-pages/Child.webpage.yml':
          'adx_webpageid: child\nadx_name: Child\nadx_partialurl: child\nadx_parentpageid: home\nadx_pagetemplateid: main\n',
      },
    },
  );
  assert.doesNotMatch(html, /Liquid error/);
  const [host] = hosts(html);
  assert.deepEqual(host?.context.ControlProperties, {
    textValue: 'System.String[]',
    dayValue: '2026-01-31T00:00:00',
    momentValue: '2026-01-31T00:00:00',
  });
  assert.match(html, /<p id="after-drop">after<\/p>/);
});

test('round 2: a required input without an argument renders with an empty value and an info diagnostic only', async (t) => {
  const { html, diagnostics } = await site(t, "{% codecomponent name:inv_Invented.Required optional:'given' %}");
  assert.deepEqual(hosts(html)[0].context.ControlProperties, { optional: 'given', needed: '' });
  const missing = diagnostics.find((entry) => entry.code === 'PCF_REQUIRED_PROPERTY_MISSING');
  assert.equal(missing?.severity, 'info');
  const present = await site(t, "{% codecomponent name:inv_Invented.Required needed:'n' optional:'o' %}");
  assert.deepEqual(hosts(present.html)[0].context.ControlProperties, { needed: 'n', optional: 'o' });
});

test('a name without a namespace is read as literal and marked unobserved', async (t) => {
  const { html, diagnostics } = await site(t, '<h3>case</h3>{% codecomponent name:Widget %}<p id="after">after</p>');
  assert.equal(hosts(html).length, 0);
  assert.doesNotMatch(html, /id="after"/);
  const missing = diagnostics.find((entry) => entry.code === 'PCF_LIQUID_CONTROL_NOT_FOUND');
  assert.equal(missing?.unobserved, 'undotted-name');
  const [reference] = codeComponentReferences('{% codecomponent name:Widget %}');
  assert.equal(reference.unobserved, 'undotted-name');
});

// @test-kind unproven: TwoOptions false/'false', a +hh:mm offset and the Whole Int32 range are not in any capture
test('unobserved coercion branches: false, offsets, number spellings and the Whole range', () => {
  assert.equal(liquidControlProperty('TwoOptions', false), false);
  assert.equal(liquidControlProperty('TwoOptions', 'false'), false);
  assert.equal(liquidControlProperty('DateAndTime.DateAndTime', '2026-03-15T14:05:09+02:00'), '2026-03-15T14:05:09');
  for (const text of ['1e3', '0x10', '0b1', 'Infinity', '1,5', ''])
    assert.equal(liquidControlProperty('FP', text), undefined, text);
  assert.equal(liquidControlProperty('FP', '-12.50'), '-12.50');
  assert.equal(liquidControlProperty('Whole.None', '2147483647'), 2147483647);
  assert.equal(liquidControlProperty('Whole.None', '2147483648'), undefined);
});
