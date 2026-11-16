// VS Code tasks can call this on every run without reinstalling an unchanged lockfile.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

const canonicalDependencies = (value) =>
  JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
const publishedLock = (root) => {
  const snapshot = path.join(root, 'paqvilo-lock.json');
  return fs.existsSync(snapshot) ? snapshot : path.join(root, 'npm-shrinkwrap.json');
};
const MINIMUM_NODE = '26.13.1';
// Match the one-command Git hang guard used by lense/git.mjs. This bootstrap
// stays built-in-only so readiness also works before toolkit dependencies exist.
export const GIT_PREREQUISITE_HANG_GUARD_MS = 120_000;

/** Readiness checks never install or contact a registry, and can run before dependencies exist. */
function projectDependencyReadiness(root, { resolved = false } = {}) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const packageLockPath = path.join(root, 'package-lock.json');
    const snapshotPath = publishedLock(root);
    const lockPath = fs.existsSync(packageLockPath) ? packageLockPath : snapshotPath;
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (
      fs.existsSync(packageLockPath) &&
      fs.existsSync(snapshotPath) &&
      fs.readFileSync(packageLockPath, 'utf8') !== fs.readFileSync(snapshotPath, 'utf8')
    )
      return {
        ready: false,
        canInstall: false,
        reason:
          'package-lock.json and paqvilo-lock.json disagree. Keep the distributable dependency snapshot synchronized.',
      };
    if (!lock.packages?.[''])
      return { ready: false, canInstall: false, reason: 'package-lock.json must contain a modern packages lockfile' };
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      if (canonicalDependencies(manifest[key]) !== canonicalDependencies(lock.packages[''][key]))
        return {
          ready: false,
          canInstall: false,
          reason: 'package.json and package-lock.json disagree. Update the tool lockfile before installing.',
        };
    }
    const platformMatches = (list, platform) =>
      !list ||
      (!list.includes(`!${platform}`) && (list.every((value) => value.startsWith('!')) || list.includes(platform)));
    let mismatch = null;
    const require = createRequire(path.join(root, 'package.json'));
    const installed = resolved
      ? Object.keys(manifest.dependencies ?? {}).every((name) => {
          const expected = lock.packages[`node_modules/${name}`]?.version;
          try {
            const entry = require.resolve(name);
            const directory = require.resolve
              .paths(name)
              ?.map((base) => path.join(base, name))
              .find((base) => {
                if (!fs.existsSync(path.join(base, 'package.json'))) return false;
                const relative = path.relative(fs.realpathSync(base), entry);
                return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
              });
            const actual = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version;
            if (!expected || actual !== expected) {
              mismatch = `${name}: expected ${expected}, resolved ${actual}`;
              return false;
            }
            return true;
          } catch {
            mismatch = `${name}: dependency does not resolve`;
            return false;
          }
        })
      : Object.entries(lock.packages)
          .filter(
            ([name, entry]) =>
              name.startsWith('node_modules/') &&
              platformMatches(entry.os, process.platform) &&
              platformMatches(entry.cpu, process.arch),
          )
          .every(([name, entry]) => {
            try {
              return (
                JSON.parse(fs.readFileSync(path.join(root, name, 'package.json'), 'utf8')).version === entry.version
              );
            } catch (error) {
              // npm can omit optional fallback trees even when their packages have no OS/CPU field.
              return Boolean(entry.optional && error.code === 'ENOENT');
            }
          });
    return {
      ready: installed,
      canInstall: true,
      reason: installed
        ? 'locked dependencies are ready'
        : (mismatch ?? 'locked dependencies are missing or incomplete. Run npm run setup.'),
      dependencies: Object.keys(manifest.dependencies ?? {}),
    };
  } catch (err) {
    return { ready: false, canInstall: false, reason: `cannot read dependency manifests: ${err.message}` };
  }
}

/** Check the toolkit and its bundled Mirage as separate locked npm projects. */
export function dependencyReadiness(root) {
  const packaged = !fs.existsSync(path.join(root, 'package-lock.json'));
  const projects = [{ name: 'toolkit', directory: '.', ...projectDependencyReadiness(root, { resolved: packaged }) }];
  const mirageRoot = path.join(root, 'mirage');
  if (fs.existsSync(path.join(mirageRoot, 'package.json')))
    projects.push({
      name: 'mirage',
      directory: 'mirage',
      ...projectDependencyReadiness(mirageRoot, { resolved: packaged }),
    });
  const failed = projects.find((project) => !project.canInstall);
  const ready = projects.every((project) => project.ready);
  return {
    ready,
    canInstall: !failed,
    reason:
      failed?.reason ??
      (ready
        ? 'locked toolkit and Mirage dependencies are ready'
        : 'locked toolkit or Mirage dependencies are missing or incomplete. Run npm run setup.'),
    dependencies: projects[0].dependencies ?? [],
    projects,
  };
}

const regularFile = (file) => {
  try {
    return Boolean(file && fs.statSync(file).isFile());
  } catch {
    return false;
  }
};

