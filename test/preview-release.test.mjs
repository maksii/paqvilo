import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { branchToken, previewRelease, releasePlan, stampVersion, verifyArchive } from '../scripts/release-version.mjs';
import { requestPreview } from '../scripts/preview-release.mjs';

const sha = 'abcdef0123456789abcdef0123456789abcdef01';
const version = '0.9.4';
const plan = () => previewRelease({ branch: 'codex/input-behavior-parity', version, sha, timestamp: 1700000000000 });

test('preview versions identify the commit and branch without occupying stable npm tags', () => {
  const preview = plan();
  assert.match(
    preview.version,
    /^0\.9\.4-preview\.codex-input-behavior-parity-[a-f0-9]{8}\.1700000000000\.gabcdef012345$/,
  );
  assert.equal(preview.tag, `v${preview.version}`);
  assert.match(preview.distTag, /^preview-codex-input-behavior-parity-/);
  assert.notEqual(branchToken('feature/a'), branchToken('feature-a'), 'slug collisions must not share a channel');
  assert.notEqual(branchToken('Feature'), branchToken('feature'));
  assert.ok(branchToken('a'.repeat(200)).length <= 41);
  assert.notEqual(
    preview.version,
    previewRelease({ branch: 'codex/input-behavior-parity', version, sha, timestamp: 1700000000001 }).version,
  );
  assert.equal(
    previewRelease({ branch: 'test', version: '0.9.4-rc.1', sha, timestamp: 1 }).version.split('-preview.')[0],
    version,
  );
  for (const branch of ['', '-option']) assert.throws(() => branchToken(branch), /A branch name is required/);
  for (const branch of ['a..b', 'a\nb', 'name.lock']) assert.throws(() => branchToken(branch), /git check-ref-format/);
  for (const invalid of ['01.2.3', '0.9.4-01', 'not-semver', '0.9.4\n'])
    assert.throws(() => previewRelease({ branch: 'test', version: invalid, sha }), /Invalid package version/);
});

test('stable and next releases retain main ancestry; only correctly bound previews accept other commits', () => {
  assert.equal(releasePlan({ tag: 'v0.9.4', version, sha, onMain: true }).distTag, 'latest');
  assert.equal(releasePlan({ tag: 'v0.9.4-rc.1', version: '0.9.4-rc.1', sha, onMain: true }).distTag, 'next');
  assert.throws(() => releasePlan({ tag: 'v0.9.4', version, sha, onMain: false }), /commit on main/);
  assert.throws(() => releasePlan({ tag: 'v0.9.5', version, sha, onMain: true }), /does not match/);
  assert.deepEqual(releasePlan({ tag: plan().tag, version, sha, onMain: false }), plan());
  assert.throws(
    () => releasePlan({ tag: plan().tag, version: '0.9.5', sha, onMain: false }),
    /base version and commit/,
  );
  assert.throws(
    () => releasePlan({ tag: plan().tag, version, sha: '0'.repeat(40), onMain: true }),
    /base version and commit/,
  );
  assert.throws(
    () => releasePlan({ tag: 'v0.9.4-preview.invalid', version: '0.9.4-preview.invalid', sha, onMain: true }),
    /preview format/,
  );
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paq-preview-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const documents = {
    'package.json': { name: 'paqvilo', version, dependencies: { invented: '1.0.0' }, custom: 'keep' },
    'package-lock.json': {
      name: 'paqvilo',
      version,
      lockfileVersion: 3,
      packages: {
        '': { name: 'paqvilo', version, dependencies: { invented: '1.0.0' } },
        'node_modules/invented': { version: '1.0.0', integrity: 'unchanged' },
      },
    },
  };
  documents['npm-shrinkwrap.json'] = structuredClone(documents['package-lock.json']);
  for (const [file, value] of Object.entries(documents)) fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
  return { dir, documents };
}

test('runner version stamping keeps package and both lockfiles consistent without changing dependencies', (t) => {
  const { dir, documents } = fixture(t);
  stampVersion(dir, plan().version);
  for (const [file, original] of Object.entries(documents)) {
    const expected = structuredClone(original);
    expected.version = plan().version;
    if (expected.packages) expected.packages[''].version = plan().version;
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, file))), expected);
  }
  assert.equal(
    fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'),
    fs.readFileSync(path.join(dir, 'npm-shrinkwrap.json'), 'utf8'),
  );
});

