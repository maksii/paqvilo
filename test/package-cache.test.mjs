import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cacheSpecs } from '../scripts/prime-package-cache.mjs';

const exec = promisify(execFile);

test(
  'demo dependency packument is primed for an offline install when only its tarball was cached',
  { skip: !process.env.npm_execpath && 'requires npm CLI context' },
  async (t) => {
    const npm = process.env.npm_execpath;
    assert.ok(npm, 'run this test through npm');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-offline-cache-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const pkg = path.join(root, 'package');
    const consumer = path.join(root, 'consumer');
    const cache = path.join(root, 'cache');
    await fs.mkdir(pkg);
    await fs.mkdir(consumer);
    const manifest = { name: 'invented-sdk', version: '1.0.0' };
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(pkg, 'index.js'), 'export default 1;');
    const run = (args, cwd) => exec(process.execPath, [npm, ...args], { cwd, windowsHide: true, timeout: 60000 });
    const packed = JSON.parse((await run(['pack', '--json', '--ignore-scripts'], pkg)).stdout)[0];
    const archive = await fs.readFile(path.join(pkg, packed.filename));
    let origin;
    const server = http.createServer((req, res) => {
      if (req.url === '/invented-sdk/-/invented-sdk-1.0.0.tgz') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(archive);
        return;
      }
      if (req.url === '/invented-sdk') {
        const info = {
          ...manifest,
          dist: { tarball: `${origin}/invented-sdk/-/invented-sdk-1.0.0.tgz`, integrity: packed.integrity },
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            name: manifest.name,
            'dist-tags': { latest: manifest.version },
            versions: { [manifest.version]: info },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    origin = `http://127.0.0.1:${server.address().port}`;
    await fs.writeFile(
      path.join(consumer, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true, dependencies: { 'invented-sdk': '1.0.0' } }),
    );
    const options = ['--cache', cache, '--registry', origin, '--ignore-scripts', '--no-audit', '--no-fund'];
    await run(['cache', 'add', `${origin}/invented-sdk/-/invented-sdk-1.0.0.tgz`, ...options], consumer);
    await assert.rejects(run(['install', '--offline', '--package-lock=false', ...options], consumer), /ENOTCACHED/);
    const specs = cacheSpecs(
      { packages: { 'node_modules/invented-sdk': { version: '1.0.0', dev: true } } },
      { devDependencies: { 'invented-sdk': '1.0.0', paqvilo: 'file:../..' } },
    );
    assert.deepEqual(specs, ['invented-sdk@1.0.0']);
    await run(['cache', 'add', specs[0], ...options], consumer);
    await run(['install', '--offline', '--package-lock=false', ...options], consumer);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(consumer, 'node_modules/invented-sdk/package.json'), 'utf8')).version,
      '1.0.0',
    );
  },
);
