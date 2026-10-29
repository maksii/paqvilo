import fs from 'node:fs';
import path from 'node:path';
import { availableParallelism, tmpdir, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { classifyChanges, suitesForScope } from '../.github/scripts/change-scope.mjs';
import { dependencyReadiness, browserExecutable } from './ensure-dependencies.mjs';
import { downloadVerifiedArchive } from './verified-download.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK_VERSION = '9.0.2.60';
const SDK_SHA256 = '59650574cdc89c1f506fabd7275fe6325a59a8bae9fa9f92c5b5c2cbe31d5e1f';
// SHA-256 of lib/net462/Microsoft.Xrm.Sdk.dll inside that verified public archive.
const SDK_DLL_SHA256 = 'f696eaeb1145bce9f517d0b8fa5e925d0216176919af8d417dcd439acb1797f9';
const defaults = { cwd: root, stdio: 'inherit', windowsHide: true };
const seconds = (start) => `${((performance.now() - start) / 1000).toFixed(1)} s`;
function execute(command, args, options = {}) {
  const start = performance.now();
  const result = spawnSync(command, args, { ...defaults, ...options });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.error?.message}).`, {
      cause: result.error,
    });
  console.log(`[ci] ${path.basename(command)} ${args.join(' ')} (${seconds(start)})`);
  return result;
}
const npmCli = () =>
  process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
function npm(args) {
  const cli = npmCli();
  if (!fs.existsSync(cli)) throw new Error('Run CI commands through npm run ci:prepare or npm run ci:verify.');
  execute(process.execPath, [cli, ...args]);
}
function npmScript(script) {
  npm(['run', script]);
}
function environment(name, value) {
  process.env[name] = value;
  if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`);
}
export function verifyClrSdk(sdk) {
  if (createHash('sha256').update(fs.readFileSync(sdk)).digest('hex') !== SDK_DLL_SHA256)
    throw new Error('CLR SDK fixture DLL digest mismatch; run ci:prepare to restore the verified public fixture.');
}

/**
 * True when `actual` is the pinned SDK or a later patch of its feature band (10.0.1xx), the servicing updates
 * global.json's latestPatch roll-forward accepts. A different band, major or minor is a different compiler.
 */
export function dotnetSatisfies(expected, actual) {
  const parse = (version) => /^(\d+)\.(\d+)\.(\d)(\d{2})$/.exec(version)?.slice(1).map(Number);
  const [want, have] = [parse(expected), parse(actual)];
  if (!want || !have) return false;
  return want.slice(0, 3).every((part, index) => part === have[index]) && have[3] >= want[3];
}

function requireDotnet() {
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'global.json'), 'utf8')).sdk.version;
  const version = spawnSync('dotnet', ['--version'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (version.status !== 0 || !dotnetSatisfies(expected, version.stdout.trim()))
    throw new Error(
      `Incomplete CI validation: .NET SDK ${expected} or a later ${expected.replace(/\d{2}$/, 'xx')} patch is required; install it as global.json specifies.`,
    );
}

async function clrFixture() {
  const directory = path.join(root, '.paqvilo/ci/sdk-reference');
  const sdk = path.join(directory, 'reference/lib/net462/Microsoft.Xrm.Sdk.dll');
  // Re-verify the archive even on a warm local run; the fixture is never taken from a portal export.
  fs.mkdirSync(directory, { recursive: true });
  const archive = path.join(directory, 'sdk.zip');
  if (!fs.existsSync(archive)) {
    await downloadVerifiedArchive(
      `https://api.nuget.org/v3-flatcontainer/microsoft.crmsdk.coreassemblies/${SDK_VERSION}/microsoft.crmsdk.coreassemblies.${SDK_VERSION}.nupkg`,
      archive,
      SDK_SHA256,
    );
  }
  if (createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== SDK_SHA256)
    throw new Error('SDK fixture archive digest mismatch.');
  let validSdk = false;
  try {
    verifyClrSdk(sdk);
    validSdk = true;
  } catch {
    /* Re-extract a missing or changed DLL from the verified archive. */
  }
  if (!validSdk) {
    // Expand-Archive requires .zip; all arguments are fixed paths under this checkout.
    execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath $env:PAQVILO_CI_ARCHIVE -DestinationPath $env:PAQVILO_CI_DESTINATION -Force',
      ],
      {
        env: { ...process.env, PAQVILO_CI_ARCHIVE: archive, PAQVILO_CI_DESTINATION: path.join(directory, 'reference') },
      },
    );
  }
  if (!fs.existsSync(sdk)) throw new Error('CLR SDK fixture extraction did not produce Microsoft.Xrm.Sdk.dll.');
  verifyClrSdk(sdk);
  environment('PAQ_TEST_XRM_SDK', sdk);
}

