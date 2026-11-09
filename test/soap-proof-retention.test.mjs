// @test-kind tooling: recomputing the source digest cannot permit removal of a protected SOAP proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { soapNodes } from '../scripts/qualify-soap-namespace.mjs';
import {
  assertSoapParityBindingsFromSource,
  parityAstHash,
  soapBindingsFromSource,
} from '../scripts/qualify-parity.mjs';

test('SOAP source guard rejects removal of a prior proof after source digest recalculation', () => {
  const target = new URL('../mirage/test/dataverse-soap-xml.test.mjs', import.meta.url);
  const source = fs.readFileSync(target, 'utf8');
  const { tree, guard, declaration, imported } = soapNodes(source);
  const bindings = soapBindingsFromSource(source);
  bindings[0].proofs.shift();
  bindings[0].sourceAstSha256 = parityAstHash({
    ...tree,
    body: tree.body.filter((node) => node !== guard && node !== declaration && node !== imported),
  });
  const argument = guard.expression.arguments[1];
  const changed = source.slice(0, argument.range[0]) + JSON.stringify(bindings) + source.slice(argument.range[1]);
  assert.throws(() => assertSoapParityBindingsFromSource(target, bindings, changed), /changed-soap-prior-proof/);
});
