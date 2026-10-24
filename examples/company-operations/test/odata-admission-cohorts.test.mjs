import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { odataAdmissionCohorts } from '../portal-security/odata-admission-cohorts.mjs';

test('isolated OData admission cohort preserves original domains and covers direct, NN, cross-table, same-table and Global union discriminators', async () => {
  const schema = JSON.parse(await fs.readFile(new URL('../dataverse/manifest.json', import.meta.url))),
    catalogue = JSON.parse(await fs.readFile(new URL('../data/stress-catalogue.json', import.meta.url)));
  const domain = odataAdmissionCohorts({ schema, catalogue });
  assert.equal(domain.configurationsRequired, 14);
  assert.equal(domain.denominator, 34);
  assert.equal(domain.physicalRepeatedCellsRequired, 68);
  assert.equal(domain.nativeQualifiedCells, 0);
  assert.equal(domain.originalDenominatorsPreserved, true);
  assert.ok(
    [
      'direct-global',
      'direct-contact',
      'direct-account',
      'direct-self',
      'depth-1',
      'depth-2',
      'depth-3',
      'depth-8',
      'multi-level-one-to-many',
      'contact-nn-root',
      'one-level-cross-table',
      'one-level-reverse',
      'global-scoped-union',
      'same-table-parent',
    ].every((discriminator) =>
      domain.configurations.some((configuration) => configuration.discriminator === discriminator),
    ),
  );
  const same = domain.configurations.find((configuration) => configuration.discriminator === 'same-table-parent');
  assert.equal(same.permissions.at(-1).relationship, 'account_parent_account');
  for (const configuration of domain.configurations) {
    const query = configuration.bindingContract.bindRecordIds(['00000000-0000-0000-0000-000000000001']);
    assert.equal(query.queryType, 'odata');
    assert.equal(query.fixtureBindings.length, 0);
    assert.equal(query.fixtureIds.length, 1);
    assert.equal(query.expectedNativeOutcome, 'requires-native-evidence');
    assert.equal(configuration.configurationCells.length, configuration.roleMaskCount);
    assert.ok(
      configuration.configurationCells.every((cell) => cell.operation === 'read' && cell.lane === 'webapi-odata'),
    );
  }
});
