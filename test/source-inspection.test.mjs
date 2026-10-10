import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSourceInspector, inspectionSources, inspectRenderedPage } from '../lense/source-inspection.mjs';
import { inspectionFixture, addNativeInspectionFixture } from './source-inspection-fixture.mjs';

test('live inspection selects exported route languages and matching snippet source identity', async (t) => {
  const fx = inspectionFixture(); t.after(fx.cleanup);
  fs.appendFileSync(path.join(fx.portal, 'website.yml'), '\nadx_defaultlanguage: lang-en');
  fs.writeFileSync(path.join(fx.portal, 'websitelanguage.yml'), '- adx_websitelanguageid: lang-en\n  adx_name: English\n  adx_languagecode: en-US\n  adx_lcid: 1033\n- adx_websitelanguageid: lang-fr\n  adx_name: French\n  adx_languagecode: fr-FR\n  adx_lcid: 1036');
  for (const [code, language, label] of [['en-US', 'lang-en', 'English'], ['fr-FR', 'lang-fr', 'French']]) {
    const prefix = path.join(fx.portal, `web-pages/home/Home.${code}.webpage`);
    fs.writeFileSync(`${prefix}.yml`, `adx_webpageid: home-${code}\nadx_rootwebpageid: home\nadx_isroot: false\nadx_name: ${label} page\nadx_webpagelanguageid: ${language}\nadx_partialurl: /\nadx_pagetemplateid: main`);
    fs.writeFileSync(`${prefix}.copy.html`, `{{ snippets["Banner"] }}<p>${label}</p>`);
    fs.writeFileSync(`${prefix}.custom_javascript.js`, `window.language = '${code}';`);
    const snippet = path.join(fx.portal, `content-snippets/Banner.${code}.contentsnippet`);
    fs.writeFileSync(`${snippet}.yml`, `adx_contentsnippetid: banner-${code}\nadx_name: Banner\nadx_contentsnippetlanguageid: ${language}`);
    fs.writeFileSync(`${snippet}.value.html`, `${label} banner`);
  }
  fs.writeFileSync(path.join(fx.portal, 'content-snippets/ZZDisabled.contentsnippet.yml'), 'adx_contentsnippetid: disabled-banner\nadx_name: Banner\nadx_contentsnippetlanguageid: lang-fr\nadx_statecode: 1\nadx_value: Inactive banner');
  const inspector = createSourceInspector({ sourceDir: fx.portal, mirageConfig: { project: fx.project } });
  const french = (await inspector.inspect('/fr-FR/')).report;
  assert.equal(french.language.code, 'fr-FR');
  assert.equal(french.page.title, 'French page');
  assert.equal(french.requestPath, '/fr-FR/');
  assert.equal(french.pageSources.find((row) => row.name === 'Page JavaScript').sourceFile, path.join(fx.portal, 'web-pages/home/Home.fr-FR.webpage.custom_javascript.js'));
  assert.equal(french.snippets[0].value, 'French banner');
  assert.equal(french.snippets[0].sourceFile, path.join(fx.portal, 'content-snippets/Banner.fr-FR.contentsnippet.value.html'));
  const english = (await inspector.inspect('/en-US/')).report;
  assert.equal(english.page.title, 'English page');
  assert.equal(english.snippets[0].value, 'English banner');
  assert.equal(english.snippets[0].sourceFile, path.join(fx.portal, 'content-snippets/Banner.en-US.contentsnippet.value.html'));
  assert.equal((await inspector.inspect('/zz-ZZ/')).report.page, null);
});

