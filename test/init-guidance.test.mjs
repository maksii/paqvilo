// @test-kind contract: init, setup and demo guidance names options, scripts and commands that exist where the user runs them
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareProject } from '../lense/project-scaffold.mjs';
import { checkProject, scaffoldWarning } from '../lense/project-check.mjs';
import { pickSiteAndEnv } from '../lense/prompt.mjs';
import { tempDir } from './fixture.mjs';

const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
const run = (args, options = {}) =>
  new Promise((resolve) =>
    execFile(
      process.execPath,
      [cli, ...args],
      { env, encoding: 'utf8', windowsHide: true, ...options },
      (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }),
    ),
  );
async function folder(t) {
  const directory = await tempDir('paqvilo-init-guidance-');
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return directory;
}

test('init --into-existing names only the scripts the kept package.json has', async (t) => {
  const directory = await folder(t);
  await fs.writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name: 'kept',
      devDependencies: { paqvilo: '^0.9.0' },
      scripts: { test: 'node --test', 'check:project': 'paqvilo init --ready --config ./paqvilo.config.yml' },
    }),
  );
  const report = await prepareProject(directory, { name: 'kept', intoExisting: true });
  assert.ok(report.skipped.includes('package.json'));
  assert.deepEqual(report.next, [
    'npx --no-install paqvilo doctor --setup',
    'npx --no-install paqvilo setup --open',
    'npx --no-install paqvilo init --check',
    'npm run check:project',
  ]);
  assert.equal(
    report.adoption,
    'Files were added without merging existing package/configuration. Run npm run check:project to review integration diagnostics.',
  );
});

test('the scaffold marker warning runs the check script in the project and names the folder elsewhere', async (t) => {
  const directory = await folder(t);
  await prepareProject(directory, { name: 'warn' });
  assert.equal(
    scaffoldWarning(directory, directory),
    'Project scaffold has unfinished markers; run npm run check:scaffold.',
  );
  const elsewhere = scaffoldWarning(directory, path.dirname(directory));
  assert.ok(elsewhere.includes(` init --check ${directory}.`), elsewhere);
  assert.doesNotMatch(elsewhere, /npm run/);
});

test('init --ready hints run the project scripts from the project folder', async (t) => {
  const directory = await folder(t);
  await prepareProject(directory, { name: 'ready' });
  const result = await run(['init', '--ready'], { cwd: directory });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(
    result.stdout.includes(
      'Offline doctor gate failed; run npm run doctor -- --all --mirage for detailed local diagnostics.',
    ),
    result.stdout,
  );
  assert.ok(
    result.stdout.includes('Complete this item; run npm run check:scaffold for file:line guidance.'),
    result.stdout,
  );
  assert.doesNotMatch(result.stdout, /run paqvilo |use init --check/);
});

test('a prompt without a terminal names its own option', async (t) => {
  const directory = await folder(t);
  const result = await run(['init', path.join(directory, 'new'), '--interactive']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Name it instead, e\.g\. --browser msedge/);
  const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
  t.after(() => (tty ? Object.defineProperty(process.stdin, 'isTTY', tty) : delete process.stdin.isTTY));
  const catalogue = {
    sites: { portal: { environments: { dev: { url: 'http://127.0.0.1:1' }, test: { url: 'http://127.0.0.1:2' } } } },
  };
  await assert.rejects(pickSiteAndEnv(catalogue, { site: 'portal' }), /e\.g\. --env dev$/);
});

test('init --check reports an inherited solutionRoots warning at its defaults key', async (t) => {
  const directory = await folder(t);
  await prepareProject(directory, { name: 'roots' });
  const file = path.join(directory, 'paqvilo.config.yml');
  const text = (await fs.readFile(file, 'utf8')).replace(
    /(\n {4}solutionRoots:\n) {6}\[\]\n/,
    '$1      - absent/core\n',
  );
  await fs.writeFile(file, text);
  const key = text.split('\n').findIndex((line) => line === '    solutionRoots:') + 1;
  assert.ok(key > 1);
  const roots = checkProject(directory, { processEnv: {} }).todo.filter((item) =>
    item.text.startsWith('sites.portal.mirage.solutionRoots:'),
  );
  assert.equal(roots.length, 1);
  assert.equal(roots[0].line, key);
});

test('setup names both conflicting values and reports a project file as project', async (t) => {
  const directory = await folder(t);
  const conflict = await run(['setup', '--config', 'a.yml', '--project', 'b.yml'], { cwd: directory });
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /--config a\.yml and --project b\.yml are alternatives; select one/);
  const child = spawn(process.execPath, [cli, 'setup', '--project', 'site.yml', '--json'], {
    cwd: directory,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  let output = '';
  try {
    for await (const chunk of child.stdout) {
      output += chunk;
      if (output.includes('\n')) break;
    }
  } finally {
    // The server runs in the test folder: it has ended before the folder is removed.
    child.kill();
    await exited;
  }
  const report = JSON.parse(output.split('\n')[0]);
  assert.equal(report.project, 'site.yml');
  assert.equal(report.config, 'site.yml');
});

// @test-kind tooling: the banner text is printed only by a run that opens a browser, so its source is read
test('the demo banner spells plug-in as the product documentation does', async () => {
  const source = await fs.readFile(new URL('../lense/commands/demo.mjs', import.meta.url), 'utf8');
  assert.match(source, /check plug-in validation\./);
  assert.doesNotMatch(source, /\bplugin validation/);
});