test('inconsistent lock metadata rejects stamping before any file is rewritten', (t) => {
  const { dir, documents } = fixture(t);
  documents['npm-shrinkwrap.json'].packages[''].version = '0.8.0';
  fs.writeFileSync(path.join(dir, 'npm-shrinkwrap.json'), JSON.stringify(documents['npm-shrinkwrap.json']));
  const before = Object.fromEntries(
    Object.keys(documents).map((file) => [file, fs.readFileSync(path.join(dir, file), 'utf8')]),
  );
  assert.throws(() => stampVersion(dir, plan().version), /Lockfile root version/);
  for (const [file, bytes] of Object.entries(before))
    assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), bytes);
});

test('publish verification rejects incorrectly named archives and mismatched packed versions', (t) => {
  const { dir } = fixture(t),
    packed = path.join(dir, 'package'),
    dist = path.join(dir, 'dist');
  fs.mkdirSync(packed);
  fs.mkdirSync(dist);
  for (const file of ['package.json', 'npm-shrinkwrap.json'])
    fs.copyFileSync(path.join(dir, file), path.join(packed, file));
  const archive = path.join(dist, `paqvilo-${version}.tgz`);
  execFileSync('tar', ['-czf', `dist/paqvilo-${version}.tgz`, 'package'], { cwd: dir, windowsHide: true });
  assert.equal(verifyArchive(dist, version), archive);
  assert.throws(() => verifyArchive(dist, plan().version), /gated package archive/);
  const wrong = JSON.parse(fs.readFileSync(path.join(packed, 'package.json')));
  wrong.version = '0.9.5';
  fs.writeFileSync(path.join(packed, 'package.json'), JSON.stringify(wrong));
  execFileSync('tar', ['-czf', `dist/paqvilo-${version}.tgz`, 'package'], { cwd: dir, windowsHide: true });
  assert.throws(() => verifyArchive(dist, version), /archive metadata/);
});

function fakeGh({ dispatchFails = false, oldWorkflow = false } = {}) {
  const calls = [];
  return {
    calls,
    runGh: (args) => {
      calls.push(args);
      if (args[1]?.includes('/git/ref/heads/')) return JSON.stringify({ object: { type: 'commit', sha } });
      if (args[1]?.includes('/contents/package.json'))
        return JSON.stringify({
          content: Buffer.from(JSON.stringify({ name: 'paqvilo', version })).toString('base64'),
        });
      if (args[1]?.includes('/contents/.github/workflows/release.yml'))
        return JSON.stringify({
          content: Buffer.from(
            oldWorkflow ? 'on: {}' : fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url)),
          ).toString('base64'),
        });
      if (args[0] === 'workflow' && dispatchFails) throw new Error('Dispatch unavailable');
      return '{}';
    },
  };
}

test('on-demand previews resolve remote source once, create an immutable tag and default to dry-run', () => {
  for (const publish of [false, true]) {
    const backend = fakeGh();
    const result = requestPreview({
      repo: 'invented/toolkit',
      branch: 'codex/input-behavior-parity',
      timestamp: 1700000000000,
      publish,
      runGh: backend.runGh,
    });
    assert.equal(result.dryRun, !publish);
    assert.ok(backend.calls[1][1].endsWith(`?ref=${sha}`), 'metadata must use the resolved SHA, not a moving branch');
    assert.deepEqual(backend.calls[3], [
      'api',
      'repos/invented/toolkit/git/refs',
      '--method',
      'POST',
      '-f',
      `ref=refs/tags/${result.tag}`,
      '-f',
      `sha=${sha}`,
    ]);
    assert.deepEqual(backend.calls[4], [
      'workflow',
      'run',
      'release.yml',
      '--repo',
      'invented/toolkit',
      '--ref',
      result.tag,
      '-f',
      `tag=${result.tag}`,
      '-f',
      `dry_run=${!publish}`,
    ]);
    assert.equal(result.install, `npm install --save-dev --save-exact paqvilo@${result.version}`);
  }
});

