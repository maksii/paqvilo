// @test-kind contract: source inspection joins exported components, Solution metadata and observed requests with invented fixtures; Paqvilo's own report design, no native capture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApiRouteObserver, createSourceInspector, inspectionSources } from '../lense/source-inspection.mjs';
import { inspectionFixture, addNativeInspectionFixture } from './source-inspection-fixture.mjs';

const write = (root, name, body) => {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), body);
};
const copy = (fx, body) => write(fx.portal, 'web-pages/home/Home.webpage.copy.html', body);
const inspect = (fx, route = '/', rendered = {}) =>
  createSourceInspector({ sourceDir: fx.portal, mirageConfig: { solutionRoots: [fx.solution] } }).inspect(
    route,
    rendered,
  );
const otherTable = (fx) => {
  write(
    fx.solution,
    'Entities/fx_other/Entity.xml',
    '<Entity><Name>fx_other</Name><EntityInfo><entity Name="fx_other"><EntitySetName>fx_others</EntitySetName><attributes><attribute PhysicalName="fx_label"><Type>nvarchar</Type><Name>fx_label</Name><LogicalName>fx_label</LogicalName></attribute></attributes></entity></EntityInfo></Entity>',
  );
  write(
    fx.solution,
    'Entities/fx_other/SavedQueries/other-lookup.xml',
    '<savedquery><savedqueryid>other-lookup</savedqueryid><querytype>64</querytype><isdefault>1</isdefault><fetchxml><fetch><entity name="fx_other"><attribute name="fx_label"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="fx_label" width="100"/></row></grid></layoutxml><LocalizedNames><LocalizedName description="Other lookup" languagecode="1033"/></LocalizedNames></savedquery>',
  );
};

test('C1: a codecomponent tag whose arguments contain % is still found', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  copy(fx, `{% codecomponent name:'fx_Example.Wide' width:'50%' %}`);
  const { report } = await inspect(fx);
  assert.deepEqual(
    report.codeComponents.map((row) => row.name),
    ['fx_Example.Wide'],
  );
});

test('C1: server logic tags with a % argument were already found (start-anchored pattern)', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  write(fx.portal, 'server-logic/orders.serverlogic.yml', 'adx_serverlogicid: orders-logic\nadx_name: orders');
  write(fx.portal, 'server-logic/orders.js', 'function get() {}');
  copy(fx, `{% serverlogic name:'orders' note:'100%' %}`);
  const { report } = await inspect(fx);
  assert.deepEqual(
    report.logic.filter((row) => row.kind === 'server-logic').map((row) => row.name),
    ['orders'],
  );
});

test('C6 and C7: a form without FormXml never takes a same-named list view, and the failed join is unresolved', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  write(
    fx.portal,
    'basic-forms/Same.basicform.yml',
    'adx_entityformid: same-form\nadx_name: Same\nadx_entityname: fx_widget\nadx_formname: Absent form\nadx_mode: 100000000',
  );
  write(
    fx.portal,
    'lists/Same.list.yml',
    'adx_entitylistid: same-list\nadx_name: Same\nadx_entityname: fx_widget\nadx_view: widget-view',
  );
  write(
    fx.solution,
    'Entities/fx_widget/SavedQueries/widget-view.xml',
    '<savedquery><savedqueryid>widget-view</savedqueryid><fetchxml><fetch><entity name="fx_widget"><attribute name="fx_title"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="fx_title" width="100"/></row></grid></layoutxml><LocalizedNames><LocalizedName description="Widgets" languagecode="1033"/></LocalizedNames></savedquery>',
  );
  copy(fx, '{% entityform id: "same-form" %}');
  const { report } = await inspect(fx);
  const form = report.forms.find((row) => row.id === 'same-form');
  assert.equal(form.formXml, null);
  assert.equal(
    report.componentIndex.forms.find((row) => row.id === 'same-form').formXml,
    null,
    'the export index does not join the form to the list view either',
  );
  const missing = report.unresolved.find((row) => row.code === 'SYSTEMFORM_UNRESOLVED');
  assert.equal(missing?.componentId, 'same-form');
  assert.equal(missing.componentKind, 'basic-form');
  assert.equal(missing.expression, 'Same');
});

