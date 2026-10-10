// Install the actual distributable into an independent project, without portal traffic.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateReleaseFiles } from './release-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.env.npm_execpath;
if (!npm || !fs.existsSync(npm)) throw new Error('Run npm run release:smoke to use the configured npm CLI.');
const directory = path.join(root, '.paqvilo', 'distribution');
fs.mkdirSync(directory, { recursive: true });
const work = fs.mkdtempSync(path.join(directory, 'smoke-'));
const run = (args, cwd, timeout = 120_000) => {
  const result = spawnSync(process.execPath, [npm, ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.error?.message ?? `${args[0]} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};

const packed = JSON.parse(run(['pack', '--json', '--ignore-scripts', '--pack-destination', work], root))[0];
validateReleaseFiles(packed.files);
const project = path.join(work, 'project');
fs.cpSync(path.join(root, 'examples/project'), project, { recursive: true, filter: (file) => !['node_modules', 'package-lock.json', '.paqvilo'].includes(path.basename(file)) });
const manifestFile = path.join(project, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
manifest.dependencies.paqvilo = `file:${path.join(work, packed.filename).replaceAll('\\', '/')}`;
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
run(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], project);
const installed = path.join(project, 'node_modules/paqvilo/bin/paqvilo.mjs');
const cli = (...args) => {
  const result = spawnSync(process.execPath, [installed, ...args], { cwd: project, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Installed command failed: ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
};
for (const product of ['lense', 'mirage']) {
  const help = spawnSync(process.execPath, [installed, product, '--help'], { cwd: project, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (help.status !== 0 || !help.stdout.toLowerCase().includes(product)) throw new Error(`Installed ${product} help failed: ${help.stderr}`);
}
const demoHelp = spawnSync(process.execPath, [installed, 'mirage', 'demo', '--help'], { cwd: project, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
if (demoHelp.status !== 0 || !demoHelp.stdout.includes('Copies a populated')) throw new Error(`Installed demo command is missing: ${demoHelp.stderr}`);
const initialized = cli('mirage', 'init', '--site', 'example', '--json');
const stateRoot = path.join(project, '.paqvilo') + path.sep;
if (!initialized.file.startsWith(stateRoot)) throw new Error('Project initialization wrote inside the installed toolkit.');
let session;
try {
  session = cli('mirage', 'start', '--site', 'example', '--port', '0', '--preset', 'example-demo', '--json');
  if (!session.stateFile.startsWith(stateRoot)) throw new Error('Runtime state did not stay in the portal project.');
  if (!cli('mirage', 'status', '--json').sessions.some((item) => item.pid === session.pid && item.ready)) throw new Error('Project-scoped status did not discover its runtime.');
  const response = await fetch(session.url);
  if (!response.ok || !(await response.text()).includes('Build it three ways')) throw new Error('Installed lifecycle did not render the project.');
} finally {
  if (session) cli('mirage', 'stop', '--site', 'example', '--json');
}
if (cli('mirage', 'status', '--json').sessions.some((item) => item.processAlive)) throw new Error('Installed lifecycle left an owned runtime running.');
const tests = run(['test'], project);
console.log(tests.trim());
console.log(`Distribution smoke passed: ${packed.files.length} files; independent offline install, command namespaces, project-scoped lifecycle and the project-owned test. Artifact: ${path.join(work, packed.filename)}`);
