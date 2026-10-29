import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectSyntheticEvidence } from '../scripts/collect-evidence.mjs';

const name = `${'a'.repeat(32)}-diagnostic.json`;
const marker = 'invented-private-marker-must-not-be-collected-or-overwritten';

function fixture(t) {
  const parent = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, 'paq-collector-security-')));
  t.after(() => {
    const relative = path.relative(parent, fs.realpathSync.native(root));
    assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const state = path.join(root, 'state');
  const source = path.join(state, 'synthetic-navigation');
  fs.mkdirSync(source, { recursive: true });
  const candidate = path.join(source, name);
  const approved = '{"synthetic":true}\n';
  fs.writeFileSync(candidate, approved);
  const privateFile = path.join(root, 'invented-private.json');
  fs.writeFileSync(privateFile, marker);
  return { root, state, source, candidate, approved, privateFile };
}

test('synthetic collection preserves approved bytes and its exact filename allowlist', (t) => {
  const files = fixture(t);
  fs.writeFileSync(path.join(files.source, 'discovery.json'), marker);
  fs.writeFileSync(path.join(files.source, `${'b'.repeat(32)}-raw-state.json`), marker);
  const collected = collectSyntheticEvidence(files.state);
  assert.deepEqual(collected.files, [`synthetic-navigation/${name}`]);
  assert.equal(fs.readFileSync(path.join(collected.output, collected.files[0]), 'utf8'), files.approved);
  assert.equal(fs.readFileSync(files.privateFile, 'utf8'), marker);
});

test('synthetic collection refuses a source substituted with a private hardlink after its pathname check', (t) => {
  const files = fixture(t);
  const lstat = fs.lstatSync.bind(fs);
  let substituted = false;
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    const entry = lstat(file, ...args);
    if (file === files.candidate && !substituted) {
      substituted = true;
      fs.unlinkSync(file);
      fs.linkSync(files.privateFile, file);
    }
    return entry;
  });
  const collected = collectSyntheticEvidence(files.state);
  assert.equal(substituted, true);
  assert.deepEqual(collected.files, []);
  assert.deepEqual(fs.readdirSync(collected.output), ['manifest.json']);
  assert.equal(fs.readFileSync(files.privateFile, 'utf8'), marker);
});

test('synthetic collection rejects a replaced source parent even when the new path remains ordinary', (t) => {
  const files = fixture(t);
  const privateDirectory = path.join(files.root, 'private-source');
  fs.mkdirSync(privateDirectory);
  fs.writeFileSync(path.join(privateDirectory, name), marker);
  const open = fs.openSync.bind(fs);
  const copy = fs.copyFileSync.bind(fs);
  let substituted = false;
  const substitute = (file) => {
    if (file !== files.candidate || substituted) return;
    substituted = true;
    fs.renameSync(files.source, files.source + '-original');
    fs.renameSync(privateDirectory, files.source);
  };
  t.mock.method(fs, 'openSync', (file, ...args) => {
    substitute(file);
    return open(file, ...args);
  });
  t.mock.method(fs, 'copyFileSync', (file, ...args) => {
    substitute(file);
    return copy(file, ...args);
  });
  const collected = collectSyntheticEvidence(files.state);
  assert.equal(substituted, true);
  assert.deepEqual(collected.files, []);
  assert.equal(fs.readFileSync(files.candidate, 'utf8'), marker);
  assert.equal(fs.readFileSync(path.join(files.source + '-original', name), 'utf8'), files.approved);
});

test('synthetic collection bounds source reads to the captured size and refuses post-validation growth', (t) => {
  const files = fixture(t);
  const originalSize = fs.statSync(files.candidate).size;
  const open = fs.openSync.bind(fs);
  const read = fs.readSync.bind(fs);
  const copy = fs.copyFileSync.bind(fs);
  let descriptor;
  let grown = false;
  let bytesRead = 0;
  const grow = () => {
    if (grown) return;
    grown = true;
    fs.appendFileSync(files.candidate, marker);
  };
  t.mock.method(fs, 'openSync', (file, ...args) => {
    const opened = open(file, ...args);
    if (file === files.candidate) descriptor = opened;
    return opened;
  });
  t.mock.method(fs, 'readSync', (file, ...args) => {
    if (file === descriptor) grow();
    const size = read(file, ...args);
    if (file === descriptor) bytesRead += size;
    return size;
  });
  t.mock.method(fs, 'copyFileSync', (file, ...args) => {
    if (file === files.candidate) grow();
    return copy(file, ...args);
  });
  const collected = collectSyntheticEvidence(files.state);
  assert.equal(grown, true);
  assert.deepEqual(collected.files, []);
  assert.ok(bytesRead <= originalSize + 1, 'only the fixed-size snapshot and one overflow sentinel may be read');
  assert.deepEqual(fs.readdirSync(collected.output), ['manifest.json']);
});

