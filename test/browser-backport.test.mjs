import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDirSync } from './fixture.mjs';
import {
  PLAYWRIGHT_VERSION,
  DEFAULT_DISABLED_FEATURES,
  BACKPORTED_DISABLED_FEATURES,
  backportLaunchOptions,
  installChromiumBackport,
  requirePinnedDefaults,
} from './browser-backport.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));

test('Windows backport replaces only the pinned default and preserves caller choices and ownership APIs', (t) => {
  const args = Object.freeze(['--invented-option=retained', '--enable-features=InventedEnabled']);
  const ignoreDefaultArgs = Object.freeze(['--mute-audio']);
  const options = Object.freeze({ args, ignoreDefaultArgs, channel: 'msedge', timeout: 1734, env: { INVENTED: '1' } });
  const transformed = backportLaunchOptions(options, 'win32');
  assert.deepEqual(transformed.args, [BACKPORTED_DISABLED_FEATURES, ...args]);
  assert.deepEqual(transformed.ignoreDefaultArgs, [...ignoreDefaultArgs, DEFAULT_DISABLED_FEATURES]);
  for (const key of ['channel', 'timeout', 'env']) assert.equal(transformed[key], options[key]);
  assert.equal(backportLaunchOptions(options, 'linux'), options);
  assert.equal(backportLaunchOptions(options, 'darwin'), options);
  for (const ignored of [true, [DEFAULT_DISABLED_FEATURES]]) {
    const explicit = { ...options, ignoreDefaultArgs: ignored };
    assert.equal(backportLaunchOptions(explicit, 'win32'), explicit);
  }
  const custom = { args: ['--disable-features=InventedCallerOverride'] };
  assert.deepEqual(backportLaunchOptions(custom, 'win32').args, [BACKPORTED_DISABLED_FEATURES, ...custom.args]);
  const explicitDefault = { args: [DEFAULT_DISABLED_FEATURES] };
  assert.equal(backportLaunchOptions(explicitDefault, 'win32'), explicitDefault);
  assert.deepEqual(backportLaunchOptions(undefined, 'win32').args, [BACKPORTED_DISABLED_FEATURES]);
  assert.deepEqual(backportLaunchOptions({ ignoreDefaultArgs: false }, 'win32').ignoreDefaultArgs, [
    DEFAULT_DISABLED_FEATURES,
  ]);
  for (const invalid of [
    null,
    false,
    'invalid options',
    [],
    { args: '--invalid' },
    { args: null },
    { args: [12] },
    { ignoreDefaultArgs: '--invalid' },
    { ignoreDefaultArgs: null },
    { ignoreDefaultArgs: [false] },
  ])
    assert.equal(backportLaunchOptions(invalid, 'win32'), invalid, 'forward invalid input to the original API');
  const calls = [];
  const chromium = {
    launch(...values) {
      calls.push({ method: 'launch', receiver: this, values });
      return 'browser';
    },
    launchPersistentContext(...values) {
      calls.push({ method: 'persistent', receiver: this, values });
      return 'context';
    },
    connect() {},
    connectOverCDP() {},
    launchServer(...values) {
      calls.push({ method: 'server', receiver: this, values });
      return 'server';
    },
  };
  const untouched = [chromium.connect, chromium.connectOverCDP];
  const directory = path.dirname(require.resolve('playwright-core/package.json'));
  installChromiumBackport(chromium, directory, 'win32');
  const launch = chromium.launch;
  installChromiumBackport(chromium, directory, 'win32');
  assert.equal(chromium.launch, launch);
  assert.equal(chromium.launch(options), 'browser');
  assert.equal(chromium.launchPersistentContext('invented-profile', options), 'context');
  assert.equal(chromium.launchServer(options), 'server');
  assert.deepEqual(
    calls.map(({ method, values }) => [method, values]),
    [
      ['launch', [transformed]],
      ['persistent', ['invented-profile', transformed]],
      ['server', [transformed]],
    ],
  );
  for (const call of calls) assert.equal(call.receiver, chromium);
  assert.deepEqual([chromium.connect, chromium.connectOverCDP], untouched);
  t.diagnostic('No existing connect or connectOverCDP API is replaced');
});

