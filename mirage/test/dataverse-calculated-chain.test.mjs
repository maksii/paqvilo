// @test-kind unproven: local model of the five-column calculated chain limit (null plus CALCULATED_UNSUPPORTED); no native capture of the over-limit read
// Calculated column chains (lib/dataverse-calculated.mjs): whether a column computes depends only on its own dependency
// chain, never on which other columns a read selects, their order or the read surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION } from '../lib/dataverse-calculated.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';

const ONE = '10000000-0000-4000-8000-000000000001';
const TEN = '10000000-0000-4000-8000-000000000002';
const PARENT = '20000000-0000-4000-8000-000000000001';
const calc = (formulaDefinition) => ({
  dataverseType: 'decimal',
  columnMetadata: { sourceType: 1, formulaDefinition },
});
const plusOne = (name) => calc(`<Add><Field Name="${name}"/><Constant Value="1"/></Add>`);

// c1 = x_amount + 1, cN = c(N-1) + 1: cN is a chain of N calculated columns. p1..p5 on the parent likewise; q reads p5
// through the lookup (a chain of six), r reads p4 (five). loop_a and loop_b read each other.
const fields = { x_amount: { dataverseType: 'decimal' }, x_pid: { dataverseType: 'lookup', targets: ['x_p'] } };
for (let n = 1; n <= 7; n++) fields[`c${n}`] = plusOne(n === 1 ? 'x_amount' : `c${n - 1}`);
fields.q = plusOne('x_pid.p5');
fields.r = plusOne('x_pid.p4');
fields.loop_a = plusOne('loop_b');
fields.loop_b = plusOne('loop_a');
const parentFields = { x_rate: { dataverseType: 'decimal' } };
for (let n = 1; n <= 5; n++) parentFields[`p${n}`] = plusOne(n === 1 ? 'x_rate' : `p${n - 1}`);

const mappings = {
  x_p: { logicalName: 'x_p', entitySet: 'x_ps', idColumn: 'x_pid', fields: parentFields },
  x_n: {
    logicalName: 'x_n',
    entitySet: 'x_ns',
    idColumn: 'x_nid',
    relationships: { x_pid: { entity: 'x_p', from: 'x_pid', to: 'x_pid', many: false } },
    fields,
  },
};
const lookup = { id: PARENT, logical_name: 'x_p' };
const tables = {
  x_p: [{ x_pid: PARENT, x_rate: 100 }],
  x_n: [
    { x_nid: ONE, x_amount: 1, x_pid: lookup },
    { x_nid: TEN, x_amount: 10, x_pid: lookup },
  ],
};

async function setup(t) {
  const diagnostics = [];
  const fixture = await contractModuleFixture(t, {
    mappings,
    tables,
    extension: EXTENSION,
    options: { diagnostic: (entry) => diagnostics.push(entry) },
  });
  const read = async (select) => fixture.json(await fixture.request('GET', `/x_ns(${ONE})?$select=${select}`), 200);
  const ids = async (path) =>
    (await fixture.json(await fixture.request('GET', path), 200)).value.map((row) => row.x_nid);
  return { ...fixture, diagnostics, read, ids };
}

const chain = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
const expected = { c1: 2, c2: 3, c3: 4, c4: 5, c5: 6, c6: null, c7: null };
const pick = (row, columns) => Object.fromEntries(columns.map((column) => [column, row[column]]));
const unsupported = (diagnostics) =>
  diagnostics
    .filter((entry) => entry.code === 'CALCULATED_UNSUPPORTED')
    .map((entry) => entry.column)
    .sort();

test('a chained calculated column reads the same value whatever $select lists and in whatever order', async (t) => {
  const { read, diagnostics } = await setup(t);
  for (const column of chain)
    assert.deepEqual(pick(await read(column), [column]), { [column]: expected[column] }, column);
  assert.deepEqual(pick(await read(chain.join(',')), chain), expected);
  assert.deepEqual(pick(await read(chain.toReversed().join(',')), chain), expected);
  assert.deepEqual(pick(await read('c5,c6,c7'), ['c5', 'c6', 'c7']), { c5: 6, c6: null, c7: null });
  // Reported once for each column past the bound, naming that column.
  assert.deepEqual(unsupported(diagnostics), ['c6', 'c7']);
  assert.ok(diagnostics.every((entry) => /more than 5 chained calculated columns/.test(entry.message)));
});

test('$filter, FetchXML and $apply see the same chain bound as the projection', async (t) => {
  const { ids, json, request, diagnostics } = await setup(t);
  // The boundary column (a chain of five) computes on every surface.
  assert.deepEqual(await ids('/x_ns?$select=x_nid&$filter=c5 eq 15'), [TEN]);
  assert.deepEqual(await ids('/x_ns?$select=x_nid&$filter=c5 eq 6'), [ONE]);
  // The first column past the bound reads null, also when the filter lists the inner columns first.
  assert.deepEqual(await ids('/x_ns?$select=x_nid&$filter=c7 eq 8'), []);
  assert.deepEqual(await ids('/x_ns?$select=x_nid&$filter=c5 eq 6 and c6 eq 7'), []);
  assert.deepEqual((await ids('/x_ns?$select=x_nid&$filter=c6 eq null')).sort(), [ONE, TEN]);
  const fetch = (xml) => ids(`/x_ns?fetchXml=${encodeURIComponent(xml)}`);
  const condition = (attribute, value) =>
    `<fetch><entity name="x_n"><attribute name="x_nid"/><filter><condition attribute="${attribute}" operator="eq" value="${value}"/></filter></entity></fetch>`;
  assert.deepEqual(await fetch(condition('c5', 15)), [TEN]);
  assert.deepEqual(await fetch(condition('c6', 16)), []);
  const sums = await json(
    await request('GET', '/x_ns?$apply=aggregate(c5 with sum as five,c6 with sum as six,c1 with sum as one)'),
    200,
  );
  assert.equal(Number(sums.value[0].five), 21);
  assert.equal(Number(sums.value[0].six), 0); // c6 reads null on every row: nothing to add
  assert.equal(Number(sums.value[0].one), 13);
  assert.deepEqual(unsupported(diagnostics), ['c6', 'c7']);
});

test('a lookup hop counts toward the chain; a cycle reads null', async (t) => {
  const { read, json, request, diagnostics } = await setup(t);
  // r reads p4 (four columns on the parent): five in all. q reads p5: six.
  assert.deepEqual(pick(await read('q,r'), ['q', 'r']), { q: null, r: 105 });
  assert.deepEqual(pick(await read('r'), ['r']), { r: 105 });
  const parent = await json(await request('GET', `/x_ps(${PARENT})?$select=p5`), 200);
  assert.equal(parent.p5, 105);
  assert.deepEqual(pick(await read('loop_a,loop_b'), ['loop_a', 'loop_b']), { loop_a: null, loop_b: null });
  assert.deepEqual(unsupported(diagnostics), ['loop_a', 'loop_b', 'q']);
  assert.match(diagnostics.find((entry) => entry.column === 'loop_a').message, /cycle/);
});
