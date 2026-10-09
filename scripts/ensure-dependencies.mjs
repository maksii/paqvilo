// VS Code tasks can call this on every run without reinstalling an unchanged lockfile.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

const canonicalDependencies = (value) => JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));

/** Readiness checks never install or contact a registry, and can run before dependencies exist. */
function projectDependencyReadiness(root) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const packageLockPath = path.join(root, 'package-lock.json');
    const shrinkwrapPath = path.join(root, 'npm-shrinkwrap.json');
    const lockPath = fs.existsSync(packageLockPath) ? packageLockPath : shrinkwrapPath;
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (fs.existsSync(packageLockPath) && fs.existsSync(shrinkwrapPath) && fs.readFileSync(packageLockPath, 'utf8') !== fs.readFileSync(shrinkwrapPath, 'utf8'))
      return { ready: false, canInstall: false, reason: 'package-lock.json and npm-shrinkwrap.json disagree. Keep the distributable shrinkwrap synchronized.' };
    if (!lock.packages?.['']) return { ready: false, canInstall: false, reason: 'package-lock.json must contain a modern packages lockfile' };
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      if (canonicalDependencies(manifest[key]) !== canonicalDependencies(lock.packages[''][key])) return { ready: false, canInstall: false, reason: 'package.json and package-lock.json disagree. Update the tool lockfile before installing.' };
    }
    const platformMatches = (list, platform) => !list || (!list.includes(`!${platform}`) && (list.every((value) => value.startsWith('!')) || list.includes(platform)));
    const installed = Object.entries(lock.packages).filter(([name, entry]) => name.startsWith('node_modules/') && platformMatches(entry.os, process.platform) && platformMatches(entry.cpu, process.arch)).every(([name, entry]) => {
      try { return JSON.parse(fs.readFileSync(path.join(root, name, 'package.json'), 'utf8')).version === entry.version; } catch { return false; }
    });
    return { ready: installed, canInstall: true, reason: installed ? 'locked dependencies are ready' : 'locked dependencies are missing or incomplete. Run npm run setup.', dependencies: Object.keys(manifest.dependencies ?? {}) };
  } catch (err) {
    return { ready: false, canInstall: false, reason: `cannot read dependency manifests: ${err.message}` };
  }
}

/** Check the toolkit and its bundled Mirage as separate locked npm projects. */
export function dependencyReadiness(root) {
  const projects = [{ name: 'toolkit', directory: '.', ...projectDependencyReadiness(root) }];
  const mirageRoot = path.join(root, 'mirage');
  if (fs.existsSync(path.join(mirageRoot, 'package.json')))
    projects.push({ name: 'mirage', directory: 'mirage', ...projectDependencyReadiness(mirageRoot) });
  const failed = projects.find((project) => !project.canInstall);
  const ready = projects.every((project) => project.ready);
  return {
    ready,
    canInstall: !failed,
    reason: failed?.reason ?? (ready ? 'locked toolkit and Mirage dependencies are ready' : 'locked toolkit or Mirage dependencies are missing or incomplete. Run npm run setup.'),
    dependencies: projects[0].dependencies ?? [],
    projects,
  };
}

const regularFile = (file) => { try { return Boolean(file && fs.statSync(file).isFile()); } catch { return false; } };

/** Presence only: this does not launch a browser or certify OS/browser runtime dependencies. */
export async function browserExecutable(channel, { platform = process.platform, env = process.env, exists = regularFile } = {}) {
  if (!['msedge', 'chrome', 'chromium'].includes(channel)) throw new Error('--browser must be msedge, chrome or chromium');
  let candidates = [];
  if (channel === 'chromium') {
    try { const { chromium } = await import('playwright-core'); candidates = [chromium.executablePath()]; } catch { /* missing toolkit dependency */ }
  } else if (platform === 'win32') {
    const suffix = channel === 'msedge' ? ['Microsoft', 'Edge', 'Application', 'msedge.exe'] : ['Google', 'Chrome', 'Application', 'chrome.exe'];
    candidates = [...new Set([env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean))].map((root) => path.join(root, ...suffix));
  } else if (platform === 'darwin') {
    const name = channel === 'msedge' ? 'Microsoft Edge' : 'Google Chrome';
    candidates = [`/Applications/${name}.app/Contents/MacOS/${name}`, ...(env.HOME ? [`${env.HOME}/Applications/${name}.app/Contents/MacOS/${name}`] : [])];
  } else {
    candidates = channel === 'msedge' ? ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'] : ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
  }
  return { channel, path: candidates.find(exists) ?? null, checkedPaths: candidates, check: 'executable-presence', launchVerified: false };
}

