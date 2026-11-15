// The _sim environment variable PUT keeps one value row per definition when the Solution has the definition but no value,
// including across a Solution re-seed. The admin pattern follows admin-api.test.mjs.
import test from 'node:test';
import { environmentVariableFixture, adminJsonCaller } from './fixtures/source-site.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const lowerId = (value) =>
  String(value && typeof value === 'object' ? (value.id ?? value.value) : (value ?? ''))
    .replace(/[{}]/g, '')
    .toLowerCase();

test('_sim environment variable PUT keeps exactly one value row per definition across re-seeding', async (t) => {
  const { dir, portal, solution } = await environmentVariableFixture(t, 'pp-sim-envput-');
  // A definition with no environmentvariablevalues.json: the Solution has no value row to seed.
  const variable = path.join(solution, 'environmentvariabledefinitions', 'sample_NoValue');
  await fs.mkdir(variable, { recursive: true });
  await fs.writeFile(
    path.join(variable, 'environmentvariabledefinition.xml'),
    '<environmentvariabledefinition schemaname="sample_NoValue"><defaultvalue>default</defaultvalue><displayname default="No value"><label description="No value" languagecode="1033" /></displayname><type>100000000</type></environmentvariabledefinition>',
  );
  const app = await createSimulator({
    sourceDir: portal,
    stateFile: path.join(dir, 'state', 'state.json'),
    watch: false,
    solutionRoots: [solution],
  });
  ownedFixture(t).add(() => app.close());
  const call = adminJsonCaller(app);
  const definition = async () =>
    (await call('/__sim/api/environment')).json.environmentVariables.definitions.find(
      (item) => item.schemaName === 'sample_NoValue',
    );
  const valueRows = async () => {
    const id = lowerId((await definition()).id);
    return app.store
      .snapshot()
      .tables.environmentvariablevalue.filter((row) => lowerId(row.environmentvariabledefinitionid) === id);
  };

  assert.equal((await valueRows()).length, 0, 'no value row before any local value');
  assert.equal((await call('/__sim/api/environment/variables/sample_NoValue', 'PUT', { value: 'first' })).status, 200);
  assert.equal((await call('/__sim/api/environment/variables/sample_NoValue', 'PUT', { value: 'second' })).status, 200);
  assert.equal(
    (await call('/__sim/api/config', 'PATCH', { permissionMode: 'permissive' })).status,
    200,
    'an unrelated state change re-seeds Solution rows',
  );
  const rows = await valueRows();
  assert.equal(rows.length, 1, 'exactly one value row for the definition');
  assert.equal(rows[0].value, 'second');
  assert.equal((await definition()).effectiveValue, 'second');
});
