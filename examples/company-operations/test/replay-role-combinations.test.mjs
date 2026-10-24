import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildBlueprint } from '../portal-security/blueprint.mjs';
import { evaluateConfiguredGraph } from '../portal-security/model-audit.mjs';
import { replayStore } from '../portal-harness/replay.mjs';

const schema = JSON.parse(await readFile(new URL('../dataverse/manifest.json', import.meta.url)));
const catalogue = JSON.parse(await readFile(new URL('../data/stress-catalogue.json', import.meta.url)));
const blueprint = buildBlueprint(schema, catalogue);
const businessRoles = blueprint.roles.filter(role => role.code !== 'TESTRUNNER');
const runner = blueprint.roles.find(role => role.code === 'TESTRUNNER');
const scopes = { Global: 756150000, Contact: 756150001, Account: 756150002, Parent: 756150003, Self: 756150004 };
const byKey = new Map(blueprint.nodes.map(node => [node.key, node]));
const roles = new Map(blueprint.roles.map(role => [role.code, role]));
// Synthetic exported-policy input constructed from the project blueprint. It is
// a local model test, never an authoritative snapshot of the hosted portal.
const nativeComponents = [
  ...blueprint.roles.map(role => ({ powerpagecomponentid: role.id, powerpagecomponenttype: 11, name: role.name, statecode: 0,
    content: JSON.stringify({ mspp_name: role.name, mspp_authenticatedusersrole: false, mspp_anonymoususersrole: false }) })),
  ...blueprint.nodes.map(node => ({ powerpagecomponentid: node.id, powerpagecomponenttype: 18, name: node.name, statecode: node.active ? 0 : 1,
    content: JSON.stringify({ mspp_entitylogicalname: node.table, mspp_scope: scopes[node.scope],
      mspp_entitypermission_webrole: [roles.get(node.role).id], mspp_read: node.privileges.read,
      mspp_create: node.privileges.create, mspp_write: node.privileges.write, mspp_delete: node.privileges.delete,
      mspp_append: node.privileges.append, mspp_appendto: node.privileges.appendTo,
      ...(node.parent ? { mspp_parententitypermission: byKey.get(node.parent).id, mspp_parentrelationship: node.relationship }
        : node.scope === 'Contact' ? { mspp_contactrelationship: node.relationship } : {}) }) })),
];
const popcount = mask => mask.toString(2).replaceAll('0', '').length;

test('replayed role combinations grant exactly the union of independent single-role reachability for every fixture and six privileges', () => {
  // Every parent chain stays inside one role, so a runtime interaction between
  // roles shows up with two of them. Up to two roles and every set missing at
  // most two cover all pairs and every dropped-role case without 4096 masks.
  for (const node of blueprint.nodes) if (node.parent) assert.equal(byKey.get(node.parent).role, node.role, node.key);
  assert.equal(businessRoles.length, 12);
  const masks = Array.from({ length: 4096 }, (_, mask) => mask).filter(mask => popcount(mask) <= 2 || popcount(mask) >= 10);
  assert.equal(masks.length, 158);
  const persona = catalogue.personas.find(persona => persona.key === 'P-STRESS');
  const independent = roleCodes => evaluateConfiguredGraph(blueprint, schema,
    { ...catalogue, personas: catalogue.personas.map(current => current.key === persona.key ? { ...current, webRoles: roleCodes } : current) }, persona.key);
  const baseline = independent([]), alternatives = businessRoles.map(role => independent([role.code]));
  const rights = [['read', 'read'], ['create', 'create'], ['write', 'update'], ['delete', 'delete'], ['append', 'append'], ['appendTo', 'appendTo']];
  const { store, identity: actor, diagnostics } = replayStore({ schema, catalogue, nativeComponents,
    contactId: persona.contactId, roles: [runner.name] });
  assert.deepEqual(diagnostics.filter(diagnostic => diagnostic.code.startsWith('PERMISSION_')), []);
  const rows = catalogue.records.map(record => ({ key: record.key, table: record.table,
    row: store.tableRows(record.table).find(row => row[`${record.table}id`] === record.id),
    expected: rights.map(([right]) => ({ baseline: baseline.get(record.key)?.privileges.has(right) ?? false,
      mask: alternatives.reduce((mask, ledger, bit) => mask | (ledger.get(record.key)?.privileges.has(right) ? 1 << bit : 0), 0) })) }));
  for (const record of rows) assert.ok(record.row, `Missing fixture ${record.key}`);
  let checked = 0, granted = 0;
  for (const mask of masks) {
    const selected = businessRoles.filter((_, bit) => mask & (1 << bit));
    const identity = { ...actor, roles: [runner.name, ...selected.map(role => role.name)], roleIds: [runner.id, ...selected.map(role => role.id)] };
    const memo = store.permissionMemo();
    for (const record of rows) for (let index = 0; index < rights.length; index++) {
      const expected = record.expected[index].baseline || Boolean(mask & record.expected[index].mask);
      const actual = store.allowed(record.table, rights[index][1], record.row, identity, new Set(), null, memo);
      if (actual !== expected) assert.equal(actual, expected, `mask=${mask} row=${record.key} privilege=${rights[index][0]}`);
      checked++; if (actual) granted++;
    }
  }
  assert.equal(checked, masks.length * catalogue.records.length * rights.length);
  assert.ok(granted > 0 && granted < checked, 'the fixture universe must contain both granted and denied cells');
  // Reachability/flags are exhaustive only for this fixed source graph and
  // fixture universe. Query serialization, guards and hosted CRUD are separate.
});