test('asset inspection follows relative declared references with exact browser path matching', async (t) => {
  const fx = inspectionFixture(); t.after(fx.cleanup);
  fs.writeFileSync(path.join(fx.portal, 'web-pages/home/Home.webpage.copy.html'), '<script src="widget.js?v=1"></script><link href="assets/theme.css"><script src="/unrelated.js.backup"></script><img src="https://external.invalid/foreign.svg">');
  const files = {
    'assets/theme.css': '@import "./nested.css"; .icon { background: url("../logo.svg#icon"); }',
    'assets/nested.css': '@font-face { src: url("../font.woff2"); }',
    'module.js': "export const table = '/_api/fx_widgets';",
    'logo.svg': '<svg/>', 'font.woff2': 'fixture', 'unrelated.js': 'window.unrelated = true;', 'foreign.svg': '<svg/>',
  };
  fs.writeFileSync(path.join(fx.portal, 'web-files/widget.js'), "import('./module.js');");
  for (const [route, body] of Object.entries(files)) {
    const name = route.replaceAll('/', '-');
    fs.writeFileSync(path.join(fx.portal, `web-files/${name}.webfile.yml`), `adx_webfileid: ${name}\nadx_name: ${name}\nadx_partialurl: ${route}\nadx_parentpageid: home\nfilename: ${name}`);
    fs.writeFileSync(path.join(fx.portal, `web-files/${name}`), body);
  }
  const { report } = await createSourceInspector({ sourceDir: fx.portal, mirageConfig: { project: fx.project } }).inspect('/');
  assert.deepEqual(report.assets.map((row) => row.url).sort(), ['/assets/nested.css', '/assets/theme.css', '/font.woff2', '/logo.svg', '/module.js', '/widget.js']);
  assert.equal(report.apiReferences.find((row) => row.name === 'fx_widgets')?.entity, 'fx_widget');
});

test('PCF schema-name references trace literal dataset tables, views and columns while dynamic or ambiguous bindings stay unknown', async (t) => {
  const fx = inspectionFixture(); t.after(fx.cleanup);
  addNativeInspectionFixture(fx);
  fs.writeFileSync(path.join(fx.portal, 'web-pages/home/Home.webpage.yml'), 'adx_webpageid: home\nadx_name: Widget page\nadx_partialurl: /\nadx_pagetemplateid: main');
  fs.writeFileSync(path.join(fx.portal, 'web-pages/home/Home.webpage.copy.html'), `{% codecomponent name:'fx_Example.Grid', Rows:'child-view' %}{% codecomponent name:'fx_Example.Grid', Rows:page.view %}{% codecomponent name:'fx_example.grid', Rows:'fx_child' %}{% codecomponent name:'fx_Example.Grid', Rows:'Related children' %}`);
  const controlDir = path.join(fx.solution, 'Controls/fx_Example.Grid');
  fs.mkdirSync(controlDir, { recursive: true });
  fs.writeFileSync(path.join(controlDir, 'ControlManifest.xml'), '<manifest><control namespace="Example" constructor="Grid" control-type="standard"><data-set name="Rows"/><resources><code path="bundle.js" order="1"/></resources></control></manifest>');
  fs.writeFileSync(path.join(controlDir, 'ControlManifest.xml.data.xml'), '<CustomControl><Name>fx_Example.Grid</Name></CustomControl>');
  fs.writeFileSync(path.join(controlDir, 'bundle.js'), 'window.Example = {};');
  const viewFile = path.join(fx.solution, 'Entities/fx_child/SavedQueries/child-view.xml');
  fs.writeFileSync(path.join(fx.solution, 'Entities/fx_child/SavedQueries/duplicate-view.xml'), fs.readFileSync(viewFile, 'utf8').replace('child-view', 'duplicate-view'));
  const { report } = await createSourceInspector({ sourceDir: fx.portal, mirageConfig: { project: fx.project } }).inspect('/');
  const [view, dynamic, table, ambiguous] = report.codeComponents;
  assert.equal(view.binding, 'declared-schema-name');
  assert.equal(view.sourceFile, path.join(controlDir, 'ControlManifest.xml'));
  assert.equal(view.datasets[0].sourceFile, viewFile);
  assert.equal(view.datasets[0].entity, 'fx_child');
  assert.equal(view.datasets[0].viewId, 'child-view');
  assert.equal(view.datasets[0].fields[0].name, 'fx_name');
  assert.equal(dynamic.datasets[0].resolved, false);
  assert.equal(dynamic.datasets[0].evidence, 'dynamic-reference');
  assert.equal(table.schemaName, 'fx_Example.Grid');
  assert.equal(table.datasets[0].sourceFile, path.join(fx.solution, 'Entities/fx_child/Entity.xml'));
  assert.equal(ambiguous.datasets[0].resolved, false);
  assert.equal(report.views.find((row) => row.id === 'child-view').evidence, 'code-component-dataset');
  assert.equal(report.columns.find((row) => row.entity === 'fx_child' && row.name === 'fx_name').evidence, 'code-component-dataset');
  assert.equal(report.tables.find((row) => row.logicalName === 'fx_child').permissions.effective, 'unknown');
  assert.equal(report.unresolved.some((row) => /Multiple exported views/.test(row.reason)), true);
});

