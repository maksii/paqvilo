import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { dependencyReadiness } from './ensure-dependencies.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim());
  return result.stdout.trim();
}

function install() {
  if (path.resolve(git(['rev-parse', '--show-toplevel'])) !== root) throw new Error('Install hooks from the toolkit checkout.');
  const current = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (current.stdout.trim() && current.stdout.trim() !== '.githooks') throw new Error(`Existing core.hooksPath is ${current.stdout.trim()}; reconcile it with .githooks before installing.`);
  for (const name of ['pre-commit', 'commit-msg']) fs.chmodSync(path.join(root, '.githooks', name), 0o755);
  git(['config', '--local', 'core.hooksPath', '.githooks']);
  console.log('Installed local hooks: staged-source validation and Conventional Commits.');
}

// Export the index instead of testing unstaged edits. Never stash or mutate contributor files.
function preCommit() {
  const parent = path.join(root, '.paqvilo', 'hooks');
  fs.mkdirSync(parent, { recursive: true });
  const snapshot = fs.mkdtempSync(path.join(parent, 'staged-'));
  try {
    git(['checkout-index', '--all', `--prefix=${snapshot.replaceAll('\\', '/')}/`]);
    for (const directory of ['', 'mirage']) {
      const source = path.join(root, directory, 'node_modules');
      if (fs.existsSync(source)) fs.symlinkSync(source, path.join(snapshot, directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    const ready = dependencyReadiness(snapshot);
    if (!ready.ready) throw new Error(`${ready.reason} Stage consistent manifests, then run npm run setup.`);
    const npmCli = process.env.npm_execpath;
    if (!npmCli || !fs.existsSync(npmCli)) throw new Error('Run this hook through npm run hooks:check.');
    // Git's hook environment otherwise leaks the original index into synthetic test repositories.
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
    console.log('Validating staged sources: syntax, boundary, unit/browser tests and package contents.');
    const result = spawnSync(process.execPath, [npmCli, 'run', 'validate'], { cwd: snapshot, env, stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) throw new Error(result.error?.message ?? 'Staged validation failed. Commit stopped.');
  } finally {
    // Only remove the owned snapshot; rm does not follow the node_modules junctions.
    fs.rmSync(snapshot, { recursive: true, force: true });
  }
}

try {
  if (process.argv[2] === 'install') install();
  else if (process.argv[2] === 'pre-commit') preCommit();
  else throw new Error('Use install or pre-commit.');
} catch (error) { console.error(`Git hook: ${error.message}`); process.exitCode = 1; }
