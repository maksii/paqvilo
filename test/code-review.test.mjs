import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {
  inspectDeadCode,
  inspectClones,
  compareReview,
  reviewInventory,
  publicApiOrigins,
} from '../scripts/code-review.mjs';
import { browserSources, knipConfig } from '../scripts/code-review.config.mjs';
import { tempDir } from './fixture.mjs';

const copiedLogic = `export function calculate(items) {\n${Array.from({ length: 20 }, (_, i) => ` const value${i} = items[${i}] * ${i + 1} + ${i + 5};`).join('\n')}\n return [${Array.from({ length: 20 }, (_, i) => `value${i}`).join(',')}];\n}\n`;

test('review tools detect an orphan module, unused export and copied logic without editing sources', async () => {
  const root = await tempDir('paqvilo-review-');
  try {
    const config = path.join(root, 'knip.json');
    await fs.writeFile(path.join(root, 'package.json'), '{"private":true,"type":"module"}');
    await fs.writeFile(config, JSON.stringify({ entry: ['entry.mjs'], project: ['*.mjs'], includeEntryExports: true }));
    await fs.writeFile(path.join(root, 'entry.mjs'), "import { used } from './logic.mjs'; console.log(used());\n");
    await fs.writeFile(path.join(root, 'logic.mjs'), 'export const used = () => 1; export const unused = () => 2;\n');
    await fs.writeFile(path.join(root, 'orphan.mjs'), 'export const stranded = 3;\n');
    const dead = inspectDeadCode(root, config);
    assert.ok(dead.some((item) => item.type === 'files' && item.file === 'orphan.mjs'));
    assert.ok(dead.some((item) => item.type === 'exports' && item.name === 'unused'));
    assert.ok(!dead.some((item) => item.name === 'used'));
    const block = copiedLogic;
    for (const file of ['copy-a.mjs', 'copy-b.mjs']) await fs.writeFile(path.join(root, file), block);
    const clones = inspectClones(root, ['copy-a.mjs', 'copy-b.mjs'], path.join(root, 'reports'));
    assert.ok(clones.length > 0);
    const cloneReport = JSON.parse(await fs.readFile(path.join(root, 'reports/jscpd-report.json'), 'utf8'));
    assert.deepEqual(
      [cloneReport.duplicates[0].firstFile.name, cloneReport.duplicates[0].secondFile.name].sort(),
      [path.join(root, 'copy-a.mjs'), path.join(root, 'copy-b.mjs')]
        .map((file) => syncFs.realpathSync.native(file))
        .sort(),
      'persisted evidence points back to source after its temporary snapshot is removed',
    );
    assert.equal(compareReview(clones, []).length, clones.length);
    assert.equal(compareReview(clones, clones).length, 0);
    assert.equal(
      compareReview([...clones, clones[0]], clones).length,
      1,
      'another occurrence of an accepted clone needs review',
    );
    await fs.writeFile(path.join(root, 'copy-a.mjs'), '\n\n' + block);
    const shifted = inspectClones(root, ['copy-a.mjs', 'copy-b.mjs'], path.join(root, 'shifted'));
    assert.deepEqual(
      shifted.map((item) => item.key),
      clones.map((item) => item.key),
      'line shifts do not create findings',
    );
    assert.equal(
      await fs.readFile(path.join(root, 'logic.mjs'), 'utf8'),
      'export const used = () => 1; export const unused = () => 2;\n',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analysis accepts explicitly aliased roots and rebases clone paths from a canonical temporary root', async (t) => {
  const fixture = await tempDir('paqvilo-root-alias-review-');
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const physical = path.join(fixture, 'physical-source'),
    alias = path.join(fixture, 'source-alias');
  const temporary = path.join(fixture, 'physical-temp'),
    temporaryAlias = path.join(fixture, 'temp-alias');
  await fs.mkdir(path.join(physical, 'mirage/lib'), { recursive: true });
  await fs.mkdir(temporary);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(physical, alias, linkType);
  await fs.symlink(temporary, temporaryAlias, linkType);
  await fs.writeFile(
    path.join(physical, 'package.json'),
    JSON.stringify({ type: 'module', exports: { './mirage': './mirage/api.mjs' } }),
  );
  await fs.writeFile(path.join(physical, 'mirage/api.mjs'), "export { used as publicName } from './lib/logic.mjs';");
  await fs.writeFile(path.join(physical, 'mirage/lib/logic.mjs'), 'export const used = 1;');
  await fs.writeFile(path.join(physical, 'mirage/lib/orphan.mjs'), 'console.log("invented stranded module");');
  const config = path.join(physical, 'knip.json');
  await fs.writeFile(
    config,
    JSON.stringify({ entry: ['mirage/api.mjs'], project: ['mirage/**/*.mjs'], includeEntryExports: true }),
  );
  for (const name of ['copy-a.mjs', 'copy-b.mjs']) await fs.writeFile(path.join(physical, name), copiedLogic);
  t.mock.method(os, 'tmpdir', () => temporaryAlias);
  const origins = publicApiOrigins(alias);
  assert.ok(origins.has('mirage/lib/logic.mjs:used'));
  assert.deepEqual([...origins].sort(), [...publicApiOrigins(physical)].sort());
  assert.ok(
    inspectDeadCode(alias, config).some((item) => item.type === 'files' && item.file === 'mirage/lib/orphan.mjs'),
  );
  assert.ok(reviewInventory(alias).runtime.includes('mirage/lib/logic.mjs'));
  const output = path.join(fixture, 'report');
  const clones = inspectClones(alias, ['copy-a.mjs', 'copy-b.mjs'], output);
  assert.ok(clones.length > 0);
  assert.deepEqual(clones[0].files, ['copy-a.mjs', 'copy-b.mjs']);
  const report = JSON.parse(await fs.readFile(path.join(output, 'jscpd-report.json'), 'utf8'));
  for (const file of [report.duplicates[0].firstFile, report.duplicates[0].secondFile])
    assert.equal(path.dirname(file.name), syncFs.realpathSync.native(physical));
  assert.deepEqual(await fs.readdir(temporary), [], 'canonical snapshots are still removed');
});

test('native Git-root identity retains indexed-link refusals when legacy realpath preserves an alias spelling', async (t) => {
  const fixture = await tempDir('paqvilo-git-root-alias-');
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, 'repository-with-a-long-directory-name'),
    alias = path.join(fixture, 'repo-alias');
  const linked = path.join(root, 'mirage/lib/linked'),
    privateSource = path.join(root, '.paqvilo/private');
  await fs.mkdir(linked, { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), '{"private":true,"type":"module"}');
  await fs.writeFile(path.join(linked, 'source.mjs'), 'console.log("tracked placeholder");');
  for (const args of [
    ['init', '--quiet'],
    ['add', '.'],
  ])
    assert.equal(spawnSync('git', args, { cwd: root, windowsHide: true }).status, 0);
  await fs.rename(linked, `${linked}-original`);
  await fs.mkdir(privateSource, { recursive: true });
  await fs.writeFile(path.join(privateSource, 'source.mjs'), 'console.log("invented private sentinel");');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(privateSource, linked, linkType);
  await fs.symlink(root, alias, linkType);
  const requested = [alias];
  if (process.platform === 'win32') {
    // Read-only conversion uses the actual volume's 8.3 alias when available.
    const short = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${root}") do @echo %~sI"`], {
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    assert.equal(short.status, 0);
    assert.equal(syncFs.realpathSync.native(short.stdout.trim()), syncFs.realpathSync.native(root));
    requested.push(short.stdout.trim());
  }
  const legacy = syncFs.realpathSync;
  t.mock.method(syncFs, 'realpathSync', (file, ...args) =>
    path.resolve(file) === path.resolve(alias) ? path.resolve(alias) : legacy(file, ...args),
  );
  assert.equal(syncFs.realpathSync.native, legacy.native);
  for (const directory of requested) assert.throws(() => reviewInventory(directory), /linked path/);
});

test('review models browser URL aliases and explicit API roots without wildcard public roots', () => {
  assert.match(
    browserSources("import './ui-kit.mjs';", 'D:/repo/lense/setup/app.mjs'),
    /\.\.\/\.\.\/mirage\/admin\/ui-kit/,
  );
  assert.match(
    browserSources("import './persona-search.mjs';", 'D:/repo/mirage/admin/app.mjs'),
    /\.\.\/lib\/persona-search/,
  );
  assert.match(
    browserSources("import '/_apps/assets/controls.mjs';", 'D:/repo/mirage/test-browser/control.test.mjs'),
    /\.\.\/lib\/model-driven\/controls/,
  );
  assert.ok(knipConfig().entry.includes('mirage/api.mjs'));
  assert.ok(!knipConfig().entry.some((file) => /lib\/\*\.mjs/.test(file)));
  const inventory = reviewInventory();
  assert.ok(inventory.runtime.includes('mirage/lib/data.mjs'));
  assert.ok(inventory.tests.includes('test/code-review.test.mjs'));
  assert.ok(inventory.tests.includes('examples/project/test/portal.test.mjs'));
  assert.ok(inventory.tests.some((file) => file.startsWith('examples/company-operations/test/')));
  assert.ok(
    !Object.values(inventory)
      .flat()
      .some((file) => /(?:fixtures|\.paqvilo|node_modules)\//.test(file)),
  );
});

test('public API origins follow named aliases and wildcard reexports without executing implementations', async () => {
  const root = await tempDir('paqvilo-public-review-');
  try {
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        type: 'module',
        exports: {
          './api': './api.mjs',
          './typed': { types: './typed.d.ts', import: { default: './typed.mjs' } },
          './internal/*': './*',
        },
      }),
    );
    await fs.writeFile(
      path.join(root, 'api.mjs'),
      "export { original as publicName } from './logic.mjs'; export * from './more.mjs';",
    );
    await fs.writeFile(
      path.join(root, 'logic.mjs'),
      "throw new Error('analysis must not execute'); export function original() {} export const privateName = 1;",
    );
    await fs.writeFile(path.join(root, 'more.mjs'), 'export const otherPublicName = 2;');
    await fs.writeFile(path.join(root, 'typed.d.ts'), 'export declare function typed(): void;');
    await fs.writeFile(path.join(root, 'typed.mjs'), "throw new Error('must not execute'); export function typed() {}");
    const origins = publicApiOrigins(root);
    assert.ok(origins.has('api.mjs:publicName'));
    assert.ok(origins.has('logic.mjs:original'));
    assert.ok(origins.has('more.mjs:otherPublicName'));
    assert.ok(origins.has('typed.d.ts:typed'));
    assert.ok(origins.has('typed.mjs:typed'));
    assert.ok(!origins.has('logic.mjs:privateName'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('actual runtime and full configuration detect body-only orphans despite package wildcard exports', async () => {
  const root = await tempDir('paqvilo-wildcard-review-');
  const config = new URL('../scripts/code-review.config.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  try {
    await fs.mkdir(path.join(root, 'bin'), { recursive: true });
    await fs.mkdir(path.join(root, 'mirage/lib'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        name: 'paqvilo',
        exports: { './mirage': './mirage/api.mjs', './mirage/*': './mirage/*' },
      }),
    );
    await fs.writeFile(
      path.join(root, 'bin/paqvilo.mjs'),
      "import { used } from '../mirage/lib/logic.mjs'; console.log(used());",
    );
    await fs.writeFile(path.join(root, 'mirage/api.mjs'), "export { used as publicName } from './lib/logic.mjs';");
    await fs.writeFile(
      path.join(root, 'mirage/lib/logic.mjs'),
      'export const used = () => 1; export const unused = () => 2;',
    );
    await fs.writeFile(path.join(root, 'mirage/lib/body-only.mjs'), "console.log('stranded module');");
    for (const scope of ['runtime', 'full']) {
      const findings = inspectDeadCode(root, config, scope);
      assert.ok(
        findings.some((item) => item.type === 'files' && item.file === 'mirage/lib/body-only.mjs'),
        scope,
      );
      assert.ok(
        findings.some((item) => item.type === 'exports' && item.name === 'unused'),
        scope,
      );
      assert.ok(!findings.some((item) => item.name === 'used' || item.name === 'publicName'), scope);
    }
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    assert.equal(manifest.exports['./mirage/*'], './mirage/*', 'source manifest remains intact');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Git-indexed linked ancestors cannot expose outside or ignored private sources to review', async (t) => {
  const fixture = await tempDir('paqvilo-linked-review-');
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, 'repo'),
    linked = path.join(root, 'mirage/lib/linked');
  await fs.mkdir(linked, { recursive: true });
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ type: 'module', exports: { './mirage': './mirage/api.mjs' } }),
  );
  await fs.writeFile(path.join(root, 'mirage/api.mjs'), "export { value } from './lib/linked/orphan.mjs';");
  await fs.writeFile(path.join(linked, 'orphan.mjs'), 'export const value = 1;');
  const config = path.join(root, 'knip.json');
  await fs.writeFile(
    config,
    JSON.stringify({ entry: ['mirage/api.mjs'], project: ['mirage/**/*.mjs'], includeEntryExports: true }),
  );
  for (const args of [
    ['init', '--quiet'],
    ['add', '.'],
  ])
    assert.equal(spawnSync('git', args, { cwd: root, windowsHide: true }).status, 0);
  await fs.rename(linked, `${linked}-original`);
  for (const target of [path.join(fixture, 'outside'), path.join(root, '.paqvilo/private')]) {
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'orphan.mjs'), 'export const value = "invented private sentinel";');
    await fs.symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const open = syncFs.openSync;
    const mock = t.mock.method(syncFs, 'openSync', (file, ...args) => {
      assert.ok(!String(file).startsWith(target), 'private sentinel bytes must never be opened');
      return open(file, ...args);
    });
    try {
      assert.throws(() => inspectDeadCode(root, config), /linked path/);
      assert.throws(() => reviewInventory(root), /linked path/);
      assert.throws(() => publicApiOrigins(root), /linked path/);
      assert.throws(
        () => inspectClones(root, ['mirage/lib/linked/orphan.mjs'], path.join(fixture, 'report')),
        /linked path/,
      );
    } finally {
      mock.mock.restore();
      await fs.unlink(linked);
    }
  }
  const privateName = process.platform === 'win32' ? '.PAQVILO' : '.paqvilo';
  await fs.writeFile(
    path.join(root, 'mirage/api.mjs'),
    `export { value } from '../${privateName}/private/orphan.mjs';`,
  );
  assert.throws(() => publicApiOrigins(root), /excluded directory/);
  await fs.writeFile(path.join(root, 'mirage/api.mjs'), "export { value } from '../../outside/orphan.mjs';");
  assert.throws(() => publicApiOrigins(root), /escapes its workspace/);
});

test('oversized modeled modules fail explicitly while large unmodeled JSON does not expand read bounds', async (t) => {
  const root = await tempDir('paqvilo-large-review-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'mirage/lib'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), '{"private":true,"type":"module"}');
  await fs.writeFile(path.join(root, 'entry.mjs'), 'console.log(1);');
  const config = path.join(root, 'knip.json');
  await fs.writeFile(config, JSON.stringify({ entry: ['entry.mjs'], project: ['entry.mjs', 'mirage/**/*.mjs'] }));
  const makeLarge = async (name) => {
    const handle = await fs.open(path.join(root, name), 'wx');
    await handle.truncate(5 * 1024 * 1024 + 1);
    await handle.close();
  };
  await makeLarge('large-fixture.json');
  assert.deepEqual(inspectDeadCode(root, config), []);
  await makeLarge('mirage/lib/large.mjs');
  assert.throws(() => inspectDeadCode(root, config), /5 MiB limit: mirage[\\/]lib[\\/]large.mjs/);
  assert.throws(() => reviewInventory(root), /5 MiB limit/);
  assert.throws(() => inspectClones(root, ['mirage/lib/large.mjs'], path.join(root, 'report')), /5 MiB limit/);
});

test('a nested staging snapshot uses its own files rather than an ancestor Git index', async (t) => {
  const parent = await tempDir('paqvilo-staged-review-');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  await fs.writeFile(path.join(parent, '.gitignore'), '.paqvilo/\n');
  await fs.writeFile(path.join(parent, 'parent-only.mjs'), 'console.log("parent");');
  for (const args of [
    ['init', '--quiet'],
    ['add', '.'],
  ])
    assert.equal(spawnSync('git', args, { cwd: parent, windowsHide: true }).status, 0);
  const root = path.join(parent, '.paqvilo/hooks/staged');
  await fs.mkdir(path.join(root, 'mirage/lib'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), '{"private":true,"type":"module"}');
  await fs.writeFile(path.join(root, 'mirage/cli.mjs'), "import { used } from './lib/logic.mjs'; console.log(used);");
  await fs.writeFile(path.join(root, 'mirage/lib/logic.mjs'), 'export const used = 1;');
  await fs.writeFile(path.join(root, 'mirage/lib/orphan.mjs'), 'console.log("staged orphan");');
  const config = path.join(root, 'knip.json');
  await fs.writeFile(
    config,
    JSON.stringify({ entry: ['mirage/cli.mjs'], project: ['mirage/**/*.mjs'], includeEntryExports: true }),
  );
  const inventory = reviewInventory(root);
  assert.ok(inventory.runtime.includes('mirage/lib/logic.mjs'));
  assert.ok(!Object.values(inventory).flat().includes('parent-only.mjs'));
  assert.ok(
    inspectDeadCode(root, config).some((item) => item.type === 'files' && item.file === 'mirage/lib/orphan.mjs'),
  );
});