/** Presence only: this does not launch a browser or certify OS/browser runtime dependencies. */
export async function browserExecutable(
  channel,
  { platform = process.platform, env = process.env, exists = regularFile } = {},
) {
  if (!['msedge', 'chrome', 'chromium'].includes(channel))
    throw new Error('--browser must be msedge, chrome or chromium');
  let candidates = [];
  if (channel === 'chromium') {
    try {
      const { chromium } = await import('playwright-core');
      candidates = [chromium.executablePath()];
    } catch {
      /* missing toolkit dependency */
    }
  } else if (platform === 'win32') {
    const suffix =
      channel === 'msedge'
        ? ['Microsoft', 'Edge', 'Application', 'msedge.exe']
        : ['Google', 'Chrome', 'Application', 'chrome.exe'];
    candidates = [
      ...new Set(
        [
          env.PROGRAMFILES,
          env['PROGRAMFILES(X86)'],
          env.ProgramFiles,
          env['ProgramFiles(x86)'],
          env.LOCALAPPDATA,
        ].filter(Boolean),
      ),
    ].map((root) => path.join(root, ...suffix));
  } else if (platform === 'darwin') {
    const name = channel === 'msedge' ? 'Microsoft Edge' : 'Google Chrome';
    candidates = [
      `/Applications/${name}.app/Contents/MacOS/${name}`,
      ...(env.HOME ? [`${env.HOME}/Applications/${name}.app/Contents/MacOS/${name}`] : []),
    ];
  } else {
    candidates =
      channel === 'msedge'
        ? ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']
        : ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
  }
  return {
    channel,
    path: candidates.find(exists) ?? null,
    checkedPaths: candidates,
    check: 'executable-presence',
    launchVerified: false,
  };
}

/** Probe once without blocking readiness cancellation or abandoning the child. */
export async function probeGitVersion({ signal, execute = execFile } = {}) {
  signal?.throwIfAborted();
  const completed = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const child = execute(
    'git', // NOSONAR: fixed tool name resolved through PATH by developer tooling
    ['--version'],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: GIT_PREREQUISITE_HANG_GUARD_MS,
      signal,
    },
    (error, stdout, stderr) => {
      let status = 0;
      if (error) status = Number.isInteger(error.code) ? error.code : null;
      completed.resolve({
        status,
        stdout,
        stderr,
        error,
      });
    },
  );
  child.once('close', closed.resolve);
  const result = await completed.promise;
  await closed.promise;
  signal?.throwIfAborted();
  return result;
}

export async function prerequisiteReadiness({
  browser,
  nodeVersion = process.versions.node,
  probeGit = probeGitVersion,
  locateBrowser = browserExecutable,
  signal,
} = {}) {
  signal?.throwIfAborted();
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(nodeVersion);
  const parts = match?.slice(1).map(Number);
  const node = {
    version: nodeVersion,
    minimumMajor: 26,
    minimumVersion: MINIMUM_NODE,
    ready: Boolean(parts?.[0] === 26 && (parts[1] > 13 || (parts[1] === 13 && parts[2] >= 1))),
  };
  const result = await probeGit({ signal });
  signal?.throwIfAborted();
  let gitError = null;
  if (result.status !== 0) {
    if (result.error?.code === 'ENOENT') gitError = 'Git was not found on PATH (ENOENT).';
    else if (Number.isInteger(result.status)) gitError = `Git --version exited with status ${result.status}.`;
    else gitError = `Git readiness probe did not complete: ${result.error?.message ?? 'no process result'}`;
  }
  const git = {
    ready: result.status === 0,
    version: result.status === 0 ? result.stdout.trim() : null,
    error: gitError,
  };
  const browserResult = browser ? await locateBrowser(browser) : null;
  signal?.throwIfAborted();
  return {
    node,
    git,
    browser: browserResult && { ...browserResult, ready: Boolean(browserResult.path) },
    ready: node.ready && git.ready && (!browserResult || Boolean(browserResult.path)),
  };
}

