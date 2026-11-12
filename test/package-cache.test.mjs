// @test-kind tooling: exercises the package-cache primer and offline install metadata path with an isolated local registry
import { makeTemporaryDirectory } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cacheSpecs } from '../scripts/prime-package-cache.mjs';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

test(
  'demo dependency packument is primed for an offline install when only its tarball was cached',
  { skip: !process.env.npm_execpath && 'requires npm CLI context' },
  async (t) => {
    const npm = process.env.npm_execpath;
    assert.ok(npm, 'run this test through npm');
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-offline-cache-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const pkg = path.join(root, 'package');
    const consumer = path.join(root, 'consumer');
    const cache = path.join(root, 'cache');
    await fs.mkdir(pkg);
    await fs.mkdir(consumer);
    const manifest = { name: 'invented-sdk', version: '1.0.0' };
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(pkg, 'index.js'), 'export default 1;');
    const run = (args, cwd) => exec(process.execPath, [npm, ...args], { cwd, windowsHide: true });
    const packed = JSON.parse(
      (await run(['pack', '--json', '--ignore-scripts', '--offline', '--cache', cache], pkg)).stdout,
    )[0];
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
    const primer = fileURLToPath(new URL('../scripts/prime-package-cache.mjs', import.meta.url));
    const primerRoot = path.join(root, 'primer');
    await fs.mkdir(path.join(primerRoot, 'examples', 'project'), { recursive: true });
    await fs.writeFile(
      path.join(primerRoot, 'package.json'),
      JSON.stringify({ name: 'paqvilo', version: '1.0.0', private: true, files: ['index.js'] }),
    );
    await fs.writeFile(path.join(primerRoot, 'index.js'), 'export default 1;\n');
    await fs.writeFile(
      path.join(primerRoot, 'npm-shrinkwrap.json'),
      JSON.stringify({
        name: 'paqvilo',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'paqvilo', version: '1.0.0' } },
      }),
    );
    await fs.writeFile(
      path.join(primerRoot, 'examples', 'project', 'package.json'),
      JSON.stringify({ name: 'primer-example', private: true, devDependencies: { 'invented-sdk': '1.0.0' } }),
    );
    const primerEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^npm_config_(cache|registry|offline|update_notifier)$/i.test(key),
      ),
    );
    Object.assign(primerEnvironment, {
      npm_execpath: npm,
      npm_config_cache: cache,
      npm_config_registry: origin,
      npm_config_update_notifier: 'false',
      npm_config_offline: 'false',
    });
    await exec(process.execPath, [primer], {
      cwd: primerRoot,
      env: primerEnvironment,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    await run(['install', '--offline', '--package-lock=false', ...options], consumer);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(consumer, 'node_modules/invented-sdk/package.json'), 'utf8')).version,
      '1.0.0',
    );
  },
);
