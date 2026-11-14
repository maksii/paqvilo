import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPermissionModel, comparePermissionModels } from '../fixtures.mjs';

const scopes = { global: 756150000, contact: 756150001, account: 756150002, parent: 756150003 };
const grant = (id, { entity = 'x_item', scope = 'contact', roles = ['reader'], rights = ['read'], ...extra } = {}) => ({
  kind: 'tablepermission',
  id,
  name: id,
  file: `${id}.yml`,
  adx_entitylogicalname: entity,
  adx_scope: scopes[scope],
  adx_entitypermission_webrole: roles,
  ...Object.fromEntries(rights.map((right) => [`adx_${right === 'update' ? 'write' : right}`, true])),
  ...(scope === 'contact' ? { adx_contactrelationship: `${entity}_contact` } : {}),
  ...(scope === 'account' ? { adx_accountrelationship: `${entity}_account` } : {}),
  ...extra,
});
function fixture(grants = [grant('own')]) {
  const role = (id) => ({ kind: 'webrole', id, name: id });
  const rel = (entity, target, field) => ({
    type: 'one-to-many',
    referencingEntity: entity,
    referencedEntity: target,
    referencingAttribute: field,
    referencedAttribute: `${target}id`,
  });
  return {
    portal: { records: [role('reader'), role('writer'), ...grants] },
    state: {
      mappings: Object.fromEntries(
        ['x_item', 'x_group', 'contact', 'account'].map((name) => [name, { idColumn: `${name}id` }]),
      ),
      tables: { contact: [{ contactid: 'person' }] },
      permissions: [],
      settings: { permissionMode: 'enforce' },
      simulator: { contactRoles: [{ contactId: 'person', roleId: 'reader' }] },
    },
    relationships: {
      x_item_contact: rel('x_item', 'contact', 'x_contact'),
      x_item_account: rel('x_item', 'account', 'x_account'),
      x_group_contact: rel('x_group', 'contact', 'x_contact'),
      x_item_group: rel('x_item', 'x_group', 'x_group'),
    },
  };
}
const compile = (f) => buildPermissionModel(f.portal, f.state, { source: 'exported', relationships: f.relationships });

test('renames, ordering and equivalent grant splits do not change compiled potential access', () => {
  const before = fixture([grant('original', { rights: ['read', 'update'] })]);
  const after = fixture([grant('renamed-write', { rights: ['update'] }), grant('renamed-read')]);
  after.portal.records.reverse();
  const old = compile(before),
    next = compile(after),
    untouched = structuredClone([old, next]);
  const report = comparePermissionModels(old, next);
  assert.equal(report.status, 'unchanged');
  assert.deepEqual(report.summary, { wider: 0, narrower: 0, indeterminate: 0, unchanged: 2 });
  assert.deepEqual(report.changes, []);
  assert.deepEqual([old, next], untouched);
});

test('global coverage proves inclusion while different identity predicates remain indeterminate', () => {
  const scoped = compile(fixture()),
    global = compile(fixture([grant('all', { scope: 'global' })]));
  assert.equal(comparePermissionModels(scoped, global).status, 'wider');
  assert.equal(comparePermissionModels(global, scoped).status, 'narrower');
  const other = compile(fixture([grant('account', { scope: 'account' })]));
  const report = comparePermissionModels(scoped, other);
  assert.equal(report.status, 'indeterminate');
  assert.equal(report.changes[0].classification, 'indeterminate');
});

test('independent added and removed rights are explicit with stable source evidence', () => {
  const report = comparePermissionModels(
    compile(fixture([grant('read')])),
    compile(fixture([grant('delete', { rights: ['delete'] })])),
  );
  assert.equal(report.status, 'mixed');
  assert.equal(report.summary.wider, 1);
  assert.equal(report.summary.narrower, 1);
  const added = report.changes.find((change) => change.operation === 'delete');
  assert.equal(added.roleId, 'reader');
  assert.deepEqual(added.after[0].permissionIds, ['delete']);
  assert.deepEqual(added.after[0].sourceFiles, ['delete.yml']);
});

test('parent predicates are structural and inherited role changes remain visible', () => {
  const root = (id, roles = ['reader']) => grant(id, { entity: 'x_group', roles });
  const child = (id, parent) =>
    grant(id, {
      scope: 'parent',
      roles: [],
      adx_parententitypermission: parent,
      adx_parentrelationship: 'x_item_group',
    });
  const a = compile(fixture([root('root'), child('child', 'root')]));
  const renamed = compile(fixture([child('child-new', 'root-new'), root('root-new')]));
  assert.equal(comparePermissionModels(a, renamed).status, 'unchanged');
  const changed = comparePermissionModels(a, compile(fixture([root('root', ['writer']), child('child', 'root')])));
  assert.equal(changed.status, 'mixed');
  assert.ok(
    changed.changes.some(
      (change) => change.entity === 'x_item' && change.roleId === 'writer' && change.classification === 'wider',
    ),
  );
  assert.ok(
    changed.changes.some(
      (change) => change.entity === 'x_item' && change.roleId === 'reader' && change.classification === 'narrower',
    ),
  );
});

