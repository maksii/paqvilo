import { makeTemporaryDirectory } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { orderedMap } from '../lense/async-map.mjs';
import { directoryFiles } from '../lense/directory-files.mjs';
import { mapLimit, sourceDirectoryDigest } from '../mirage/lib/solution-cache.mjs';
import { decodeXml, xmlAttributes, xmlStartTag, xmlTokens } from '../mirage/lib/xml-text.mjs';
import { globalMetadataVersion } from '../mirage/lib/metadata-version.mjs';
import { liveDataverseSettings } from '../mirage/lib/live-dataverse-settings.mjs';
import { registerRuntimeShutdown } from '../mirage/lib/runtime-shutdown.mjs';
import { observeProcessReadiness } from '../mirage/lib/process-readiness.mjs';

test('ordered mapper bounds work, preserves iterables and explicit adapter limit policies', async () => {
  let active = 0,
    peak = 0;
  assert.deepEqual(
    await orderedMap(new Set([3, 1, 2]), 2, async (value) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, value));
      active--;
      return value * 2;
    }),
    [6, 2, 4],
  );
  assert.equal(peak, 2);
  assert.deepEqual(await orderedMap([], 2, () => assert.fail()), []);
  for (const limit of [0, -1, NaN, Infinity, 1.5, '2'])
    await assert.rejects(
      orderedMap([1], limit, () => assert.fail()),
      /positive integer/,
    );
  await assert.rejects(
    orderedMap([1], 1, () => {
      throw new Error('mapper refused');
    }),
    /mapper refused/,
  );
  for (const limit of [0, -1, 1.5, '2', Infinity])
    assert.deepEqual(await mapLimit(new Set([1, 2]), limit, (value) => value), [1, 2]);
  // Preserve the legacy cache adapter's NaN behavior; product callers pass explicit valid constants.
  assert.equal(0 in (await mapLimit([1], NaN, () => assert.fail())), false);
});

test('directory policy preserves import order and exact fingerprint bytes', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-traversal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'z.txt': 'z',
    'a/nested.txt': 'a',
    '.paqvilo/local.txt': 'local',
    'node_modules/x.txt': 'module',
    '.git/x': 'git',
  };
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  }
  const listed = await directoryFiles(root, {
    skip: new Set(['.git', '.paqvilo', 'node_modules']),
    sort: (a, b) => a.name.localeCompare(b.name),
  });
  assert.deepEqual(
    listed.map((file) => path.relative(root, file).replaceAll('\\', '/')),
    ['a/nested.txt', 'z.txt'],
  );
  const expected = createHash('sha256');
  for (const name of ['a/nested.txt', 'z.txt']) expected.update(name).update('\0').update(files[name]).update('\0');
  assert.equal(await sourceDirectoryDigest(root), expected.digest('hex'));
  const natural = await directoryFiles(root, { skip: new Set(['.git', '.portalconfig']) });
  const walk = async (dir) => {
    const result = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ['.git', '.portalconfig'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) result.push(...(await walk(file)));
      else if (entry.isFile()) result.push(file);
    }
    return result;
  };
  assert.deepEqual(natural, await walk(root));
});

test('shared XML decoding handles adjacent CDATA and invalid numeric references without unbounded scans', () => {
  assert.equal(decodeXml('<![CDATA[α]]><![CDATA[β]]>&amp;&#65;&#x1f642;&lt;&gt;&quot;&apos;'), 'αβ&A🙂<>"\'');
  assert.equal(decodeXml('<![CDATA['.repeat(20000)), '<![CDATA['.repeat(20000));
  assert.equal(decodeXml('&#9999999999999999999999;'), '&#9999999999999999999999;');
  assert.equal(decodeXml(null), '');
});

