import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFragment } from 'parse5';
import { DataStore } from '../lib/data.mjs';
import { renderComponent as candidate } from '../lib/platform.mjs';

const actor = '10000000-0000-4000-8000-000000000001';
const parent = '20000000-0000-4000-8000-000000000001';
const second = '20000000-0000-4000-8000-000000000002';
const identity = { contactId: actor, roles: ['Reader'] };
const attributes = (node) => Object.fromEntries((node.attrs ?? []).map(({ name, value }) => [name, value]));
function input(html, id) {
  let found;
  function visit(node) {
    if (node.tagName === 'input' && attributes(node).id === id) found = attributes(node);
    for (const child of node.childNodes ?? []) visit(child);
  }
  visit(parseFragment(html));
  assert.ok(found, 'lookup control must be rendered');
  return found;
}
async function render(
  renderer,
  { code = 'invented-code', rows, metadata = {}, denied = false, noQuery = false, parameterAbsent = false } = {},
) {
  rows ??= [{ sample_parentid: parent, sample_name: 'Invented parent', sample_code: code, owner: actor }];
  const store = new DataStore({
    state: {
      mappings: {
        sample_parent: {
          entitySet: 'sample_parents',
          idColumn: 'sample_parentid',
          nameColumn: 'sample_name',
          fields: { sample_code: { type: 'nvarchar' } },
        },
        sample_child: {
          entitySet: 'sample_children',
          idColumn: 'sample_childid',
          fields: {},
          relationships: {
            sample_parent_children: {
              from: 'sample_parentid',
              to: 'sample_parentid',
              entity: 'sample_parent',
              many: false,
            },
          },
        },
      },
      tables: { sample_parent: rows, sample_child: [] },
      permissions: [
        { entity: 'sample_parent', roles: ['Reader'], operations: ['read'], scope: 'contact', field: 'owner' },
        { entity: 'sample_child', roles: ['Reader'], operations: ['read', 'create'], scope: 'global' },
      ],
      settings: { permissionMode: 'enforce' },
    },
  });
  const calls = [];
  const readProvider = {
    get(entity, id, principal) {
      calls.push({ method: 'get', entity, id, principal });
      return store.get(entity, id, principal);
    },
    query(entity, query, principal) {
      calls.push({ method: 'query', entity, query, principal });
      if (denied) throw Object.assign(Error('Invented read denied'), { status: 403 });
      return store.query(entity, query, principal);
    },
  };
  if (noQuery) delete readProvider.query;
  const formMetadata = {
    adx_setentityreference: true,
    adx_referenceentitysourcetype: 756150000,
    adx_referenceentitylogicalname: 'sample_parent',
    adx_referencequerystringname: 'reference',
    adx_referencequerystringisprimarykey: false,
    adx_referencequeryattributelogicalname: 'sample_code',
    adx_referencetargetlookupattributelogicalname: 'sample_parentid',
    ...metadata,
  };
  const options = {
    portal: {
      forms: [{ id: 'form', name: 'Invented child', mode: 100000000, metadata: formMetadata }],
      records: [],
      pages: [],
      website: {},
      settings: {},
    },
    store,
    readProvider,
    schemas: {
      form: {
        entity: 'sample_child',
        fields: [
          { name: 'sample_name', label: 'Name', dataverseType: 'nvarchar' },
          {
            name: 'sample_parentid',
            label: 'Parent',
            dataverseType: 'lookup',
            lookupTargets: ['sample_parent'],
            required: true,
          },
        ],
      },
    },
  };
  const before = store.snapshot();
  const html = await renderer(
    'entityform',
    'form',
    { user: identity, request: { params: parameterAbsent ? {} : { reference: code } } },
    options,
  );
  assert.deepEqual(store.snapshot(), before, 'reference rendering must never stamp a row');
  return { html, calls, id: input(html, 'sample_parentid'), name: input(html, 'sample_parentid_name') };
}

test('a sole permitted metadata attribute match fills the reference lookup and keeps required labelling', async () => {
  const result = await render(candidate);
  assert.equal(result.id.value, parent);
  assert.equal(result.name.value, 'Invented parent');
  assert.equal(result.id['aria-required'], 'true');
  assert.equal(result.name.readonly, '');
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].method, 'query');
  assert.strictEqual(result.calls[0].principal, identity);
  assert.equal(result.calls[0].query.$filter, "sample_code eq 'invented-code'");
  assert.equal(result.calls[0].query.$top, 1);
});

test('apostrophes and apparent OData operators remain one literal value', async () => {
  const code = "O'Brien' or sample_name ne 'x";
  const result = await render(candidate, { code });
  assert.equal(result.id.value, parent);
  assert.equal(result.calls[0].query.$filter, "sample_code eq 'O''Brien'' or sample_name ne ''x'");
});

test('empty attribute match leaves the required lookup empty', async () => {
  const result = await render(candidate, { rows: [] });
  assert.equal(result.id.value, undefined);
  assert.equal(result.name.value, undefined);
  assert.equal(result.id['aria-required'], 'true');
});

test('multiple permitted attribute matches bind one bounded provider result without an ambiguity error', async () => {
  const rows = [parent, second].map((id) => ({
    sample_parentid: id,
    sample_name: 'Invented parent',
    sample_code: 'invented-code',
    owner: actor,
  }));
  const result = await render(candidate, { rows });
  assert.equal(result.id.value, parent);
  assert.equal(result.calls[0].query.$top, 1);
});

test('foreign unreadable matches never bind or create false ambiguity', async () => {
  const rows = [
    { sample_parentid: second, sample_name: 'Foreign parent', sample_code: 'invented-code', owner: 'other' },
    { sample_parentid: parent, sample_name: 'Invented parent', sample_code: 'invented-code', owner: actor },
  ];
  const result = await render(candidate, { rows });
  assert.equal(result.id.value, parent);
  const hidden = await render(candidate, { rows: rows.slice(0, 1) });
  assert.equal(hidden.id.value, undefined);
});

test('read-provider denial or missing query capability never falls back to the store', async () => {
  for (const configuration of [{ denied: true }, { noQuery: true }]) {
    const result = await render(candidate, configuration);
    assert.equal(result.id.value, undefined);
    assert.equal(result.name.value, undefined);
    assert.equal(result.calls.filter((call) => call.method === 'get').length, 0);
  }
});

test('missing or malformed attribute metadata does not become a filter expression', async () => {
  for (const attribute of [undefined, '', "sample_code eq 'x' or owner"]) {
    const result = await render(candidate, { metadata: { adx_referencequeryattributelogicalname: attribute } });
    assert.equal(result.id.value, undefined);
    assert.equal(result.calls.length, 0);
  }
});

test('exact GUID primary-key lookup retains the get path and principal', async () => {
  const result = await render(candidate, { code: parent, metadata: { adx_referencequerystringisprimarykey: true } });
  assert.equal(result.id.value, parent);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].method, 'get');
  assert.equal(result.calls[0].id, parent);
  assert.strictEqual(result.calls[0].principal, identity);
});

test('missing query parameter performs no reference query', async () => {
  const result = await render(candidate, { parameterAbsent: true });
  assert.equal(result.id.value, undefined);
  assert.equal(result.calls.length, 0);
});