function readOptions() {
  try {
    const { values: options } = parseArgs({
      options: { check: { type: 'boolean' }, json: { type: 'boolean' }, browser: { type: 'string' } },
    });
    if (options.json && !options.check)
      throw new Error('--json requires --check so machine-readable setup never installs dependencies');
    if (options.browser && !['msedge', 'chrome', 'chromium'].includes(options.browser))
      throw new Error('--browser must be msedge, chrome or chromium');
    return { options };
  } catch (error) {
    if (process.argv.includes('--json'))
      console.log(
        JSON.stringify({ schemaVersion: 1, command: 'setup', offline: true, ready: false, error: error.message }),
      );
    else console.error(`paqvilo: ${error.message}; use --check for an offline readiness check.`);
    return { error };
  }
}
function verifyResolvedDependencies(root, result) {
  if (!result.ready) return;
  try {
    for (const project of result.projects) {
      const require = createRequire(path.join(root, project.directory, 'package.json'));
      for (const name of project.dependencies) require(name);
    }
  } catch {
    result.ready = false;
    result.reason = 'locked dependencies are incomplete. Run npm run setup.';
  }
}
function printReadinessReport(options, result, prerequisites, report) {
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`paqvilo: ${result.reason}`);
    const nodeStatus = prerequisites.node.ready
      ? 'ready'
      : `Node.js ${MINIMUM_NODE} or newer in the 26.x LTS line required`;
    console.log(`Node ${prerequisites.node.version}: ${nodeStatus}`);
    console.log(`Git: ${prerequisites.git.version ?? prerequisites.git.error}`);
    if (prerequisites.browser)
      console.log(
        `${prerequisites.browser.channel}: ${prerequisites.browser.path ?? 'executable not found in standard installation paths'} (presence only; not launched)`,
      );
  }
}
function reportMissingPrerequisite(prerequisites, browser) {
  if (prerequisites.node.ready && !prerequisites.git.ready) {
    console.error(`paqvilo: Git prerequisite is not ready: ${prerequisites.git.error}`);
    return;
  }
  let missing = `${browser} browser executable`;
  if (!prerequisites.node.ready) missing = `Node.js ${MINIMUM_NODE} or newer in the 26.x LTS line`;
  console.error(`paqvilo: missing prerequisite: ${missing}`);
}
/** Materialize the shipped dependency snapshot only while a packaged installation is repaired. */
export function withNpmInstallLock(directory, install) {
  const lock = path.join(directory, 'package-lock.json');
  let contents;
  try {
    contents = readInstallSnapshot(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return install();
    throw error;
  }
  let descriptor;
  try {
    descriptor = fs.openSync(lock, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') return install();
    throw error;
  }
  let created;
  try {
    fs.writeFileSync(descriptor, contents);
    created = fs.fstatSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  let result;
  let failure;
  try {
    result = install();
  } catch (error) {
    failure = { error };
  }
  removeInstallLock(directory, lock, created, contents);
  if (failure) throw failure.error;
  return result;
}

function readInstallSnapshot(directory) {
  try {
    return fs.readFileSync(path.join(directory, 'paqvilo-lock.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return fs.readFileSync(path.join(directory, 'npm-shrinkwrap.json'));
  }
}

function removeInstallLock(directory, lock, created, contents) {
  // Rename first: later checks and deletion refer only to our private path, never
  // to a replacement another process might create at the original lock path.
  const recovery = fs.mkdtempSync(path.join(directory, '.paqvilo-install-lock-'));
  const moved = path.join(recovery, 'package-lock.json');
  fs.renameSync(lock, moved);
  const descriptor = fs.openSync(moved, 'r');
  let owned;
  try {
    const current = fs.fstatSync(descriptor);
    owned =
      current.isFile() &&
      current.dev === created.dev &&
      current.ino === created.ino &&
      fs.readFileSync(descriptor).equals(contents);
  } finally {
    fs.closeSync(descriptor);
  }
  if (!owned) {
    // An exclusive hard link restores the changed file without overwriting a
    // newer lock. If restoration fails, retain the recovery file for the user.
    try {
      fs.linkSync(moved, lock);
    } catch (error) {
      throw new Error(`The temporary package lock changed; it has been preserved at ${moved}.`, { cause: error });
    }
  }
  fs.unlinkSync(moved);
  fs.rmdirSync(recovery);
  if (!owned) throw new Error('The temporary package lock changed during dependency repair; it has been preserved.');
}

function installProjects(root, projects) {
  const args = ['ci', '--ignore-scripts', '--no-audit', '--no-fund'];
  for (const project of projects) {
    if (project.ready) continue;
    const cwd = path.resolve(root, project.directory);
    const installation = withNpmInstallLock(
      cwd,
      () =>
        process.platform === 'win32'
          ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], {
              cwd,
              stdio: 'inherit',
              windowsHide: true,
            })
          : spawnSync('npm', args, { cwd, stdio: 'inherit' }), // NOSONAR: fixed tool name resolved through PATH by developer tooling
    );
    if (installation.error)
      console.error(`paqvilo: ${project.name} dependency installation failed: ${installation.error.message}`);
    if (installation.status !== 0) return installation.status ?? 1;
  }
  return 0;
}
async function main() {
  const parsed = readOptions();
  if (parsed.error) return 1;
  const { options } = parsed;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = dependencyReadiness(root);
  verifyResolvedDependencies(root, result);
  const prerequisites = await prerequisiteReadiness({ browser: options.browser });
  const report = {
    schemaVersion: 1,
    command: 'setup',
    offline: Boolean(options.check),
    ready: result.ready && prerequisites.ready,
    dependencies: result,
    prerequisites,
  };
  if (options.check) {
    printReadinessReport(options, result, prerequisites, report);
    return report.ready ? 0 : 1;
  }
  if (!prerequisites.ready) {
    reportMissingPrerequisite(prerequisites, options.browser);
    return 1;
  }
  if (result.ready) {
    console.log(`paqvilo: ${result.reason}`);
    return 0;
  }
  if (!result.canInstall) {
    console.error(`paqvilo: ${result.reason}`);
    return 1;
  }
  return installProjects(root, result.projects);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main();