test('a child with no readable parent grants no rows despite its own enabled read flag', () => {
  const parent = (rights) => grant('root', { entity: 'x_group', rights });
  const child = grant('child', {
    scope: 'parent',
    roles: [],
    adx_parententitypermission: 'root',
    adx_parentrelationship: 'x_item_group',
  });
  const a = compile(fixture([parent(['read']), child]));
  const b = compile(fixture([parent(['delete']), child]));
  const report = comparePermissionModels(a, b);
  assert.equal(report.changes.find((change) => change.entity === 'x_item').classification, 'narrower');
});

test('changed compiled relationships and unresolved exports cannot silently qualify as access reductions', () => {
  const before = compile(fixture()),
    changed = fixture();
  changed.relationships.x_item_contact.referencingAttribute = 'x_alternate_contact';
  assert.equal(comparePermissionModels(before, compile(changed)).status, 'indeterminate');
  const broken = fixture();
  delete broken.relationships.x_item_contact;
  const report = comparePermissionModels(before, compile(broken));
  assert.equal(report.status, 'indeterminate');
  assert.equal(report.changes[0].classification, 'indeterminate');
  assert.ok(report.diagnostics.some((issue) => issue.code === 'PERMISSION_RELATIONSHIP_UNRESOLVED'));
});

test('source, association policy, default-role, membership and persona changes require explicit qualification', () => {
  const before = compile(fixture());
  const variants = [
    [
      'PERMISSION_DIFF_SOURCE_CHANGED',
      (model) => {
        model.source = 'combined';
      },
    ],
    [
      'PERMISSION_DIFF_SETTINGS_CHANGED',
      (model) => {
        model.settings.associationPermissions = 'compatibility';
      },
    ],
    [
      'PERMISSION_DIFF_DEFAULT_ROLES_CHANGED',
      (model) => {
        model.webRoles[0].authenticated = true;
      },
    ],
    [
      'PERMISSION_DIFF_MEMBERSHIPS_CHANGED',
      (model) => {
        model.memberships = [];
      },
    ],
    [
      'PERMISSION_DIFF_PERSONAS_CHANGED',
      (model) => {
        model.personas[0].accountId = 'another-account';
      },
    ],
  ];
  for (const [code, mutate] of variants) {
    const after = structuredClone(before);
    mutate(after);
    const report = comparePermissionModels(before, after);
    assert.equal(report.status, 'indeterminate', code);
    assert.ok(
      report.diagnostics.some((issue) => issue.code === code),
      code,
    );
  }
});

test('renamed roles with exact stable IDs and reordered memberships remain comparable', () => {
  const before = compile(fixture()),
    after = structuredClone(before);
  after.webRoles.reverse();
  after.webRoles[0].name = 'Renamed display label';
  after.permissions[0].name = 'Renamed permission';
  after.permissions[0].provenance.file = 'moved.yml';
  assert.equal(comparePermissionModels(before, after).status, 'unchanged');
});

test('configured universal grants cover redundant role-specific additions', () => {
  const before = compile(fixture());
  before.source = 'configured';
  before.permissions = [{ id: 'public', entity: 'x_item', scope: 'global', operations: ['read'], roles: [] }];
  const after = structuredClone(before);
  after.permissions.push({
    id: 'redundant',
    entity: 'x_item',
    scope: 'contact',
    field: 'x_contact',
    operations: ['read'],
    roleIds: ['reader'],
  });
  assert.equal(comparePermissionModels(before, after).status, 'unchanged');
});

test('malformed, ambiguous and bounded models fail explicitly without emitting extra input values', () => {
  const before = compile(fixture()),
    after = structuredClone(before);
  after.permissions[0].scope = 'unqualified';
  after.permissions[0].businessSecret = 'invented-private-value';
  assert.equal(comparePermissionModels(before, after).status, 'indeterminate');
  assert.doesNotMatch(JSON.stringify(comparePermissionModels(before, after)), /invented-private-value/);
  after.permissions = [{ ...before.permissions[0] }, { ...before.permissions[0] }];
  assert.ok(
    comparePermissionModels(before, after).diagnostics.some((issue) => issue.code === 'PERMISSION_DIFF_ID_AMBIGUOUS'),
  );
  assert.throws(() => comparePermissionModels({ ...before, permissions: undefined }, before), /permissions/);
  assert.throws(
    () => comparePermissionModels({ ...before, permissions: Array(10_001).fill(before.permissions[0]) }, before),
    /10000/,
  );
});

test('alias-heavy permission and persona arrays consume one shared work budget before expanding their products', () => {
  const before = compile(fixture());
  const aliases = Array(10_000).fill('reader');
  const grants = {
    ...before,
    permissions: Array.from({ length: 1000 }, (_, index) => ({
      ...before.permissions[0],
      id: `alias-${index}`,
      roleIds: aliases,
    })),
  };
  assert.throws(() => comparePermissionModels(grants, before), { name: 'RangeError', message: /work-unit budget/ });
  const personas = {
    ...before,
    personas: Array.from({ length: 1000 }, (_, index) => ({ contactId: `person-${index}`, roleIds: aliases })),
  };
  assert.throws(() => comparePermissionModels(before, personas), { name: 'RangeError', message: /work-unit budget/ });
});
