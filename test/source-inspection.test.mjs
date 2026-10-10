import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSourceInspector, inspectionSources, inspectRenderedPage } from '../lense/source-inspection.mjs';
import { inspectionFixture, addNativeInspectionFixture } from './source-inspection-fixture.mjs';

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