test('shared XML scanners match the tag grammar they replace and stay linear on unterminated markup', () => {
  // The expressions these scanners replace; equal results keep FetchXML and form XML parsing unchanged.
  const tokens = (source) => source.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^>]+>|[^<]+/g) ?? [];
  const startTag = (token) => {
    const match = /^<([\w:.-]+)([\s\S]*?)(\/?)\s*>$/.exec(token);
    return match && { name: match[1], markup: match[2], selfClosing: Boolean(match[3]) };
  };
  const attributes = (markup) =>
    [...markup.matchAll(/([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/g)].map((match) => [match[1], match[3]]);
  const corpus = [
    '<fetch top="5"><entity name=\'x_item\'><attribute name="x_name"/><filter type="and"></filter></entity></fetch>',
    '<?xml version="1.0"?><!-- note > inside --><a b = "1" c=\'2\' d="&amp;" />text<b/><c / >',
    '<!--> <? unterminated <> a < b > tail <a x="1" y=2 z="open><b/>',
    '<a name.with:chars-x="v" lone= "w" =" q" x="a>b"></a>',
    '<a\t\n x\n=\n"multi\nline"\t/>',
  ];
  for (const source of corpus) {
    assert.deepEqual(xmlTokens(source), tokens(source), source);
    for (const token of tokens(source).filter((item) => item.startsWith('<') && !item.startsWith('</'))) {
      if (token.startsWith('<!--') || token.startsWith('<?')) continue;
      assert.deepEqual(xmlStartTag(token), startTag(token), token);
      if (startTag(token)) assert.deepEqual(xmlAttributes(startTag(token).markup), attributes(startTag(token).markup));
    }
  }
  // Inputs that made the replaced expressions polynomial give the same results and complete in one scan.
  assert.deepEqual(xmlAttributes('-="a'.repeat(2000)), attributes('-="a'.repeat(2000)));
  assert.deepEqual(xmlAttributes('a="x b=\'y '.repeat(2000)), attributes('a="x b=\'y '.repeat(2000)));
  assert.deepEqual(xmlTokens('<!--'.repeat(50000)), Array(50000).fill('!--'));
  assert.deepEqual(xmlTokens('<?'.repeat(50000)), Array(50000).fill('?'));
  assert.deepEqual(xmlTokens('<'.repeat(50000)), []);
  assert.deepEqual(xmlStartTag('<-' + '\t'.repeat(50000) + '>'), { name: '-', markup: '', selfClosing: false });
  assert.deepEqual(xmlAttributes('-'.repeat(50000)), []);
  assert.equal(xmlAttributes('-="a'.repeat(50000)).length, 25000);
  // An unterminated quote and a long run of unquoted values are each scanned once.
  assert.deepEqual(xmlAttributes('x="' + 'y=a '.repeat(50000)), []);
});

test('synthetic metadata identity policy and live environment overrides preserve explicit null and false', () => {
  let store = { state: { mappings: { specimen: { logicalName: 'specimen' } } } };
  const first = globalMetadataVersion(store);
  assert.equal(globalMetadataVersion({ state: { mappings: structuredClone(store.state.mappings) } }), first);
  store.state.mappings = { changed: {} };
  assert.notEqual(globalMetadataVersion(store), first);
  store.observed = { webApiGlobalMetadataVersion: 'observed' };
  assert.equal(globalMetadataVersion(store), 'observed');
  const settings = liveDataverseSettings(
    { tds: { enabled: true }, serviceProtection: { requestsPer300s: 50 }, gitRemoteDirectory: 'relative' },
    process.cwd(),
    () => store,
  );
  assert.equal(settings.tds.enabled(), true);
  assert.equal(settings.serviceProtection.requestsPer300s(), 50);
  store = { state: { dataverse: { environment: { tdsEnabled: false, requestsPer300s: null } } } };
  assert.equal(settings.tds.enabled(), false);
  assert.equal(settings.serviceProtection.requestsPer300s(), null);
  assert.equal(settings.gitRemoteDirectory, path.resolve('relative'));
});

