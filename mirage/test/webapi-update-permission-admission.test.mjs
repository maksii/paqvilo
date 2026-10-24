import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { handleWebApi, webApiErrorResponse } from '../lib/webapi-handler.mjs';
import { DataError } from '../lib/data-error.mjs';
import { observedConfig } from '../lib/project-config.mjs';
const guid = (n) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const visitor = { contactId: guid(100), roles: ['Reader'] };
const observed = {
  webApiUpdatePermissionQuery: 'native-classic',
  evidence: 'Invented source-derived Update admission fixture',
};
function fixture(depths = [8, 8], profile = observed) {
  const mappings = {
      widget: {
        entitySet: 'widgets',
        idColumn: 'widgetid',
        nameColumn: 'name',
        fields: { name: { dataverseType: 'nvarchar' } },
      },
    },
    tables = { widget: [] },
    permissions = [];
  const own = { widgetid: guid(1), name: 'before' },
    foreign = { widgetid: guid(2), name: 'before' };
  for (const [branch, depth] of depths.entries()) {
    for (let i = 0; i < depth; i++) {
      const entity = `branch${branch}_hop${i}`,
        parent = i ? `branch${branch}_hop${i - 1}` : null;
      mappings[entity] = { entitySet: entity + 's', idColumn: 'id' };
      tables[entity] = [0, 1].map((side) => ({
        id: guid(200 + branch * 100 + i * 2 + side),
        ...(i
          ? { parentid: guid(200 + branch * 100 + (i - 1) * 2 + side) }
          : { owner: side ? guid(101) : visitor.contactId }),
      }));
      permissions.push({
        id: entity,
        entity,
        scope: i ? 'parent' : 'contact',
        roles: ['Reader'],
        operations: ['read', 'update'],
        ...(i
          ? { parentPermissionId: parent, relationship: { entity: parent, from: 'parentid', to: 'id' } }
          : { field: 'owner' }),
      });
    }
    const terminal = `branch${branch}_hop${depth - 1}`,
      field = 'parent' + branch;
    own[field] = tables[terminal][0].id;
    foreign[field] = tables[terminal][1].id;
    permissions.push({
      id: 'leaf' + branch,
      entity: 'widget',
      scope: 'parent',
      roles: ['Reader'],
      operations: ['read', 'update'],
      parentPermissionId: terminal,
      relationship: { entity: terminal, from: field, to: 'id' },
    });
  }
  tables.widget = [own, foreign];
  const store = new DataStore({ state: { mappings, tables, permissions, settings: { permissionMode: 'enforce' } } });
  store.setObserved(profile);
  return {
    store,
    portal: {
      settings: { 'Webapi/widget/enabled': 'true', 'Webapi/widget/fields': 'name', 'Webapi/error/innererror': 'true' },
    },
    writes: 0,
  };
}
async function patch(f, id = guid(1), identity = visitor, body = { name: 'after' }) {
  let status, payload;
  const req = {
      method: 'PATCH',
      headers: { __requestverificationtoken: 'local-token', 'content-type': 'application/json' },
    },
    res = {
      headersSent: false,
      writeHead(code) {
        status = code;
        this.headersSent = true;
      },
      end(value) {
        if (value) payload = JSON.parse(value);
      },
    };
  await handleWebApi(req, res, new URL(`http://127.0.0.1/_api/widgets(${id})`), {
    store: f.store,
    portal: f.portal,
    identity,
    csrf: 'local-token',
    origin: 'http://127.0.0.1',
    origins: ['http://127.0.0.1'],
    jsonBody: async () => body,
    change: async (fn) => {
      f.writes++;
      return fn();
    },
    json(r, code, value) {
      r.writeHead(code);
      r.end(JSON.stringify(value));
    },
  });
  return { status, payload };
}
test('observed oversized Update graph rejects own and foreign rows before writes, with hidden native admission envelope', async () => {
  for (const id of [guid(1), guid(2)]) {
    const f = fixture(),
      before = structuredClone(f.store.state.tables.widget),
      result = await patch(f, id);
    assert.equal(result.status, 500);
    assert.deepEqual(result.payload, {
      error: { code: '9004010A', message: 'An unexpected error occurred while processing the request' },
    });
    assert.equal(f.writes, 0);
    assert.deepEqual(f.store.state.tables.widget, before);
  }
});
test('fifteen generated links remain admitted and normal row permissions still apply', async () => {
  const own = fixture([7, 8]);
  assert.equal((await patch(own)).status, 204);
  assert.equal(own.store.state.tables.widget[0].name, 'after');
  const denied = fixture([7, 8]);
  assert.equal((await patch(denied, guid(2))).status, 403);
  assert.equal(denied.store.state.tables.widget[1].name, 'before');
});
test('organization Update hooks are never called when observed portal admission fails', async () => {
  const f = fixture();
  let invoked = 0;
  f.store.recordPipeline = {
    updateInternal() {
      invoked++;
      throw Error('Unreachable organization write');
    },
  };
  const result = await patch(f);
  assert.equal(result.status, 500);
  assert.equal(invoked, 0);
  assert.equal(f.store.state.tables.widget[0].name, 'before');
});
test('unobserved sites and SDK writes retain graph-based rights even above the portal admission limit', async () => {
  const f = fixture([8, 8], null);
  assert.equal((await patch(f)).status, 204);
  assert.equal((await patch(f, guid(2))).status, 403);
  const sdk = fixture();
  await sdk.store.updateRecordAsync('widget', guid(1), { name: 'sdk' }, visitor);
  assert.equal(sdk.store.state.tables.widget[0].name, 'sdk');
});
test('global or administrator rights bypass scoped query construction', async () => {
  const f = fixture();
  f.store.state.permissions.push({
    id: 'global',
    entity: 'widget',
    scope: 'global',
    roles: ['Reader'],
    operations: ['update'],
  });
  assert.equal((await patch(f, guid(2))).status, 204);
  const admin = fixture();
  assert.equal((await patch(admin, guid(2), { admin: true })).status, 204);
});
test('Update admission requires a named site observation', () => {
  assert.throws(() => observedConfig({ webApiUpdatePermissionQuery: 'native-classic' }), /evidence/);
  assert.equal(observedConfig(observed).webApiUpdatePermissionQuery, 'native-classic');
  assert.throws(
    () => observedConfig({ ...observed, webApiUpdatePermissionQuery: 'invented' }),
    /webApiUpdatePermissionQuery/,
  );
});
test('independently observed Update and Delete denial text preserves native Unicode and table terminology', () => {
  for (const operation of ['update', 'delete']) {
    const e = new DataError('denied', 403, 'PermissionDenied', { operation, table: 'widget' }),
      observed = webApiErrorResponse(e, { mutationPermissionText: 'table' }),
      fallback = webApiErrorResponse(e);
    assert.equal(observed.body.error.message, `You don’t have permission to ${operation} widget table.`);
    assert.equal(fallback.body.error.message, `You don't have permission to ${operation} widget entity.`);
  }
  assert.throws(() => observedConfig({ webApiMutationPermissionText: 'table' }), /evidence/);
  assert.equal(
    observedConfig({ webApiMutationPermissionText: 'table', evidence: 'Invented denial text receipt' })
      .webApiMutationPermissionText,
    'table',
  );
});
