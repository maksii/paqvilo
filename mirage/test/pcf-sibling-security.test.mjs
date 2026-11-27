// @test-kind security: a hostile control manifest, style or bundle never makes the catalogue resolve, stat or serve a path outside its control folder (UNC share, drive, backslash, traversal, junction, ZIP traversal)
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importCodeComponents, controlRelativePath } from '../lib/code-components.mjs';
import { writeSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

async function workspace(t) {
  const dir = await fsp.realpath(await makeTemporaryDirectory(path.join(os.tmpdir(), 'pcf-sibling-')));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function writeFiles(root, files) {
  for (const [relative, data] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fsp.writeFile(path.join(root, relative), data);
  }
}
const HOSTILE = [
  String.raw`\\attacker.invalid\share\a.png`,
  '//attacker.invalid/share/b.png',
  String.raw`..\..\outside.png`,
  String.raw`img\..\..\..\outside.png`,
  'C:/outside.png',
  'c:outside.png',
  '%5C%5Cattacker.invalid%5Cshare%5Cc.png',
  '%2E%2E/%2E%2E/outside.png',
  'file:///outside.png',
  '../../outside.png',
  '/outside.png',
];
const manifest = (resources) =>
  `<manifest><control namespace="Invented" constructor="Editor" control-type="standard"><resources>${resources}</resources></control></manifest>`;

// Every path the file system is asked to resolve or stat during the import.
function watchFileSystem(t) {
  const seen = [];
  for (const name of ['realpath', 'stat', 'lstat', 'open', 'readdir', 'opendir']) {
    const original = fsp[name];
    t.mock.method(fsp, name, function (file, ...rest) {
      seen.push(String(file));
      return original.call(this, file, ...rest);
    });
  }
  return seen;
}
const inside = (root, file) => {
  const relative = path.relative(root, path.resolve(file));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

test('controlRelativePath refuses every non-local spelling before a lookup', () => {
  for (const value of [...HOSTILE.filter((url) => !url.includes('%')), '', '.', 'a?b.png', 'a#b.png', 'a\u0000.png'])
    assert.equal(controlRelativePath(value), null, value);
  assert.equal(controlRelativePath('img/./a.png'), 'img/a.png');
  assert.equal(controlRelativePath('img/../a.png'), 'a.png');
});

test('style and source-map references to shares, drives or outside folders are never looked up or served', async (t) => {
  const dir = await workspace(t);
  const control = path.join(dir, 'Controls', 'inv_Invented.Editor');
  const css = HOSTILE.map((url, index) => `.r${index}{background:url("${url}")}`).join('');
  await writeFiles(control, {
    'ControlManifest.xml': manifest('<code path="bundle.js" order="1"/><css path="css/editor.css" order="1"/>'),
    'ControlManifest.xml.data.xml': '<CustomControl><Name>inv_Invented.Editor</Name></CustomControl>',
    'bundle.js': String.raw`var x;` + '\n//# sourceMappingURL=' + String.raw`\\attacker.invalid\share\x.map`,
    'css/editor.css': css + '.ok{background:url(../img/ok.png?v=1)}',
    'img/ok.png': 'ok',
  });
  await fsp.writeFile(path.join(dir, 'outside.png'), 'outside');
  const seen = watchFileSystem(t);
  const catalog = await importCodeComponents([{ dir }]);
  t.mock.restoreAll();
  assert.deepEqual(catalog.diagnostics, []);
  const outside = seen.filter((file) => !inside(dir, file));
  assert.deepEqual(outside, [], 'no file system call leaves the workspace');
  assert.equal(
    seen.filter((file) => !inside(control, file) && ![dir, path.join(dir, 'Controls')].includes(file)).length,
    0,
  );
  assert.ok(!seen.some((file) => /attacker|outside\.png/i.test(file)), seen.join('\n'));
  const paths = [...catalog.assets.values()].map((asset) => path.relative(control, asset.file).replaceAll('\\', '/'));
  assert.deepEqual(paths.sort(), ['bundle.js', 'css/editor.css', 'img/ok.png']);
});

test('declared resources that name a drive or a share are refused without a lookup', async (t) => {
  const dir = await workspace(t);
  const control = path.join(dir, 'Controls', 'inv_Invented.Editor');
  await writeFiles(control, {
    'ControlManifest.xml': manifest('<code path="C:/outside.js" order="1"/>'),
    'ControlManifest.xml.data.xml': '<CustomControl><Name>inv_Invented.Editor</Name></CustomControl>',
  });
  const seen = watchFileSystem(t);
  const catalog = await importCodeComponents([{ dir }]);
  t.mock.restoreAll();
  assert.equal(catalog.controls.size, 0);
  assert.equal(catalog.diagnostics[0].code, 'PCF_IMPORT_FAILED');
  assert.deepEqual(
    seen.filter((file) => !inside(dir, file)),
    [],
  );
});

test('a junction inside the control folder that points outside is never served', async (t) => {
  const dir = await workspace(t);
  const control = path.join(dir, 'Controls', 'inv_Invented.Editor');
  await writeFiles(control, {
    'ControlManifest.xml': manifest('<code path="bundle.js" order="1"/><css path="editor.css" order="1"/>'),
    'ControlManifest.xml.data.xml': '<CustomControl><Name>inv_Invented.Editor</Name></CustomControl>',
    'bundle.js': 'var x;',
    'editor.css': '.a{background:url(linked/secret.png)}',
  });
  const elsewhere = path.join(dir, 'elsewhere');
  await writeFiles(elsewhere, { 'secret.png': 'secret' });
  await fsp.symlink(elsewhere, path.join(control, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const catalog = await importCodeComponents([{ dir }]);
  assert.ok(![...catalog.assets.keys()].some((url) => url.includes('secret')));
  assert.equal(catalog.assets.size, 2);
});

test('a ZIP control never reaches another control folder through its style references', async (t) => {
  const dir = await workspace(t);
  const zip = path.join(dir, 'invented.zip');
  const entry = (name, text) => ({ name, data: Buffer.from(text) });
  await fsp.writeFile(
    zip,
    writeSolutionAssetEntries([
      entry(
        'customizations.xml',
        '<ImportExportXml><CustomControls><CustomControl><Name>inv_Invented.Editor</Name><FileName>/Controls/inv_Invented.Editor/ControlManifest.xml</FileName></CustomControl></CustomControls></ImportExportXml>',
      ),
      entry(
        'Controls/inv_Invented.Editor/ControlManifest.xml',
        manifest('<code path="bundle.js" order="1"/><css path="editor.css" order="1"/>'),
      ),
      entry('Controls/inv_Invented.Editor/bundle.js', 'var x;'),
      entry(
        'Controls/inv_Invented.Editor/editor.css',
        String.raw`.a{background:url(../inv_Other.Control/secret.png)}.b{background:url(..\inv_Other.Control\secret.png)}`,
      ),
      entry('Controls/inv_Other.Control/secret.png', 'secret'),
    ]),
  );
  const catalog = await importCodeComponents([{ type: 'zip', dir: zip }]);
  assert.equal(catalog.assets.size, 2);
  assert.ok(![...catalog.assets.values()].some((asset) => asset.data?.toString() === 'secret'));
});
