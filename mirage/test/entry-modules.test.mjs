// @test-kind contract: every module a user or another package loads first (package exports, bins and the named entry files) loads on its own in a fresh process
// An import cycle can leave a binding uninitialized only when a particular module is the first one loaded; a test
// process that imported something else first never sees it. Each entry therefore loads in its own child process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const rootPackage = JSON.parse(fs.readFileSync(new URL('package.json', ROOT), 'utf8'));
const miragePackage = JSON.parse(fs.readFileSync(new URL('mirage/package.json', ROOT), 'utf8'));

// The runtime target of an exports entry: a path, or the `default` (else `import`) of a conditional entry.
const target = (entry) => (typeof entry === 'string' ? entry : (entry?.default ?? entry?.import));
// Exported files of a package; wildcard subpaths and JSON files are not entry modules.
const exportedModules = (pkg, base) =>
  Object.entries(typeof pkg.exports === 'string' ? { '.': pkg.exports } : (pkg.exports ?? {}))
    .filter(([subpath]) => !subpath.includes('*'))
    .map(([, entry]) => target(entry))
    .filter((file) => file && !file.endsWith('.json'))
    .map((file) => new URL(file, base));
const bins = (pkg, base) =>
  Object.values(typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {})).map(
    (file) => new URL(file, base),
  );

const MIRAGE = new URL('mirage/', ROOT);
const modules = new Set(
  [
    ...exportedModules(rootPackage, ROOT),
    ...exportedModules(miragePackage, MIRAGE),
    new URL('lib/config-keys.mjs', MIRAGE),
    new URL('lib/dataverse-security.mjs', MIRAGE),
    new URL('lib/data.mjs', MIRAGE),
    new URL('server.mjs', MIRAGE),
    new URL('lense/config.mjs', ROOT),
  ].map((url) => url.href),
);
const clis = new Set(
  [...bins(rootPackage, ROOT), ...bins(miragePackage, MIRAGE), new URL('cli.mjs', MIRAGE)].map((url) => url.href),
);

// The repository-relative path of an entry, for test names.
const label = (href) => path.relative(fileURLToPath(ROOT), fileURLToPath(href)).replaceAll(path.sep, '/');

// Runs node with the arguments in a fresh process; settles when its output streams have closed.
function run(args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, args, { cwd: fileURLToPath(ROOT), env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (text) => (stderr += text));
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stderr }));
  });
}

test('the entry list covers the package exports, the bins and the named entry files', () => {
  assert.ok(modules.has(new URL('mirage/lib/config-keys.mjs', ROOT).href));
  assert.ok(modules.has(new URL('mirage/api.mjs', ROOT).href), 'the root package exports are listed');
  assert.ok(clis.has(new URL('bin/paqvilo.mjs', ROOT).href), 'the root package bin is listed');
  for (const href of [...modules, ...clis]) assert.ok(fs.existsSync(new URL(href)), `${href} exists`);
});

for (const href of modules)
  test(`${label(href)} loads as the first module of a process`, async () => {
    const result = await run(['--input-type=module', '-e', `await import(${JSON.stringify(href)});`]);
    assert.deepEqual(result, { code: 0, signal: null, stderr: '' });
  });

for (const href of clis)
  test(`${label(href)} --help runs as the first module of a process`, async () => {
    const result = await run([fileURLToPath(href), '--help']);
    assert.deepEqual(result, { code: 0, signal: null, stderr: '' });
  });