// Public MIT-licensed exports for the ecosystem import checks in this suite file, pinned by
// commit and archive digest. Only the listed subtrees are extracted.
const ECOSYSTEM_TEST = 'test/short-key-fixtures.test.mjs';
const ECOSYSTEM = [
  [
    'microsoft/power-pages-samples',
    'da7f1bc128c11ff11c23fc814be4a2b10cfd82ef',
    '4dcb914b21b89dc8a543b217564c6a2347eea9c1e399685f1aafc4642f1ff172',
    ['samples', 'templates'],
  ],
  [
    'microsoft/gov-apptemplates',
    '64dabc2652a13a2423ee3fb1d6f4bfe8f33fe1d9',
    '5b2e3dc640d17f371fd3ba63e3d2220b5619d46c5b5a722eeb9fbd677f9025b7',
    ['portals/core-portal'],
  ],
  [
    'microsoft/contoso-real-estate-power-platform',
    'dbd5f76d8098d838f8cbdd050134ea6094b68cf5',
    'af122e203c50a194e83e625b3d82e7bf503d4f0cf3da7aaeeb54adf43a723649',
    ['src/portal/solution/ContosoRealEstatePortal/src'],
  ],
  [
    '365Evergreen/WorkmateProSWA',
    '6e83e55120638992684bb74bd2000cac14326dc6',
    'fa82507f2b321b2694fde63c9e836aa6e82d5972ca2cb0f3a5490bad1f6cbdb4',
    ['dataverse/hired-schemas/HiRedAUstartersolution'],
  ],
  [
    'tonipohl/PowerPagesCodeMagazine',
    '2fe359cc37ad546aead7437942b222ce9e697e8f',
    '4094027be41fb4bf5f71e771e2af38fb4889e92a2a1e88dbcdf330c7f86ae047',
    ['ContosoCoursesRegistrationSite_1_0_0_0'],
  ],
];
const ecosystemRoot = () => path.join(root, '.paqvilo/ci/ecosystem');
// Windows ships bsdtar in System32; another tar earlier on PATH (such as MSYS) misreads drive paths.
const tar = () =>
  process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

async function ecosystemFixtures() {
  const directory = ecosystemRoot();
  fs.mkdirSync(directory, { recursive: true });
  for (const [repository, commit, digest, members] of ECOSYSTEM) {
    const name = repository.replace('/', '__');
    const archive = path.join(directory, name + '.tar.gz');
    // A persistent runner keeps the archive; a changed pin replaces it.
    if (fs.existsSync(archive) && createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== digest)
      fs.rmSync(archive);
    if (!fs.existsSync(archive))
      await downloadVerifiedArchive(`https://codeload.github.com/${repository}/tar.gz/${commit}`, archive, digest, {
        maxBytes: 256 * 1024 * 1024,
      });
    // Extract afresh from the verified archive so no earlier run's edits survive.
    const target = path.join(directory, name);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target);
    const prefix = `${repository.split('/')[1]}-${commit}/`;
    execute(tar(), [
      '-xzf',
      archive,
      '-C',
      target,
      '--strip-components=1',
      ...members.map((member) => prefix + member),
    ]);
  }
}

function requireEcosystemFixtures() {
  for (const [repository, , , members] of ECOSYSTEM)
    for (const member of members)
      if (!fs.existsSync(path.join(ecosystemRoot(), repository.replace('/', '__'), member)))
        throw new Error('Incomplete CI validation: public ecosystem fixtures missing; run ci:prepare.');
  // Not a PAQVILO_ name: the toolkit rejects unknown PAQVILO_ settings in every spawned CLI.
  environment('PAQ_TEST_ECOSYSTEM_FIXTURES', ecosystemRoot());
}

// Shards partition a package's `node --test [flags] <glob>` script by sorted file index, as node:test does.
function packageTests(directory, script) {
  const command = JSON.parse(fs.readFileSync(path.join(root, directory, 'package.json'), 'utf8')).scripts[script];
  const words = command.split(' ');
  const flags = words.slice(2, -1);
  if (words[0] !== 'node' || words[1] !== '--test' || flags.some((flag) => !flag.startsWith('--')))
    throw new Error(`Cannot shard the ${directory || 'root'} ${script} script.`);
  return { flags, files: fs.globSync(words.at(-1), { cwd: path.join(root, directory) }).sort() };
}

export function shardFiles(files, shard) {
  const [index, total] = shard.split('/').map(Number);
  return files.filter((_, position) => position % total === index - 1);
}

function runPackageTests(directory, script, shard) {
  if (!shard) return npm([...(directory ? ['--prefix', directory] : []), 'run', script]);
  const { flags, files } = packageTests(directory, script);
  execute(process.execPath, ['--test', ...flags, ...shardFiles(files, shard)], { cwd: path.join(root, directory) });
}

const needsEcosystem = (suite, unit, shard) =>
  unit &&
  ['mirage', 'all'].includes(suite) &&
  (!shard || shardFiles(packageTests('mirage', 'test').files, shard).includes(path.normalize(ECOSYSTEM_TEST)));

export function requiresClrFixture(suite, platform = process.platform) {
  return platform === 'win32' && ['mirage', 'examples', 'all'].includes(suite);
}