test('C10 and C11: relative and normalised literal references resolve against the requested address', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  write(
    fx.portal,
    'web-pages/other/Other.webpage.copy.html',
    '<script src="other.js"></script><img src="~/Logo%20One.PNG?v=2">',
  );
  write(
    fx.portal,
    'web-files/other.js.webfile.yml',
    'adx_webfileid: other-js\nadx_name: other.js\nadx_partialurl: other.js\nadx_parentpageid: other\nfilename: other.js',
  );
  write(
    fx.portal,
    'web-files/other.js',
    "fetch('/data.json'); $.getScript('/lazy.js'); $.ajax({ url: '/ajax.js' }); new URL('/module.js', location); ",
  );
  for (const [name, body] of [
    ['logo one.png', 'png'],
    ['data.json', '{}'],
    ['lazy.js', ''],
    ['ajax.js', ''],
    ['module.js', ''],
    ['poster.png', 'png'],
    ['small.png', 'png'],
    ['imported.css', ''],
  ]) {
    write(
      fx.portal,
      `web-files/${name}.webfile.yml`,
      `adx_webfileid: ${name.replace(/\W/g, '-')}\nadx_name: ${name}\nadx_partialurl: ${name}\nadx_parentpageid: home\nfilename: ${name}`,
    );
    write(fx.portal, `web-files/${name}`, body);
  }
  write(fx.portal, 'web-files/widget.css', "@import url('/imported.css');");
  copy(
    fx,
    '<link rel="stylesheet" href="/widget.css"><video poster="/poster.png"></video><img srcset="/small.png 1x, /missing.png 2x">',
  );
  const { report: other } = await inspect(fx, '/other/');
  assert.ok(
    other.assets.some((row) => row.url === '/other/other.js'),
    'relative to /other/, not /',
  );
  for (const url of ['/logo one.png', '/data.json', '/lazy.js', '/ajax.js', '/module.js'])
    assert.ok(
      other.assets.some((row) => row.url.toLowerCase() === url),
      url,
    );
  const { report: home } = await inspect(fx, '/');
  for (const url of ['/poster.png', '/small.png', '/imported.css'])
    assert.ok(
      home.assets.some((row) => row.url === url),
      url,
    );
});

test('C12: the stylesheets the platform layout links for a page are reported without any markup naming them', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  write(
    fx.portal,
    'page-templates/Main.pagetemplate.yml',
    'adx_pagetemplateid: main\nadx_name: Main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
  );
  copy(fx, '<p>No stylesheet link here.</p>');
  write(
    fx.portal,
    'web-files/child.css.webfile.yml',
    'adx_webfileid: child-css\nadx_name: child.css\nadx_partialurl: child.css\nadx_parentpageid: other\nfilename: child.css',
  );
  write(fx.portal, 'web-files/child.css', '');
  const { report } = await inspect(fx, '/');
  const linked = report.assets.find((row) => row.url === '/widget.css');
  assert.equal(linked?.evidence, 'platform-linked-stylesheet');
  assert.equal(
    report.assets.some((row) => row.url === '/other/child.css'),
    false,
    'a descendant page stylesheet is not linked on its ancestor',
  );
  const { report: child } = await inspect(fx, '/other/');
  assert.ok(child.assets.some((row) => row.url === '/widget.css'));
  assert.ok(child.assets.some((row) => row.url === '/other/child.css'));
});

test('C13, C14, C15 and C21: component JavaScript is scanned, Web API tables load on demand with their settings, and gaps are unresolved', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  otherTable(fx);
  write(
    fx.portal,
    'basic-forms/Widget.basicform.custom_javascript.js',
    "fetch('/_api/fx_others'); fetch('/_api/fx_absents'); const set = 'fx_'; fetch('/_api/' + set);",
  );
  write(
    fx.portal,
    'sitesetting.yml',
    '- adx_sitesettingid: api-on\n  adx_name: Webapi/fx_other/enabled\n  adx_value: true\n- adx_sitesettingid: api-fields\n  adx_name: Webapi/fx_other/fields\n  adx_value: fx_label',
  );
  const { report } = await inspect(fx);
  const other = report.apiReferences.find((row) => row.name === 'fx_others');
  assert.equal(other.entity, 'fx_other', 'the table only the Web API reaches is loaded from the Solution sources');
  const table = report.tables.find((row) => row.logicalName === 'fx_other');
  assert.equal(table.metadataState, 'loaded');
  assert.ok(table.sourceFile.endsWith(path.join('fx_other', 'Entity.xml')));
  assert.deepEqual(
    report.siteSettings
      .filter((row) => /^Webapi\/fx_other\//.test(row.name))
      .map((row) => row.name)
      .sort(),
    ['Webapi/fx_other/enabled', 'Webapi/fx_other/fields'],
  );
  assert.ok(report.unresolved.some((row) => row.kind === 'web-api-entity-set' && row.expression === 'fx_absents'));
  const dynamic = report.unresolved.find((row) => row.kind === 'web-api-dynamic');
  assert.ok(dynamic.sourceFile.endsWith('Widget.basicform.custom_javascript.js'));
  assert.equal(
    report.unresolved.some((row) => row.kind === 'web-api-entity-set' && row.expression === 'fx_'),
    false,
    'a partial literal set name is not reported as an unknown set',
  );
});

