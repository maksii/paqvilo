import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectSyntheticEvidence } from '../scripts/collect-evidence.mjs';
import {
  validateReleaseFiles,
  REQUIRED_RELEASE_FILES,
  checkPackageMetadata,
  checkDocumentation,
} from '../scripts/release-check.mjs';
import { packageDependencyEvidence } from '../scripts/package-dependency-evidence.mjs';

test('distribution evidence preserves transitive version, integrity and layout differences', () => {
  const source = {
    packages: {
      '': { version: '1.0.0' },
      'node_modules/a': { version: '1.0.0', integrity: 'sha512-original' },
      'node_modules/b': { version: '2.0.0', integrity: 'sha512-same-version-original' },
      'node_modules/optional': { version: '1.0.0', optional: true },
    },
  };
  const consumer = {
    packages: {
      'node_modules/paqvilo': { version: '1.0.0', integrity: 'sha512-archive' },
      'node_modules/a': { version: '1.0.1', integrity: 'sha512-new-version' },
      'node_modules/b': { version: '2.0.0', integrity: 'sha512-same-version-new' },
      'node_modules/paqvilo/node_modules/c': { version: '3.0.0', integrity: 'sha512-nested' },
    },
  };
  const report = packageDependencyEvidence(source, consumer, 'paqvilo');
  assert.deepEqual(
    report.differences.map((entry) => entry.path),
    ['node_modules/a', 'node_modules/b', 'node_modules/optional', 'node_modules/paqvilo/node_modules/c'],
  );
  assert.equal(report.differences[0].consumer.integrity, 'sha512-new-version');
  assert.equal(report.differences[1].source.version, report.differences[1].consumer.version);
  assert.equal(report.differences[2].consumer, null);
  assert.equal(report.differences[3].source, null);
  assert.equal(report.toolkit.integrity, 'sha512-archive');
  assert.deepEqual(
    report.sourcePackages.map((entry) => entry.path),
    Object.keys(source.packages).slice(1),
  );
  assert.equal(report.consumerPackages.length, 4);
});

test('release counts distinct archive entries whose GUID paths npm masks identically', () => {
  const required = REQUIRED_RELEASE_FILES.map((path) => ({ path }));
  const masked = { path: 'examples/project/solution/PluginAssemblies/PaqviloDemoPlugins-***/PaqviloDemoPlugins.dll' };
  assert.equal(validateReleaseFiles([...required, masked, masked]), required.length + 2);
});

test('release checks nested user guides and example documentation links', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-doc-links-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, text) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  for (const name of ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md', 'mirage/README.md'])
    write(name, '# Guide\n');
  write('.gitignore', '.env\npaqvilo.config.local.yml\n');
  write('mirage/docs/baseline/rerun.md', '[Input](./scenario%20inputs.md#fields)');
  assert.throws(() => checkDocumentation(root), /Broken documentation link.*rerun\.md/);
  write('mirage/docs/baseline/scenario inputs.md', '# Fields\n');
  write('examples/project/deployment/README.md', '[Site](../../../missing.md)');
  assert.throws(() => checkDocumentation(root), /Broken documentation link.*README\.md/);
  write('missing.md', '# Site\n');
  write('mirage/docs/node_modules/private/README.md', '[Ignore](absent.md)');
  assert.doesNotThrow(() => checkDocumentation(root));
});