export function resetExampleModules(checkout = root) {
  const owner = fs.realpathSync(checkout);
  const project = fs.realpathSync(path.join(checkout, 'examples/project'));
  const relative = path.relative(owner, project);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new Error('Example dependency directory escaped the owned checkout.');
  const modules = path.join(project, 'node_modules');
  let entry;
  try {
    entry = fs.lstatSync(modules);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (entry.isSymbolicLink()) fs.unlinkSync(modules);
  else fs.rmSync(modules, { recursive: true, force: true });
}

export function requireExampleBrowserDependency(project, checkout = root) {
  const lock = JSON.parse(fs.readFileSync(path.join(checkout, 'npm-shrinkwrap.json'), 'utf8'));
  // Probe in a fresh process, as the suite does: Node caches resolutions across fixture cleanup.
  const resolved = spawnSync(process.execPath, ['-p', "require('playwright-core/package.json').version"], {
    cwd: path.join(checkout, project),
    encoding: 'utf8',
    windowsHide: true,
  });
  const actual = resolved.status === 0 ? resolved.stdout.trim() : null;
  const expected = lock.packages?.['node_modules/playwright-core']?.version;
  if (!actual || !expected || actual !== expected)
    throw new Error(
      'Incomplete example validation: resolved Playwright differs from the toolkit lockfile; run ci:prepare.',
    );
}

export async function prepareLane(
  suite,
  { browser = false, unit = true, quality = false, sdk = false, shard = null } = {},
) {
  if (!['lense', 'mirage', 'examples', 'all', 'quality', 'sdk'].includes(suite))
    throw new Error(`Unknown CI suite: ${suite}`);
  if (!['lense', 'quality'].includes(suite)) requireDotnet();
  quality ||= suite === 'quality';
  npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  npm(['ci', '--prefix', 'mirage', '--ignore-scripts', '--no-audit', '--no-fund']);
  if (suite === 'mirage' || suite === 'all' || quality || sdk) {
    npm(['ci', '--prefix', 'mirage/test-sdk/tds', '--ignore-scripts', '--no-audit', '--no-fund']);
  }
  if (requiresClrFixture(suite)) await clrFixture();
  if (needsEcosystem(suite, unit, shard)) await ecosystemFixtures();
  if (suite === 'all' || quality || sdk) {
    for (const project of ['mirage/test-sdk/dynamics-web-api', 'mirage/test-sdk/cert-auth'])
      npm(['ci', '--prefix', project, '--ignore-scripts', '--no-audit', '--no-fund']);
  }
  if (suite === 'examples' || suite === 'all' || quality) {
    resetExampleModules();
    // This example intentionally has no lockfile. Exact direct pins still need
    // packuments: root npm ci may have cached only their tarballs. Preparation
    // may fetch that metadata; test:example verifies the prepared cache offline.
    npm([
      'install',
      '--prefix',
      'examples/project',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--install-links=false',
    ]);
    npm([
      'ci',
      '--prefix',
      'examples/company-operations',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--install-links=false',
    ]);
    if (process.platform === 'win32' && ['examples', 'all'].includes(suite)) {
      execute('dotnet', [
        'restore',
        'examples/company-operations/plugins/SdkProbes/SdkProbes.csproj',
        '--locked-mode',
        '--disable-build-servers',
      ]);
      // Compile once here: a cold MSBuild run inside the test budget times out on loaded runners.
      execute('dotnet', [
        'build',
        'examples/company-operations/plugins/SdkProbes/SdkProbes.csproj',
        '--no-restore',
        '--configuration',
        'Release',
        '--disable-build-servers',
      ]);
    }
  }
  if (browser) installChromium();
  if (sdk || suite === 'all' || suite === 'sdk') {
    const { prepareSdkFixtures } = await import('./sdk-preparation.mjs');
    await prepareSdkFixtures({ root, execute });
  }
}

// System libraries need root. Use passwordless sudo when available (GitHub-hosted Linux);
// otherwise the runner must already provide them (CONTRIBUTING.md) and a launch reports what is missing.
export function chromiumInstallArguments(platform = process.platform, canInstallSystemDependencies = rootAvailable) {
  return [
    'node_modules/playwright-core/cli.js',
    'install',
    ...(platform === 'linux' && canInstallSystemDependencies() ? ['--with-deps'] : []),
    'chromium',
  ];
}
function rootAvailable() {
  if (process.getuid?.() === 0) return true;
  return spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore', timeout: 10_000 }).status === 0;
}
function installChromium() {
  execute(process.execPath, chromiumInstallArguments());
}

function requireSdkClients() {
  for (const project of ['mirage/test-sdk/tds', 'mirage/test-sdk/dynamics-web-api', 'mirage/test-sdk/cert-auth']) {
    const directory = path.join(root, project);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8'));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const installed = path.join(directory, 'node_modules', name, 'package.json');
      if (
        !fs.existsSync(installed) ||
        JSON.parse(fs.readFileSync(installed, 'utf8')).version !== lock.packages?.['node_modules/' + name]?.version
      )
        throw new Error('Incomplete quality validation: install the locked SDK clients with ci:prepare --quality.');
    }
  }
}

function requireQualityDependencies() {
  requireSdkClients();
  for (const project of ['examples/project', 'examples/company-operations']) {
    const dependency = path.join(root, project, 'node_modules/paqvilo');
    if (!fs.existsSync(path.join(dependency, 'package.json')) || fs.realpathSync(dependency) !== fs.realpathSync(root))
      throw new Error(
        'Incomplete quality validation: fixture self-imports must link this checkout; run ci:prepare --quality.',
      );
    requireExampleBrowserDependency(project);
  }
}