test('C15: a table found during enrichment without Solution metadata gets an unresolved entry', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  addNativeInspectionFixture(fx);
  fs.rmSync(path.join(fx.solution, 'Entities/fx_child/Entity.xml'));
  const { report } = await inspect(fx);
  const child = report.tables.find((row) => row.logicalName === 'fx_child');
  assert.equal(child.metadataState, 'not-in-solution-sources');
  assert.ok(report.unresolved.some((row) => row.kind === 'table' && row.expression === 'fx_child'));
});

test('C16 and C17: list, subgrid and form targets and every form metadata row are related to their component', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  addNativeInspectionFixture(fx);
  const settings = {
    ItemActions: [
      { Type: 'CrmEntityFormView-DetailsAction', TargetType: 1, RedirectWebpageId: 'other' },
      { Type: 'CrmEntityFormView-EditAction', TargetType: 2, RedirectUrl: '/external/edit' },
      { Type: 'CrmEntityFormView-WorkflowAction', Workflow: { Id: 'flow-1', Name: 'Approve' } },
    ],
  };
  write(
    fx.portal,
    'lists/Items.list.yml',
    `adx_entitylistid: item-list\nadx_name: Items\nadx_entityname: fx_widget\nadx_webpagefordetailsview: other\nadx_webpageforcreate: gone-page\nadx_settings: ${JSON.stringify(JSON.stringify(settings))}`,
  );
  write(
    fx.portal,
    'basic-forms/Widget.basicform.yml',
    'adx_entityformid: widget-edit\nadx_name: Edit widget\nadx_entityname: fx_widget\nadx_formname: Widget form\nadx_mode: 100000001\nadx_onsuccess: 756150001\nadx_redirectwebpage: other',
  );
  write(
    fx.portal,
    'basic-forms/Widget.attribute.basicformmetadata.yml',
    '- adx_entityformmetadataid: title-row\n  adx_entityform: widget-edit\n  adx_type: 100000000\n  adx_attributelogicalname: fx_title\n- adx_entityformmetadataid: notes-row\n  adx_entityform: widget-edit\n  adx_type: 100000005\n- adx_entityformmetadataid: inactive-row\n  adx_entityform: widget-edit\n  adx_type: 100000001\n  adx_sectionname: hidden\n  statecode: 1',
  );
  copy(fx, '{% entitylist name: "Items" %}{% endentitylist %}{% entityform name: "Edit widget" %}');
  const { report } = await inspect(fx);
  const list = report.components.find((row) => row.kind === 'list');
  const kinds = list.relations.map((row) => [row.kind, row.url ?? row.workflowId ?? row.pageId]);
  assert.deepEqual(kinds, [
    ['details-page', '/other/'],
    ['create-page', 'gone-page'],
    ['action-page', '/other/'],
    ['action-url', '/external/edit'],
    ['workflow', 'flow-1'],
  ]);
  assert.ok(report.unresolved.some((row) => row.kind === 'target-page' && row.expression === 'gone-page'));
  const form = report.forms.find((row) => row.id === 'widget-edit');
  assert.deepEqual(
    form.relations.map((row) => [row.kind, row.url]),
    [['redirect-page', '/other/']],
  );
  const rows = Object.fromEntries(form.metadataRows.map((row) => [row.id, [row.type, row.target]]));
  assert.deepEqual(rows['title-row'], ['attribute', 'fx_title']);
  assert.deepEqual(rows['notes-row'], ['notes', null]);
  assert.ok(rows['grid-settings'], 'the subgrid settings row of the fixture is listed too');
  assert.equal(rows['inactive-row'], undefined, 'inactive rows are not listed');
  const grid = report.nativeComponents.find((row) => row.kind === 'subgrid');
  assert.deepEqual(
    grid.relations.map((row) => row.kind),
    ['action-page'],
  );
});

