import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importCodeComponents, renderCodeComponent } from '../lib/code-components.mjs';
import { observedConfig } from '../lib/project-config.mjs';

const id = 'd0000000-0000-4000-8000-000000000001';
async function fixture(t, resources = '<code path="bundle.js" order="1"/>') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-pcf-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const control = path.join(dir, 'Controls', 'tst_Synthetic.Editor');
  await fs.mkdir(control, { recursive: true });
  await fs.writeFile(
    path.join(control, 'ControlManifest.xml'),
    `<manifest><control namespace="Synthetic" constructor="Editor" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="bound"/><resources>${resources}</resources></control></manifest>`,
  );
  await fs.writeFile(
    path.join(control, 'ControlManifest.xml.data.xml'),
    '<CustomControl><Name>tst_Synthetic.Editor</Name></CustomControl>',
  );
  await fs.writeFile(
    path.join(control, 'bundle.js'),
    'window.ComponentFramework.registerControl("Synthetic.Editor",class{});',
  );
  return { dir, control };
}
test('PCF manifests expose only declared resources and use evidenced GUID mappings', async (t) => {
  const { dir } = await fixture(t);
  const catalog = await importCodeComponents([{ dir }]);
  assert.equal(catalog.controls.size, 1);
  assert.equal(catalog.assets.size, 1);
  const observed = observedConfig({
    codeComponents: { [id]: 'tst_Synthetic.Editor' },
    evidence: 'invented fixture tag binding',
  });
  const html = renderCodeComponent({
    name: id,
    args: { name: id, value: '</script>' },
    portal: { observed },
    catalog,
    identity: { roles: ['Reader'] },
  });
  assert.match(html, /data-pcf-schema="tst_Synthetic.Editor"/);
  assert.match(html, /__paqviloPcf.mount/);
  assert.ok(!html.includes('"</script>"'));
  assert.match(renderCodeComponent({ name: id, portal: {}, catalog }), /requires an observed/);
  assert.throws(() => observedConfig({ codeComponents: { [id]: 'tst_Synthetic.Editor' } }), /evidence/);
  assert.throws(() => observedConfig({ codeComponents: { [id]: '../escape' }, evidence: 'fixture' }), /schema names/);
});

test('PCF classic SDK export declarations consume only leading block comments and a complete var declaration', async (t) => {
  const { dir, control } = await fixture(t);
  const cases = [
    ['var Bundle;Bundle={Editor:class{}};', 'Bundle'],
    ['\uFEFF \r\n/* generated */\t/** license\nline */\nvar $Bundle_2 \t;\n', '$Bundle_2'],
    ['/**//* next */var _Bundle;', '_Bundle'],
    ['window.ComponentFramework.registerControl("Synthetic.Editor",class{});', undefined],
    ['let Bundle; var Other;', undefined],
    ['var Bundle={};', undefined],
    ['var Bundle, Other;', undefined],
    ['variable Bundle;', undefined],
    ['var 2Bundle;', undefined],
    ['var Bundle.part;', undefined],
    ['var Bundle', undefined],
    ['/* unfinished var Bundle;', undefined],
    ['/* ended */ statement(); var Bundle;', undefined],
    ['// line header\nvar Bundle;', undefined],
  ];
  for (const [source, expected] of cases) {
    await fs.writeFile(path.join(control, 'bundle.js'), source);
    const catalog = await importCodeComponents([{ dir }]);
    assert.deepEqual(catalog.diagnostics, []);
    const resource = catalog.controls.get('tst_Synthetic.Editor').resources[0];
    assert.equal(resource.exportGlobal, expected, JSON.stringify(source));
    assert.equal(Object.hasOwn(resource, 'exportGlobal'), expected !== undefined);
  }
});

