import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { dependencyReadiness } from './ensure-dependencies.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function git(args, { raw = false } = {}) {
  const result = spawnSync('git', ['--no-optional-locks', ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim());
  return raw ? result.stdout : result.stdout.trim();
}

function install() {
  if (path.resolve(git(['rev-parse', '--show-toplevel'])) !== root)
    throw new Error('Install hooks from the toolkit checkout.');
  const current = spawnSync('git', ['--no-optional-locks', 'config', '--get', 'core.hooksPath'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (current.stdout.trim() && current.stdout.trim() !== '.githooks')
    throw new Error(
      `Existing core.hooksPath is ${current.stdout.trim()}; reconcile it with .githooks before installing.`,
    );
  for (const name of ['pre-commit', 'pre-push', 'commit-msg']) fs.chmodSync(path.join(root, '.githooks', name), 0o755);
  git(['config', '--local', 'core.hooksPath', '.githooks']);
  console.log('Installed local hooks: staged quality checks, scoped pre-push validation and Conventional Commits.');
}

// A fixture's package self-import must resolve to staged source, never to the original checkout.
// Independent registry dependencies may reuse their locked installed trees; local source links may not.
function linkFixtureDependencies(snapshot) {
  for (const project of [
    'examples/project',
    'examples/company-operations',
    'mirage/test-sdk/tds',
    'mirage/test-sdk/dynamics-web-api',
    'mirage/test-sdk/cert-auth',
  ]) {
    const directory = path.join(snapshot, project);
    const manifestFile = path.join(directory, 'package.json');
    if (!fs.existsSync(manifestFile)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    const modules = path.join(directory, 'node_modules');
    fs.mkdirSync(modules, { recursive: true });
    if (dependencies.paqvilo) {
      if (
        !dependencies.paqvilo.startsWith('file:') ||
        path.resolve(directory, dependencies.paqvilo.slice(5)) !== snapshot
      )
        throw new Error('Fixture paqvilo dependency must name the staged toolkit root.');
      fs.symlinkSync(snapshot, path.join(modules, 'paqvilo'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    const lockFile = path.join(directory, 'package-lock.json');
    if (!fs.existsSync(lockFile)) continue;
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    for (const [name, entry] of Object.entries(lock.packages ?? {})) {
      if (!/^node_modules\/(?:@[^/]+\/)?[^/]+$/.test(name) || name === 'node_modules/paqvilo') continue;
      if (entry.link || entry.resolved?.startsWith('file:'))
        throw new Error('Unregistered local fixture dependency cannot enter staged validation.');
      const source = path.join(root, project, name);
      if (!fs.existsSync(source)) continue; // The resolver reports missing imports; optional platform packages may be absent.
      const installed = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
      if (installed.version !== entry.version)
        throw new Error('Fixture dependency differs from its staged lockfile; run ci:prepare.');
      const destination = path.join(directory, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
    }
  }
}

// Export the index instead of testing unstaged edits. Never stash or mutate contributor files.
async function preCommit() {
  const stagedTree = git(['write-tree']);
  const files = git(['diff', '--cached', '--name-only', '--no-renames', '-z', '--'], { raw: true })
    .split('\0')
    .filter(Boolean);
  const parent = path.join(root, '.paqvilo', 'hooks');
  fs.mkdirSync(parent, { recursive: true });
  const snapshot = fs.mkdtempSync(path.join(parent, 'staged-'));
  try {
    git(['checkout-index', '--all', `--prefix=${snapshot.replaceAll('\\', '/')}/`]);
    // Gate selection must use the same staged sources as the checks themselves.
    const { preCommitScripts } = await import(
      pathToFileURL(path.join(snapshot, '.github', 'scripts', 'change-scope.mjs')).href
    );
    const scripts = preCommitScripts(files);
    console.log(`Staged validation: ${scripts.join(', ') || 'no applicable checks'}.`);
    // Changed test files declare their kind; parity assertions change only with recorded proof (docs/test-kinds.md).
    const tags = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-test-tags.mjs'), '--staged'], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (tags.status !== 0) throw new Error('Staged validation failed (test kinds). Commit stopped.');
    if (scripts.includes('quality')) {
      for (const directory of ['', 'mirage']) {
        const source = path.join(root, directory, 'node_modules');
        if (fs.existsSync(source))
          fs.symlinkSync(
            source,
            path.join(snapshot, directory, 'node_modules'),
            process.platform === 'win32' ? 'junction' : 'dir',
          );
      }
      linkFixtureDependencies(snapshot);
      const ready = dependencyReadiness(snapshot);
      if (!ready.ready) throw new Error(`${ready.reason} Stage consistent manifests, then run npm run setup.`);
    }
    const npmCli = process.env.npm_execpath;
    if (scripts.length && (!npmCli || !fs.existsSync(npmCli)))
      throw new Error('Run this hook through npm run hooks:check.');
    // Git's hook environment otherwise leaks the original index into synthetic test repositories.
    const env = { ...process.env };
    env.PAQVILO_TOOL_CACHE = path.join(root, '.paqvilo', 'tools');
    for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
    for (const script of scripts) {
      const result = spawnSync(process.execPath, [npmCli, 'run', script], {
        cwd: snapshot,
        env,
        stdio: 'inherit',
        windowsHide: true,
      });
      if (result.status !== 0)
        throw new Error(result.error?.message ?? `Staged validation failed (${script}). Commit stopped.`);
    }
    if (git(['write-tree']) !== stagedTree)
      throw new Error('The staged index changed during validation. Review the index and commit again.');
  } finally {
    // Only remove the owned snapshot; rm does not follow the node_modules junctions.
    fs.rmSync(snapshot, { recursive: true, force: true });
  }
}

function prePush() {
  const head = git(['rev-parse', 'HEAD']);
  const updates = fs.readFileSync(0, 'utf8').trim().split('\n').filter(Boolean);
  for (const line of updates) {
    const [, localOid] = line.split(' ');
    if (!/^0+$/.test(localOid) && localOid !== head)
      throw new Error(
        'Pre-push validation can only qualify the checked-out commit. Check out each branch before pushing it.',
      );
  }
  if (updates.length && updates.every((line) => /^0+$/.test(line.split(' ')[1]))) return;
  if (git(['status', '--porcelain']))
    throw new Error(
      'Pre-push validation requires a clean worktree and index; the pushed HEAD must be the verified source tree.',
    );
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !fs.existsSync(npmCli)) throw new Error('Run this hook through npm run hooks:push.');
  const branch = git(['branch', '--show-current']);
  const args = ['run', 'ci:verify', '--', ...(branch === 'main' ? ['--full'] : [])];
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.error?.message ?? 'Pre-push validation failed. Push stopped.');
}

try {
  if (process.argv[2] === 'install') install();
  else if (process.argv[2] === 'pre-commit') await preCommit();
  else if (process.argv[2] === 'pre-push') prePush();
  else throw new Error('Use install, pre-commit or pre-push.');
} catch (error) {
  console.error(`Git hook: ${error.message}`);
  process.exitCode = 1;
}
