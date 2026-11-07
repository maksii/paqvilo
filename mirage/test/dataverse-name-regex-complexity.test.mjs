// @test-kind security: Dataverse operation metadata parsing handles long malformed attribute names in linear time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { platformOperationCsdl } from '../lib/dataverse-operation-contracts.mjs';

test('unknown operation survives a long invalid attribute name', () => {
  const input = `<Action ${'a'.repeat(100_000)}! />`;
  assert.equal(platformOperationCsdl(input), input);
});
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('security reference rejects long malformed entity names', () => {
  const source = readFileSync(new URL('../lib/dataverse-security-messages.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function targetRef(');
  const end = source.indexOf('\n// The teamtemplate', start);
  assert.ok(start >= 0 && end > start);
  const targetRef = runInNewContext(`(${source.slice(start, end).trim()})`, {
    invalid: (message) => new Error(message),
  });
  assert.throws(
    () => targetRef({ store: { resolveMapping: (name) => name } }, `${'a'.repeat(100_000)}!`),
    /Invalid argument/,
  );
  assert.equal(
    targetRef({ store: { resolveMapping: (name) => name } }, `123accounts(${'a'.repeat(36)})`).mapping,
    'accounts',
  );
});

test('retained-data attribute removal handles long whitespace without rescanning', () => {
  const source = readFileSync(new URL('../lib/dataverse-data-messages.mjs', import.meta.url), 'utf8');
  const match = /opening\.replace\((\/.*?\/i),/.exec(source);
  assert.ok(match);
  const pattern = runInNewContext(match[1]);
  const opening = `<fetch ${' '.repeat(100_000)}x>`;
  assert.equal(opening.replace(pattern, ''), opening);
  assert.equal('<fetch datasource="archive">'.replace(pattern, ''), '<fetch>');
});
