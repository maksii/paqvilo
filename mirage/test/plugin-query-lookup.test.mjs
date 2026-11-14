// @test-kind compatibility: Learn Web API lookup property _<name>_value maps to the SDK attribute <name>; commit cites recorder use, unreplayed
// With a RetrieveMultiple step registered, a Web API read becomes the step's QueryExpression. A lookup property
// (_x_value) in $select, $filter or $orderby names the SDK attribute x. Invented table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { odataToSdkQuery } from '../lib/plugin-query.mjs';

test('a Web API lookup property converts to its SDK attribute in the observer query', () => {
  const id = '10000000-0000-4000-8000-000000000091';
  const query = odataToSdkQuery('x_widget', {
    $select: 'x_name,_x_parentid_value',
    $filter: `_x_parentid_value eq ${id}`,
    $orderby: '_x_parentid_value desc',
  });
  assert.deepEqual(query.columnSet.columns, ['x_name', 'x_parentid']);
  assert.equal(query.criteria.conditions[0].attributeName, 'x_parentid');
  assert.equal(query.orders[0].attributeName, 'x_parentid');
});