test('old branches are rejected before creating tags and dispatch failures provide an exact retry', () => {
  const old = fakeGh({ oldWorkflow: true });
  assert.throws(
    () => requestPreview({ repo: 'invented/toolkit', branch: 'test', runGh: old.runGh }),
    /merge or rebase/,
  );
  assert.equal(old.calls.length, 3);
  const failed = fakeGh({ dispatchFails: true });
  assert.throws(
    () => requestPreview({ repo: 'invented/toolkit', branch: 'test', timestamp: 1, runGh: failed.runGh }),
    (error) => error.message.includes('Created v0.9.4-preview.') && error.message.includes('-f dry_run=true'),
  );
  assert.equal(failed.calls.length, 5, 'a failed dispatch must not overwrite or delete its tag');
});

test('release workflows gate the preview metadata and publish only the tested archive', () => {
  const release = parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const ci = parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.ok(release.on.push.tags.includes('!v*-preview.*'));
  assert.equal(release.on.workflow_dispatch.inputs.dry_run.default, true);
  assert.deepEqual(release.jobs.publish.needs, ['plan', 'ci']);
  assert.equal(release.jobs.publish.environment.name, 'npm');
  assert.ok(release.jobs.publish.steps.some((step) => step.uses?.startsWith('actions/download-artifact@')));
  assert.ok(
    !release.jobs.publish.steps.some((step) => step.run?.includes('npm pack')),
    'publishing must reuse the CI archive',
  );
  const githubRelease = release.jobs.publish.steps.find((step) => step.name === 'Create stable GitHub release');
  assert.ok(githubRelease.if.includes("env.PREVIEW != 'true'"));
  assert.equal(release.jobs.ci.uses, './.github/workflows/ci.yml');
  assert.equal(release.jobs.ci.with.full, true, 'releases must require every suite');
  assert.equal(release.jobs.ci.with.ref, '${{ needs.plan.outputs.sha }}');
  assert.equal(
    release.jobs.ci.with.package_version,
    "${{ needs.plan.outputs.preview == 'true' && needs.plan.outputs.version || '' }}",
  );
  for (const name of ['checks', 'test', 'browser', 'windows', 'package']) {
    const steps = ci.jobs[name].steps;
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, '${{ inputs.ref || github.sha }}', name);
    const stamp = steps.findIndex((step) => step.run === 'node scripts/release-version.mjs stamp');
    const prepare = steps.findIndex((step) => /^npm (?:ci|run ci:prepare)\b/.test(step.run ?? ''));
    assert.ok(stamp >= 0 && prepare > stamp, name + ' must stamp before dependency preparation');
    assert.equal(steps[stamp].if, "inputs.package_version != ''", name);
    assert.equal(steps[stamp].env.PACKAGE_VERSION, '${{ inputs.package_version }}', name);
    if (['test', 'browser', 'windows'].includes(name)) {
      const mode = name === 'browser' ? '--browser' : '--unit';
      assert.ok(steps[prepare].run.startsWith('npm run ci:prepare -- --suite ${{ matrix.suite }} ' + mode));
      const verify = steps.findIndex((step) =>
        step.run?.startsWith('npm run ci:verify -- --suite ${{ matrix.suite }} ' + mode + ' --prepared'),
      );
      assert.ok(verify > prepare, name + ' must validate the prepared, stamped suite');
      const lanes = name === 'browser' ? 'browsers' : 'units';
      assert.equal(ci.jobs[name].strategy.matrix.include, `\${{ fromJSON(needs.changes.outputs.${lanes}) }}`);
    }
  }
});