test('native PCF inspection links FormXml, enabled attribute metadata and manifests without treating model-driven defaults as portal enablement', async (t) => {
  const fx = inspectionFixture(); t.after(fx.cleanup);
  const formFile = path.join(fx.solution, 'Entities/fx_widget/FormXml/main/widget-form.xml');
  const descriptions = '<controlDescriptions><controlDescription forControl="native-editor"><customControl name="fx_Example.Editor" formFactor="0"><parameters><value>fx_title</value><caption static="true" type="SingleLine.Text">Configured label</caption></parameters></customControl><customControl name="fx_Example.Tablet" formFactor="1"><parameters><value>fx_title</value></parameters></customControl></controlDescription></controlDescriptions>';
  fs.writeFileSync(formFile, fs.readFileSync(formFile, 'utf8').replace('id="fx_title"', 'id="fx_title" uniqueid="native-editor"').replace('</tabs>', `</tabs>${descriptions}`));
  const metadataFile = path.join(fx.portal, 'basic-forms/Widget.basicform.basicformmetadata.yml');
  fs.writeFileSync(metadataFile, 'adx_entityformmetadataid: editor-setting\nadx_entityform: widget-edit\nadx_type: 100000000\nadx_attributelogicalname: fx_title\nadx_controlstyle: 756150001');
  for (const component of ['Editor', 'Tablet']) {
    const controlDir = path.join(fx.solution, `Controls/fx_Example.${component}`); fs.mkdirSync(controlDir, { recursive: true });
    fs.writeFileSync(path.join(controlDir, 'ControlManifest.xml'), `<manifest><control namespace="Example" constructor="${component}" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="bound"/><resources><code path="bundle.js" order="1"/></resources></control></manifest>`);
    fs.writeFileSync(path.join(controlDir, 'ControlManifest.xml.data.xml'), `<CustomControl><Name>fx_Example.${component}</Name></CustomControl>`);
    fs.writeFileSync(path.join(controlDir, 'bundle.js'), 'window.Example = {};');
  }
  const inspector = createSourceInspector({ sourceDir: fx.portal, mirageConfig: { project: fx.project } });
  const rendered = { controls: [{ schemaName: 'fx_Example.Editor', nativeField: 'fx_title' }] };
  let { report } = await inspector.inspect('/', rendered);
  const editor = report.codeComponents.find((row) => row.name === 'fx_Example.Editor');
  const tablet = report.codeComponents.find((row) => row.name === 'fx_Example.Tablet');
  assert.equal(editor.binding, 'native-formxml');
  assert.equal(editor.sourceFile, path.join(fx.solution, 'Controls/fx_Example.Editor/ControlManifest.xml'));
  assert.equal(editor.formSource.sourceFile, formFile);
  assert.equal(editor.metadataSources[0].sourceFile, metadataFile);
  assert.equal(editor.enablement, 'configured');
  assert.equal(editor.selectedDesktop, true);
  assert.equal(editor.evidence, 'rendered-and-form-source');
  assert.equal(editor.parameters.value.column, 'fx_title');
  assert.equal(tablet.selectedDesktop, false);
  fs.writeFileSync(metadataFile, fs.readFileSync(metadataFile, 'utf8').replace('756150001', '0'));
  inspector.invalidate(); report = (await inspector.inspect('/')).report;
  assert.equal(report.codeComponents.find((row) => row.name === 'fx_Example.Editor').enablement, 'not-enabled');
});

test('portal-only live inspection resolves source chains, files and role grants without claiming effective access', async (t) => {
  const fx = inspectionFixture(); t.after(fx.cleanup);
  const inspector = createSourceInspector({ sourceDir: fx.portal });
  const { report, roots } = await inspector.inspect('/', { assets: [{ path: '/widget.css' }], controls: [{ tag: 'input', id: 'fx_title', name: 'fx_title' }] });
  assert.deepEqual(roots, [fx.portal]);
  assert.equal(report.evidence.mode, 'live-sources');
  assert.equal(report.page.pageName, 'Widget page');
  assert.deepEqual(report.webTemplates.map((row) => row.name).sort(), ['Main', 'Partial']);
  assert.equal(report.snippets[0].name, 'Banner');
  assert.equal(report.forms[0].entity, 'fx_widget');
  assert.equal(report.forms[0].formXml, null);
  assert.equal(report.tables[0].permissions.effective, 'unknown');
  assert.equal(report.page.access.allowed, undefined);
  assert.deepEqual(report.permissionRules.map((row) => row.roles[0]).sort(), ['Editor', 'Reader']);
  assert.equal(report.pageSources.some((row) => row.sourceFile.endsWith('custom_javascript.js')), true);
  assert.equal(report.assets.find((row) => row.url === '/widget.css').evidence, 'rendered-asset');
  assert.equal(report.renderedControls[0].evidence, 'rendered-unmapped');
});

