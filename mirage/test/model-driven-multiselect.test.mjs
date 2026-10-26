import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateValues } from '../lib/model-driven/data.mjs';
import { modelDrivenFixture } from './model-driven-fixture.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const field = {
  name: 'x_choices',
  label: 'Choices',
  type: 'multiselect',
  dataverseType: 'multiselectpicklist',
  options: [
    { value: 1, label: 'One' },
    { value: 2, label: 'Two' },
  ],
};

test('multiselect shell writes validate all selections and normalize at the Dataverse boundary', () => {
  const table = { fields: { x_choices: field } };
  assert.deepEqual(validateValues(table, { x_choices: [2, 1, 2] }, 'update'), { x_choices: '2,1' });
  assert.deepEqual(validateValues(table, { x_choices: [] }, 'update'), { x_choices: null });
  assert.deepEqual(validateValues(table, { x_choices: null }, 'update'), { x_choices: null });
  for (const value of [[3], ['1'], [1.5], '1,2', [1, null]])
    assert.throws(() => validateValues(table, { x_choices: value }, 'update'), /known choice values/);
  assert.throws(
    () => validateValues({ fields: { x_choices: { ...field, required: true } } }, { x_choices: [] }, 'create'),
    /required/,
  );
});

test('boolean metadata choice values retain boolean form writes for both option labels', () => {
  const table = {
    fields: {
      x_approved: {
        name: 'x_approved',
        label: 'Approved',
        type: 'boolean',
        dataverseType: 'bit',
        options: [
          { value: 0, label: 'No' },
          { value: 1, label: 'Yes' },
        ],
      },
    },
  };
  assert.deepEqual(validateValues(table, { x_approved: false }, 'update'), { x_approved: false });
  assert.deepEqual(validateValues(table, { x_approved: true }, 'update'), { x_approved: true });
  assert.deepEqual(
    validateValues(
      {
        fields: {
          x_approved: {
            ...table.fields.x_approved,
            options: [
              { value: false, label: 'No' },
              { value: true, label: 'Yes' },
            ],
          },
        },
      },
      { x_approved: false },
      'update',
    ),
    { x_approved: false },
  );
  assert.throws(() => validateValues(table, { x_approved: 1 }, 'update'), /boolean/);
});

test('imported multiselect metadata round trips through the shared organization pipeline', async (t) => {
  const fixture = await modelDrivenFixture(t, {}, { started: false });
  const file = path.join(fixture.solutionDir, 'Entities/x_item/Entity.xml');
  const xml = await fs.readFile(file, 'utf8');
  await fs.writeFile(
    file,
    xml.replace(
      '</attributes>',
      '<attribute PhysicalName="x_choices"><Name>x_choices</Name><LogicalName>x_choices</LogicalName><Type>multiselectpicklist</Type><optionset Name="x_choices"><options><option value="1"><labels><label description="One" languagecode="1033"/></labels></option><option value="2"><labels><label description="Two" languagecode="1033"/></labels></option></options></optionset></attribute></attributes>',
    ),
  );
  const sim = await fixture.start();
  ownedFixture(t).add(() => sim.close());
  const origin = sim.url;
  const catalogue = await (await fetch(origin + '/_apps/api')).json();
  assert.equal(catalogue.tables.x_item.fields.x_choices.type, 'multiselect');
  assert.equal(catalogue.tables.x_item.entitySet, 'x_items');
  const headers = { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf };
  const response = await fetch(origin + '/_apps/api/tables/x_item', {
    method: 'POST',
    headers,
    body: JSON.stringify({ x_name: 'Choices round trip', x_choices: [2, 1] }),
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.row.x_choices, '2,1');
  const id = created.row.x_itemid;
  const invalid = await fetch(origin + '/_apps/api/tables/x_item/' + id, {
    method: 'PATCH',
    headers: { ...headers, 'if-match': created.etag },
    body: JSON.stringify({ x_name: 'Must not change', x_choices: [9] }),
  });
  assert.equal(invalid.status, 400);
  const saved = await (await fetch(origin + '/_apps/api/tables/x_item/' + id)).json();
  assert.equal(saved.row.x_name, 'Choices round trip');
  const cleared = await fetch(origin + '/_apps/api/tables/x_item/' + id, {
    method: 'PATCH',
    headers: { ...headers, 'if-match': saved.etag },
    body: JSON.stringify({ x_choices: [] }),
  });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).row.x_choices ?? null, null);
  const empty = await (await fetch(origin + '/_apps/api/tables/x_item/' + id)).json();
  assert.equal(empty.row.x_choices ?? null, null);
});
