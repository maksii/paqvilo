// @test-kind security: a compiled code site never serves a dotfile or a file in a dot directory, whatever request name or link resolves to it.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compiledCodeSiteAsset, readCodeSite } from '../lib/code-site.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-code-site-dot-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (relative, contents) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  };
  await write('powerpages.config.json', JSON.stringify({ compiledPath: 'dist', defaultLandingPage: 'index.html' }));
  await write('dist/index.html', '<!doctype html><html><head></head><body>app</body></html>');
  await write('dist/assets/app.js', 'console.log("app");');
  await write('dist/.env', 'INVENTED_SETTING=1');
  await write('dist/.git/config', '[core]');
  const diagnostics = [];
  const site = await readCodeSite(root, diagnostics);
  assert.deepEqual(diagnostics, []);
  return { root, site, dist: path.join(root, 'dist') };
}

test('dotfiles are refused by request name and after their link resolves', async (t) => {
  const { site, dist } = await fixture(t);
  assert.equal(await compiledCodeSiteAsset(site, '/assets/app.js'), path.join(dist, 'assets', 'app.js'));
  assert.equal(await compiledCodeSiteAsset(site, '/.env'), null);
  assert.equal(await compiledCodeSiteAsset(site, '/.git/config'), null);
  // A directory link (a junction needs no privilege on Windows) whose own name has no dot reaches a dot directory.
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(path.join(dist, '.git'), path.join(dist, 'repository'), type);
  await fs.symlink(path.join(dist, 'assets'), path.join(dist, 'scripts'), type);
  assert.equal(await compiledCodeSiteAsset(site, '/repository/config'), null);
  assert.equal(
    await compiledCodeSiteAsset(site, '/scripts/app.js'),
    path.join(dist, 'assets', 'app.js'),
    'a link to a public directory still serves',
  );
});

test('Windows 8.3 short names do not reach dotfiles', async (t) => {
  const { site, dist } = await fixture(t);
  // A short name exists only where the volume generates 8.3 names; realpath maps one back to its long name.
  const shortName = async (candidate, long) => {
    try {
      return path.basename(await fs.realpath(path.join(dist, candidate))) === long ? candidate : null;
    } catch {
      return null;
    }
  };
  const env = process.platform === 'win32' ? await shortName('ENV~1', '.env') : null;
  const git = process.platform === 'win32' ? await shortName('GIT~1', '.git') : null;
  if (!env && !git) {
    t.skip('this filesystem has no 8.3 short names');
    return;
  }
  if (env) assert.equal(await compiledCodeSiteAsset(site, `/${env}`), null);
  if (git) assert.equal(await compiledCodeSiteAsset(site, `/${git}/config`), null);
});