test(
  'PCF classic SDK declaration scanning handles large repeated headers and incomplete prefixes',
  { timeout: 10000 },
  async (t) => {
    const { dir, control } = await fixture(t);
    const header = ' \t/* generated header */\n'.repeat(20000);
    for (const [source, expected] of [
      [header + 'var LargeBundle;', 'LargeBundle'],
      [header + ' '.repeat(250000) + 'var LargeBundle=', undefined],
      [header + '/*' + '* '.repeat(250000), undefined],
    ]) {
      await fs.writeFile(path.join(control, 'bundle.js'), source);
      const catalog = await importCodeComponents([{ dir }]);
      assert.deepEqual(catalog.diagnostics, []);
      assert.equal(catalog.controls.get('tst_Synthetic.Editor').resources[0].exportGlobal, expected);
    }
  },
);
test('PCF manifest traversal is rejected and missing resources never become mountable', async (t) => {
  const { dir } = await fixture(t, '<code path="../../outside.js"/>');
  await fs.writeFile(path.join(dir, 'outside.js'), 'bad');
  const catalog = await importCodeComponents([{ dir }]);
  assert.equal(catalog.controls.size, 0);
  assert.equal(catalog.assets.size, 0);
  assert.equal(catalog.diagnostics[0].code, 'PCF_IMPORT_FAILED');
});
test('PCF rejects invalid declared paths and reports platform and dataset dependencies explicitly', async (t) => {
  const { dir, control } = await fixture(
    t,
    '<code path="bundle.js"/><platform-library name="React" version="16.14.0"/>',
  );
  let catalog = await importCodeComponents([{ dir }]);
  assert.deepEqual(catalog.controls.get('tst_Synthetic.Editor').libraries, [{ name: 'React', version: '16.14.0' }]);
  const portal = { observed: { codeComponents: { [id]: 'tst_Synthetic.Editor' } } };
  assert.match(renderCodeComponent({ name: id, portal, catalog }), /requires platform libraries \(React 16\.14\.0\)/);
  await fs.writeFile(
    path.join(control, 'ControlManifest.xml'),
    '<manifest><control namespace="Synthetic" constructor="Editor" control-type="standard"><data-set name="rows"/><resources><code path="bundle.js"/></resources></control></manifest>',
  );
  catalog = await importCodeComponents([{ dir }]);
  assert.deepEqual(catalog.controls.get('tst_Synthetic.Editor').datasets, [{ name: 'rows' }]);
  assert.match(
    renderCodeComponent({ name: id, portal, catalog }),
    /requires a dataset binding to an exported table and view/,
  );
  await fs.writeFile(
    path.join(control, 'ControlManifest.xml'),
    '<manifest><control namespace="Synthetic" constructor="Editor" control-type="standard"><resources><code path="bundle.js#ignored"/></resources></control></manifest>',
  );
  catalog = await importCodeComponents([{ dir }]);
  assert.equal(catalog.controls.size, 0);
  assert.match(catalog.diagnostics[0].message, /invalid path/);
});
test('PCF type groups preserve their exported types instead of treating numeric values as text', async (t) => {
  const { dir, control } = await fixture(t);
  await fs.writeFile(
    path.join(control, 'ControlManifest.xml'),
    '<manifest><control namespace="Synthetic" constructor="Editor" control-type="standard"><type-group name="Numeric"><type>Whole.None</type></type-group><property name="count" of-type-group="Numeric" usage="bound" default-value="7"/><resources><code path="bundle.js"/></resources></control></manifest>',
  );
  const catalog = await importCodeComponents([{ dir }]);
  assert.deepEqual(catalog.controls.get('tst_Synthetic.Editor').properties[0].types, ['Whole.None']);
  assert.equal(catalog.controls.get('tst_Synthetic.Editor').properties[0]['default-value'], '7');
});
test('PCF datasets bind only to selected exported views and exact table mappings', async (t) => {
  const { dir, control } = await fixture(t);
  await fs.writeFile(
    path.join(control, 'ControlManifest.xml'),
    '<manifest><control namespace="Synthetic" constructor="Editor" control-type="standard"><data-set name="rows"/><resources><code path="bundle.js"/></resources></control></manifest>',
  );
  const catalog = await importCodeComponents([{ dir }]);
  const portal = { observed: { codeComponents: { [id]: 'tst_Synthetic.Editor' } } };
  const metadata = {
    entities: {
      tst_row: {
        primaryNameAttribute: 'tst_title',
        fields: { tst_title: { label: 'Title', dataverseType: 'nvarchar' } },
      },
    },
    views: [
      {
        id: 'd0000000-0000-4000-8000-000000000002',
        name: 'Visible Rows',
        entity: 'tst_row',
        fields: [{ name: 'tst_title', width: 200 }],
        fetchXml: '<fetch><entity name="tst_row"><attribute name="tst_title"/></entity></fetch>',
      },
    ],
  };
  const mappings = { tst_row: { entitySet: 'tst_rows', idColumn: 'tst_rowid' } };
  const html = renderCodeComponent({
    name: id,
    args: { rows: metadata.views[0].id },
    portal,
    catalog,
    metadata,
    mappings,
  });
  assert.match(html, /__paqviloPcf.mount/);
  assert.match(html, /"viewId":"d0000000-0000-4000-8000-000000000002"/);
  assert.match(html, /"displayName":"Title"/);
  assert.match(
    renderCodeComponent({ name: id, args: { rows: 'missing' }, portal, catalog, metadata, mappings }),
    /no exported table definition/,
  );
  assert.match(
    renderCodeComponent({
      name: id,
      args: { rows: 'Visible Rows' },
      portal,
      catalog,
      metadata: { ...metadata, views: [...metadata.views, { ...metadata.views[0], id: 'other' }] },
      mappings,
    }),
    /multiple exported views/,
  );
});
test('PCF native form mounts require declared bound properties and retain selected language metadata', async (t) => {
  const { dir, control } = await fixture(t);
  await fs.writeFile(
    path.join(control, 'ControlManifest.xml'),
    '<manifest><control namespace="Synthetic" constructor="Editor" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="bound"/><property name="caption" of-type="SingleLine.Text" usage="input"/><resources><code path="bundle.js"/></resources></control></manifest>',
  );
  const catalog = await importCodeComponents([{ dir }]);
  const context = { name: 'tst_Synthetic.Editor', portal: {}, catalog, language: { code: 'fr-FR', lcid: 1036 } };
  const html = renderCodeComponent({
    ...context,
    nativeBinding: { id: 'fullname', control: 'text', properties: ['value'] },
  });
  assert.match(html, /__paqviloPcf.mount/);
  assert.match(html, /"lcid":1036/);
  assert.match(html, /"nativeBinding"/);
  for (const properties of [[], ['unknown'], ['caption'], ['value', 'caption']])
    assert.match(
      renderCodeComponent({ ...context, nativeBinding: { id: 'fullname', control: 'text', properties } }),
      /no valid single-field native binding/,
    );
});

