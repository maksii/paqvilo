import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  extendReferenceSchema,
  extendReferenceCatalogue,
  referenceRoles,
} from '../portal-security/reference-projections.mjs';
import { buildBlueprint } from '../portal-security/blueprint.mjs';
import { compilePlans } from '../portal-harness/compile.mjs';

const schema = JSON.parse(await readFile(new URL('../dataverse/manifest.json', import.meta.url)));
const catalogue = JSON.parse(await readFile(new URL('../data/stress-catalogue.json', import.meta.url)));

test('observable CurrencyReference has unique required system lookup while Money retains native Currency relationships', () => {
  const table = schema.tables.find((table) => table.name === 'pqvd_currencyreference');
  assert.equal(table.ownership, 'organization');
  assert.deepEqual(
    table.keys.map((key) => key.columns),
    [['pqvd_code'], ['pqvd_systemcurrencyid']],
  );
  const relation = schema.relationships.find((relation) => relation.name === 'pqvd_transactioncurrency_references');
  assert.equal(relation.parent, 'transactioncurrency');
  assert.equal(relation.lookup.required, 'required');
  for (const table of ['pqvd_employmentterms', 'pqvd_equipmentfinance']) {
    assert.ok(
      schema.tables.find((current) => current.name === table).columns.some((column) => column.type === 'money'),
    );
    assert.ok(
      catalogue.records
        .filter((record) => record.table === table)
        .every((record) => record.refs.transactioncurrencyid && !record.refs.pqvd_systemcurrencyid),
    );
  }
  const systemRows = catalogue.records.filter((record) => record.table === 'transactioncurrency');
  const refs = catalogue.records.filter((record) => record.table === 'pqvd_currencyreference');
  assert.equal(refs.length, 2);
  assert.equal(new Set(refs.map((record) => record.refs.pqvd_systemcurrencyid)).size, 2);
  for (const row of refs)
    assert.equal(
      row.fields.pqvd_code,
      systemRows.find((system) => system.key === row.refs.pqvd_systemcurrencyid).fields.isocurrencycode,
    );
});

test('custom reference and system binding projections are distinct scoped leaves and preserve revoked principal negatives', () => {
  const extended = extendReferenceCatalogue(structuredClone(catalogue), schema),
    before = JSON.stringify(extended);
  extendReferenceCatalogue(extended, schema);
  assert.equal(JSON.stringify(extended), before);
  const blueprint = buildBlueprint(schema, extended);
  for (const role of referenceRoles) {
    const custom = blueprint.nodes.find((node) => node.role === role && node.table === 'pqvd_currencyreference');
    assert.equal(custom.relationship, 'pqvd_access_currencyreferences');
    assert.deepEqual(custom.privileges, {
      read: true,
      create: false,
      write: false,
      delete: false,
      append: false,
      appendTo: false,
    });
    const system = blueprint.nodes.find((node) => node.role === role && node.table === 'transactioncurrency');
    assert.equal(system.relationship, 'pqvd_access_currencies');
    assert.equal(system.privileges.appendTo, ['HR', 'PROCUREMENT'].includes(role));
  }
  for (const grant of extended.records.filter((record) => record.table === 'pqvd_accesspermission')) {
    const custom = extended.associations.find(
      (association) => association.from === grant.key && association.relationship === 'pqvd_access_currencyreferences',
    );
    const system = extended.associations.find(
      (association) => association.from === grant.key && association.relationship === 'pqvd_access_currencies',
    );
    assert.deepEqual(
      custom.to.map((key) => extended.records.find((record) => record.key === key).refs.pqvd_systemcurrencyid).sort(),
      [...system.to].sort(),
    );
  }
  assert.equal(
    blueprint.nodes.some((node) => node.scope === 'Global'),
    false,
  );
});

test('R21 changes observable root explicitly and historical legacy schema extension remains opt-in and non-destructive', () => {
  const manifest = compilePlans(catalogue, schema),
    root = manifest.cases.find((plan) => plan.id === 'R21');
  assert.equal(root.table, 'pqvd_currencyreference');
  assert.ok(root.fetchXml.includes('pqvd_currencyreferenceid'));
  assert.equal(manifest.cases.length, 37);
  const legacySchema = structuredClone(schema);
  legacySchema.tables = legacySchema.tables.filter((table) => table.name !== 'pqvd_currencyreference');
  legacySchema.relationships = legacySchema.relationships.filter(
    (relation) => !['pqvd_access_currencyreferences', 'pqvd_transactioncurrency_references'].includes(relation.name),
  );
  const legacy = structuredClone(catalogue);
  legacy.records = legacy.records.filter((record) => record.table !== 'pqvd_currencyreference');
  legacy.tables = legacy.tables.filter((table) => table.name !== 'pqvd_currencyreference');
  legacy.associations = legacy.associations.filter(
    (association) => association.relationship !== 'pqvd_access_currencyreferences',
  );
  const count = legacy.records.length;
  extendReferenceCatalogue(legacy, legacySchema);
  assert.equal(legacy.records.length, count);
  const oldBlueprint = buildBlueprint(legacySchema, legacy),
    newBlueprint = buildBlueprint(schema, catalogue);
  for (const old of oldBlueprint.nodes) {
    const retained = newBlueprint.nodes.find((node) => node.id === old.id);
    assert.deepEqual(
      retained,
      old,
      'An existing permission identity/content must remain unchanged during this additive transition.',
    );
  }
  extendReferenceSchema(legacySchema);
  extendReferenceCatalogue(legacy, legacySchema);
  assert.equal(legacy.records.length, count + 2);
});