test('project-selected Solution metadata provides exact FormXml and field paths; refresh observes source edits', async (t) => {
  const fx = inspectionFixture(); t.after(fx.cleanup);
  const inspector = createSourceInspector({ sourceDir: fx.portal, mirageConfig: { project: fx.project } });
  const { report, roots } = await inspector.inspect('/', { controls: [{ tag: 'input', id: 'fx_title', name: 'fx_title' }] });
  assert.deepEqual(roots, [fx.portal, fx.solution]);
  assert.equal(report.forms[0].formXml.sourceFile, path.join(fx.solution, 'Entities/fx_widget/FormXml/main/widget-form.xml'));
  assert.equal(report.columns[0].name, 'fx_title');
  assert.equal(report.renderedControls[0].field, 'fx_widget.fx_title');
  assert.equal(report.renderedControls[0].sourceFile, path.join(fx.solution, 'Entities/fx_widget/Entity.xml'));
  fs.writeFileSync(path.join(fx.portal, 'content-snippets/Banner.contentsnippet.value.html'), 'Fresh banner');
  inspector.invalidate();
  assert.equal((await inspector.inspect('/')).report.snippets[0].value, 'Fresh banner');
});

test('missing or mismatched Solution configuration preserves portal inspection and does not select an unrelated project', async (t) => {
  const fx = inspectionFixture(); t.after(fx.cleanup);
  const sources = await inspectionSources({ sourceDir: fx.portal, mirageConfig: { solutionRoots: [path.join(fx.work, 'missing')] } });
  assert.deepEqual(sources.roots, []);
  assert.equal(sources.diagnostics[0].code, 'INSPECT_SOLUTION_UNAVAILABLE');
  assert.doesNotThrow(() => new Function(`return (${inspectRenderedPage.toString()})`));
  const other = inspectionFixture(); t.after(other.cleanup);
  const mismatched = await inspectionSources({ sourceDir: other.portal, mirageConfig: { project: fx.project } });
  assert.deepEqual(mismatched.roots, []);
  assert.equal(mismatched.diagnostics[0].code, 'INSPECT_PROJECT_UNAVAILABLE');
});

test('unquoted literal PCF IDs open declared manifest/resources, while dynamic component expressions stay unresolved', async (t) => {
  const fx = inspectionFixture(); t.after(fx.cleanup);
  const componentId = '10000000-0000-4000-8000-000000000001';
  const controlDir = path.join(fx.solution, 'Controls/fx_Example.Widget');
  fs.mkdirSync(controlDir, { recursive: true });
  fs.writeFileSync(path.join(controlDir, 'ControlManifest.xml'), '<manifest><control namespace="Example" constructor="Widget" control-type="standard"><resources><code path="bundle.js" order="1"/></resources></control></manifest>');
  fs.writeFileSync(path.join(controlDir, 'ControlManifest.xml.data.xml'), '<CustomControl><Name>fx_Example.Widget</Name></CustomControl>');
  fs.writeFileSync(path.join(controlDir, 'bundle.js'), 'window.Example = {};');
  fs.appendFileSync(path.join(fx.portal, 'web-pages/home/Home.webpage.copy.html'), `{% codecomponent name:${componentId} %}{% codecomponent name: page.component %}`);
  const inspector = createSourceInspector({ sourceDir: fx.portal, mirageConfig: { solutionRoots: [fx.solution], observed: { codeComponents: { [componentId]: 'fx_Example.Widget' } } } });
  const { report } = await inspector.inspect('/');
  assert.equal(report.codeComponents[0].schemaName, 'fx_Example.Widget');
  assert.equal(report.codeComponents[0].sourceFile, path.join(controlDir, 'ControlManifest.xml'));
  assert.equal(report.codeComponents[0].resources[0].sourceFile, path.join(controlDir, 'bundle.js'));
  assert.equal(report.codeComponents[1].dynamic, true);
  assert.equal(report.codeComponents[1].sourceFile, undefined);
  assert.equal(report.unresolved.some((row) => row.kind === 'code-component' && /dynamic/.test(row.reason)), true);
});

