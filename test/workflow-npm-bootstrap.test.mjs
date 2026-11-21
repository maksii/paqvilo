// @test-kind tooling: hosted Node setup cannot invoke a bundled npm cache probe before the strict pinned npm bootstrap, and every existing cache remains active afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import YAML from 'yaml';

const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const version = manifest.packageManager.replace(/^npm@/, '');
const pairedLocks = ['paqvilo-lock.json', 'mirage/package-lock.json'];
const cachedJobs = {
  'ci.checks': pairedLocks,
  'ci.test': pairedLocks,
  'ci.browser': pairedLocks,
  'ci.windows': pairedLocks,
  'ci.sdk-linux': ['package-lock.json'],
  'ci.package': pairedLocks,
  'pages.build': ['package-lock.json'],
  'release.plan': ['package-lock.json'],
  'release.publish': ['package-lock.json'],
  'sonarqube.coverage': pairedLocks,
  'sonarqube.analysis': ['paqvilo-lock.json'],
};

function validateBootstrap(steps, label, locks) {
  const setups = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.uses?.startsWith('actions/setup-node@'));
  if (!setups.length) return { initial: 0, caches: 0 };
  const initial = setups.filter(({ step }) => step.with?.['node-version'] || step.with?.['node-version-file']);
  assert.equal(initial.length, 1, `${label}: set up Node once; cache restoration must not reset its PATH`);
  const setup = initial[0];
  assert.equal(setup.step.with['node-version-file'], '.node-version');
  assert.equal(
    setup.step.with['package-manager-cache'],
    false,
    `${label}: automatic npm cache probes must be disabled before the pinned bootstrap`,
  );
  assert.equal(setup.step.with.cache, undefined, `${label}: explicit cache probes also run before setup completes`);
  const pin = steps.findIndex((step) => step.name === 'Install the pinned npm version');
  const caches = setups.filter(({ index }) => index !== setup.index);
  if (pin < 0) {
    assert.equal(caches.length, 0, `${label}: a built-in-only job must not invoke npm cache probes`);
    assert.equal(locks, undefined);
    return { initial: 1, caches: 0 };
  }
  assert.ok(setup.index < pin, `${label}: select Node before bootstrapping npm`);
  assert.equal(steps[pin]['working-directory'], '${{ runner.temp }}', `${label}: bundled npm runs outside devEngines`);
  assert.ok(
    steps[pin].run.includes(`npm install --global ${manifest.packageManager} --ignore-scripts --no-audit --no-fund`),
  );
  assert.ok(
    steps[pin].run.includes(`test "$(npm --version)" = "${version}"`),
    `${label}: verify the active npm version`,
  );
  assert.equal(caches.length, 1, `${label}: preserve the npm cache after its pinned bootstrap`);
  assert.ok(pin < caches[0].index, `${label}: install the pinned npm before any cache probe`);
  assert.equal(caches[0].step.uses, setup.step.uses, `${label}: preserve the pinned vendor cache implementation`);
  assert.deepEqual(
    Object.keys(caches[0].step.with).sort(),
    ['cache', 'cache-dependency-path'],
    `${label}: cache-only setup must not reinstall Node or alter registry authentication`,
  );
  assert.equal(caches[0].step.with.cache, 'npm');
  assert.deepEqual(
    caches[0].step.with['cache-dependency-path'].trim().split(/\r?\n/),
    locks,
    `${label}: preserve every tracked lockfile input, including previously automatic caches`,
  );
  return { initial: 1, caches: 1 };
}

test('every hosted Node bootstrap installs strict npm before restoring all existing npm caches', () => {
  const directory = new URL('../.github/workflows/', import.meta.url);
  const visited = [];
  let initial = 0;
  let caches = 0;
  assert.equal(manifest.devEngines.packageManager.version, version);
  assert.equal(manifest.devEngines.packageManager.onFail, 'error');
  for (const file of fs.readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))) {
    const workflow = YAML.parse(fs.readFileSync(new URL(file, directory), 'utf8'));
    for (const [job, definition] of Object.entries(workflow.jobs)) {
      const label = `${file.replace(/\.ya?ml$/, '')}.${job}`;
      const result = validateBootstrap(definition.steps ?? [], label, cachedJobs[label]);
      initial += result.initial;
      caches += result.caches;
      if (result.caches) visited.push(label);
    }
  }
  assert.equal(initial, 12, 'every Node-installing job is covered, including the built-in-only changes job');
  assert.equal(caches, 11, 'seven explicit and four formerly automatic npm caches remain active');
  assert.deepEqual(visited.sort(), Object.keys(cachedJobs).sort());
});

function fixture() {
  const action = 'actions/setup-node@invented-pinned-reference';
  return [
    { uses: action, with: { 'node-version-file': '.node-version', 'package-manager-cache': false } },
    {
      name: 'Install the pinned npm version',
      'working-directory': '${{ runner.temp }}',
      run: `npm install --global ${manifest.packageManager} --ignore-scripts --no-audit --no-fund\ntest "$(npm --version)" = "${version}"`,
    },
    { uses: action, with: { cache: 'npm', 'cache-dependency-path': 'package-lock.json' } },
  ];
}

test('a bundled npm cache probe is rejected whether enabled explicitly or automatically', () => {
  const automatic = fixture();
  delete automatic[0].with['package-manager-cache'];
  assert.throws(() => validateBootstrap(automatic, 'automatic', ['package-lock.json']), /automatic npm cache probes/);
  const explicit = fixture();
  explicit[0].with.cache = 'npm';
  assert.throws(() => validateBootstrap(explicit, 'explicit', ['package-lock.json']), /explicit cache probes/);
});

test('cache restoration before npm installation and a second Node PATH reset are rejected', () => {
  const early = fixture();
  [early[1], early[2]] = [early[2], early[1]];
  assert.throws(() => validateBootstrap(early, 'early', ['package-lock.json']), /before any cache probe/);
  const reset = fixture();
  reset[2].with['node-version-file'] = '.node-version';
  assert.throws(() => validateBootstrap(reset, 'reset', ['package-lock.json']), /set up Node once/);
});

test('fixing bootstrap order cannot remove caches or their original lockfile selectors', () => {
  const missing = fixture().slice(0, 2);
  assert.throws(() => validateBootstrap(missing, 'missing', ['package-lock.json']), /preserve the npm cache/);
  const narrowed = fixture();
  assert.throws(() => validateBootstrap(narrowed, 'narrowed', pairedLocks), /preserve every tracked lockfile input/);
  const projectCwd = fixture();
  projectCwd[1]['working-directory'] = '${{ github.workspace }}';
  assert.throws(() => validateBootstrap(projectCwd, 'project-cwd', ['package-lock.json']), /outside devEngines/);
});
