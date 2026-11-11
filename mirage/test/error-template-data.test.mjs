// @test-kind security: Portal and Dataverse template admission reject nested accessors and array iteration hooks before user code executes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateDataverseErrorTemplates } from '../lib/dataverse-error-templates.mjs';
import { validateWebApiErrorTemplates } from '../lib/webapi-error-templates.mjs';
const suffix = '\r\n   at Invented.Reader.Convert(Object value)';
function capability(dataverse) {
  return {
    version: 1,
    evidence: 'Invented template admission fixture',
    templates: [
      {
        method: 'PATCH',
        descriptor: {
          ...(dataverse ? { target: 'record' } : {}),
          kind: 'primitive-type',
          sourceType: 'Edm.Boolean',
          expectedType: 'Edm.Int32',
        },
        suffix,
        suffixSha256: createHash('sha256').update(suffix).digest('hex'),
        capturedSourceSha256: '1'.repeat(64),
        qualifiedVariationSha256: '2'.repeat(64),
      },
    ],
  };
}

for (const [name, validate, dataverse] of [
  ['portal', validateWebApiErrorTemplates, false],
  ['Dataverse', validateDataverseErrorTemplates, true],
]) {
  test(name + ' template admission accepts normal explicit arrays', () => {
    assert.equal(validate(capability(dataverse)).length, 1);
  });
  for (const field of ['kind', 'capturedSourceSha256', 'qualifiedVariationSha256', 'suffixSha256'])
    for (const hook of ['toString', 'toPrimitive getter'])
      test(name + ' rejects coercible ' + field + ' via ' + hook + ' without executing it', () => {
        let calls = 0;
        const value = capability(dataverse),
          coercible = {};
        if (hook === 'toString')
          coercible.toString = () => {
            calls++;
            return field === 'kind' ? 'primitive-type' : '1'.repeat(64);
          };
        else
          Object.defineProperty(coercible, Symbol.toPrimitive, {
            get() {
              calls++;
              return () => '1'.repeat(64);
            },
          });
        if (field === 'kind') value.templates[0].descriptor.kind = coercible;
        else value.templates[0][field] = coercible;
        assert.throws(() => validate(value));
        assert.equal(calls, 0);
      });
  for (const [label, mutate] of [
    ['top-level getter', (value, invoked) => Object.defineProperty(value, 'version', { get: invoked })],
    ['template getter', (value, invoked) => Object.defineProperty(value.templates[0], 'method', { get: invoked })],
    [
      'descriptor getter',
      (value, invoked) => Object.defineProperty(value.templates[0].descriptor, 'expectedType', { get: invoked }),
    ],
    [
      'symbol metadata getter',
      (value, invoked) => Object.defineProperty(value.templates[0].descriptor, Symbol('metadata'), { get: invoked }),
    ],
    ['array index getter', (value, invoked) => Object.defineProperty(value.templates, '0', { get: invoked })],
    ['array map getter', (value, invoked) => Object.defineProperty(value.templates, 'map', { get: invoked })],
    [
      'array map override',
      (value, invoked) => {
        value.templates.map = invoked;
      },
    ],
    [
      'array iterator getter',
      (value, invoked) => Object.defineProperty(value.templates, Symbol.iterator, { get: invoked }),
    ],
    [
      'array hole',
      (value) => {
        delete value.templates[0];
      },
    ],
    [
      'array custom prototype',
      (value, invoked) =>
        Object.setPrototypeOf(value.templates, {
          get map() {
            return invoked();
          },
        }),
    ],
  ])
    test(name + ' rejects ' + label + ' without evaluating it', () => {
      let calls = 0;
      const value = capability(dataverse);
      mutate(value, () => {
        calls++;
        return 'PATCH';
      });
      assert.throws(() => validate(value), /plain explicit data properties|dense plain array/);
      assert.equal(calls, 0);
    });
}