test('PCF feature declarations preserve source attributes and order and distinguish portal eligibility from local APIs', async (t) => {
  const { dir, control } = await fixture(t);
  const declarations = [
    { name: 'Device.captureImage', required: 'false' },
    { name: 'WebAPI', required: '1' },
    { name: 'Utility', required: 'true' },
    { name: 'WebAPI', required: '0' },
    { name: 'Unqualified.Feature', required: 'false', 'source-note': 'retained' },
    { name: 'device.captureImage', required: 'false' },
  ];
  const write = async (features) =>
    fs.writeFile(
      path.join(control, 'ControlManifest.xml'),
      `<manifest><control namespace="Synthetic" constructor="Editor" control-type="standard"><feature-usage>${features}</feature-usage><resources><code path="bundle.js"/></resources></control></manifest>`,
    );
  await write(
    declarations
      .map(
        (f) =>
          `<uses-feature ${Object.entries(f)
            .map(([name, value]) => `${name}="${value}"`)
            .join(' ')}/>`,
      )
      .join(''),
  );
  let catalog = await importCodeComponents([{ dir }]);
  assert.deepEqual(catalog.controls.get('tst_Synthetic.Editor').features, declarations);
  const diagnostics = [];
  const html = renderCodeComponent({
    name: 'tst_Synthetic.Editor',
    portal: {},
    catalog,
    diagnostic: (value) => diagnostics.push(value),
  });
  assert.doesNotMatch(html, /__paqviloPcf.mount|<script/);
  assert.equal(diagnostics[0].code, 'PCF_HOST_UNSUPPORTED');
  assert.equal(diagnostics[0].reason, 'PCF_FEATURE_DECLARATIONS_UNSUPPORTED');
  assert.deepEqual(
    diagnostics[0].features.map((f) => [f.name, f.required, f.eligible, f.hostApiAvailable]),
    [
      ['Device.captureImage', 'false', true, false],
      ['WebAPI', '1', false, true],
      ['Utility', 'true', false, false],
      ['WebAPI', '0', true, true],
      ['Unqualified.Feature', 'false', true, null],
      ['device.captureImage', 'false', true, false],
    ],
  );
  for (const [required, eligible] of [
    ['true', false],
    ['1', false],
    ['false', true],
    ['0', true],
    [' true ', false],
    [' false ', true],
    ['TRUE', false],
    ['', false],
  ]) {
    await write(`<uses-feature name="WebAPI" required="${required}"/>`);
    catalog = await importCodeComponents([{ dir }]);
    const found = [];
    const output = renderCodeComponent({
      name: 'tst_Synthetic.Editor',
      portal: {},
      catalog,
      diagnostic: (value) => found.push(value),
    });
    assert.equal(output.includes('__paqviloPcf.mount'), eligible, required);
    if (!eligible)
      assert.equal(
        found[0].features[0].reason,
        ['true', '1'].includes(required.trim())
          ? 'PCF_PORTAL_REQUIRED_FEATURE_UNSUPPORTED'
          : 'PCF_FEATURE_DECLARATION_INVALID',
      );
    assert.equal(catalog.controls.get('tst_Synthetic.Editor').features[0].required, required);
  }
  for (const declaration of ['<uses-feature name="WebAPI"/>', '<uses-feature required="false"/>']) {
    await write(declaration);
    catalog = await importCodeComponents([{ dir }]);
    const found = [];
    renderCodeComponent({
      name: 'tst_Synthetic.Editor',
      portal: {},
      catalog,
      diagnostic: (value) => found.push(value),
    });
    assert.equal(found[0].features[0].reason, 'PCF_FEATURE_DECLARATION_INVALID');
  }
  await write('');
  catalog = await importCodeComponents([{ dir }]);
  assert.deepEqual(catalog.controls.get('tst_Synthetic.Editor').features, []);
  assert.match(renderCodeComponent({ name: 'tst_Synthetic.Editor', portal: {}, catalog }), /__paqviloPcf.mount/);
});