test('pinned package version and the complete upstream default list fail closed on drift', (t) => {
  const original = path.dirname(require.resolve('playwright-core/package.json'));
  requirePinnedDefaults(original);
  const directory = tempDirSync('paq-browser-defaults-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'lib'));
  const manifest = path.join(directory, 'package.json');
  const source = fs.readFileSync(path.join(original, 'lib/coreBundle.js'), 'utf8');
  fs.writeFileSync(manifest, JSON.stringify({ name: 'playwright-core', version: PLAYWRIGHT_VERSION }));
  fs.writeFileSync(
    path.join(directory, 'lib/coreBundle.js'),
    source.replace('"OptimizationHints",', '"InventedChangedDefault",'),
  );
  assert.throws(() => requirePinnedDefaults(directory), /disabledFeatures changed/);
  fs.writeFileSync(manifest, JSON.stringify({ name: 'playwright-core', version: '1.65.0' }));
  assert.throws(() => requirePinnedDefaults(directory), /changing pinned Playwright/);
  fs.writeFileSync(manifest, JSON.stringify({ name: 'invented-other-package', version: PLAYWRIGHT_VERSION }));
  assert.throws(() => requirePinnedDefaults(directory), /changing pinned Playwright/);
});

test('test bootstrap stays lazy in an ordinary process and propagates only its explicit preload', () => {
  const bootstrap = new URL('./browser-bootstrap.mjs', import.meta.url).href;
  const env = { ...process.env, NODE_OPTIONS: '--trace-warnings' };
  const nestedSource = `
    const assert=require('node:assert/strict');
    const {chromium}=require('playwright-core');
    let calls=0;
    chromium._channel={launch:async options=>{
      calls++;
      assert.equal(options.args?.includes(${JSON.stringify(BACKPORTED_DISABLED_FEATURES)})||false,process.platform==='win32');
      throw new Error('invented launch interception');
    }};
    assert.equal(process.env.NODE_OPTIONS.split(/\\s+/).filter(v=>v===${JSON.stringify('--import=' + bootstrap)}).length,1);
    assert.rejects(chromium.launch(),/invented launch interception/).then(()=>{assert.equal(calls,1);console.log('inherited activation verified')});
  `;
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      bootstrap,
      '-e',
      `
    const assert=require('node:assert/strict');
    assert.equal(Object.keys(require.cache).some(p=>/[\\\\/]playwright-core[\\\\/]/.test(p)),false);
    assert.ok(process.env.NODE_OPTIONS.startsWith('--trace-warnings '));
    const {spawnSync}=require('node:child_process');
    const nested=spawnSync(process.execPath,['-e',${JSON.stringify(nestedSource)}],{encoding:'utf8'});
    assert.equal(nested.status,0,nested.stderr); assert.equal(nested.stdout.trim(),'inherited activation verified');
    console.log('lazy descendants verified');
  `,
    ],
    { cwd: root, env, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /lazy descendants verified/);
});

test('actual version CLI retains its ordinary module graph with test activation', () => {
  const bootstrap = new URL('./browser-bootstrap.mjs', import.meta.url).href;
  const cli = new URL('../bin/paqvilo.mjs', import.meta.url).href;
  const script = `
    import {registerHooks} from 'node:module';
    const loaded=[];
    registerHooks({load(url,context,next){if(url.startsWith('file:'))loaded.push(url);return next(url,context)}});
    process.on('exit',()=>process.stderr.write('__CLI_GRAPH__'+JSON.stringify(loaded)));
    process.argv=[process.execPath,${JSON.stringify(fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url)))},'--version'];
    await import(${JSON.stringify(cli)});
  `;
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const run = (activated) => {
    const child = spawnSync(
      process.execPath,
      [...(activated ? ['--import', bootstrap] : []), '--input-type=module', '-e', script],
      { cwd: root, env, encoding: 'utf8', windowsHide: true },
    );
    assert.equal(child.status, 0, child.stderr);
    return { stdout: child.stdout, graph: JSON.parse(child.stderr.split('__CLI_GRAPH__')[1]) };
  };
  const baseline = run(false),
    activated = run(true);
  assert.deepEqual(activated, baseline);
  assert.ok(activated.graph.some((url) => url.endsWith('/bin/paqvilo.mjs')));
  assert.equal(
    activated.graph.some((url) => url.includes('/playwright-core/')),
    false,
  );
});