function requireFixtures(suite, { unit = true, browser = true, shard = null } = {}) {
  if (suite !== 'lense') requireDotnet();
  if (suite === 'mirage') {
    if (unit) environment('PAQ_TEST_REQUIRE_TLS_TOOLS', '1');
    if (!fs.existsSync(path.join(root, 'mirage/test-sdk/tds/node_modules/tedious/lib/tedious.js')))
      throw new Error('Incomplete CI validation: install the locked TDS fixture with ci:prepare.');
  }
  if (needsEcosystem(suite, unit, shard)) requireEcosystemFixtures();
  if (requiresClrFixture(suite)) {
    const sdk =
      process.env.PAQ_TEST_XRM_SDK ||
      path.join(root, '.paqvilo/ci/sdk-reference/reference/lib/net462/Microsoft.Xrm.Sdk.dll');
    if (!fs.existsSync(sdk)) throw new Error('Incomplete CI validation: CLR SDK fixture missing; run ci:prepare.');
    verifyClrSdk(sdk);
    environment('PAQ_TEST_XRM_SDK', sdk);
  }
  if (suite === 'examples') {
    for (const project of ['examples/project', 'examples/company-operations']) {
      const dependency = path.join(root, project, 'node_modules/paqvilo');
      if (
        !fs.existsSync(path.join(dependency, 'package.json')) ||
        fs.realpathSync(dependency) !== fs.realpathSync(root)
      )
        throw new Error(`Incomplete CI validation: ${project} must link to this checkout; run ci:prepare.`);
      requireExampleBrowserDependency(project);
    }
    if (unitPlatformNeedsSdk()) {
      if (
        !fs.existsSync(
          path.join(root, 'examples/company-operations/plugins/SdkProbes/bin/Release/net462/SdkProbes.exe'),
        )
      )
        throw new Error('Incomplete CI validation: SDK projection driver build missing; run ci:prepare.');
    }
  }
  if (browser) environment('PAQVILO_BROWSER', ciBrowser());
}

/** Recheck mutable prerequisites before reusing evidence for an otherwise identical source tree. */
export async function verificationFixturesReady(
  scope,
  suites,
  { unit = true, browser = true, shard = null, quality = true, platform = process.platform } = {},
  checks = {},
) {
  try {
    if (quality && scope.quality) (checks.quality ?? requireQualityDependencies)();
    for (const selected of suites) (checks.suite ?? requireFixtures)(selected, { unit, browser, shard });
    if (unit && suites.includes('mirage')) {
      const requireTls =
        checks.tls ??
        (async () => {
          const { tlsTools } = await import('../mirage/test/tls-tools-fixture.mjs');
          tlsTools({ required: true });
        });
      await requireTls();
    }
    if (fullSdkGate(scope, platform)) {
      const requireSdk =
        checks.sdk ??
        (async () => {
          const { requireSdkFixtures } = await import('./sdk-preparation.mjs');
          requireSdkFixtures(root);
        });
      await requireSdk();
    }
    return true;
  } catch {
    return false; // A missing or modified fixture requires preparation and fresh verification.
  }
}

export function ciBrowser(env = process.env, platform = process.platform) {
  const channel = env.PAQ_CI_BROWSER || 'chromium';
  if (!['chromium', 'msedge'].includes(channel) || (channel === 'msedge' && platform !== 'win32'))
    throw new Error('PAQ_CI_BROWSER must select chromium, or msedge on Windows.');
  return channel;
}

/** Local validation covers every hosted browser lane of its platform: Windows runs both Chromium and Edge. */
export const localBrowserChannels = (platform = process.platform) =>
  platform === 'win32' ? ['chromium', 'msedge'] : ['chromium'];

/**
 * Hosted Windows runners expose TEMP through an 8.3 alias (C:\Users\RUNNER~1\...), so os.tmpdir() differs from its
 * real path there. Local Windows validation runs under the short alias of a long-named directory to reproduce that;
 * a volume without 8.3 names keeps the long path.
 */
export function runnerTemporaryDirectory({ platform = process.platform, env = process.env, base = tmpdir() } = {}) {
  if (platform !== 'win32' || env.GITHUB_ACTIONS === 'true') return null;
  const directory = path.join(base, 'paqvilo-validation-temporary');
  fs.mkdirSync(directory, { recursive: true });
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:PAQ_CI_TEMPORARY).ShortPath',
    ],
    { env: { ...process.env, PAQ_CI_TEMPORARY: directory }, encoding: 'utf8', windowsHide: true },
  );
  const short = result.status === 0 ? result.stdout.trim() : '';
  return short || directory;
}

export function fullSdkGate(scope, platform = process.platform) {
  return Boolean(scope.full || scope.sdk) && ['win32', 'linux'].includes(platform);
}

async function verifySdkGates() {
  requireDotnet();
  requireSdkClients();
  const { requireSdkFixtures, auditServiceClientDependencies } = await import('./sdk-preparation.mjs');
  await requireSdkFixtures(root);
  environment('PAQ_TEST_REQUIRE_SDK_GATES', '1');
  execute('dotnet', ['restore', 'mirage/test-sdk/cert-auth/Gate/Gate.csproj', '--locked-mode']);
  for (const project of ['tds', 'dynamics-web-api', 'cert-auth'])
    npm(['--prefix', 'mirage/test-sdk/' + project, 'test']);
  execute('dotnet', ['restore', 'mirage/test-sdk/serviceclient/Gate/Gate.csproj', '--locked-mode']);
  await auditServiceClientDependencies({ root, execute });
  execute(process.execPath, ['--test', '--test-timeout=600000', 'mirage/test-sdk/serviceclient/gate.test.mjs'], {
    env: { ...process.env, PAQ_TEST_REQUIRE_SDK_GATES: '1' },
  });
  execute(
    process.execPath,
    [
      '--test',
      '--test-timeout=600000',
      'mirage/test-sdk/python-dataverse/gate.test.mjs',
      'mirage/test-sdk/webapi-samples/gate.test.mjs',
    ],
    {
      env: { ...process.env, PAQ_TEST_REQUIRE_SDK_GATES: '1' },
    },
  );
  // The shipped verify-storage check: 600,000 rows past the engine string limit, about 1 GiB of temporary disk.
  execute(process.execPath, ['--expose-gc', '--max-old-space-size=4096', 'mirage/test-volume/state-storage.mjs']);
}

const unitPlatformNeedsSdk = () => process.platform === 'win32';

