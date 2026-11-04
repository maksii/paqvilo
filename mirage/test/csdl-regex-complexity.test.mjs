// @test-kind security: CSDL cataloguing avoids rescanning unterminated tag prefixes in untrusted metadata.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectCsdl } from '../dataverse-parity.mjs';

test('CSDL catalogue retains valid entries before long unterminated start tags', () => {
  const malformed = '<Parameter '.repeat(30_000);
  const xml = `<Edmx><Schema Namespace="Example"><Action Name="Run"><Parameter Name="x" Type="Edm.String"/>${malformed}</Action><EntitySet Name="things" EntityType="Example.Thing"/><EntityType Name="Thing"/>${'<EntitySet '.repeat(30_000)}</Schema></Edmx>`;
  const result = inspectCsdl(xml);
  assert.equal(result.operations.length, 1);
  assert.deepEqual(result.operations[0].parameters, [{ Name: 'x', Type: 'Edm.String' }]);
  assert.equal(result.entitySets.length, 1);
  assert.equal(result.types.length, 1);
});
import { csdlAttributes } from '../lib/csdl-attributes.mjs';

test('CSDL attribute extraction rejects long incomplete names without repeated scans', () => {
  const name = 'x'.repeat(100_000);
  assert.deepEqual(csdlAttributes(`${name}!`), {});
  assert.deepEqual(csdlAttributes(`Name="A&amp;B" Kind='Entity' ${name}!`), { Name: 'A&B', Kind: 'Entity' });
});