test('synthetic collection exclusively creates outputs without overwriting a pre-existing private hardlink', (t) => {
  const files = fixture(t);
  const mkdir = fs.mkdirSync.bind(fs);
  let injected = false;
  t.mock.method(fs, 'mkdirSync', (directory, ...args) => {
    const result = mkdir(directory, ...args);
    if (directory.includes('ci-evidence-') && path.basename(directory) === 'synthetic-navigation' && !injected) {
      injected = true;
      fs.linkSync(files.privateFile, path.join(directory, name));
    }
    return result;
  });
  assert.throws(() => collectSyntheticEvidence(files.state), { code: 'EEXIST' });
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(files.privateFile, 'utf8'), marker);
});

test('synthetic collection refuses an output folder replaced by an outside directory link', (t) => {
  const files = fixture(t);
  const outside = path.join(files.root, 'outside-output');
  fs.mkdirSync(outside);
  const mkdir = fs.mkdirSync.bind(fs);
  let substituted = false;
  t.mock.method(fs, 'mkdirSync', (directory, ...args) => {
    const result = mkdir(directory, ...args);
    if (directory.includes('ci-evidence-') && path.basename(directory) === 'synthetic-navigation' && !substituted) {
      substituted = true;
      fs.rmdirSync(directory);
      fs.symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return result;
  });
  assert.throws(() => collectSyntheticEvidence(files.state), /output directory/);
  assert.equal(substituted, true);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.readFileSync(files.privateFile, 'utf8'), marker);
});

test('synthetic collection exclusively creates its manifest even when no source file is collected', (t) => {
  const files = fixture(t);
  fs.unlinkSync(files.candidate);
  const open = fs.openSync.bind(fs);
  const write = fs.writeFileSync.bind(fs);
  let injected = false;
  const inject = (file) => {
    if (path.basename(file) !== 'manifest.json' || injected) return;
    injected = true;
    fs.linkSync(files.privateFile, file);
  };
  t.mock.method(fs, 'openSync', (file, ...args) => {
    inject(file);
    return open(file, ...args);
  });
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    inject(file);
    return write(file, ...args);
  });
  assert.throws(() => collectSyntheticEvidence(files.state), { code: 'EEXIST' });
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(files.privateFile, 'utf8'), marker);
  assert.deepEqual(
    fs.readdirSync(files.state).filter((file) => /^\.?ci-evidence-/.test(file)),
    [],
  );
});

test('synthetic collection still closes independent descriptors and removes private staging after a close failure', (t) => {
  const files = fixture(t);
  const open = fs.openSync.bind(fs);
  const close = fs.closeSync.bind(fs);
  let sourceDescriptor;
  let failed = false;
  let closes = 0;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    const descriptor = open(file, ...args);
    if (file === files.candidate) sourceDescriptor = descriptor;
    return descriptor;
  });
  t.mock.method(fs, 'closeSync', (descriptor) => {
    close(descriptor);
    closes++;
    if (descriptor === sourceDescriptor && !failed) {
      failed = true;
      throw new Error('Invented source close failure');
    }
  });
  assert.throws(() => collectSyntheticEvidence(files.state), /Invented source close failure/);
  assert.equal(failed, true);
  assert.ok(closes >= 3, 'publication, source and private snapshot descriptors are independently closed');
  assert.deepEqual(
    fs.readdirSync(files.state).filter((file) => /^\.?ci-evidence-/.test(file)),
    [],
  );
});

test('synthetic collection refuses a replaced private staging directory without removing the replacement tree', (t) => {
  const files = fixture(t);
  const foreign = path.join(files.root, 'foreign-stage');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'sentinel'), marker);
  const open = fs.openSync.bind(fs);
  let substituted = false;
  let replacement;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (path.basename(file) === 'source-snapshot' && !substituted) {
      substituted = true;
      replacement = path.dirname(file);
      fs.renameSync(replacement, replacement + '-original');
      fs.renameSync(foreign, replacement);
    }
    return open(file, ...args);
  });
  assert.throws(() => collectSyntheticEvidence(files.state), /private staging directory changed/);
  assert.equal(substituted, true);
  assert.equal(fs.readFileSync(path.join(replacement, 'sentinel'), 'utf8'), marker);
  assert.equal(
    fs.statSync(path.join(replacement, 'source-snapshot')).size,
    0,
    'no bytes enter a substituted staging parent',
  );
  assert.deepEqual(
    fs.readdirSync(files.state).filter((file) => /^ci-evidence-/.test(file)),
    [],
  );
});