export async function prerequisiteReadiness({ browser, nodeVersion = process.versions.node, probeGit, locateBrowser = browserExecutable } = {}) {
  const major = Number(nodeVersion.split('.')[0]);
  const node = { version: nodeVersion, minimumMajor: 22, ready: Number.isInteger(major) && major >= 22 };
  const result = probeGit ? probeGit() : spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  const git = { ready: result.status === 0, version: result.status === 0 ? result.stdout.trim() : null, error: result.status === 0 ? null : result.error?.message ?? 'Git is not available on PATH' };
  const browserResult = browser ? await locateBrowser(browser) : null;
  return { node, git, browser: browserResult && { ...browserResult, ready: Boolean(browserResult.path) }, ready: node.ready && git.ready && (!browserResult || Boolean(browserResult.path)) };
}

async function main() {
  let options;
  try {
    ({ values: options } = parseArgs({ options: { check: { type: 'boolean' }, json: { type: 'boolean' }, browser: { type: 'string' } } }));
    if (options.json && !options.check) throw new Error('--json requires --check so machine-readable setup never installs dependencies');
    if (options.browser && !['msedge', 'chrome', 'chromium'].includes(options.browser)) throw new Error('--browser must be msedge, chrome or chromium');
  } catch (error) {
    if (process.argv.includes('--json')) console.log(JSON.stringify({ schemaVersion: 1, command: 'setup', offline: true, ready: false, error: error.message }));
    else console.error(`paqvilo: ${error.message}; use --check for an offline readiness check.`);
    return 1;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = dependencyReadiness(root);
  if (result.ready) {
    try {
      for (const project of result.projects) {
        const require = createRequire(path.join(root, project.directory, 'package.json'));
        for (const name of project.dependencies) require(name);
      }
    } catch { result.ready = false; result.reason = 'locked dependencies are incomplete. Run npm run setup.'; }
  }
  const prerequisites = await prerequisiteReadiness({ browser: options.browser });
  const report = { schemaVersion: 1, command: 'setup', offline: Boolean(options.check), ready: result.ready && prerequisites.ready, dependencies: result, prerequisites };
  if (options.check) {
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`paqvilo: ${result.reason}`);
      console.log(`Node ${prerequisites.node.version}: ${prerequisites.node.ready ? 'ready' : 'Node.js 22 or newer required'}`);
      console.log(`Git: ${prerequisites.git.version ?? prerequisites.git.error}`);
      if (prerequisites.browser) console.log(`${prerequisites.browser.channel}: ${prerequisites.browser.path ?? 'executable not found in standard installation paths'} (presence only; not launched)`);
    }
    return report.ready ? 0 : 1;
  }
  if (!prerequisites.ready) { console.error(`paqvilo: missing prerequisite: ${!prerequisites.node.ready ? 'Node.js 22 or newer' : !prerequisites.git.ready ? 'Git on PATH' : `${options.browser} browser executable`}`); return 1; }
  if (result.ready) { console.log(`paqvilo: ${result.reason}`); return 0; }
  if (!result.canInstall) { console.error(`paqvilo: ${result.reason}`); return 1; }
  const args = ['ci', '--ignore-scripts', '--no-audit', '--no-fund'];
  for (const project of result.projects) {
    if (project.ready) continue;
    const cwd = path.resolve(root, project.directory);
    const installation = process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], { cwd, stdio: 'inherit', windowsHide: true })
      : spawnSync('npm', args, { cwd, stdio: 'inherit' });
    if (installation.error) console.error(`paqvilo: ${project.name} dependency installation failed: ${installation.error.message}`);
    if (installation.status !== 0) return installation.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
