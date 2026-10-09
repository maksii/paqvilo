// Audit the distributable file list without creating an archive or contacting a registry.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const DOCUMENTATION_ASSETS = new Set([
  'docs/assets/overview.svg',
  'docs/assets/lense-icon.png', 'docs/assets/mirage-icon.png',
  'docs/assets/lense-visual.png', 'docs/assets/mirage-visual.png',
]);

export const REQUIRED_RELEASE_FILES = [
  'package.json', 'README.md', 'CONTRIBUTING.md', 'AGENTS.md', '.env.example',
  'paqvilo.config.yml', 'npm-shrinkwrap.json', 'bin/paqvilo.mjs', 'lense/cli.mjs', 'scripts/ensure-dependencies.mjs', 'LICENSE', 'NOTICE',
  'mirage/cli.mjs', 'mirage/server.mjs', 'mirage/lib/importer.mjs',
  'mirage/lib/project-config.mjs', 'mirage/admin/index.html',
  'mirage/lib/bootstrap-plugins-compat.js', 'mirage/lib/datetimepicker-compat.js',
  'mirage/lib/jqueryui-dialog-compat.js', 'mirage/lib/date-format-compat.js',
  'mirage/lib/footer-spacing-compat.js',
  'mirage/lib/bootstrap-fonts/glyphicons-halflings-regular.woff2',
  'mirage/lib/bootstrap-fonts/LICENSE-bootstrap.txt',
  'mirage/admin/app.mjs', 'mirage/admin/style.css',
  'mirage/package.json',
  'mirage/package-lock.json', 'mirage/README.md',
  'mirage/MIGRATION.md', 'mirage/docs/runtime-evidence.md',
  'mirage/docs/bootstrap-and-sources.md', 'mirage/docs/dataverse-parity.md',
  'mirage/docs/sim-administration.md', 'mirage/docs/toolkit-integration.md',
  'mirage/docs/data-packs.md', 'mirage/docs/parity-evidence.md',
  'mirage/docs/README.md', 'mirage/docs/forms-lists-parity.md',
  'mirage/testing/session.mjs', 'docs/project-extensions.md', 'docs/architecture.md',
  'docs/index.md', 'docs/getting-started.md', ...DOCUMENTATION_ASSETS,
  'examples/project/pack/pack.mjs', 'examples/project/test/portal.test.mjs', 'examples/project/gitignore.template',
];
export function validateReleaseFiles(files) {
  const allowed = /^(?:package\.json|npm-shrinkwrap\.json|README\.md|CONTRIBUTING\.md|AGENTS\.md|LICENSE|NOTICE|\.env\.example|paqvilo\.config\.yml|bin\/paqvilo\.mjs|scripts\/ensure-dependencies\.mjs|lense\/[a-z0-9/-]+\.mjs|docs\/[a-z0-9-]+\.md|examples\/project\/(?:README\.md|package\.json|paqvilo\.config\.yml|gitignore\.template|(?:pack|test)\/[a-z0-9.-]+\.mjs|portal\/[a-zA-Z0-9./_-]+\.(?:yml|html|css|js))|mirage\/(?:[a-z0-9-]+\.mjs|package(?:-lock)?\.json|README\.md|MIGRATION\.md|lib\/[a-z0-9-]+\.(?:mjs|js|css|json)|lib\/bootstrap-fonts\/(?:glyphicons-halflings-regular\.(?:eot|svg|ttf|woff2?)|LICENSE-bootstrap\.txt)|admin\/(?:index\.html|app\.mjs|style\.css)|testing\/[a-z0-9-]+\.mjs|docs\/(?:README|[a-z0-9-]+)\.md))$/;
  const paths = new Set(files.map((file) => file.path));
  // Allow only named product illustrations, never arbitrary screenshots or evidence.
  for (const name of paths) if (!allowed.test(name) && !DOCUMENTATION_ASSETS.has(name)) throw new Error(`Unexpected release file: ${name}`);
  for (const name of REQUIRED_RELEASE_FILES) if (!paths.has(name)) throw new Error(`Required release file is missing: ${name}`);
  return paths.size;
}

function checkEditorTasks(root) {
  const tasks = JSON.parse(fs.readFileSync(path.join(root, '.vscode/tasks.json'), 'utf8'));
  const launch = JSON.parse(fs.readFileSync(path.join(root, '.vscode/launch.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const labels = new Set(tasks.tasks.map((task) => task.label));
  if (labels.size !== tasks.tasks.length) throw new Error('Duplicate editor task labels');
  for (const task of tasks.tasks) {
    for (const dependency of [task.dependsOn ?? []].flat()) if (!labels.has(dependency)) throw new Error(`Missing editor task: ${dependency}`);
    if (task.type === 'npm' && !pkg.scripts[task.script]) throw new Error(`Missing npm script in editor task: ${task.script}`);
    if (task.command === 'node' && !fs.existsSync(path.join(root, task.args[0]))) throw new Error(`Missing editor task program: ${task.args[0]}`);
  }
  for (const config of launch.configurations) {
    if (config.preLaunchTask && !labels.has(config.preLaunchTask)) throw new Error(`Missing debugger task: ${config.preLaunchTask}`);
    if (config.program && !fs.existsSync(config.program.replace('${workspaceFolder}', root))) throw new Error(`Missing debugger program: ${config.program}`);
  }
}

function checkDocumentation(root) {
  for (const name of ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'docs/index.md', 'docs/getting-started.md', 'docs/lense.md', 'docs/configuration.md', 'examples/project/README.md', 'mirage/README.md', 'mirage/MIGRATION.md', 'mirage/docs/README.md', 'mirage/docs/runtime-evidence.md']) {
    const text = fs.readFileSync(path.join(root, name), 'utf8');
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^https?:/.test(target)) continue;
      if (!fs.existsSync(path.resolve(root, path.dirname(name), target))) throw new Error(`Broken documentation link in ${name}: ${target}`);
    }
  }
  for (const name of ['.env', 'paqvilo.config.local.yml']) {
    if (!fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes(name)) throw new Error(`Personal state is not ignored: ${name}`);
  }
}

// npm provenance rejects a publish whose repository.url does not name the source repository.
export function checkPackageMetadata(pkg) {
  if (!/^git\+https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(pkg.repository?.url ?? '')) throw new Error('package.json repository.url must be git+https://github.com/<owner>/<repo>.git for npm provenance');
}

function checkLockConsistency(root) {
  const packageLock = fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8');
  const shrinkwrap = fs.readFileSync(path.join(root, 'npm-shrinkwrap.json'), 'utf8');
  if (packageLock !== shrinkwrap) throw new Error('npm-shrinkwrap.json must match package-lock.json');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    checkDocumentation(root);
    checkLockConsistency(root);
    checkPackageMetadata(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')));
    checkEditorTasks(root);
    const npmCli = process.env.npm_execpath;
    if (!npmCli || !fs.existsSync(npmCli)) throw new Error('Run npm run release:check so the configured npm CLI is used');
    const packed = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    if (packed.status !== 0) throw new Error(packed.error?.message ?? packed.stderr.trim());
    const report = JSON.parse(packed.stdout)[0];
    const count = validateReleaseFiles(report.files);
    console.log(`Release check passed: ${count} allowlisted files, ${report.unpackedSize} bytes; documentation links and editor tasks valid.`);
  } catch (error) { console.error(`Release check failed: ${error.message}`); process.exitCode = 1; }
}
