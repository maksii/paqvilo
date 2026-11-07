// @test-kind contract: Native source diagnostics use documented declaration shapes without certifying binaries, builds, devices or host behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeNative } from '../lense/analysis/native-rules.mjs';

const entry = (file, value) => ({
  file,
  relativeFile: file,
  rootId: 'invented',
  text: typeof value === 'string' ? value : JSON.stringify(value),
});
const manifest = (extra = {}) => ({
  name: 'sample-extension',
  version: '1.0.0',
  abi: { compatibleShells: '>=1.0.0', builtAgainst: '1.0.0' },
  entrypoints: { android: { dex: 'SamplePlugin.dex', packageClass: 'sample.SamplePackage' } },
  receivers: [{ name: 'sampleReceiver', nativeModule: 'sampleModule', methods: ['execute'] }],
  ...extra,
});
function inspect(entries) {
  const findings = [];
  const coverage = analyzeNative(entries, (ruleId, source, field) =>
    findings.push({ ruleId, file: source.file, field }),
  );
  return { findings, coverage, ids: findings.map((finding) => finding.ruleId) };
}

test('a source extension may declare Android only and still requires separate native evidence', () => {
  const result = inspect([entry('manifest.json', manifest())]);
  assert.deepEqual(result.ids, ['NATIVE-EXT-003']);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.domains.find((domain) => domain.domain === 'mobile-extension').recognized, 1);
});

test('invalid explicit entrypoint and receiver shapes fail without inventing class or binary names', () => {
  for (const value of [
    manifest({ entrypoints: {} }),
    manifest({ receivers: [] }),
    manifest({ receivers: [{ name: 'receiver', nativeModule: 'module', methods: [] }] }),
  ]) {
    const result = inspect([entry('manifest.json', value)]);
    assert.deepEqual(result.ids, ['NATIVE-EXT-001']);
    assert.equal(result.coverage.complete, false);
  }
  assert.deepEqual(inspect([entry('unrelated/manifest.json', { name: 'browser-extension' })]).ids, []);
});

test('duplicate receivers remain review warnings while method names stay out of diagnostics', () => {
  const value = manifest();
  value.receivers.push({ ...value.receivers[0], methods: ['PRIVATE-METHOD-CANARY', 'PRIVATE-METHOD-CANARY'] });
  const result = inspect([entry('manifest.json', value)]);
  assert.ok(result.ids.includes('NATIVE-EXT-002'));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-METHOD-CANARY|sampleReceiver/);
});

test('native applications do not inherit Code Apps or extension version baselines', () => {
  const packageSource = entry('package.json', {
    dependencies: { '@microsoft/power-apps-native-host': '7.0.0', 'react-native': '8.0.0' },
  });
  const result = inspect([packageSource, entry('yarn.lock', '# invented lock')]);
  assert.deepEqual(result.ids, []);
  assert.equal(result.coverage.domains.find((domain) => domain.domain === 'mobile-apps').recognized, 1);
  assert.deepEqual(inspect([entry('package.json', { dependencies: { expo: '55.0.0' } })]).ids, []);
});

test('native host dependency and explicit runtime shape concerns are warnings or hints', () => {
  const result = inspect([
    entry('package.json', { dependencies: { '@microsoft/power-apps-native-host': '1.0.0' } }),
    entry('app.json', {
      expo: { extra: { powerappsNative: { schemaVersion: 'future', nativeRuntimeVersions: { android: 'unknown' } } } },
    }),
  ]);
  assert.deepEqual(new Set(result.ids), new Set(['MOBILE-APP-001', 'MOBILE-APP-002', 'MOBILE-APP-003']));
});

// @test-kind security: Malformed recognized manifest source is diagnosed without executing or echoing its payload.
test('a malformed packaged manifest remains incomplete without disclosing parser source', () => {
  const result = inspect([entry('sample.ppmplugin!/manifest.json', '{"secret":PRIVATE-NATIVE-CANARY}')]);
  assert.deepEqual(result.ids, ['NATIVE-EXT-001']);
  assert.equal(result.coverage.complete, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-NATIVE-CANARY/);
});

test('invalid explicit platform declarations and missing receivers cannot disappear through truthiness', () => {
  const missing = manifest();
  delete missing.receivers;
  const nullable = manifest({
    entrypoints: { android: null, ios: { framework: 'Sample', moduleClass: 'SampleModule' } },
  });
  for (const value of [missing, nullable])
    assert.deepEqual(inspect([entry('manifest.json', value)]).ids, ['NATIVE-EXT-001']);
  assert.deepEqual(inspect([entry('sample.PPMPLUGIN!/manifest.json', '{')]).ids, ['NATIVE-EXT-001']);
});

test('native configuration is recognized independently and malformed known configuration is incomplete', () => {
  const configuration = entry('app.json', { expo: { extra: { powerappsNative: { schemaVersion: 'unknown' } } } });
  assert.deepEqual(inspect([configuration]).ids, ['MOBILE-APP-003']);
  const pkg = entry('package.json', {
    dependencies: { '@microsoft/power-apps-native-host': '1.0.0' },
    optionalDependencies: { 'react-native': '1.0.0' },
  });
  const valid = inspect([pkg, entry('yarn.lock', '# lock')]);
  assert.deepEqual(valid.ids, []);
  const bad = inspect([pkg, entry('app.json', '{PRIVATE-NATIVE-CONFIG-CANARY')]);
  assert.ok(bad.ids.includes('MOBILE-APP-004'));
  assert.equal(bad.coverage.complete, false);
  assert.doesNotMatch(JSON.stringify(bad), /PRIVATE-NATIVE-CONFIG-CANARY/);
  assert.deepEqual(
    inspect([entry('backup-package.json', { dependencies: { '@microsoft/power-apps-native-host': '1.0.0' } })]).ids,
    [],
  );
});
