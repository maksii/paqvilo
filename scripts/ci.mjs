import fs from 'node:fs';
import path from 'node:path';
import { availableParallelism, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { classifyChanges, suitesForScope } from '../.github/scripts/change-scope.mjs';
import { dependencyReadiness } from './ensure-dependencies.mjs';
import { downloadVerifiedArchive } from './verified-download.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK_VERSION = '9.0.2.60';
const SDK_SHA256 = '59650574cdc89c1f506fabd7275fe6325a59a8bae9fa9f92c5b5c2cbe31d5e1f';
// SHA-256 of lib/net462/Microsoft.Xrm.Sdk.dll inside that verified public archive.
const SDK_DLL_SHA256 = 'f696eaeb1145bce9f517d0b8fa5e925d0216176919af8d417dcd439acb1797f9';
const defaults = { cwd: root, stdio: 'inherit', windowsHide: true };
function execute(command, args, options = {}) {
  const result = spawnSync(command, args, { ...defaults, ...options });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.error?.message}).`, {
      cause: result.error,
    });
  return result;
}
function npm(args) {
  const cli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
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

function requireDotnet() {
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'global.json'), 'utf8')).sdk.version;
  const version = spawnSync('dotnet', ['--version'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (version.status !== 0 || version.stdout.trim() !== expected)
    throw new Error(
      `Incomplete CI validation: .NET SDK ${expected} is required; install the SDK pinned in global.json.`,
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

export async function prepareLane(suite, { browser = false, quality = false, sdk = false } = {}) {
  if (!['lense', 'mirage', 'examples', 'all', 'quality'].includes(suite)) throw new Error(`Unknown CI suite: ${suite}`);
  if (!['lense', 'quality'].includes(suite)) requireDotnet();
  quality ||= suite === 'quality';
  npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  npm(['ci', '--prefix', 'mirage', '--ignore-scripts', '--no-audit', '--no-fund']);
  if (suite === 'mirage' || suite === 'all' || quality) {
    npm(['ci', '--prefix', 'mirage/test-sdk/tds', '--ignore-scripts', '--no-audit', '--no-fund']);
  }
  if (requiresClrFixture(suite)) await clrFixture();
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
      environment('PAQ_TEST_SDK_PROBES_RESTORED', '1');
    }
  }
  if (browser) {
    execute(process.execPath, [
      'node_modules/playwright-core/cli.js',
      'install',
      ...(process.platform === 'linux' ? ['--with-deps'] : []),
      'chromium',
    ]);
  }
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

function requireFixtures(suite, browser) {
  if (suite !== 'lense') requireDotnet();
  if (suite === 'mirage') {
    if (!fs.existsSync(path.join(root, 'mirage/test-sdk/tds/node_modules/tedious/lib/tedious.js')))
      throw new Error('Incomplete CI validation: install the locked TDS fixture with ci:prepare.');
  }
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
      if (!fs.existsSync(path.join(root, 'examples/company-operations/plugins/SdkProbes/obj/project.assets.json')))
        throw new Error('Incomplete CI validation: SDK projection driver restore missing; run ci:prepare.');
      environment('PAQ_TEST_SDK_PROBES_RESTORED', '1');
    }
  }
  if (browser) environment('PAQVILO_BROWSER', 'chromium');
}

export function fullSdkGate(scope, platform = process.platform) {
  return Boolean(scope.full) && platform === 'win32';
}

function verifySdkGates() {
  requireDotnet();
  requireSdkClients();
  execute('dotnet', ['restore', 'mirage/test-sdk/cert-auth/Gate/Gate.csproj', '--locked-mode']);
  for (const project of ['tds', 'dynamics-web-api', 'cert-auth'])
    npm(['--prefix', 'mirage/test-sdk/' + project, 'test']);
}

const unitPlatformNeedsSdk = () => process.platform === 'win32';

export function verifyLane(suite, { unit = true, browser = true } = {}) {
  requireFixtures(suite, browser);
  if (unit) {
    if (suite === 'lense') npmScript('test');
    if (suite === 'mirage') npm(['--prefix', 'mirage', 'test']);
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
    if (suite === 'lense') npmScript('test:browser');
    if (suite === 'mirage') npm(['--prefix', 'mirage', 'run', 'test:browser']);
    if (suite === 'examples') {
      npmScript('test:example:browser');
      npmScript('test:company:browser');
    }
  }
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

function verificationIdentity(allowStaged = false) {
  const tree = validationTree({ allowStaged });
  if (!tree) return null;
  const cli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const npmVersion = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', windowsHide: true });
  if (npmVersion.status !== 0) return null;
  const require = createRequire(path.join(root, 'package.json'));
  let playwright;
  try {
    playwright = require('playwright-core');
  } catch {
    return null; /* Preparation installs the locked package before validation. */
  }
  const executable = playwright.chromium.executablePath();
  const browser = fs.existsSync(executable) ? fs.statSync(executable) : null;
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
    chromium: browser ? `${executable}:${browser.size}:${browser.mtimeMs}` : null,
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
    throw new Error('--sdk prepares full Windows client gates; combine only with prepare --suite mirage --unit.');
  if (values.unit && values.browser)
    throw new Error('--unit and --browser are mutually exclusive. Omit both to run both.');
  if (values.full && (values.unit || values.browser))
    throw new Error('--full requires unit and browser validation; use --suite for a partial run.');
  if (values.full && values.suite) throw new Error('--full selects every suite and cannot be combined with --suite.');
  if (values.base && values.suite) throw new Error('--base cannot be combined with an explicit --suite.');
  if (command === 'sdk') {
    if (Object.values(values).some(Boolean)) throw new Error('The SDK gate command takes no options.');
    return verifySdkGates();
  }
  const full = values.full;
  const suite = values.suite;
  const browser = !values.unit;
  const unit = !values.browser;
  if (command === 'prepare')
    return prepareLane(values.quality ? 'quality' : (suite ?? 'all'), {
      browser: values.quality ? false : browser,
      sdk: values.sdk,
    });
  if (command !== 'verify')
    throw new Error(
      'Use prepare or verify, with --suite lense|mirage|examples, --unit, --browser, --prepared, --base <ref>, or --full.',
    );
  let scope;
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
    scope = classifyChanges(diff.stdout.split('\0').filter(Boolean));
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
  const identity = verificationIdentity(Boolean(full));
  const receiptFile = path.join(root, '.paqvilo/ci/verification.json');
  const receipt = consumeVerificationReceipt(receiptFile);
  let securityChecked = false;
  const onlineChecks = () => {
    npmScript('audit:dependencies');
    npm(['audit', 'signatures']);
    npm(['audit', 'signatures', '--prefix', 'mirage']);
    securityChecked = true;
  };
  const ready = dependencyReadiness(root).ready;
  if (!suite && ready) onlineChecks();
  let fixturesReady = true;
  try {
    if (!suite && scope.quality) requireQualityDependencies();
    for (const selected of suites) requireFixtures(selected, browser);
  } catch {
    fixturesReady = false; /* Missing fixtures require preparation, never a cached pass. */
  }
  if (
    !suite &&
    process.env.GITHUB_ACTIONS !== 'true' &&
    unit &&
    browser &&
    ready &&
    fixturesReady &&
    matchingVerification(receipt, identity, scope)
  ) {
    if (!matchingVerification(receipt, verificationIdentity(Boolean(full)), scope))
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
      quality: !suite && Boolean(scope.quality),
    });
  const baselineIdentity = verificationIdentity(Boolean(full));
  if (!suite && !baselineIdentity)
    throw new Error('Source or toolchain changed during preparation; review the staged tree and rerun validation.');
  if (!suite) {
    if (!securityChecked) onlineChecks();
    if (scope.quality) npmScript('quality');
    if (scope.runtime) npmScript('check');
    if (scope.package) npmScript('release:check');
  }
  for (const selected of suites) verifyLane(selected, { unit, browser });
  if (fullSdkGate(scope)) verifySdkGates();
  if (scope.smoke) {
    npmScript('cache:package');
    npmScript('release:smoke');
  }
  if (scope.site) npmScript('site:build');
  const completedIdentity = verificationIdentity(Boolean(full));
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