export function verifyLane(suite, { unit = true, browser = true, shard = null } = {}) {
  requireFixtures(suite, { unit, browser, shard });
  if (unit) {
    if (suite === 'lense') runPackageTests('', 'test', shard);
    if (suite === 'mirage') {
      runPackageTests('mirage', 'test', shard);
      // In-process gates without extra installs: size ratios, never absolute times, and the toolkit's own client.
      // A sharded lane runs them once, beside the first shard.
      if (!shard || shard.startsWith('1/'))
        execute(process.execPath, [
          '--test',
          'mirage/test-volume/write-volume.test.mjs',
          'mirage/test-sdk/toolkit-client/gate.test.mjs',
        ]);
    }
    if (suite === 'examples') {
      npmScript('test:example');
      npmScript('test:company');
      if (process.platform === 'win32') {
        for (const project of ['Tests', 'QueryObservation', 'PipelineTests']) {
          const file = `examples/company-operations/plugins/${project}/${project}.csproj`;
          execute('dotnet', ['restore', file, '--locked-mode']);
          execute('dotnet', ['build', file, '--no-restore', '-c', 'Release']);
          if (project === 'Tests')
            execute(path.join(root, 'examples/company-operations/plugins/Tests/bin/Release/net462/Tests.exe'), []);
        }
      }
    }
  }
  if (browser) {
    if (suite === 'lense') runPackageTests('', 'test:browser', shard);
    if (suite === 'mirage') runPackageTests('mirage', 'test:browser', shard);
    if (suite === 'examples') {
      npmScript('test:example:browser');
      npmScript('test:company:browser');
    }
  }
}

/**
 * The independent steps of a scoped or full run, longest first so a parallel run ends on short steps. Each lane is
 * its own `ci.mjs verify --suite` process, so it runs exactly as the matching hosted job does.
 */
export function validationSteps(
  scope,
  suites,
  { unit = true, browser = true, changed = [], repeat = 0, env = process.env } = {},
  platform = process.platform,
) {
  const npmRun = (script) => [npmCli(), 'run', script];
  const verify = (suite, kind, channel = 'chromium') => ({
    args: ['scripts/ci.mjs', 'verify', '--suite', suite, ...(kind ? [`--${kind}`] : []), '--prepared'],
    env: { PAQ_CI_BROWSER: channel },
  });
  const channels = browser ? localBrowserChannels(platform) : [];
  const steps = [];
  // The Security workflow's CodeQL analysis, the longest step, so a parallel run starts it first.
  if (scope.codeql && env.GITHUB_ACTIONS !== 'true')
    steps.push({ label: 'codeql', commands: [['scripts/codeql.mjs']] });
  for (const suite of ['mirage', 'lense'].filter((suite) => suites.includes(suite))) {
    if (unit)
      steps.push({
        label: `${suite} unit`,
        commands: [verify(suite, 'unit'), ...changedTests(changed, repeat, suite)],
      });
    for (const channel of channels)
      steps.push({
        label: channel === 'chromium' ? `${suite} browser` : `${suite} browser ${channel}`,
        commands: [
          verify(suite, 'browser', channel),
          ...(channel === 'chromium' ? changedTests(changed, repeat, suite, true) : []),
        ],
      });
  }
  // Example unit and browser tests share one installed project, so they stay in one ordered step.
  if (suites.includes('examples'))
    steps.push({
      label: unit && browser ? 'examples' : unit ? 'examples unit' : 'examples browser',
      commands: [
        verify('examples', unit && browser ? null : unit ? 'unit' : 'browser'),
        ...channels.slice(1).map((channel) => verify('examples', 'browser', channel)),
      ],
    });
  if (fullSdkGate(scope, platform)) steps.push({ label: 'sdk gates', commands: [['scripts/ci.mjs', 'sdk']] });
  // Hosted runners start from a lockfile-keyed npm cache; a contributor's warm cache would hide a missing prime.
  if (scope.smoke)
    steps.push({
      label: 'package smoke',
      env: { npm_config_cache: path.join(root, '.paqvilo', 'ci', 'npm-cache-smoke') },
      commands: [
        ['-e', "require('node:fs').rmSync(process.env.npm_config_cache, { recursive: true, force: true })"],
        npmRun('cache:package'),
        npmRun('release:smoke'),
      ],
    });
  if (scope.quality) {
    const parts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
      .scripts.quality.split('&&')
      .map((part) => /^npm run (\S+)$/.exec(part.trim())?.[1]);
    if (!parts.every(Boolean)) throw new Error('The quality script must be a chain of `npm run <script>` steps.');
    for (const part of parts) steps.push({ label: part, commands: [npmRun(part)] });
  }
  if (scope.runtime) steps.push({ label: 'check', commands: [npmRun('check')] });
  if (scope.package) steps.push({ label: 'release:check', commands: [npmRun('release:check')] });
  if (scope.site) steps.push({ label: 'site:build', commands: [npmRun('site:build')] });
  return steps;
}

/**
 * Changed test files of one package script, rerun `repeat` more times after their lane passes, so a timing-dependent
 * test fails locally before the hosted matrix runs it on slower runners.
 */
export function changedTests(changed, repeat, suite, browser = false) {
  if (!repeat) return [];
  const directory = suite === 'mirage' ? 'mirage' : '';
  const { flags, files } = packageTests(directory, browser ? 'test:browser' : 'test');
  const selected = files.filter((file) => changed.includes(path.posix.join(directory, file.replaceAll('\\', '/'))));
  if (!selected.length) return [];
  return Array.from({ length: repeat }, () => ({
    args: ['--test', ...flags, ...selected],
    cwd: path.join(root, directory),
    env: browser ? { PAQVILO_BROWSER: 'chromium' } : {},
  }));
}

