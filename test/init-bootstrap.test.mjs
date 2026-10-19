import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { prepareProject } from '../lense/project-scaffold.mjs';

const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PAQVILO_|^npm_config_/i.test(key)));
const exists = async file => { try { await fs.access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-bootstrap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}
function run(args, { cwd, env = cleanEnv() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Fixture child exceeded 30 seconds')); }, 30000);
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}
async function npmCli() {
  const candidates = [process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  for (const file of candidates.filter(Boolean)) if (await exists(file)) return file;
  throw new Error('The bootstrap regression requires the installed npm CLI; run it through npm test.');
}
async function countingOrigin(t) {
  const paths = [];
  const server = http.createServer((request, response) => { paths.push(request.url); response.writeHead(503).end('Invented unavailable endpoint'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { origin: `http://127.0.0.1:${server.address().port}`, count: () => paths.length, paths };
}

test('generated bootstrap installs local dependencies once, uses unchanged lockfile for ci and never retries a lock mismatch', async t => {
  const root = await workspace(t), directory = path.join(root, 'project');
  const registry = await countingOrigin(t);
  await prepareProject(directory, { name: 'bootstrap-fixture', noPack: true, noVscode: true });
  assert.equal(await exists(path.join(directory, 'package-lock.json')), false, 'generation installs nothing');
  assert.equal(await exists(path.join(directory, 'node_modules')), false, 'generation creates no dependencies');
  const manifestFile = path.join(directory, 'package.json');
  const scaffold = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  assert.equal(scaffold.scripts.setup, 'node tools/bootstrap.mjs && npm run check:setup');
  assert.equal(scaffold.scripts['check:setup'], 'paqvilo doctor --setup --config ./paqvilo.config.yml');
  const dependency = path.join(root, 'dependency');
  await fs.mkdir(dependency);
  await fs.writeFile(path.join(dependency, 'package.json'), JSON.stringify({ name: 'invented-local-dependency', version: '1.0.0', scripts: { install: 'node lifecycle.cjs' } }));
  await fs.writeFile(path.join(dependency, 'lifecycle.cjs'), "require('node:fs').writeFileSync(require('node:path').join(__dirname,'dependency-lifecycle-ran'),'unexpected');");
  await fs.writeFile(path.join(directory, 'lifecycle.cjs'), "require('node:fs').writeFileSync('root-lifecycle-ran','unexpected');");
  await fs.writeFile(manifestFile, JSON.stringify({ name: 'bootstrap-fixture', version: '1.0.0', private: true,
    scripts: { preinstall: 'node lifecycle.cjs', install: 'node lifecycle.cjs', postinstall: 'node lifecycle.cjs', prepare: 'node lifecycle.cjs' },
    devDependencies: { 'invented-local-dependency': 'file:../dependency' } }));
  const env = { ...cleanEnv(), npm_execpath: await npmCli(), NODE_ENV: 'production', npm_config_offline: 'true',
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', npm_config_registry: registry.origin, npm_config_cache: path.join(root, 'cache') };
  const bootstrap = () => run([path.join(directory, 'tools/bootstrap.mjs')], { cwd: directory, env });
  const first = await bootstrap();
  assert.equal(first.status, 0, first.stderr); assert.match(first.stdout, /npm install --ignore-scripts/);
  const lockFile = path.join(directory, 'package-lock.json'), lock = await fs.readFile(lockFile, 'utf8');
  assert.equal(await exists(path.join(directory, 'node_modules/invented-local-dependency/package.json')), true, '--include=dev overrides production omission');
  const repeat = await bootstrap();
  assert.equal(repeat.status, 0, repeat.stderr); assert.match(repeat.stdout, /npm ci --ignore-scripts/);
  assert.equal(await fs.readFile(lockFile, 'utf8'), lock, 'repeat ci cannot update dependency resolution');
  assert.equal(await exists(path.join(directory, 'root-lifecycle-ran')), false);
  assert.equal(await exists(path.join(dependency, 'dependency-lifecycle-ran')), false);
  const extra = path.join(root, 'extra'); await fs.mkdir(extra);
  await fs.writeFile(path.join(extra, 'package.json'), JSON.stringify({ name: 'invented-extra-dependency', version: '1.0.0' }));
  const changed = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  changed.devDependencies['invented-extra-dependency'] = 'file:../extra'; await fs.writeFile(manifestFile, JSON.stringify(changed));
  const mismatch = await bootstrap();
  assert.notEqual(mismatch.status, 0); assert.match(mismatch.stdout, /npm ci --ignore-scripts/);
  assert.doesNotMatch(mismatch.stdout, /npm install --ignore-scripts/);
  assert.equal(await fs.readFile(lockFile, 'utf8'), lock, 'failed ci must not fall back to install');
  assert.equal(await exists(path.join(directory, 'node_modules/invented-extra-dependency')), false);
  assert.deepEqual(registry.paths, [], 'offline local dependency preparation never accesses a registry');
});

test('setup readiness resolves configured, personal and explicit browser choices without importing sources or contacting portals', async t => {
  const directory = await workspace(t), portal = await countingOrigin(t);
  const configFile = path.join(directory, 'paqvilo.config.yml'), marker = path.join(directory, 'pack-executed');
  await fs.writeFile(path.join(directory, 'pack.mjs'), "import fs from 'node:fs'; fs.writeFileSync(new URL('./pack-executed',import.meta.url),'unexpected'); throw new Error('Must not execute');");
  await fs.writeFile(path.join(directory, 'profile.json'), 'Malformed deployment value sentinel');
  await fs.writeFile(configFile, YAML.stringify({ sourceRoot: './missing-exports', defaultSite: 'invented',
    sites: { invented: { source: 'missing-portal', defaultEnv: 'dev', environments: { dev: portal.origin }, mirage: {
      dataPacks: ['./pack.mjs'], deploymentProfiles: { profiles: { nonselected: { pages: './profile.json' } } },
    } } }, browser: { channel: 'chromium' } }));
  const check = async (expected, { env = {}, args = [] } = {}) => {
    const result = await run([cli, 'doctor', '--setup', '--config', configFile, '--json', ...args], { cwd: directory, env: { ...cleanEnv(), ...env } });
    const report = JSON.parse(result.stdout);
    assert.equal(report.command, 'setup', result.stdout); assert.equal(report.offline, true);
    assert.equal(report.prerequisites.browser.channel, expected);
    assert.equal(report.prerequisites.browser.launchVerified, false);
    assert.equal(result.stdout.includes('Malformed deployment value sentinel'), false);
  };
  await check('chromium');
  await fs.writeFile(path.join(directory, '.env'), 'PAQVILO_BROWSER=chrome\n');
  await check('chrome');
  await check('msedge', { env: { PAQVILO_BROWSER: 'msedge' } });
  await check('chromium', { env: { PAQVILO_BROWSER: 'msedge' }, args: ['--browser', 'chromium'] });
  for(const browser of ['', 'unexpected']){
    const result=await run([cli,'doctor','--setup','--config',configFile,'--browser='+browser,'--json'],{cwd:directory,env:cleanEnv()});
    assert.equal(result.status,1);
    assert.equal(JSON.parse(result.stdout).error.code,'SETUP_CHECK_FAILED');
    assert.match(JSON.parse(result.stdout).error.message,/--browser must be/);
  }
  assert.equal(await exists(path.join(directory, 'missing-exports')), false);
  assert.equal(await exists(marker), false, 'registered pack code was not imported');
  assert.equal(portal.count(), 0, 'browser presence checks never contact configured portals');
});