test('release allowlist includes Mirage runtime and excludes tests, state, profiles and live evidence', () => {
  const required = REQUIRED_RELEASE_FILES.map((path) => ({ path }));
  assert.equal(validateReleaseFiles(required), required.length);
  assert.equal(
    validateReleaseFiles([
      ...required,
      { path: 'examples/company-operations/portal-harness/native-capture.mjs' },
      { path: 'examples/company-operations/plugins/mirage-runtime.mjs' },
    ]),
    required.length + 2,
  );
  assert.equal(
    validateReleaseFiles([
      ...required,
      { path: 'examples/company-operations/plugins/test/collector-worker-lifecycle.test.mjs' },
    ]),
    required.length + 1,
  );
  assert.throws(
    () =>
      validateReleaseFiles([
        ...required,
        { path: 'examples/company-operations/plugins/test/collector-worker-live.test.mjs' },
      ]),
    /Unexpected release file/,
  );
  assert.equal(
    validateReleaseFiles([
      ...required,
      { path: 'examples/project/solution/PluginAssemblies/PaqviloDemoPlugins-***/PaqviloDemoPlugins.dll' },
    ]),
    required.length + 1,
  );
  assert.throws(
    () =>
      validateReleaseFiles([
        ...required,
        { path: 'examples/project/solution/PluginAssemblies/PaqviloDemoPlugins-***/Unreviewed.dll' },
      ]),
    /Unexpected release file/,
  );
  for (const file of [
    'mirage/admin/unreviewed.png',
    'mirage/admin/Unreviewed.mjs',
    'mirage/admin/nested/unreviewed.mjs',
    'lense/setup/unreviewed.js',
    '.env',
    '.paqvilo/agents/session.json',
    'profiles/Default/Cookies',
    'live.png',
    'docs/assets/live.png',
    'docs/assets/private.svg',
    'lense/../../secret.mjs',
    'mirage/test/server.test.mjs',
    'mirage/test-browser/admin.test.mjs',
    'mirage/node_modules/liquidjs/index.js',
    'mirage/.paqvilo/state.json',
    'mirage/packs/customer/pack.mjs',
    'mirage/lib/arbitrary-plugin.cs',
    'mirage/lib/plugin-clr-host.exe',
    'mirage/lib/Microsoft.Xrm.Sdk.dll',
  ]) {
    assert.throws(() => validateReleaseFiles([...required, { path: file }]), /Unexpected release file/);
  }
  assert.throws(() => validateReleaseFiles(required.slice(1)), /Required release file/);
  for (const requiredPath of [
    'mirage/lib/model-driven/icons.mjs',
    'mirage/lib/model-driven/control-descriptors.mjs',
    'mirage/lib/model-driven/providers.mjs',
    'mirage/lib/standalone-runtime.mjs',
    'mirage/docs/standalone-organization.md',
    'lense/model-driven-actions.mjs',
    'lense/model-driven-action-runner.mjs',
    'lense/model-driven-actions-ui.mjs',
    'lense/model-driven-identity.mjs',
    'lense/model-driven-commands.mjs',
    'docs/model-driven-actions.md',
    'lense/model-driven-panel.mjs',
    'lense/model-driven-native-comparison.mjs',
    'lense/model-driven-targets.mjs',
    'lense/owned-page-binding.mjs',
  ])
    assert.throws(
      () => validateReleaseFiles(required.filter((file) => file.path !== requiredPath)),
      /Required release file/,
    );
  for (const file of [
    'mirage/lib/model-driven/unreviewed.mjs',
    'mirage/lib/model-driven/reference.json',
    'mirage/lib/model-driven/screenshot.png',
  ])
    assert.throws(() => validateReleaseFiles([...required, { path: file }]), /Unexpected release file/);
  assert.throws(
    () => validateReleaseFiles([...required, { path: 'lense/LICENSE-unreviewed.txt' }]),
    /Unexpected release file/,
  );
  for (const file of [
    'examples/company-operations/.paqvilo/dataverse/connection.json',
    'examples/company-operations/.paqvilo/dataverse/remote-plan.json',
    'lense/dataverse/private-credential.json',
    'examples/company-operations/plugins/bin/QueryObservation.dll',
    'examples/company-operations/plugins/obj/assets.json',
    'examples/company-operations/forms/native-live-export.xml',
    'examples/company-operations/portal-security/actual-tester-overlay.json',
    'examples/company-operations/portal-harness/native-capture.json',
    'examples/company-operations/portal-harness/native-connection.mjs',
    'examples/company-operations/plugins/mirage-native-captures.json',
  ]) {
    assert.throws(() => validateReleaseFiles([...required, { path: file }]), /Unexpected release file/);
  }
});

test('the package names its GitHub repository, which npm provenance requires', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => checkPackageMetadata(pkg));
  for (const repository of [undefined, {}, { url: '' }, { url: 'https://example.com/repo' }])
    assert.throws(() => checkPackageMetadata({ repository }), /repository\.url/);
});

test('CI collects only synthetic outputs and ignores profile/token/live files and links', (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ci-evidence-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const write = (name, text) => {
    const file = path.join(state, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write('extended-round/multipart.json', '{"synthetic":true}');
  write('extended-round/private.session.json', 'PRIVATE');
  write('agents/session.json', 'PRIVATE');
  // An allowlisted name behind the linked folder below: only the link check keeps it out.
  write('agents/acceptance.json', 'PRIVATE');
  write('profiles/Default/Cookies', 'PRIVATE');
  write('audit/live.png', 'PRIVATE');
  write('extended-round/applications-layout-fixture.png', 'PROJECT-OWNED');
  write('workspace-poc/after.json', 'PROJECT-OWNED');
  fs.symlinkSync(
    path.join(state, 'agents'),
    path.join(state, 'multi-portal-round'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const result = collectSyntheticEvidence(state);
  assert.deepEqual(result.files, ['extended-round/multipart.json']);
  assert.deepEqual(fs.readdirSync(result.output).sort(), ['extended-round', 'manifest.json']);
  assert.equal(fs.readFileSync(path.join(result.output, result.files[0]), 'utf8'), '{"synthetic":true}');
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.output, 'manifest.json'), 'utf8')).synthetic, true);
});
