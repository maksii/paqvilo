// @test-kind contract: a web file whose source is deleted or rewritten between two source reloads answers 404 or its new bytes, not a rendering error
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { readWebFileSource, webFileSourcePaths } from '../lib/web-file-source.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const changed = () => new Error('Local file changed during reading');

test('a read that meets a file being rewritten is made again and returns the settled bytes', async () => {
  const reads = [];
  const read = async (file, options) => {
    reads.push([file, options.root]);
    if (reads.length < 3) throw reads.length === 1 ? changed() : new Error('Local file changed before reading');
    return Buffer.from('settled');
  };
  assert.equal(String(await readWebFileSource('site.css', 'root', '/site.css', { read })), 'settled');
  assert.deepEqual(reads, [
    ['site.css', 'root'],
    ['site.css', 'root'],
    ['site.css', 'root'],
  ]);
});

test('a file that keeps changing fails with the reader error after a bounded number of reads', async () => {
  let reads = 0;
  await assert.rejects(
    readWebFileSource('site.css', 'root', '/site.css', { read: async () => (reads++, Promise.reject(changed())) }),
    /^Error: Local file changed during reading$/,
  );
  assert.equal(reads, 3);
});

test('any other read failure is not retried and keeps its own error', async () => {
  let reads = 0;
  const refused = new Error('Local file is outside its source root');
  await assert.rejects(
    readWebFileSource('site.css', 'root', '/site.css', { read: async () => (reads++, Promise.reject(refused)) }),
    (error) => error === refused,
  );
  assert.equal(reads, 1);
});

test('a folder where the file was is a 404; another file the reader refuses as not regular keeps its error', async () => {
  const refused = new Error('Local file is not regular or exceeds its read limit');
  const read = async () => Promise.reject(refused);
  await assert.rejects(
    readWebFileSource('site.css', 'root', '/site.css', { read, stat: async () => ({ isDirectory: () => true }) }),
    (error) => error.status === 404 && error.code === 'WEB_FILE_SOURCE_MISSING' && error.cause === refused,
  );
  await assert.rejects(
    readWebFileSource('site.css', 'root', '/site.css', { read, stat: async () => ({ isDirectory: () => false }) }),
    (error) => error === refused,
  );
});

test('a source that is gone, or is a folder now, is a 404 that names the file', async () => {
  for (const code of ['ENOENT', 'ENOTDIR', 'EISDIR']) {
    const cause = Object.assign(new Error(code), { code });
    const reject = async () => Promise.reject(cause);
    for (const attempt of [
      readWebFileSource('D:/export/site.css', 'root', '/site.css', { read: reject }),
      webFileSourcePaths('D:/export', 'D:/export/site.css', '/site.css', { realpath: reject }),
    ])
      await assert.rejects(attempt, (error) => {
        assert.equal(error.status, 404);
        assert.equal(error.code, 'WEB_FILE_SOURCE_MISSING');
        assert.equal(error.cause, cause);
        assert.match(error.message, /^The source file of web file \/site\.css is missing: D:\/export\/site\.css\. /);
        return true;
      });
  }
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  await assert.rejects(
    webFileSourcePaths('D:/export', 'D:/export/site.css', '/site.css', {
      realpath: async () => Promise.reject(denied),
    }),
    (error) => error === denied,
  );
});

test('a running portal answers 404 for a web file deleted since its last reload, and serves it again when it is back', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-web-file-source-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_websiteid: invented\nadx_name: Web file source',
    'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '<!doctype html><html><body><h1>Invented</h1></body></html>',
    'web-files/site.css': 'body{color:teal}',
    'web-files/site.css.webfile.yml':
      'adx_webfileid: invented-file\nadx_name: site.css\nadx_partialurl: site.css\nadx_parentpageid: home\nfilename: site.css\nmimetype: text/css',
  };
  await fs.mkdir(path.join(root, 'web-files'));
  for (const [file, body] of Object.entries(files)) await fs.writeFile(path.join(root, file), body);
  // No watcher: the portal keeps the model it loaded, as a running one does until its reload after the change.
  const app = await createSimulator({ sourceDir: root, watch: false });
  ownedFixture(t).add(() => app.close());
  const served = await fetch(`${app.url}/site.css`);
  assert.equal(served.status, 200);
  assert.ok((await served.text()).startsWith('body{color:teal}'));
  await fs.rm(path.join(root, 'web-files/site.css'));
  const gone = await fetch(`${app.url}/site.css`);
  assert.equal(gone.status, 404);
  assert.match(await gone.text(), /The source file of web file \/site\.css is missing/);
  assert.equal((await fetch(app.url)).status, 200, 'the portal keeps serving its pages');
  await fs.mkdir(path.join(root, 'web-files/site.css'));
  assert.equal((await fetch(`${app.url}/site.css`)).status, 404, 'a folder of that name is not a file either');
  await fs.rmdir(path.join(root, 'web-files/site.css'));
  await fs.writeFile(path.join(root, 'web-files/site.css'), 'body{color:navy}');
  const back = await fetch(`${app.url}/site.css`);
  assert.equal(back.status, 200);
  assert.ok((await back.text()).startsWith('body{color:navy}'));
});
