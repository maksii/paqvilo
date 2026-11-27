// @test-kind contract: Lense's line merge of a code site's local landing page with the root page the portal served (lense/code-site-overlay.mjs), on invented documents
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codeSiteChangeKind, codeSiteWatchPaths, mergeCompiledEntry } from '../lense/code-site-overlay.mjs';

const lines = (...rows) => rows.join('\n') + '\n';
const DEPLOYED = lines(
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <title>Invented app</title>',
  '    <script type="module" src="/assets/index-OLD.js"></script>',
  '    <link rel="stylesheet" href="/assets/index-OLD.css">',
  '  </head>',
  '  <body>',
  '    <div id="root"></div>',
  '  </body>',
  '</html>',
);
// What a portal adds to the deployed page: a client context script, here as the first child of head.
const SERVED = DEPLOYED.replace('  <head>\n', '  <head>\n<script>window.inventedContext = true;</script>\n');

test('the local build changes and the portal additions are both kept', () => {
  const local = DEPLOYED.replace('index-OLD.js', 'index-NEW.js').replace('index-OLD.css', 'index-NEW.css');
  const merged = mergeCompiledEntry({ deployed: DEPLOYED, served: SERVED, local });
  assert.equal(merged.outcome, 'applied');
  assert.equal(merged.html, local.replace('  <head>\n', '  <head>\n<script>window.inventedContext = true;</script>\n'));
});

test('an addition right before a changed line keeps its place in front of it', () => {
  const served = DEPLOYED.replace(
    '    <script type="module"',
    '<script>window.inventedContext = true;</script>\n    <script type="module"',
  );
  const local = DEPLOYED.replace('index-OLD.js', 'index-NEW.js');
  const merged = mergeCompiledEntry({ deployed: DEPLOYED, served, local });
  assert.equal(merged.outcome, 'applied');
  assert.match(
    merged.html,
    /inventedContext = true;<\/script>\n {4}<script type="module" src="\/assets\/index-NEW\.js">/,
  );
  assert.doesNotMatch(merged.html, /index-OLD\.js/);
});

test('an unchanged build leaves the served document as it is', () => {
  const merged = mergeCompiledEntry({ deployed: DEPLOYED, served: SERVED, local: DEPLOYED.replaceAll('\n', '\r\n') });
  assert.deepEqual(merged, { html: SERVED, outcome: 'unchanged' });
});

test('without the deployed landing page nothing is laid', () => {
  const merged = mergeCompiledEntry({ deployed: null, served: SERVED, local: DEPLOYED.replace('OLD', 'NEW') });
  assert.deepEqual(merged, { html: SERVED, outcome: 'unknown-deployed' });
});

test('another document on the route (a sign-in page) is never merged', () => {
  const served = lines(
    '<!doctype html>',
    '<html>',
    '<body>',
    '<form id="invented-sign-in"></form>',
    '</body>',
    '</html>',
  );
  const merged = mergeCompiledEntry({ deployed: DEPLOYED, served, local: DEPLOYED.replace('OLD', 'NEW') });
  assert.deepEqual(merged, { html: served, outcome: 'not-entry' });
});

// @test-kind observation: hosted session F5 (captures code-site-serve-a..d) served the landing page nested in a whole portal page of several hundred lines: the Home page copy on the root, the place of the page content on an application route, its first line joined to the shell's text before it
test('a landing page nested in a large portal page is laid over on its own lines; the page around it stays', () => {
  const shell = Array.from({ length: 1500 }, (_, at) => `<script>window.invented${at} = ${at};</script>`);
  const nested = DEPLOYED.replace('<!doctype html>\n', '');
  const served = [...shell, `<div id="antiforgerytoken"></div><!doctype html>`, nested, ...shell].join('\n');
  const local = DEPLOYED.replace('index-OLD.js', 'index-NEW.js');
  const merged = mergeCompiledEntry({ deployed: DEPLOYED, served, local });
  assert.equal(merged.outcome, 'applied');
  assert.equal(merged.html, served.replace('index-OLD.js', 'index-NEW.js'));
  // A local change on a line the portal page changed is still a conflict.
  const platform = served.replace('<title>Invented app</title>', '<title>Invented app</title><meta name="platform">');
  const conflict = mergeCompiledEntry({ deployed: DEPLOYED, served: platform, local: local.replace('Invented', 'X') });
  assert.equal(conflict.outcome, 'conflict');
  assert.equal(conflict.html, platform);
});

