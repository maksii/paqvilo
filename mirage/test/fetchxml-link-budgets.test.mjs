import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXmlDocument, planFetch } from '../lib/fetchxml-engine.mjs';
const joins = (n, prefix = 'j') =>
  Array.from(
    { length: n },
    (_, i) => '<link-entity name="record" from="recordid" to="recordid" alias="' + prefix + i + '"/>',
  ).join('');
const predicates = (count, inside = 0) =>
  '<filter>' +
  Array.from(
    { length: count },
    (_, i) =>
      '<filter><link-entity name="record" from="recordid" to="recordid" link-type="any" alias="a' +
      i +
      '">' +
      joins(inside, 'a' + i + 'j') +
      '</link-entity></filter>',
  ).join('') +
  '</filter>';
const plan = (body) =>
  planFetch(
    parseXmlDocument('<fetch><entity name="record"><attribute name="recordid"/>' + body + '</entity></fetch>'),
    { profile: 'sdk' },
  );
test('Dataverse separately budgets ordinary joins and the complete ordinary-plus-filter link tree', () => {
  assert.equal(plan(joins(15)).links.length, 15);
  assert.throws(
    () => plan(joins(16)),
    (e) => e.details.innerCode === '0x8004430d' && e.details.ordinaryLinks === 16,
  );
  assert.equal(plan(predicates(27)).links.length, 27);
  assert.throws(
    () => plan(predicates(28)),
    (e) => e.details.innerCode === '0x8004430d' && e.details.filterLinks === 28,
  );
  assert.equal(plan(joins(15) + predicates(1)).links.length, 16);
  assert.equal(plan(joins(9) + predicates(2, 3)).links.length, 17);
  assert.equal(plan(predicates(1, 15)).links.length, 16);
  assert.throws(
    () => plan(joins(15) + predicates(1, 1)),
    (e) => e.details.ordinaryLinks === 16,
  );
  assert.equal(plan(predicates(13, 1)).links.length, 26);
  assert.throws(
    () => plan(predicates(14, 1)),
    (e) => e.details.ordinaryLinks === 14 && e.details.totalLinks === 28 && e.details.limit === 27,
  );
});