test('C18: a lookup without DefaultViewId reports its target table and that table default lookup view', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  otherTable(fx);
  const entity = path.join(fx.solution, 'Entities/fx_widget/Entity.xml');
  fs.writeFileSync(
    entity,
    fs
      .readFileSync(entity, 'utf8')
      .replace(
        '</attributes>',
        '<attribute PhysicalName="fx_otherid"><Type>lookup</Type><Name>fx_otherid</Name><LogicalName>fx_otherid</LogicalName></attribute></attributes>',
      ),
  );
  write(
    fx.solution,
    'Other/Relationships/fx_other.xml',
    '<EntityRelationships><EntityRelationship Name="fx_other_widgets"><EntityRelationshipType>OneToMany</EntityRelationshipType><ReferencingEntityName>fx_widget</ReferencingEntityName><ReferencedEntityName>fx_other</ReferencedEntityName><ReferencingAttributeName>fx_otherid</ReferencingAttributeName><ReferencedAttributeName>fx_otherid</ReferencedAttributeName></EntityRelationship></EntityRelationships>',
  );
  const form = path.join(fx.solution, 'Entities/fx_widget/FormXml/main/widget-form.xml');
  fs.writeFileSync(
    form,
    fs
      .readFileSync(form, 'utf8')
      .replace('</rows>', '<row><cell><control id="fx_otherid" datafieldname="fx_otherid"/></cell></row></rows>'),
  );
  const { report } = await inspect(fx);
  const lookup = report.nativeComponents.find((row) => row.kind === 'lookup' && row.id === 'fx_otherid');
  assert.deepEqual(lookup.targets, ['fx_other']);
  assert.equal(lookup.viewSource, 'table-default');
  assert.deepEqual(
    lookup.defaultViews.map((row) => [row.entity, row.viewId, row.tableDefault]),
    [['fx_other', 'other-lookup', true]],
  );
  assert.ok(report.views.some((row) => row.id === 'other-lookup' && row.evidence === 'lookup-default-view'));
});

test('C27 (live): same-origin requests mark web files and cloud flows as requested, without query values', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  copy(fx, '<p>No static reference.</p>');
  write(
    fx.portal,
    'cloudflowconsumer.yml',
    '- adx_cloudflowconsumerid: flow-consumer\n  adx_name: Notify\n  adx_flowapiurl: /_api/cloudflow/v1.0/trigger/flow-run',
  );
  const observer = createApiRouteObserver();
  observer.record('https://portal.invalid/widget.js?token=secret-value', 'https://portal.invalid/');
  observer.record('https://portal.invalid/_api/cloudflow/v1.0/trigger/flow-run', 'https://portal.invalid/');
  const rendered = observer.merge({ assets: [], controls: [] });
  assert.equal(JSON.stringify(rendered).includes('secret-value'), false);
  const { report } = await inspect(fx, '/', rendered);
  assert.equal(report.assets.find((row) => row.url === '/widget.js')?.observed, 'requested');
  const flow = report.logic.find((row) => row.kind === 'cloud-flow');
  assert.equal(flow?.observed, 'requested');
});

test('C28: live inspection discovers sibling Solution sources as mirage dev does and says so', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  // A repository with the portal next to an unpacked Solution, as discoverSolutionRoots expects.
  const repository = path.join(fx.work, 'site-repo');
  fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
  fs.renameSync(fx.portal, path.join(repository, 'portal'));
  const solutions = path.join(fx.work, 'solutions-repo');
  fs.mkdirSync(path.join(solutions, 'src', 'Other'), { recursive: true });
  fs.writeFileSync(
    path.join(solutions, 'src', 'Other', 'Solution.xml'),
    '<ImportExportXml><SolutionManifest/></ImportExportXml>',
  );
  fs.cpSync(fx.solution, path.join(solutions, 'src'), { recursive: true });
  const sources = await inspectionSources({ sourceDir: path.join(repository, 'portal') });
  assert.equal(sources.selection.rule, 'sibling-discovery');
  assert.deepEqual(sources.roots, [fs.realpathSync(solutions)]);
  assert.ok(sources.diagnostics.some((row) => row.code === 'INSPECT_SOLUTION_ROOTS_DISCOVERED'));
  const inspector = createSourceInspector({ sourceDir: path.join(repository, 'portal') });
  const { report } = await inspector.inspect('/');
  assert.equal(report.sourceSelection.rule, 'sibling-discovery');
  const enriched = await inspector.enrich({ ...structuredClone(report), unresolved: [] });
  assert.ok(
    enriched.unresolved.some((row) => row.code === 'INSPECT_SOLUTION_ROOTS_DISCOVERED'),
    'enrich appends the source-selection diagnostics as inspect does',
  );
});

