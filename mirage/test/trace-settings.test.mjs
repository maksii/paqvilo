// @test-kind contract: Paqvilo's tracing and activity design (docs/design/tracing.md)
// mirage.trace (lib/trace-settings.mjs): defaults, ranges, unknown keys and the run-time merge the trace store applies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeTraceSettings, traceSettings } from '../lib/trace-settings.mjs';
import { MIRAGE_SETTINGS, parseSetting, runtimeIdentity, runtimeOptions } from '../lib/config-keys.mjs';

const DEFAULTS = { level: 'summary', traces: 500, spansPerTrace: 2000, payloadBytes: 16_384, persist: false };

test('traceSettings fills the defaults and keeps valid values', () => {
  assert.deepEqual(traceSettings(), DEFAULTS);
  assert.deepEqual(traceSettings({}), DEFAULTS);
  const full = { level: 'full', traces: 10, spansPerTrace: 20_000, payloadBytes: 1_048_576, persist: true };
  assert.deepEqual(traceSettings(full), full);
  assert.deepEqual(traceSettings({ level: 'off', traces: 10_000, spansPerTrace: 50, payloadBytes: 256 }), {
    ...DEFAULTS,
    level: 'off',
    traces: 10_000,
    spansPerTrace: 50,
    payloadBytes: 256,
  });
});

test('traceSettings rejects unknown keys, foreign levels and values out of range', () => {
  assert.throws(() => traceSettings(null), /mirage\.trace must be an object/);
  assert.throws(() => traceSettings([]), /mirage\.trace must be an object/);
  assert.throws(() => traceSettings({ capturePayloads: true }), /Unknown setting mirage\.trace\.capturePayloads/);
  assert.throws(() => traceSettings({ level: 'verbose' }), /mirage\.trace\.level must be off, summary or full/);
  for (const [key, low, high] of [
    ['traces', 9, 10_001],
    ['spansPerTrace', 49, 20_001],
    ['payloadBytes', 255, 1_048_577],
  ]) {
    assert.throws(() => traceSettings({ [key]: low }), new RegExp(`mirage\\.trace\\.${key} must be an integer`));
    assert.throws(() => traceSettings({ [key]: high }), new RegExp(`mirage\\.trace\\.${key} must be an integer`));
    assert.throws(() => traceSettings({ [key]: 100.5 }), new RegExp(`${key} must be an integer`));
    assert.throws(() => traceSettings({ [key]: '100' }), new RegExp(`${key} must be an integer`));
  }
  assert.throws(() => traceSettings({ persist: 'yes' }), /mirage\.trace\.persist must be true or false/);
  assert.throws(() => traceSettings({ level: 'x' }, 'trace'), /^Error: trace\.level must be/);
});

test('mergeTraceSettings replaces only the named members and validates the result', () => {
  const current = traceSettings({ traces: 20 });
  assert.deepEqual(mergeTraceSettings(current, { level: 'full' }), { ...current, level: 'full' });
  assert.deepEqual(mergeTraceSettings(current, {}), current);
  assert.deepEqual(current.level, 'summary', 'the current value is not mutated');
  assert.throws(() => mergeTraceSettings(current, { level: 'loud' }), /trace\.level must be off, summary or full/);
  assert.throws(() => mergeTraceSettings(current, { other: 1 }), /Unknown setting trace\.other/);
  assert.throws(() => mergeTraceSettings(current, 'full'), /trace must be an object/);
});

test('the trace row validates through traceSettings and reaches createSimulator as the trace option', () => {
  const row = MIRAGE_SETTINGS.trace;
  assert.deepEqual([...row.scopes], ['catalogue', 'project']);
  assert.equal(row.option, 'trace');
  assert.equal(row.identity, undefined, 'a level change never forces a new runtime');
  assert.deepEqual(parseSetting('trace', { level: 'full' }), { ...DEFAULTS, level: 'full' });
  assert.throws(
    () => parseSetting('trace', { other: 1 }, { label: 'mirage.trace' }),
    /Unknown setting mirage\.trace\.other/,
  );
  const project = { trace: parseSetting('trace', { level: 'off' }) },
    catalogue = { trace: parseSetting('trace', { level: 'full' }) };
  assert.deepEqual(runtimeOptions({ catalogue }).trace, catalogue.trace);
  assert.deepEqual(runtimeOptions({ project, catalogue }).trace, project.trace, 'project wins over catalogue');
  assert.equal(runtimeIdentity(runtimeOptions({ catalogue })).trace, undefined);
});
