import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { observedConfig } from '../lib/project-config.mjs';
const observed = observedConfig({
  liquidFetchExecution: 'lazy-query-drop',
  liquidFetchRights: 'native-classic',
  tablePermissionQueryPipeline: 'native-classic',
  evidence: 'Invented counterparts of separately recorded native HR and HR+IT rights probes',
});
const xml = '<fetch><entity name="widget"><attribute name="widgetid"></attribute></entity></fetch>';
const state = {
  mappings: { widget: { idColumn: 'widgetid', entitySet: 'widgets' } },
  tables: {
    widget: [
      { widgetid: 'one', hr: 'person', it: 'other' },
      { widgetid: 'two', hr: 'other', it: 'person' },
      { widgetid: 'three', hr: 'other', it: 'other' },
    ],
  },
  permissions: [
    { id: 'hr', entity: 'widget', scope: 'contact', field: 'hr', roles: ['HR'], operations: ['read'] },
    {
      id: 'it',
      entity: 'widget',
      scope: 'contact',
      field: 'it',
      roles: ['IT'],
      operations: ['read', 'update', 'create', 'delete', 'append', 'appendTo'],
    },
  ],
  settings: { permissionMode: 'enforce' },
};
function store() {
  const value = new DataStore({ state });
  value.setObserved(observed);
  return value;
}
test('observed Liquid rights select actual operation grants and Create executes unscoped authored rows', () => {
  const value = store(),
    hr = { contactId: 'person', roles: ['HR'] },
    both = { contactId: 'person', roles: ['HR', 'IT'] };
  for (const right of [undefined, 'read', 'invalid'])
    assert.deepEqual(
      value.fetchXml(xml, hr, { portalRequest: true, right }).entities.map((row) => row.widgetid),
      ['one'],
    );
  for (const right of ['write', 'create', 'Create']) {
    const preview = value.previewPermissionFetchXml(xml, hr, { right }),
      result = value.fetchXml(xml, hr, { portalRequest: true, right });
    assert.equal(preview.permissionGranted, false);
    assert.doesNotMatch(preview.xml, /distinct=/);
    assert.equal(result.permission_granted, false);
    assert.deepEqual(result.entities, []);
    assert.equal(result.backendAdmission, 'denied-before-dataverse');
  }
  assert.deepEqual(
    value.fetchXml(xml, both, { portalRequest: true, right: 'read' }).entities.map((row) => row.widgetid),
    ['one', 'two'],
  );
  assert.deepEqual(
    value.fetchXml(xml, both, { portalRequest: true, right: 'write' }).entities.map((row) => row.widgetid),
    ['two'],
  );
  for (const right of ['create', 'Create']) {
    const preview = value.previewPermissionFetchXml(xml, both, { right }),
      result = value.fetchXml(xml, both, { portalRequest: true, right });
    assert.equal(preview.permissionLinkCount, 0);
    assert.equal(preview.globalPermissionGranted, false);
    assert.doesNotMatch(preview.xml, /distinct=|generated_alias/);
    assert.deepEqual(
      result.entities.map((row) => row.widgetid),
      ['one', 'three', 'two'],
    );
    assert.equal(result.global_permission_granted, false);
  }
  const strict = new DataStore({ state });
  assert.deepEqual(
    strict.fetchXml(xml, both, { portalRequest: true, right: 'create' }).entities.map((row) => row.widgetid),
    ['one', 'two'],
  );
  assert.deepEqual(
    value
      .fetchXml(xml, both, { portalRequest: true, profile: 'webapi', right: 'create' })
      .entities.map((row) => row.widgetid),
    ['one', 'two'],
  );
  for (const right of ['delete', 'Delete', 'append', 'Append', 'appendto', 'AppendTo']) {
    assert.deepEqual(
      value.fetchXml(xml, both, { portalRequest: true, right }).entities.map((row) => row.widgetid),
      ['two'],
    );
    assert.equal(value.previewPermissionFetchXml(xml, hr, { right }).permissionGranted, false);
  }
  for (const right of ['append_to', 'constructor'])
    assert.deepEqual(
      value.fetchXml(xml, both, { portalRequest: true, right }).entities.map((row) => row.widgetid),
      ['one', 'two'],
    );
  assert.throws(() => observedConfig({ liquidFetchRights: 'native-classic' }), /evidence/);
});
test('renderer forwards each right through preview and one deferred backend execution', async () => {
  const value = store(),
    identity = { contactId: 'person', roles: ['HR', 'IT'] },
    calls = [];
  const portal = {
    templates: {},
    snippets: {},
    settings: {},
    pages: [],
    webFiles: [],
    lists: [],
    entityForms: [],
    advancedForms: [],
  };
  const renderer = createPortalRenderer(portal, {
    observed,
    previewFetchXml: (source, _user, _request, options) => {
      calls.push(['preview', options.right]);
      return value.previewPermissionFetchXml(source, identity, options);
    },
    fetchXml: (source, _user, _request, options) => {
      calls.push(['execute', options.right]);
      return value.fetchXml(source, identity, { portalRequest: true, right: options.right });
    },
  });
  const result = await renderer.renderString(
    `{% fetchxml found right:'Create' %}${xml}{% endfetchxml %}{{found.permission_granted | xml_escape}}|{{found.global_permission_granted | xml_escape}}|{{found.rules_exist | xml_escape}}|{{found.results.entities.size}}|{{found.results.entities.size}}`,
  );
  assert.equal(result, 'True|False|True|3|3');
  assert.deepEqual(calls, [
    ['preview', 'Create'],
    ['execute', 'Create'],
  ]);
});