test('C32: the step in the page address marks the current multistep step, otherwise it stays unknown', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  write(
    fx.portal,
    'advanced-forms/Wizard.advancedform.yml',
    'adx_webformid: 0a0b0c0d-0000-4000-8000-000000000001\nadx_name: Wizard\nadx_startstep: 0a0b0c0d-0000-4000-8000-000000000011',
  );
  write(
    fx.portal,
    'advanced-forms/Wizard.advancedformstep.yml',
    '- adx_webformstepid: 0a0b0c0d-0000-4000-8000-000000000011\n  adx_name: First\n  adx_webform: 0a0b0c0d-0000-4000-8000-000000000001\n  adx_type: 100000001\n  adx_targetentitylogicalname: fx_widget\n  adx_formname: Widget form\n  adx_nextstep: 0a0b0c0d-0000-4000-8000-000000000012\n- adx_webformstepid: 0a0b0c0d-0000-4000-8000-000000000012\n  adx_name: Second\n  adx_webform: 0a0b0c0d-0000-4000-8000-000000000001\n  adx_type: 100000001\n  adx_targetentitylogicalname: fx_widget\n  adx_formname: Widget form',
  );
  copy(fx, '{% webform id: "0a0b0c0d-0000-4000-8000-000000000001" %}');
  const unknown = (await inspect(fx)).report.forms.find((row) => row.kind === 'advanced-form');
  assert.deepEqual(unknown.currentStep, { state: 'unknown' });
  const byAddress = (await inspect(fx, '/', { stepIds: ['0a0b0c0d-0000-4000-8000-000000000012'] })).report.forms.find(
    (row) => row.kind === 'advanced-form',
  );
  assert.deepEqual([byAddress.currentStep.name, byAddress.currentStep.evidence], ['Second', 'page-address-stepid']);
  const byIndicator = (
    await inspect(fx, '/', { multistep: [{ formControlId: '0a0b0c0d000040008000000000000001', stepIndex: 1 }] })
  ).report.forms.find((row) => row.kind === 'advanced-form');
  assert.deepEqual([byIndicator.currentStep.name, byIndicator.currentStep.evidence], ['Second', 'progress-indicator']);
});

test('C34: a page bound to a multistep form names it, and each step form lists its FormXml tabs and sections', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  const wizard = '0a0b0c0d-0000-4000-8000-000000000001';
  write(
    fx.portal,
    'advanced-forms/Wizard.advancedform.yml',
    `adx_webformid: ${wizard}\nadx_name: Wizard\nadx_startstep: 0a0b0c0d-0000-4000-8000-000000000011`,
  );
  write(
    fx.portal,
    'advanced-forms/Wizard.advancedformstep.yml',
    `- adx_webformstepid: 0a0b0c0d-0000-4000-8000-000000000011\n  adx_name: First\n  adx_webform: ${wizard}\n  adx_type: 100000001\n  adx_targetentitylogicalname: fx_widget\n  adx_formname: Widget form`,
  );
  write(
    fx.portal,
    'web-pages/home/Home.webpage.yml',
    `adx_webpageid: home\nadx_name: Widget page\nadx_partialurl: /\nadx_pagetemplateid: main\nadx_webform: ${wizard}`,
  );
  copy(fx, '<section>Wizard page</section>');
  const { report } = await inspect(fx);
  assert.equal(report.page.webFormId?.toLowerCase(), wizard);
  const indexed = report.componentIndex.forms.find((row) => row.kind === 'advanced-form');
  assert.deepEqual(
    indexed.formLayouts.map((layout) => [layout.id, layout.layout]),
    [['widget-form', [{ name: 'GENERAL', sections: ['main'] }]]],
  );
});

test('C33: web role records named by permission rules are linked with their source file', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  const inspector = createSourceInspector({ sourceDir: fx.portal, mirageConfig: { solutionRoots: [fx.solution] } });
  const { report } = await inspector.inspect('/', {});
  const reader = report.webRoles.find((row) => row.id === 'reader');
  assert.equal(reader.name, 'Reader');
  assert.ok(reader.sourceFile.endsWith('webrole.yml'));
  assert.deepEqual(reader.usedBy, ['Readers view widgets']);
  // The row is the role's record source of the shared index, and opens that record.
  assert.equal(reader.componentKey, 'web-role:reader');
  assert.deepEqual(reader.fieldPath, ['$record']);
  const open = (row) =>
    inspector.lookupSource({
      sourceKey: row.sourceKey,
      sourceRevision: row.sourceRevision,
      contentRevision: row.contentRevision,
    });
  const opened = await open(reader);
  assert.equal(opened.state, 'exact');
  assert.ok(opened.editorTarget.file.endsWith('webrole.yml'));
  const editor = await open(report.webRoles.find((row) => row.id === 'editor'));
  assert.ok(editor.editorTarget.line > opened.editorTarget.line, 'the second role in the file opens at its own record');
});