/** Extra runs of changed test files: PAQ_CI_REPEAT, else `git config paqvilo.ci.repeat`, else 2; 0 disables. */
export function validationRepeat(env = process.env, configured = gitConfig('paqvilo.ci.repeat')) {
  const value = env.PAQ_CI_REPEAT || configured || '2';
  if (!/^\d+$/.test(value)) throw new Error('PAQ_CI_REPEAT or paqvilo.ci.repeat must be a non-negative integer.');
  return Number(value);
}

function gitConfig(key) {
  const result = spawnSync('git', ['--no-optional-locks', 'config', '--get', key], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * How many validation steps run at once: PAQ_CI_JOBS, else `git config paqvilo.ci.jobs`, else one per four CPUs and
 * 4 GiB of memory. Hosted CI runs one lane per job, so it keeps one.
 */
export function validationJobs(env = process.env, configured = gitConfig('paqvilo.ci.jobs'), machine = {}) {
  const value = env.PAQ_CI_JOBS || configured;
  if (value) {
    if (!/^[1-9]\d*$/.test(value)) throw new Error(`PAQ_CI_JOBS or paqvilo.ci.jobs must be a positive integer.`);
    return Number(value);
  }
  if (env.GITHUB_ACTIONS === 'true') return 1;
  const { cpus = availableParallelism(), memory = totalmem() } = machine;
  return Math.max(1, Math.min(Math.floor(cpus / 4), Math.floor(memory / 2 ** 32)));
}

/**
 * Runs every step, at most `jobs` at a time, so one pass reports every failure. With one job the output streams as
 * before; otherwise each step writes its own log, and a failed step's log tail is printed when it ends.
 */
export async function runSteps(steps, jobs, { cwd = root, logs = path.join(root, '.paqvilo/ci/logs') } = {}) {
  const parallel = jobs > 1 && steps.length > 1;
  if (parallel) {
    fs.rmSync(logs, { recursive: true, force: true });
    fs.mkdirSync(logs, { recursive: true });
    console.log(`[ci] ${steps.length} steps, ${jobs} at a time; logs in ${logs}`);
  }
  const queue = [...steps],
    failed = [],
    timings = [];
  const worker = async () => {
    for (let step; (step = queue.shift());) {
      const start = performance.now();
      const log = path.join(logs, step.label.replace(/[^\w.-]+/g, '-') + '.log');
      const output = parallel ? fs.openSync(log, 'w') : 'inherit';
      let code = 0;
      try {
        for (const command of step.commands) {
          // A command is node arguments, or { args, env, cwd } for one lane's browser channel or package directory.
          const { args, env = {}, cwd: directory = cwd } = Array.isArray(command) ? { args: command } : command;
          const child = spawn(process.execPath, args, {
            cwd: directory,
            env: { ...process.env, ...step.env, ...env },
            stdio: ['ignore', output, output],
            windowsHide: true,
          });
          code = await new Promise((resolve) => {
            child.once('error', () => resolve('spawn error'));
            child.once('close', (status, signal) => resolve(status ?? signal));
          });
          if (code !== 0) break;
        }
      } finally {
        if (parallel) fs.closeSync(output);
      }
      timings.push([step.label, seconds(start)]);
      if (code === 0) console.log(`[ci] ✔ ${step.label} (${seconds(start)})`);
      else {
        failed.push(step.label);
        if (parallel) console.log(fs.readFileSync(log, 'utf8').split('\n').slice(-200).join('\n'));
        console.log(
          `[ci] ✖ ${step.label} failed (${code}) after ${seconds(start)}${parallel ? `; full log: ${log}` : ''}`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, steps.length) }, worker));
  if (parallel) console.log(`[ci] step times: ${timings.map(([label, time]) => `${label} ${time}`).join(', ')}`);
  if (failed.length) throw new Error(`Validation failed: ${failed.join(', ')}.`);
}

export function checkedGitStatus(directory = root) {
  const status = spawnSync('git', ['--no-optional-locks', 'status', '--porcelain'], {
    cwd: directory,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (status.status !== 0)
    throw new Error('Cannot determine Git worktree status; refusing to qualify validation.', { cause: status.error });
  return status.stdout.trim();
}

export function validationTree({ allowStaged = false, directory = root } = {}) {
  const git = (args) =>
    spawnSync('git', ['--no-optional-locks', ...args], { cwd: directory, encoding: 'utf8', windowsHide: true });
  if (allowStaged) {
    const unstaged = git(['diff', '--no-ext-diff', '--quiet', '--']);
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']);
    if (unstaged.status !== 0 || untracked.status !== 0 || untracked.stdout.length) return null;
    const tree = git(['write-tree']);
    return tree.status === 0 ? tree.stdout.trim() : null;
  }
  const status = git(['status', '--porcelain']);
  if (status.status !== 0 || status.stdout.trim()) return null;
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  return tree.status === 0 ? tree.stdout.trim() : null;
}

function chromiumHeadlessExecutable() {
  try {
    const require = createRequire(path.join(root, 'package.json'));
    return (
      require('playwright-core/lib/coreBundle')
        .registry.registry.findExecutable('chromium-headless-shell')
        ?.executablePath() ?? null
    );
  } catch {
    return null; // Preparation installs the pinned registry and browser cache.
  }
}

/** Qualify receipts against the selected channel and both Chromium launch modes. */
export async function verificationBrowser({
  env = process.env,
  platform = process.platform,
  locate = browserExecutable,
  locateHeadless = chromiumHeadlessExecutable,
} = {}) {
  const channel = ciBrowser(env, platform);
  const located = await locate(channel, { env, platform });
  const fingerprint = (executable) => {
    const browser = executable && fs.existsSync(executable) ? fs.statSync(executable) : null;
    return browser ? `${fs.realpathSync(executable)}:${browser.size}:${browser.mtimeMs}` : null;
  };
  return {
    channel,
    executable: fingerprint(located.path),
    headlessShell: channel === 'chromium' ? fingerprint(await locateHeadless()) : null,
  };
}

async function verificationIdentity(allowStaged = false) {
  const tree = validationTree({ allowStaged });
  if (!tree) return null;
  const cli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const npmVersion = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', windowsHide: true });
  if (npmVersion.status !== 0) return null;
  const require = createRequire(path.join(root, 'package.json'));
  try {
    require('playwright-core');
  } catch {
    return null; /* Preparation installs the locked package before validation. */
  }
  const selectedBrowser = await verificationBrowser();
  // Local validation runs every channel of this platform, so a changed Edge also requires a fresh pass.
  const localBrowsers = [];
  for (const channel of localBrowserChannels()) {
    let browser;
    try {
      browser = await verificationBrowser({ env: { ...process.env, PAQ_CI_BROWSER: channel } });
    } catch {
      browser = { channel, executable: null, headlessShell: null };
    }
    localBrowsers.push(`${browser.channel}:${browser.executable}:${browser.headlessShell}`);
  }
  const readPackageVersion = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')).version;
    } catch {
      return null;
    }
  };
  const sdk =
    process.env.PAQ_TEST_XRM_SDK ||
    path.join(root, '.paqvilo/ci/sdk-reference/reference/lib/net462/Microsoft.Xrm.Sdk.dll');
  const dotnet = spawnSync('dotnet', ['--version'], { encoding: 'utf8', windowsHide: true });
  return {
    tree,
    node: process.version,
    npm: npmVersion.stdout.trim(),
    platform: process.platform,
    arch: process.arch,
    nodeOptions: process.env.NODE_OPTIONS ?? '',
    playwright: require('playwright-core/package.json').version,
    browserChannel: selectedBrowser.channel,
    browserExecutable: selectedBrowser.executable,
    browserHeadlessShell: selectedBrowser.headlessShell,
    localBrowsers: localBrowsers.join('|'),
    tedious: readPackageVersion(path.join(root, 'mirage/test-sdk/tds/node_modules/tedious/package.json')),
    clrSdk: fs.existsSync(sdk) ? createHash('sha256').update(fs.readFileSync(sdk)).digest('hex') : null,
    dotnet: dotnet.status === 0 ? dotnet.stdout.trim() : null,
  };
}

export function matchingVerification(receipt, identity, scope) {
  return Boolean(
    !scope.full &&
    identity &&
    receipt?.identity &&
    Object.entries(identity).every(([name, value]) => receipt.identity[name] === value) &&
    (receipt.full || JSON.stringify(receipt.scope) === JSON.stringify(scope)),
  );
}

export function consumeVerificationReceipt(file) {
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* Missing or malformed evidence cannot qualify validation. */
  }
  // Any failed audit, preparation or suite run must revoke an earlier pass.
  fs.rmSync(file, { force: true });
  return receipt;
}

function saveVerificationReceipt(file, receipt) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n');
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const receiptFile = path.join(root, '.paqvilo/ci/verification.json');
  const receipt = ['verify', 'sdk'].includes(command) ? consumeVerificationReceipt(receiptFile) : undefined;
  const { values } = parseArgs({
    args,
    options: {
      full: { type: 'boolean' },
      suite: { type: 'string' },
      base: { type: 'string' },
      browser: { type: 'boolean' },
      unit: { type: 'boolean' },
      prepared: { type: 'boolean' },
      quality: { type: 'boolean' },
      sdk: { type: 'boolean' },
      shard: { type: 'string' },
    },
    strict: true,
  });
  if (
    values.quality &&
    (command !== 'prepare' || values.suite || values.unit || values.browser || values.full || values.base)
  )
    throw new Error('--quality is a standalone preparation mode.');
  if (
    values.sdk &&
    (command !== 'prepare' ||
      values.suite !== 'mirage' ||
      !values.unit ||
      values.browser ||
      values.full ||
      values.quality ||
      values.base)
  )
    throw new Error('--sdk prepares full client gates; combine only with prepare --suite mirage --unit.');
  if (values.unit && values.browser)
    throw new Error('--unit and --browser are mutually exclusive. Omit both to run both.');
  if (values.full && (values.unit || values.browser))
    throw new Error('--full requires unit and browser validation; use --suite for a partial run.');
  if (values.full && values.suite) throw new Error('--full selects every suite and cannot be combined with --suite.');
  if (values.base && values.suite) throw new Error('--base cannot be combined with an explicit --suite.');
  if (values.shard !== undefined) {
    const [index, total] = values.shard.split('/').map(Number);
    if (
      !/^[1-9]\d*\/[1-9]\d*$/.test(values.shard) ||
      index > total ||
      !['lense', 'mirage'].includes(values.suite) ||
      !(values.unit || values.browser)
    )
      throw new Error('--shard <index>/<total> splits only --suite lense|mirage with --unit or --browser.');
  }
  if (command === 'sdk') {
    if (Object.values(values).some(Boolean)) throw new Error('The SDK gate command takes no options.');
    return verifySdkGates();
  }
  if (command === 'sdk-prepare') {
    if (Object.values(values).some(Boolean)) throw new Error('SDK preparation takes no options.');
    return prepareLane('sdk', { unit: false, browser: false, sdk: true });
  }
  if (command === 'browser') {
    if (Object.values(values).some(Boolean)) throw new Error('The browser installation command takes no options.');
    return installChromium();
  }
  const full = values.full;
  const suite = values.suite;
  const browser = !values.unit;
  const unit = !values.browser;
  if (command === 'prepare')
    return prepareLane(values.quality ? 'quality' : (suite ?? 'all'), {
      browser: values.quality ? false : browser,
      unit: values.quality ? false : unit,
      sdk: values.sdk,
      shard: values.shard,
    });
  if (command !== 'verify')
    throw new Error(
      'Use prepare or verify, with --suite lense|mirage|examples, --unit, --browser, --prepared, --base <ref>, or --full.',
    );
  let scope;
  let changed = [];
  if (suite) {
    if (!['lense', 'mirage', 'examples'].includes(suite)) throw new Error(`Unknown CI suite: ${suite}`);
    scope = { [suite]: true };
  } else if (full) scope = classifyChanges([], { full: true });
  else {
    const base = values.base ?? 'origin/main';
    const diff = spawnSync(
      'git',
      ['--no-optional-locks', 'diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`, '--'],
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    if (diff.status !== 0) throw new Error(`Cannot compare ${base}; use --full or supply an existing --base.`);
    if (checkedGitStatus(root))
      throw new Error('Scoped pre-push validation requires a clean checkout; commit changes or use --full.');
    changed = diff.stdout.split('\0').filter(Boolean);
    scope = classifyChanges(changed);
  }
  const suites = suitesForScope(scope);
  console.log(
    `CI selection: ${JSON.stringify({ ...scope, suites, node: process.version, platform: process.platform, availableParallelism: availableParallelism(), totalMemoryMiB: Math.floor(totalmem() / 1024 / 1024) })}`,
  );
  const startingTree = validationTree({ allowStaged: Boolean(full) });
  if (!suite && !startingTree)
    throw new Error(
      'Validation requires worktree files to match the index and no untracked files; stage the full tree for --full, or commit before scoped validation.',
    );
  const identity = await verificationIdentity(Boolean(full));
  let securityChecked = false;
  const onlineChecks = () => {
    npmScript('audit:dependencies');
    npm(['audit', 'signatures']);
    npm(['audit', 'signatures', '--prefix', 'mirage']);
    securityChecked = true;
  };
  const ready = dependencyReadiness(root).ready;
  if (!suite && ready) onlineChecks();
  const fixturesReady = await verificationFixturesReady(scope, suites, {
    unit,
    browser,
    shard: values.shard,
    quality: !suite,
  });
  if (
    !suite &&
    process.env.GITHUB_ACTIONS !== 'true' &&
    unit &&
    browser &&
    ready &&
    fixturesReady &&
    matchingVerification(receipt, identity, scope)
  ) {
    if (!matchingVerification(receipt, await verificationIdentity(Boolean(full)), scope))
      throw new Error('Source, toolchain or fixtures changed during dependency audits; rerun validation.');
    saveVerificationReceipt(receiptFile, receipt);
    console.log(
      `Refreshed dependency audits/signatures and reused ${receipt.full ? 'full' : 'scoped'} deterministic validation for the identical source tree ${identity.tree}, toolchain and fixtures.`,
    );
    return;
  }
  if (!values.prepared && (suites.length || scope.quality))
    await prepareLane(suites.length === 0 ? 'quality' : suites.length === 1 ? suites[0] : 'all', {
      browser: Boolean((suites.length && browser) || scope.smoke),
      unit,
      quality: !suite && Boolean(scope.quality),
      shard: values.shard,
      sdk: !suite && fullSdkGate(scope),
    });
  const baselineIdentity = await verificationIdentity(Boolean(full));
  if (!suite && !baselineIdentity)
    throw new Error('Source or toolchain changed during preparation; review the staged tree and rerun validation.');
  if (suite) verifyLane(suite, { unit, browser, shard: values.shard });
  else {
    if (!securityChecked) onlineChecks();
    // Repeated changed tests run outside their lane process, so this process carries the lane fixture settings.
    for (const selected of suites) requireFixtures(selected, { unit, browser, shard: values.shard });
    const temporary = runnerTemporaryDirectory();
    if (temporary) {
      process.env.TEMP = process.env.TMP = temporary;
      console.log(`[ci] Temporary files use ${temporary}, as hosted Windows runners use an 8.3 TEMP alias.`);
    }
    await runSteps(
      validationSteps(scope, suites, { unit, browser, changed, repeat: validationRepeat() }),
      validationJobs(),
    );
  }
  const completedIdentity = await verificationIdentity(Boolean(full));
  if (!suite && JSON.stringify(baselineIdentity) !== JSON.stringify(completedIdentity))
    throw new Error('Source, toolchain or fixtures changed during validation; review the tree and rerun.');
  if (!suite && unit && browser && baselineIdentity && completedIdentity) {
    saveVerificationReceipt(receiptFile, {
      identity: completedIdentity,
      scope,
      full: Boolean(scope.full),
      completedAt: new Date().toISOString(),
    });
  }
  console.log('Selected CI validation completed without errors.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