test('observed component IDs resolve dynamic form references without guessing variable values', async (t) => {
  const fx = inspectionFixture(); t.after(fx.cleanup);
  const pageFile = path.join(fx.portal, 'web-pages/home/Home.webpage.yml');
  fs.writeFileSync(pageFile, fs.readFileSync(pageFile, 'utf8').replace('\nadx_entityformid: widget-edit', ''));
  fs.writeFileSync(path.join(fx.portal, 'web-pages/home/Home.webpage.copy.html'), '{% entityform name: selected_form %}');
  const inspector = createSourceInspector({ sourceDir: fx.portal, mirageConfig: { solutionRoots: [fx.solution] } });
  assert.equal((await inspector.inspect('/')).report.forms.length, 0);
  const { report } = await inspector.inspect('/', { controls: [{ tag: 'form', formId: 'widget-edit', entity: 'fx_widget' }, { tag: 'input', id: 'fx_title', name: 'fx_title' }] });
  assert.equal(report.forms[0].evidence, 'rendered-component-id');
  assert.equal(report.forms[0].formXml.sourceFile, path.join(fx.solution, 'Entities/fx_widget/FormXml/main/widget-form.xml'));
  assert.equal(report.renderedControls[1].field, 'fx_widget.fx_title');
});

test('native subgrids and quick views trace child views, tables, fields, action metadata and modal form sources', async (t) => {
  const fx = inspectionFixture(); t.after(fx.cleanup); addNativeInspectionFixture(fx);
  const inspector = createSourceInspector({ sourceDir: fx.portal, mirageConfig: { solutionRoots: [fx.solution] } });
  const { report } = await inspector.inspect('/', { controls: [{ tag: 'div', gridId: 'ChildGrid', viewId: 'child-view' }, { tag: 'span', formId: 'widget-edit', entity: 'fx_widget' }] });
  assert.equal(report.views.find((view) => view.id === 'child-view').sourceFile, path.join(fx.solution, 'Entities/fx_child/SavedQueries/child-view.xml'));
  assert.equal(report.views.find((view) => view.id === 'child-view').evidence, 'rendered-view-id');
  assert.equal(report.tables.some((table) => table.logicalName === 'fx_child'), true);
  assert.equal(report.columns.some((field) => field.entity === 'fx_child' && field.name === 'fx_name'), true);
  assert.equal(report.forms.find((form) => form.id === 'widget-edit').evidence, 'rendered-component-id');
  for (const operation of ['create', 'edit', 'read']) {
    const form = report.forms.find((form) => form.id === `child-${operation}`);
    assert.equal(form.evidence, 'configured-modal-form');
    assert.equal(form.formXml.sourceFile, path.join(fx.solution, 'Entities/fx_child/FormXml/main/child-form.xml'));
  }
  assert.equal(report.forms.some((form) => form.id === 'stale-modal-id'), false);
  const grid = report.nativeComponents.find((control) => control.id === 'ChildGrid');
  assert.equal(grid.evidence, 'rendered-control-id');
  assert.equal(grid.relationship, 'fx_widget_children');
  assert.equal(grid.metadataSources[0].sourceFile, path.join(fx.portal, 'basic-forms/Widget.basicform.basicformmetadata.yml'));
  assert.equal(grid.actions.find((action) => action.name === 'DetailsAction').conditional, true);
  assert.equal(report.nativeComponents.find((control) => control.id === 'ChildQuick').sourceFile, path.join(fx.solution, 'Entities/fx_child/FormXml/quick/quick-form.xml'));
});

test('observed Web API entity sets resolve selected metadata without inventing mappings for portal-only exports', async (t) => {
  const fx = inspectionFixture(); t.after(fx.cleanup);
  const portalOnly = await createSourceInspector({ sourceDir: fx.portal }).inspect('/', { apiSets: ['fx_widgets', 'unexported_sets'] });
  assert.equal(portalOnly.report.apiReferences.find((row) => row.name === 'fx_widgets').entity, null);
  const withSolution = await createSourceInspector({ sourceDir: fx.portal, mirageConfig: { solutionRoots: [fx.solution] } }).inspect('/', { apiSets: ['fx_widgets', 'unexported_sets'] });
  assert.equal(withSolution.report.apiReferences.find((row) => row.name === 'fx_widgets').entity, 'fx_widget');
  assert.equal(withSolution.report.apiReferences.find((row) => row.name === 'fx_widgets').evidence, 'observed-api-request');
  assert.equal(withSolution.report.apiReferences.find((row) => row.name === 'unexported_sets').entity, null);
});
