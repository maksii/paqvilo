// @test-kind observation: two source-bound native draft recordings in fixtures/model-driven-pcf-caller-native-facts.json record direct choice PCF option calls; the control definition and the operation for each case label are typed in these tests, so they are not replay cases.
import test, { before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { decode } from '../test-support/model-driven-native-decode.mjs';
import { createFormClientRuntime } from '../lib/model-driven/client-runtime.mjs';
import { createDatasetHost } from '../lib/model-driven/pcf-runtime.mjs';

const bytes = readFileSync(new URL('./fixtures/model-driven-pcf-caller-native-facts.json', import.meta.url));

const evidence = JSON.parse(bytes);

describe('native PCF caller contract', () => {
  before(() => {
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      'c4ccf954854163ab60d1fa23b24b9e97c996abdd6cccbd26fad8a193698ba074',
    );
  });

  for (const [round, capture] of evidence.captures.entries())
    for (const row of capture.cases) {
      test(`native PCF round ${round + 1}: ${row.id}`, () => {
        const recorded = decode(row.facts.rawTypedResult),
          source = recorded.before.state.source;
        const field = {
          name: 'x_choice',
          type: 'number',
          options: source.map(({ text, value }) => ({ label: text, value })),
        };
        const state = new Map();
        const runtime = createFormClientRuntime({
          table: { fields: { x_choice: field } },
          form: { attributes: ['x_choice'] },
          record: {},
          controlNames: () => ['standard', 'pcf'],
          controlField: () => 'x_choice',
          isPcfControl: (name) => name === 'pcf',
          controlState: (name, key, value) =>
            value === undefined ? state.get(`${name}:${key}`) : state.set(`${name}:${key}`, value),
          syncChoiceOptions: (caller, fieldName, options, blank) => {
            for (const name of ['standard', 'pcf']) {
              state.set(`${name}:optionPlaceholder`, blank);
              if (name !== caller) state.set(`${name}:options`, options);
            }
          },
          read: () => null,
        });
        const form = runtime.formContext,
          attr = form.getAttribute('x_choice');
        const standard = form.getControl('standard'),
          pcf = form.getControl('pcf');
        assert.notEqual(standard, pcf);
        for (const method of ['getOptions', 'addOption', 'removeOption', 'clearOptions'])
          assert.equal(typeof pcf[method], 'function');
        const snapshot = () => ({
          source: attr.getOptions(),
          standard: { result: standard.getOptions() },
          pcf: { result: pcf.getOptions() },
          value: attr.getValue(),
          text: attr.getText(),
        });
        standard.clearOptions();
        standard.addOption(source[0]);
        assert.equal(recorded.before.ready, true);
        assert.deepEqual(snapshot(), recorded.before.state);
        const perform = () => {
          if (row.id === 'pcf.add-zero') return pcf.addOption(recorded.argument, 0);
          if (row.id === 'pcf.remove-first') return pcf.removeOption(recorded.argument);
          if (row.id === 'pcf.clear') return pcf.clearOptions();
          if (row.id.startsWith('pcf.invalid.add.'))
            return pcf.addOption({ text: 'Invalid', value: recorded.argument });
          if (row.id.startsWith('pcf.invalid.remove.')) return pcf.removeOption(recorded.argument);
          if (row.id.startsWith('pcf.index.')) return pcf.addOption({ text: 'Three', value: 3 }, recorded.argument);
          if (row.id === 'pcf.duplicate') return pcf.addOption({ text: 'Duplicate', value: recorded.argument });
          throw new Error(`Unrecognized recorded case ${row.id}`);
        };
        if (recorded.outcome.error) assert.throws(perform, recorded.outcome.error);
        else assert.equal(perform(), recorded.outcome.result);
        assert.deepEqual(snapshot(), recorded.after);
        runtime.destroy();
      });
    }
});

// @test-kind compatibility: the documented PCF paging API reports the current page as pageNumber and firstPageNumber, and a dataset control reads them to show or request the next page.
test('PCF dataset paging reports the current page number', async () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({
    x_childid: `88888888-8888-4888-8888-${String(index).padStart(12, '0')}`,
    x_name: `Child ${index}`,
  }));
  const table = {
    entity: 'x_child',
    idColumn: 'x_childid',
    nameColumn: 'x_name',
    label: 'Children',
    fields: {
      x_childid: { name: 'x_childid', type: 'text' },
      x_name: { name: 'x_name', type: 'text', label: 'Name' },
    },
  };
  const query = async ({ page, pageSize }) => ({
    rows: rows.slice((page - 1) * pageSize, page * pageSize),
    total: rows.length,
  });
  const { dataset, load } = createDatasetHost({
    table,
    tables: { x_child: table },
    columns: [{ name: 'x_name' }],
    query,
    openRecord: () => {},
  });
  await load();
  assert.equal(dataset.paging.pageNumber, 1);
  assert.equal(dataset.paging.firstPageNumber, 1);
  assert.equal(dataset.paging.lastPageNumber, 3);
  await dataset.paging.loadNextPage();
  assert.equal(dataset.paging.pageNumber, 2);
  assert.equal(dataset.paging.firstPageNumber, 2);
  assert.equal(dataset.paging.lastPageNumber, 3);
  assert.equal(dataset.paging.hasNextPage, true);
  assert.equal(dataset.paging.hasPreviousPage, true);
  await dataset.paging.loadExactPage(3);
  assert.equal(dataset.paging.pageNumber, 3);
  assert.equal(dataset.paging.firstPageNumber, 3);
  assert.equal(dataset.paging.hasNextPage, false);
});