test('a line both sides changed is a conflict that names it, and the served document stays', () => {
  const served = DEPLOYED.replace('<title>Invented app</title>', '<title>Invented app</title><meta name="platform">');
  const local = DEPLOYED.replace('Invented app', 'Renamed app');
  const merged = mergeCompiledEntry({ deployed: DEPLOYED, served, local });
  assert.deepEqual(merged, { html: served, outcome: 'conflict', lines: [4] });
  // Two insertions at the same place cannot be ordered either.
  const insertion = DEPLOYED.replace('  </head>', '<meta name="local">\n  </head>');
  const platform = DEPLOYED.replace('  </head>', '<meta name="platform">\n  </head>');
  assert.equal(mergeCompiledEntry({ deployed: DEPLOYED, served: platform, local: insertion }).outcome, 'conflict');
});

test('the served line endings are kept', () => {
  const served = SERVED.replaceAll('\n', '\r\n');
  const merged = mergeCompiledEntry({ deployed: DEPLOYED, served, local: DEPLOYED.replace('OLD.js', 'NEW.js') });
  assert.equal(merged.outcome, 'applied');
  assert.ok(merged.html.includes('index-NEW.js"></script>\r\n'));
  assert.doesNotMatch(merged.html.replaceAll('\r\n', ''), /\n/);
});

test('a code-site project names its configuration and build folder for the source watcher', (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-code-site-watch-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const site = path.join(project, '.powerpages-site');
  fs.mkdirSync(site);
  const configFile = path.join(project, 'powerpages.config.json');
  // Not a code-site project: nothing beside the export is watched.
  assert.equal(codeSiteWatchPaths(site), null);
  // The build folder is named before the first build creates it.
  fs.writeFileSync(configFile, JSON.stringify({ compiledPath: 'dist', defaultLandingPage: 'index.html' }));
  assert.deepEqual(codeSiteWatchPaths(site), { configFile, compiledDir: path.join(project, 'dist') });
  assert.deepEqual(codeSiteWatchPaths(project), { configFile, compiledDir: path.join(project, 'dist') });
  // A build folder outside the project, or an unreadable configuration, leaves only the configuration watched.
  for (const text of [
    JSON.stringify({ compiledPath: '../elsewhere' }),
    JSON.stringify({ compiledPath: 'C:/abs' }),
    '{',
  ]) {
    fs.writeFileSync(configFile, text);
    assert.deepEqual(codeSiteWatchPaths(site), { configFile, compiledDir: null }, text);
  }
});

test('a saved configuration is recognised in any letter case on Windows, exactly elsewhere', () => {
  const win = (...parts) => path.win32.join('C:', ...parts);
  const windows = {
    configFile: win('Work', 'Site', 'powerpages.config.json'),
    compiledDir: win('Work', 'Site', 'dist'),
  };
  const win32 = { platform: 'win32' };
  assert.equal(
    codeSiteChangeKind(windows, win('work', 'site', 'POWERPAGES.CONFIG.JSON').toLowerCase(), win32),
    'config',
  );
  assert.equal(codeSiteChangeKind(windows, win('WORK', 'SITE', 'POWERPAGES.CONFIG.JSON'), win32), 'config');
  assert.equal(codeSiteChangeKind(windows, win('Work', 'Site', 'powerpages.config.json'), win32), 'config');
  assert.equal(codeSiteChangeKind(windows, win('WORK', 'site', 'Dist', 'app.js'), win32), 'build');
  assert.equal(codeSiteChangeKind(windows, win('Work', 'Site', 'src', 'app.js'), win32), null);
  const posix = { configFile: '/work/site/powerpages.config.json', compiledDir: '/work/site/dist' };
  const linux = { platform: 'linux' };
  assert.equal(codeSiteChangeKind(posix, '/work/site/powerpages.config.json', linux), 'config');
  // Letter case names another file on a case-sensitive file system.
  assert.equal(codeSiteChangeKind(posix, '/work/site/POWERPAGES.CONFIG.JSON', linux), null);
  assert.equal(codeSiteChangeKind(posix, '/work/site/dist/assets/index.js', linux), 'build');
  assert.equal(codeSiteChangeKind(posix, '/work/site/distribution/app.js', linux), null);
  assert.equal(codeSiteChangeKind(null, '/work/site/powerpages.config.json', linux), null);
});
