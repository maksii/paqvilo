// @test-kind observation: two native model-driven dirty-state captures on 2026-11-08 produced the 82 rows of fixtures/model-driven-dirty-expected.json, SHA256 a82c85e6df0f66ea9c0297b2ef87fdb1a83d32f51b9e7851e8a1252b219b7c93, from the probe with SHA256 62c403234c10bd3e1c8ec4dd15ea3496f672fc76d3324f1b5a2fcce1d7420177 (dirty-plan.json SHA256 2027f1107ab32fc64aa684136688a0a28e68062da217882c28edf5a9e2f92f88, not committed). The field list is typed in this test. The Boolean-first isolation snapshots below are hand-written; their native sources (dirty-diagnostic.json and dirty-isolation.json, hashes in fixtures/frontend-parity-evidence.json) are not committed, and the PR comment cited 45 and 39 snapshots from them. No replay case records these inputs.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { captureModelDrivenDirtyContract } from '../testing/model-driven-dirty.mjs';
import { presentationFixture } from './fixtures/model-driven-presentation.mjs';

const bytes = fs.readFileSync(new URL('./fixtures/model-driven-dirty-expected.json', import.meta.url));

let actual;
before(async () => {
  assert.equal(
    createHash('sha256').update(captureModelDrivenDirtyContract.toString()).digest('hex'),
    '62c403234c10bd3e1c8ec4dd15ea3496f672fc76d3324f1b5a2fcce1d7420177',
  );
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'a82c85e6df0f66ea9c0297b2ef87fdb1a83d32f51b9e7851e8a1252b219b7c93',
  );
  const fixture = presentationFixture({ falseBooleanDefault: true });
  actual = await captureModelDrivenDirtyContract(
    {
      fields: [
        { role: 'text', name: 'x_email', value: 'dirty@example.invalid' },
        { role: 'memo', name: 'x_memo', value: 'Invented dirty memo' },
        { role: 'number', name: 'x_quantity', value: 7 },
        { role: 'choice', name: 'x_choice', value: 198720001 },
        { role: 'multi', name: 'x_multi', value: [198720001, 198720000] },
        { role: 'boolean', name: 'x_boolean', value: true },
        { role: 'date', name: 'x_date', kind: 'date', value: '2026-12-09T09:30:00.000Z' },
        {
          role: 'lookup',
          name: 'x_lookup',
          value: [{ id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Invented parent', entityType: 'x_contract' }],
        },
      ],
    },
    fixture.runtime.formContext,
  );
});

for (const [index, expected] of JSON.parse(bytes).entries()) {
  test(`native model-driven dirty state: ${expected.id}`, () => assert.deepEqual(actual[index], expected));
}

for (const field of ['x_email', 'x_quantity']) {
  test(`native false-default Boolean stays pending after isolated ${field} restore`, () => {
    const fixture = presentationFixture({ falseBooleanDefault: true }),
      form = fixture.runtime.formContext;
    const bool = form.getAttribute('x_boolean'),
      other = form.getAttribute(field),
      original = other.getValue();
    const snapshots = [];
    const read = () =>
      snapshots.push([
        bool.getValue(),
        bool.getInitialValue(),
        bool.getIsDirty(),
        form.data.entity.getIsDirty(),
        form.data.getIsDirty(),
        other.getIsDirty(),
      ]);
    read();
    other.setValue(field === 'x_email' ? 'isolation@example.invalid' : 7);
    read();
    other.setValue(original);
    read();
    bool.setValue(false);
    read();
    bool.setValue(true);
    read();
    bool.setValue(false);
    read();
    assert.deepEqual(snapshots, [
      [false, 0, false, false, false, false],
      [false, 0, true, true, true, true],
      [false, 0, true, true, true, false],
      [false, 0, true, true, true, false],
      [true, 0, true, true, true, false],
      [false, 0, false, true, true, false],
    ]);
  });
}
