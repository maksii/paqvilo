import test from 'node:test';
import assert from 'node:assert/strict';
import { retentionPlan, prunePreviews } from '../scripts/preview-retention.mjs';

const preview = (base, index, branch = 'invented-12345678') => `${base}-preview.${branch}.${index}.gabcdef012345`;
function fixture(versions, tags = {}) {
  return { name: 'paqvilo', versions: Object.fromEntries(versions.map(version => [version, { version }])),
    time: Object.fromEntries(versions.map((version, i) => [version, new Date(1700000000000 + i * 1000).toISOString()])),
    'dist-tags': { latest: '0.9.5', ...tags } };
}

test('retain three previews globally by publication time and retire released bases immediately', () => {
  const old = [preview('0.9.3', 1), preview('0.9.4', 2), preview('0.9.5', 3)];
  const current = [preview('0.9.6', 4), preview('0.9.6', 5, 'other-87654321'), preview('0.9.7', 6), preview('0.9.6', 7)];
  const metadata = fixture(['0.9.4', '0.9.5', '0.9.6-rc.1', '0.0.0-stage', '0.9.6-preview.unknown', ...old, ...current]);
  const plan = retentionPlan(metadata);
  assert.deepEqual(new Set(plan.remove.map(item => item.version)), new Set([...old, current[0]]));
  assert.deepEqual(plan.preserve.map(item => item.version), current.slice(1).reverse());
  assert.equal(plan.remove.find(item => item.version === current[0]).reason, 'preview-limit');
  assert.ok(old.every(version => plan.remove.some(item => item.version === version && item.reason === 'stable-released')));
  assert.ok(plan.preservedOtherVersions.includes('0.9.6-rc.1'));
  metadata.versions['0.9.6'] = { version: '0.9.6' };
  assert.equal(retentionPlan(metadata).remove.filter(item => item.reason === 'stable-released').length, 6);
});

test('preserve primary releases regardless of latest tag and compare base versions numerically', () => {
  const plan = retentionPlan(fixture(['0.9.5', '0.10.0', preview('0.9.99', 1), preview('0.10.0', 2), preview('0.10.1', 3)]));
  assert.equal(plan.newestStable, '0.10.0');
  assert.equal(plan.remove.length, 2);
  assert.deepEqual(plan.preservedOtherVersions, ['0.9.5', '0.10.0']);
  assert.equal(plan.preserve[0].version, preview('0.10.1', 3));
});

test('matching branch channel is disposable but other tags protect their targets and count toward cap', () => {
  const old = preview('0.9.4', 1), first = preview('0.9.6', 2), second = preview('0.9.6', 3);
  const metadata = fixture(['0.9.5', old, first, second], { 'preview-invented-12345678': old, next: first });
  const plan = retentionPlan(metadata, { keep: 1 });
  assert.ok(plan.remove.some(item => item.version === old));
  assert.ok(plan.remove.some(item => item.version === second));
  assert.deepEqual(plan.preserve, [{ version: first, reason: 'protected-tag', tags: ['next'] }]);
  metadata['dist-tags'].custom = old;
  assert.ok(retentionPlan(metadata).preserve.some(item => item.version === old));
  assert.equal(plan.warnings.length, 1);
});

test('bad keep, missing stable latest, malformed metadata and missing timestamps fail closed', () => {
  const metadata = fixture(['0.9.5', preview('0.9.6', 1)]);
  for (const keep of [0, -1, '3', 1.5, 101, NaN]) assert.throws(() => retentionPlan(metadata, { keep }), /keep/);
  for (const invalid of [null, {}, { ...metadata, name: 'another-package' }, { ...metadata, versions: [] }, { ...metadata, time: null }, { ...metadata, 'dist-tags': { latest: preview('0.9.6', 1) } }])
    assert.throws(() => retentionPlan(invalid));
  delete metadata.time[preview('0.9.6', 1)];
  assert.throws(() => retentionPlan(metadata), /publication time/);
});

test('plan only does not invoke npm; apply only ever unpublishes an exact generated preview', async () => {
  const old = preview('0.9.4', 1), active = preview('0.9.6', 2);
  const metadata = fixture(['0.9.5', old, active], { 'preview-invented-12345678': old });
  const calls = [];
  const runNpm = args => {
    calls.push(args);
    if (args[0] === 'unpublish') {
      const version = args[1].slice('paqvilo@'.length);
      delete metadata.versions[version];
      for (const [tag, target] of Object.entries(metadata['dist-tags'])) if (target === version) delete metadata['dist-tags'][tag];
    }
  };
  const read = async () => structuredClone(metadata);
  const planned = await prunePreviews({ read, runNpm });
  assert.equal(planned.applied, false);
  assert.equal(calls.length, 0);
  const result = await prunePreviews({ read, runNpm, apply: true });
  assert.deepEqual(calls, [['unpublish', `paqvilo@${old}`]]);
  assert.deepEqual(result.removed, [old]);
  assert.equal(metadata['dist-tags'].latest, '0.9.5');
  assert.ok(metadata.versions[active]);
  await prunePreviews({ read, runNpm, apply: true });
  assert.equal(calls.length, 1, 'idempotent no-op does not need credentials');
});

test('authentication failure and registry refusal stop cleanup without a broad fallback or whoami gate', async () => {
  const metadata = fixture(['0.9.5', preview('0.9.4', 1), preview('0.9.4', 2)]);
  const calls = [];
  await assert.rejects(prunePreviews({ read: async () => metadata, apply: true, runNpm: args => { calls.push(args); throw Error('unauthenticated'); } }), /unauthenticated/);
  assert.deepEqual(calls, [['unpublish', `paqvilo@${preview('0.9.4', 2)}`]]);
  calls.length = 0;
  await assert.rejects(prunePreviews({ read: async () => metadata, apply: true, runNpm: args => {
    calls.push(args); if (args[0] === 'unpublish') throw Error('policy denied');
  } }), /policy denied/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'unpublish');
});

test('recheck avoids removing newly protected versions and verifies successful registry removal', async () => {
  const version = preview('0.9.4', 1), metadata = fixture(['0.9.5', version]);
  let reads = 0;
  const calls = [];
  const result = await prunePreviews({ apply: true, read: async () => {
    const copy = structuredClone(metadata);
    if (++reads > 1) copy['dist-tags'].pinned = version;
    return copy;
  }, runNpm: args => calls.push(args) });
  assert.deepEqual(result.skipped, [version]);
  assert.deepEqual(calls, []);
  await assert.rejects(prunePreviews({ apply: true, read: async () => metadata, runNpm: () => {} }), /still lists/);
});
