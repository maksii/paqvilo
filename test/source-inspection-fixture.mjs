import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function inspectionFixture() {
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-inspect-')));
  const portal = path.join(work, 'portal'), solution = path.join(work, 'solution');
  const write = (root, files) => {
    for (const [name, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), body);
    }
  };
  write(portal, {
    'website.yml': 'adx_websiteid: site\nadx_name: Inspection fixture',
    'webrole.yml': '- adx_webroleid: reader\n  adx_name: Reader\n- adx_webroleid: editor\n  adx_name: Editor',
    'tablepermission.yml': '- adx_entitypermissionid: read-widgets\n  adx_name: Readers view widgets\n  adx_entitylogicalname: fx_widget\n  adx_scope: 756150000\n  adx_read: true\n  adx_entitypermission_webrole: [reader]\n- adx_entitypermissionid: edit-widgets\n  adx_name: Editors update widgets\n  adx_entitylogicalname: fx_widget\n  adx_scope: 756150000\n  adx_write: true\n  adx_entitypermission_webrole: [editor]',
    'web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Widget page\nadx_partialurl: /\nadx_pagetemplateid: main\nadx_entityformid: widget-edit',
    'web-pages/home/Home.webpage.copy.html': '<section>{% include "Partial" %}{{ snippets["Banner"] }}{% entityform name: "Edit widget" %}<script src="/widget.js"></script><link rel="stylesheet" href="/widget.css">',
    'web-pages/home/Home.webpage.custom_javascript.js': 'window.pageFeature = true;',
    'web-pages/home/Home.webpage.custom_css.css': '.widget { color: #364451; }',
    'web-pages/other/Other.webpage.yml': 'adx_webpageid: other\nadx_name: Other\nadx_partialurl: other\nadx_parentpageid: home',
    'web-pages/other/Other.webpage.copy.html': '<p>Another page</p>',
    'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_name: Main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'web-templates/Main.webtemplate.source.html': '{% include "Partial" %}',
    'web-templates/Partial.webtemplate.yml': 'adx_webtemplateid: partial\nadx_name: Partial',
    'web-templates/Partial.webtemplate.source.html': '<aside>{{ snippets["Banner"] }}</aside>',
    'content-snippets/Banner.contentsnippet.yml': 'adx_contentsnippetid: banner\nadx_name: Banner',
    'content-snippets/Banner.contentsnippet.value.html': 'Edit locally',
    'basic-forms/Widget.basicform.yml': 'adx_entityformid: widget-edit\nadx_name: Edit widget\nadx_entityname: fx_widget\nadx_formname: Widget form\nadx_mode: 100000001',
    'web-files/widget.js.webfile.yml': 'adx_webfileid: widget-js\nadx_name: widget.js\nadx_partialurl: widget.js\nadx_parentpageid: home\nfilename: widget.js',
    'web-files/widget.js': 'window.widgetFeature = true;',
    'web-files/widget.css.webfile.yml': 'adx_webfileid: widget-css\nadx_name: widget.css\nadx_partialurl: widget.css\nadx_parentpageid: home\nfilename: widget.css',
    'web-files/widget.css': '.widget { margin: 1rem; }',
  });
  write(solution, {
    'Entities/fx_widget/Entity.xml': '<Entity><Name LocalizedName="Widget">fx_widget</Name><EntityInfo><entity Name="fx_widget"><EntitySetName>fx_widgets</EntitySetName><PrimaryIdAttribute>fx_widgetid</PrimaryIdAttribute><attributes><attribute PhysicalName="fx_title"><Type>nvarchar</Type><Name>fx_title</Name><LogicalName>fx_title</LogicalName><RequiredLevel>required</RequiredLevel><displaynames><displayname description="Title" languagecode="1033"/></displaynames></attribute></attributes></entity></EntityInfo></Entity>',
    'Entities/fx_widget/FormXml/main/widget-form.xml': '<systemform><formid>widget-form</formid><FormActivationState>1</FormActivationState><form><tabs><tab name="GENERAL"><columns><column><sections><section name="main"><rows><row><cell><control id="fx_title" datafieldname="fx_title"/></cell></row></rows></section></sections></column></columns></tab></tabs></form><LocalizedNames><LocalizedName description="Widget form" languagecode="1033"/></LocalizedNames></systemform>',
  });
  const project = path.join(work, 'project.yml');
  fs.writeFileSync(project, 'version: 2\ndefaultPortal: fixture\nportals:\n  - id: fixture\n    source: ./portal\n    solutions: [sample]\nsolutions:\n  - id: sample\n    source: ./solution\n');
  return { work, portal, solution, project, cleanup: () => fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

export function addNativeInspectionFixture(fx) {
  const write = (root, name, body) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
  const formFile = path.join(fx.solution, 'Entities/fx_widget/FormXml/main/widget-form.xml');
  const grid = '<row><cell><labels><label description="Child records" languagecode="1033"/></labels><control id="ChildGrid" indicationOfSubgrid="true"><parameters><TargetEntityType>fx_child</TargetEntityType><ViewId>child-view</ViewId><RelationshipName>fx_widget_children</RelationshipName></parameters></control></cell></row>';
  const quick = '<row><cell><control id="ChildQuick" datafieldname="fx_childid"><parameters><QuickForms>&lt;QuickForms&gt;&lt;QuickFormId entityname="fx_child"&gt;quick-form&lt;/QuickFormId&gt;&lt;/QuickForms&gt;</QuickForms></parameters></control></cell></row>';
  fs.writeFileSync(formFile, fs.readFileSync(formFile, 'utf8').replace('</rows>', `${grid}${quick}</rows>`));
  write(fx.solution, 'Entities/fx_child/Entity.xml', '<Entity><Name>fx_child</Name><EntityInfo><entity Name="fx_child"><EntitySetName>fx_children</EntitySetName><attributes><attribute PhysicalName="fx_name"><Type>nvarchar</Type><Name>fx_name</Name><LogicalName>fx_name</LogicalName><displaynames><displayname description="Child name" languagecode="1033"/></displaynames></attribute></attributes></entity></EntityInfo></Entity>');
  write(fx.solution, 'Entities/fx_child/SavedQueries/child-view.xml', '<savedquery><savedqueryid>child-view</savedqueryid><fetchxml><fetch><entity name="fx_child"><attribute name="fx_name"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="fx_name" width="200"/></row></grid></layoutxml><LocalizedNames><LocalizedName description="Related children" languagecode="1033"/></LocalizedNames></savedquery>');
  write(fx.solution, 'Entities/fx_child/FormXml/main/child-form.xml', '<systemform><formid>child-form</formid><FormActivationState>1</FormActivationState><form><tabs><tab name="GENERAL"><columns><column><sections><section><rows><row><cell><control id="fx_name" datafieldname="fx_name"/></cell></row></rows></section></sections></column></columns></tab></tabs></form><LocalizedNames><LocalizedName description="Child form" languagecode="1033"/></LocalizedNames></systemform>');
  write(fx.solution, 'Entities/fx_child/FormXml/quick/quick-form.xml', '<systemform><formid>quick-form</formid><FormActivationState>1</FormActivationState><form><tabs><tab name="GENERAL"><columns><column><sections><section><rows><row><cell><control id="fx_name" datafieldname="fx_name"/></cell></row></rows></section></sections></column></columns></tab></tabs></form><LocalizedNames><LocalizedName description="Child quick view" languagecode="1033"/></LocalizedNames></systemform>');
  for (const [name, mode] of [['Create', 100000000], ['Edit', 100000001], ['Read', 100000002]]) write(fx.portal, `basic-forms/Child-${name}.basicform.yml`, `adx_entityformid: child-${name.toLowerCase()}\nadx_name: ${name} child\nadx_entityname: fx_child\nadx_formid: child-form\nadx_formname: Child form\nadx_mode: ${mode}`);
  const settings = { ViewActions: [{ Type: 'CrmEntityFormView-CreateAction', TargetType: 0, EntityFormId: 'child-create' }], ItemActions: [{ Type: 'CrmEntityFormView-EditAction', TargetType: 0, EntityFormId: 'child-edit' }, { Type: 'CrmEntityFormView-DetailsAction', TargetType: 0, EntityFormId: 'child-read', FilterCriteria: '<filter/>' }, { Type: 'CrmEntityFormView-EditAction', TargetType: 1, EntityFormId: 'stale-modal-id', RedirectWebpageId: 'other' }] };
  write(fx.portal, 'basic-forms/Widget.basicform.basicformmetadata.yml', `adx_entityformmetadataid: grid-settings\nadx_entityform: widget-edit\nadx_type: 100000002\nadx_subgrid_name: ChildGrid\nadx_subgrid_settings: ${JSON.stringify(JSON.stringify(settings))}`);
}
