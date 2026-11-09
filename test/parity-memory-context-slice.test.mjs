// @test-kind tooling: source certificates bind caller state history and reject altered or escaping renderer inputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeParitySource } from '../scripts/qualify-parity.mjs';
import { certifyMemoryContextSlice } from '../scripts/parity-memory-context-slice.mjs';

const file = 'mirage/test/example.test.mjs';
const source = `
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalRenderer } from '../lib/liquid.mjs';
function renderer(observed, options = {}) {
  return createPortalRenderer({ templates: {}, settings: {}, observed }, options);
}
test('sample', async () => {
  const engine = renderer({ mode: 'observed' });
  const context = engine.contextForPage({ id: 'fixed' }, '/');
  assert.equal(await engine.renderString('previous', context), 'previous');
  const source = 'target';
  assert.equal(await renderer({ mode: 'observed' }).renderString(source), 'target');
  assert.equal(await engine.renderString('second'), 'second');
});
`;
function models(before = source, after = before) {
  const baselineModel = describeParitySource(before, file),
    currentModel = describeParitySource(after, file);
  return { baselineModel, currentModel, row: baselineModel.registrations[0] };
}
function certify(m, index) {
  return certifyMemoryContextSlice({ ...m, baselineId: m.row.id, assertionSha256: m.row.assertions[index].sha256 });
}

test('binds fresh inline and retained-engine calls to identical ordered history', () => {
  const m = models(),
    fresh = certify(m, 1),
    reused = certify(m, 2);
  assert.equal(fresh.receiver, 'fresh-inline');
  assert.equal(reused.receiver, 'retained-engine');
  assert.notEqual(fresh.orderedPrefixSha256, reused.orderedPrefixSha256);
  assert.equal(fresh.context, 'omitted');
  assert.equal(fresh.moduleIsolationRequired, true);
  assert.equal(fresh.nativeParityProven, false);
});

test('rejects changed history, helper configuration and selected arguments', () => {
  assert.throws(
    () => certify(models(source, source.replace("'previous', context", "'changed', context")), 1),
    /parent-body-drift/,
  );
  assert.throws(
    () => certify(models(source, source.replace('settings: {}', "settings: { x: 'changed' }")), 1),
    /helper-drift/,
  );
  assert.throws(
    () => certify(models(source, source.replace('renderString(source)', 'renderString(source, {})')), 1),
    /parent-body-drift/,
  );
});

test('rejects escaping or mutating a retained renderer even if both versions match', () => {
  const escaping = source.replace("const source = 'target';", "globalThis.saved = engine; const source = 'target';");
  assert.throws(() => certify(models(escaping), 2), /unsupported-memory-context-slice/);
  const mutation = source.replace("const source = 'target';", "engine.changed = true; const source = 'target';");
  assert.throws(() => certify(models(mutation), 2), /unsupported-memory-context-slice/);
  const concurrent = source.replace(
    "const source = 'target';",
    "engine.renderString('unawaited'); const source = 'target';",
  );
  assert.throws(() => certify(models(concurrent), 2), /unsupported-memory-context-slice/);
});

test('rejects nonliteral renderer inputs and mutable source variables', () => {
  const dynamic = source.replace("renderer({ mode: 'observed' });", 'renderer({ mode: process.env.MODE });');
  assert.throws(() => certify(models(dynamic), 2), /unsupported-memory-context-slice/);
  const mutable = source.replace("const source = 'target';", "let source = 'target';");
  assert.throws(() => certify(models(mutable), 1), /unsupported-memory-context-slice/);
  const dynamicContext = source.replace("{ id: 'fixed' }", '{ id: process.env.PAGE }');
  assert.throws(() => certify(models(dynamicContext), 2), /unsupported-memory-context-slice/);
  const escapingContext = source.replace(
    "const source = 'target';",
    "globalThis.saved = context; const source = 'target';",
  );
  assert.throws(() => certify(models(escapingContext), 2), /unsupported-memory-context-slice/);
});
