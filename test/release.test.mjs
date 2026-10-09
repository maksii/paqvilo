import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectSyntheticEvidence } from '../scripts/collect-evidence.mjs';
import { validateReleaseFiles, REQUIRED_RELEASE_FILES, checkPackageMetadata } from '../scripts/release-check.mjs';

test('release allowlist includes Mirage runtime and excludes tests, state, profiles and live evidence', () => {
  const required = REQUIRED_RELEASE_FILES.map((path) => ({ path }));
  assert.equal(validateReleaseFiles(required), required.length);
  for (const file of ['.env', '.paqvilo/agents/session.json', 'profiles/Default/Cookies', 'live.png', 'lense/../../secret.mjs', 'mirage/test/server.test.mjs', 'mirage/test-browser/admin.test.mjs', 'mirage/node_modules/liquidjs/index.js', 'mirage/.paqvilo/state.json', 'mirage/packs/customer/pack.mjs']) {
    assert.throws(() => validateReleaseFiles([...required, { path: file }]), /Unexpected release file/);
  }
  assert.throws(() => validateReleaseFiles(required.slice(1)), /Required release file/);
});

test('the package names its GitHub repository, which npm provenance requires', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => checkPackageMetadata(pkg));
  for (const repository of [undefined, {}, { url: '' }, { url: 'https://example.com/repo' }]) assert.throws(() => checkPackageMetadata({ repository }), /repository\.url/);
});

test('CI collects only synthetic outputs and ignores profile/token/live files and links', (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ci-evidence-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const write = (name, text) => { const file = path.join(state, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  write('extended-round/multipart.json', '{"synthetic":true}');
  write('extended-round/private.session.json', 'PRIVATE');
  write('agents/session.json', 'PRIVATE');
  write('profiles/Default/Cookies', 'PRIVATE');
  write('audit/live.png', 'PRIVATE');
  write('extended-round/applications-layout-fixture.png', 'PROJECT-OWNED');
  write('workspace-poc/after.json', 'PROJECT-OWNED');
  fs.symlinkSync(path.join(state, 'agents'), path.join(state, 'multi-portal-round'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = collectSyntheticEvidence(state);
  assert.deepEqual(result.files, ['extended-round/multipart.json']);
  assert.deepEqual(fs.readdirSync(result.output).sort(), ['extended-round', 'manifest.json']);
  assert.equal(fs.readFileSync(path.join(result.output, result.files[0]), 'utf8'), '{"synthetic":true}');
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.output, 'manifest.json'), 'utf8')).synthetic, true);
});
