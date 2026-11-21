// @test-kind contract: Paqvilo capability registry design: every installed organization module reports its own capability record (mirage/docs/capabilities-and-preflight.md)
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { createCapabilityRegistry, normalizeCapabilityRecord } from '../lib/capability-registry.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { loadOrganizationSources } from '../lib/solution-runtime-source.mjs';
import { composeOrganizationHost } from '../lib/organization-host.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import { fieldSecurity } from '../lib/dataverse-fls.mjs';
import { workflowExtension } from '../lib/dataverse-workflows.mjs';

test('every registered organization module describes itself under its own name', () => {
  const modules = [...EXTENSIONS, workflowExtension({ facts: [] })];
  const missing = modules.filter((entry) => typeof entry.describe !== 'function').map((entry) => entry.name);
  assert.deepEqual(missing, [], 'modules without describe() would be reported as inventory');
  for (const entry of modules) {
    const record = normalizeCapabilityRecord(entry.describe(undefined));
    assert.equal(record.name, entry.name);
    assert.ok(['inventory', 'contract', 'behaviour'].includes(record.level), `${entry.name}: ${record.level}`);
  }
});

test('field security reports its local enforcement, with the assumed privilege read at contract', () => {
  const record = normalizeCapabilityRecord(fieldSecurity.describe());
  assert.equal(record.name, 'dataverse-fls');
  assert.deepEqual(
    record.operations.map(({ name, level }) => [name, level]),
    [['RetrievePrincipalAttributePrivileges', 'contract']],
  );
  assert.notEqual(record.level, 'inventory');
});

test('the registry path and the organization host report the same record for every extension module', async (t) => {
  const store = await new DataStore({ state: emptyState() }).init();
  const sources = await loadOrganizationSources({ solutionRoots: [] });
  const host = await composeOrganizationHost({
    store,
    sources: { plugins: () => sources.metadata.plugins, workflows: () => sources.workflows, layers: () => [] },
    sourcesKey: () => sources,
    overrides: () => null,
    diagnostic: () => {},
  });
  ownedFixture(t).add(() => host.close());
  await host.createBackend();
  const organization = await host.createOrganization({
    settings: dataverseSettings({ enabled: true, tds: { enabled: false } }),
    change: (fn) => fn(),
  });
  const shape = (record) => ({
    level: record.level,
    operations: record.operations.map(({ name, level }) => [name, level]),
  });
  const hostRecords = new Map(
    host
      .capabilities()
      .list()
      .map((record) => [record.name, record]),
  );
  const registry = createCapabilityRegistry();
  const described = registry.fromExtensions(EXTENSIONS, organization.api);
  assert.ok(
    described.some((record) => record.operations.length > 0),
    'the installed operations are described',
  );
  for (const record of described) {
    assert.ok(hostRecords.has(record.name), record.name);
    assert.deepEqual(shape(record), shape(hostRecords.get(record.name)), record.name);
  }
});
