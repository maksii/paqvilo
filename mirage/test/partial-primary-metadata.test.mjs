// @test-kind contract: declared primary identities remain queryable in partial exports without admitting arbitrary columns.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSimulator } from '../api.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

for (const [entity, idColumn, nameColumn, declared] of [
  ['x_partial', 'x_partialid', 'x_title', true],
  ['incident', 'incidentid', 'title', false],
])
  test(`partial ${entity} metadata offers a usable default grid with declared primary columns and source attributes`, async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-partial-primary-'));
    ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
    const directory = path.join(root, 'Entities', entity);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, 'Entity.xml'),
      `<Entity><Name>${entity}</Name><EntityInfo><entity Name="${entity}"><EntitySetName>${entity}s</EntitySetName>${declared ? `<PrimaryIdAttribute>${idColumn}</PrimaryIdAttribute><PrimaryNameAttribute>${nameColumn}</PrimaryNameAttribute>` : ''}<attributes><attribute PhysicalName="x_extension"><Name>x_extension</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>`,
    );
    const sim = await createSimulator({
      runtime: { kind: 'model-driven' },
      solutionRoots: [root],
      watch: false,
      initial: {
        mappings: { [entity]: { entitySet: entity + 's', idColumn, nameColumn } },
        tables: { [entity]: [] },
      },
    });
    ownedFixture(t).add(() => sim.close());
    const read = (suffix) => fetch(sim.url + '/_apps/api/' + suffix);
    const empty = await read('tables/' + entity);
    assert.equal(empty.status, 200, await empty.clone().text());
    const metadata = await (await read('metadata/' + entity)).json();
    assert.ok(metadata.fields[nameColumn]);
    assert.ok(metadata.fields[idColumn]);
    assert.ok(metadata.fields.x_extension);
    assert.equal(metadata.fields.x_unknown, undefined);
    const unknown = await read(
      'tables/' + entity + '?query=' + encodeURIComponent(JSON.stringify({ columns: ['x_unknown'] })),
    );
    assert.equal(unknown.status, 400);
    const created = await fetch(sim.url + '/_apps/api/tables/' + entity, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
      body: JSON.stringify({ [nameColumn]: 'Declared name' }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const populated = await read('tables/' + entity);
    assert.equal(populated.status, 200);
    assert.match(await populated.text(), /Declared name/);
    if (declared) {
      const file = path.join(directory, 'Entity.xml');
      await fs.writeFile(
        file,
        (await fs.readFile(file, 'utf8')).replace(
          '<PrimaryNameAttribute>x_title</PrimaryNameAttribute>',
          '<PrimaryNameAttribute>x_renamed</PrimaryNameAttribute>',
        ),
      );
      await sim.reload();
      const changed = await (await read('metadata/' + entity)).json();
      assert.ok(changed.fields.x_renamed, 'source invalidation retains the later declared primary name');
      assert.ok(changed.fields.x_extension);
      assert.equal(changed.fields.x_unknown, undefined);
      assert.equal((await read('tables/' + entity)).status, 200);
    }
  });