test('owned shutdown is idempotent and removes discovery and listeners even when close rejects', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-shutdown-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const fails of [false, true]) {
    const discovery = path.join(root, 'owned.json'),
      other = path.join(root, 'other.json');
    await fs.writeFile(discovery, '{}');
    await fs.writeFile(other, '{}');
    const owner = new EventEmitter(),
      input = new EventEmitter();
    let closed = 0;
    const lifecycle = registerRuntimeShutdown({
      owner,
      input,
      discovery,
      close: async () => {
        closed++;
        if (fails) throw new Error('close failed');
      },
      exit: () => assert.fail('direct stop does not exit'),
    });
    const stopped = lifecycle.stop();
    assert.equal(lifecycle.stop(), stopped);
    if (fails) await assert.rejects(stopped, /close failed/);
    else await stopped;
    assert.equal(closed, 1);
    assert.equal(
      owner.listenerCount('SIGINT') +
        owner.listenerCount('SIGTERM') +
        input.listenerCount('data') +
        input.listenerCount('end'),
      0,
    );
    await assert.rejects(fs.access(discovery), /ENOENT/);
    await fs.access(other);
  }
});

test('shutdown preserves both runtime close and discovery removal failures', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-shutdown-failure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const owner = new EventEmitter(),
    input = new EventEmitter();
  const discovery = path.join(root, 'directory-not-file');
  await fs.mkdir(discovery);
  const closeError = new Error('original close failure');
  const lifecycle = registerRuntimeShutdown({
    owner,
    input,
    discovery,
    close: async () => {
      throw closeError;
    },
  });
  await assert.rejects(
    lifecycle.stop(),
    (error) => error instanceof AggregateError && error.errors[0] === closeError && error.errors.length === 2,
  );
});

test('signals and stdin stop close only once and report shutdown failures', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-shutdown-trigger-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const trigger of ['SIGINT', 'SIGTERM', 'stop', 'fail']) {
    const owner = new EventEmitter(),
      input = new EventEmitter();
    const discovery = path.join(root, `${trigger}.json`);
    await fs.writeFile(discovery, '{}');
    let calls = 0,
      written = '';
    owner.stderr = {
      write: (text) => {
        written += text;
      },
    };
    let exited;
    const complete = new Promise((resolve) => {
      exited = resolve;
    });
    registerRuntimeShutdown({
      owner,
      input,
      discovery,
      exit: exited,
      close: async () => {
        calls++;
        if (trigger === 'fail') throw new Error('invented close refusal');
      },
    });
    if (trigger === 'stop') input.emit('data', 'stop\n');
    else if (trigger === 'fail') owner.emit('SIGINT');
    else owner.emit(trigger);
    owner.emit('SIGINT');
    input.emit('end');
    input.emit('data', 'stop\n');
    assert.equal(await complete, trigger === 'fail' ? 1 : 0);
    assert.equal(calls, 1);
    if (trigger === 'fail') assert.match(written, /invented close refusal/);
    assert.equal(owner.listenerCount('SIGINT') + input.listenerCount('end'), 0);
    await assert.rejects(fs.access(discovery), /ENOENT/);
  }
});

test('readiness observer handles fragmented JSON, exits, spawn errors and timeouts without listener leaks', async () => {
  for (const kind of ['ready', 'exit', 'error', 'timeout']) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = child.stderr.setEncoding = () => {};
    const observed = observeProcessReadiness(child, { timeoutMs: 10, label: 'invented' });
    if (kind === 'ready') {
      child.stdout.emit('data', '{"port');
      child.stdout.emit('data', 'als":[]}');
      assert.deepEqual(await observed.promise, { portals: [] });
    } else if (kind === 'exit') {
      child.stderr.emit('data', 'invented failure');
      child.emit('exit', 3);
      await assert.rejects(observed.promise, /invented exited with 3.*invented failure/);
    } else if (kind === 'error') {
      child.emit('error', new Error('spawn refused'));
      await assert.rejects(observed.promise, /spawn refused/);
    } else await assert.rejects(observed.promise, /within 10 ms/);
    for (const event of ['exit', 'error']) assert.equal(child.listenerCount(event), 0);
    assert.equal(child.stdout.listenerCount('data') + child.stderr.listenerCount('data'), 0);
  }
});
