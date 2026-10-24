import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  permissionOrderDisambiguator,
  planPermissionOrderDisambiguatorFixtures,
} from '../portal-security/permission-order-disambiguator.mjs';

const schema = JSON.parse(await readFile(new URL('../dataverse/manifest.json', import.meta.url)));
const catalogue = JSON.parse(await readFile(new URL('../data/stress-catalogue.json', import.meta.url)));
const configuration = permissionOrderDisambiguator({ schema, catalogue });
const id = (number) => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

test('order experiment separates depth and lexical hypotheses and declares only four native read cells', () => {
  assert.notDeepEqual(configuration.hypotheses['depth-descending'], configuration.hypotheses['path-lexical']);
  assert.equal(configuration.permissions.length, 9);
  assert.equal(configuration.configurationCells.length, 4);
  assert.equal(configuration.minimumRepeatedReadCells, 8);
  assert.equal(configuration.nativeQualifiedCells, 0);
  assert.ok(configuration.configurationCells.every((cell) => cell.operation === 'read'));
  assert.equal(configuration.metadataReadbackRequirements[0].mustAlreadyExist, true);
  assert.equal(
    configuration.permissions.filter((permission) => permission.relationship === 'account_parent_account').length,
    2,
  );
  assert.ok(configuration.permissions.every((permission) => !permission.privileges.write));
});

test('disposable Account chains and both positive projection targets preserve all three region negatives', () => {
  const resolvedIds = Object.fromEntries(catalogue.records.map((record, index) => [record.key, id(index + 100)]));
  const plan = planPermissionOrderDisambiguatorFixtures(configuration, {
    schema,
    catalogue,
    resolvedIds,
    actorContactId: id(1),
    runId: id(2),
  });
  assert.equal(plan.nativeDataVerified, false);
  assert.equal(plan.records.length, 63);
  assert.equal(plan.associations.length, 12);
  for (const region of configuration.requiredRegions) {
    const accounts = plan.records.filter((record) => record.table === 'account' && record.region === region);
    assert.equal(accounts.length, 3);
    const child = accounts.find((record) => record.key.endsWith('-account'));
    const mid = accounts.find((record) => record.key.endsWith('-order-mid'));
    const top = accounts.find((record) => record.key.endsWith('-order-top'));
    assert.equal(child.refs.parentaccountid.id, mid.id);
    assert.equal(mid.refs.parentaccountid.id, top.id);
    assert.ok(
      plan.cleanup.findIndex((record) => record.id === child.id) <
        plan.cleanup.findIndex((record) => record.id === mid.id),
    );
    assert.ok(
      plan.cleanup.findIndex((record) => record.id === mid.id) <
        plan.cleanup.findIndex((record) => record.id === top.id),
    );
    for (const columns of plan.tables.find((table) => table.name === 'account').keys ?? [])
      for (const column of columns)
        if (typeof child.fields[column] === 'string')
          assert.equal(new Set(accounts.map((record) => record.fields[column])).size, 3);
    assert.ok(child.deferredRefs.includes('parentaccountid'));
    const targets = plan.associations.filter(
      (association) => association.region === region && association.relationship === 'pqvd_access_accounts',
    );
    assert.deepEqual(new Set(targets.map((association) => association.to.id)), new Set([child.id, top.id]));
    assert.equal(plan.regionRecordIds[region].length, 1);
  }
  assert.equal(plan.cleanup.length, plan.records.length);
  assert.equal(
    configuration.bindingContract.bindRecordIds(Object.values(plan.regionRecordIds).flat()).fixtureBindings.length,
    0,
  );
});