test('PCF RESX import retains languages and resource metadata instead of flattening translations', async (t) => {
  const { dir, control } = await fixture(t);
  await fs.mkdir(path.join(control, 'strings'));
  const declarations = [
    { path: 'strings/Labels.1036.resx', version: '2.3.4', order: '03', culture: 'fr-FR' },
    { path: 'strings/Labels.1033.resx', version: '1.2.3', order: '1' },
  ];
  const files = {
    'strings/Labels.1036.resx':
      '<root xml:lang="fr-FR"><resheader name="version"><value>2.0</value></resheader><data name="Caption" xml:space="preserve"><value> Bonjour β </value><comment>French label</comment></data><data name="Empty"><value></value></data></root>',
    'strings/Labels.1033.resx':
      '<root><data name="Caption"><value>Hello</value></data><data name="EnglishOnly"><value>Base-only string</value></data></root>',
  };
  for (const [relative, text] of Object.entries(files)) await fs.writeFile(path.join(control, relative), text);
  const write = async (resources) =>
    fs.writeFile(
      path.join(control, 'ControlManifest.xml'),
      `<manifest><control namespace="Synthetic" constructor="Editor" control-type="standard"><resources><code path="bundle.js"/>${resources
        .map(
          (attrs) =>
            `<resx ${Object.entries(attrs)
              .map(([key, value]) => `${key}="${value}"`)
              .join(' ')}/>`,
        )
        .join('')}</resources></control></manifest>`,
    );
  await write(declarations);
  let catalog = await importCodeComponents([{ dir }]);
  const c = catalog.controls.get('tst_Synthetic.Editor');
  assert.deepEqual(
    c.stringResources.map((resource) => resource.attributes),
    declarations,
  );
  assert.deepEqual(
    c.stringResources.map((resource) => resource.lcid),
    [1036, 1033],
  );
  assert.equal(c.stringResources[0].strings.Caption, ' Bonjour β ');
  assert.equal(c.stringResources[0].entries[0].attrs['xml:space'], 'preserve');
  assert.equal(c.stringResources[0].entries[0].children.find((node) => node.name === 'comment').text, 'French label');
  assert.equal(c.stringResources[0].document.attrs['xml:lang'], 'fr-FR');
  assert.equal(c.stringResources[0].document.children[0].name, 'resheader');
  const spec = (catalog, language, websiteLanguages = []) => {
    const diagnostics = [];
    const html = renderCodeComponent({
      name: 'tst_Synthetic.Editor',
      catalog,
      language,
      portal: { websiteLanguages },
      diagnostic: (d) => diagnostics.push(d),
    });
    return { value: JSON.parse(/__paqviloPcf\.mount\((.*), document\.currentScript/.exec(html)[1]), diagnostics };
  };
  const french = spec(catalog, { code: 'fr-FR', lcid: 1036 });
  assert.deepEqual(french.value.strings, { Caption: ' Bonjour β ', Empty: '' });
  assert.equal(french.value.localization.resources[0].selection, 'selected-language');
  assert.equal(french.diagnostics.length, 0);
  assert.equal(french.value.stringResources, undefined);
  const english = spec(catalog, { code: 'en-US' });
  assert.deepEqual(english.value.strings, { Caption: 'Hello', EnglishOnly: 'Base-only string' });
  assert.equal(english.value.language.lcid, 1033);
  const fallback = spec(catalog, { code: 'de-DE', lcid: 1031 }, [{ code: 'fr-FR', lcid: 1036, isDefault: true }]);
  assert.deepEqual(fallback.value.strings, french.value.strings);
  assert.equal(fallback.diagnostics[0].code, 'PCF_RESOURCE_LANGUAGE_FALLBACK');
  assert.equal(fallback.diagnostics[0].nativeQualified, false);
  const unresolved = spec(catalog, { lcid: 1031 });
  assert.deepEqual(unresolved.value.strings, {});
  assert.equal(unresolved.diagnostics[0].code, 'PCF_RESOURCE_LANGUAGE_UNRESOLVED');
  await write([...declarations].reverse());
  catalog = await importCodeComponents([{ dir }]);
  assert.deepEqual(spec(catalog, { lcid: 1036 }).value.strings, french.value.strings);
  await fs.writeFile(path.join(control, 'strings/Labels.01036.resx'), files['strings/Labels.1036.resx']);
  await write([...declarations, { path: 'strings/Labels.01036.resx', version: '99.0.0' }]);
  catalog = await importCodeComponents([{ dir }]);
  const duplicateLocale = spec(catalog, { lcid: 1036 });
  assert.deepEqual(duplicateLocale.value.strings, {});
  assert.equal(duplicateLocale.diagnostics[0].code, 'PCF_RESOURCE_LANGUAGE_AMBIGUOUS');
  // A newer resource version must not silently choose a language or source.
  await fs.writeFile(
    path.join(control, 'strings/Unqualified.resx'),
    '<root><data name="Unknown"><value>Unqualified language</value></data></root>',
  );
  await write([{ path: 'strings/Unqualified.resx', version: '1.0.0', culture: 'fr-FR' }]);
  catalog = await importCodeComponents([{ dir }]);
  assert.equal(catalog.controls.get('tst_Synthetic.Editor').stringResources[0].lcid, null);
  assert.deepEqual(spec(catalog, { lcid: 1036 }).value.strings, {});
  assert.equal(catalog.diagnostics[0].code, 'PCF_RESOURCE_LANGUAGE_UNRESOLVED');
  await fs.writeFile(
    path.join(control, 'strings/Second.1036.resx'),
    '<root><data name="Caption"><value>Conflicting caption</value></data><data name="Other"><value>Second resource</value></data></root>',
  );
  await write([declarations[0], { path: 'strings/Second.1036.resx', version: '1.0.0' }]);
  catalog = await importCodeComponents([{ dir }]);
  const conflictingKey = spec(catalog, { lcid: 1036 });
  assert.deepEqual(conflictingKey.value.strings, { Empty: '', Other: 'Second resource' });
  assert.equal(conflictingKey.diagnostics[0].code, 'PCF_RESOURCE_KEY_AMBIGUOUS');
  await fs.writeFile(
    path.join(control, 'strings/Second.1036.resx'),
    '<root><data name="Repeated"><value>One</value></data><data name="Repeated"><value>Two</value></data></root>',
  );
  await write([{ path: 'strings/Second.1036.resx', version: '1.0.0' }]);
  catalog = await importCodeComponents([{ dir }]);
  assert.equal(catalog.controls.get('tst_Synthetic.Editor').stringResources[0].entries.length, 2);
  assert.deepEqual(spec(catalog, { lcid: 1036 }).value.strings, {});
  assert.equal(catalog.diagnostics[0].code, 'PCF_RESOURCE_KEY_AMBIGUOUS');
});
