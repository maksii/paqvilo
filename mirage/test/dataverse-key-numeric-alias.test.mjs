import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';

for (const container of ['fields', 'fieldMetadata']) {
  for (const [type, literal, precision, tag] of [
    ['bigint', '9007199254740993', 0, 'Int64'],
    ['decimal', '99999999999.1234567891', 10, 'Decimal'],
    ['money', '99999999999999.1234', 4, 'Money'],
  ]) {
    test(`${container} type alias ${type} preserves exact key upsert, read and update`, async (t) => {
      const host = await contractModuleFixture(t, {
        extension: { name: 'numeric-key-alias-review', install() {} },
        mappings: {
          sample: {
            logicalName: 'sample',
            entitySet: 'samples',
            idColumn: 'sampleid',
            nameColumn: 'name',
            [container]: { code: { type, precision }, name: { type: 'string' } },
            alternateKeys: [{ name: 'sample_code', attributes: ['code'] }],
          },
        },
        tables: { sample: [] },
      });
      const path = `/samples(code=${literal})`;
      const created = await host.request('PATCH', path, { name: 'created' });
      const createdText = await created.text();
      assert.equal(created.status, 201, createdText);
      assert.ok(createdText.includes(`"code":${literal}`), 'the wire response preserves the exact literal');
      assert.equal(host.store.state.tables.sample.length, 1);
      const [row] = host.store.state.tables.sample;
      assert.equal(row.code.numericType, tag);
      assert.equal(row.code.value, literal);
      const read = await host.request('GET', path);
      assert.equal(read.status, 200);
      assert.ok((await read.text()).includes(`"code":${literal}`));
      await host.json(await host.request('PATCH', path, { name: 'updated' }), 200);
      assert.equal(host.store.state.tables.sample.length, 1);
      assert.equal(host.store.state.tables.sample[0].name, 'updated');
      assert.deepEqual(host.store.state.tables.sample[0].code, row.code);
      if (type === 'bigint') {
        const before = structuredClone(host.store.state.tables.sample);
        const refused = await host.request('PATCH', '/samples(code=9223372036854775808)', { name: 'invalid' });
        assert.equal(refused.status, 400);
        assert.match(await refused.text(), /Edm.Int64/);
        assert.deepEqual(host.store.state.tables.sample, before, 'an out-of-range alias write is atomic');
      }
    });
  }
}
