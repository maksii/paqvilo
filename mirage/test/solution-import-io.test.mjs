// @test-kind contract: Solution side-source importers read concurrently while keeping their serial output, byte budget, diagnostics and single-open behaviour
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readLocalFile } from '../../lense/local-file.mjs';
import { importCodeComponents } from '../lib/code-components.mjs';
import { importModelDrivenResources } from '../lib/model-driven-resources.mjs';
import { importSolutionOperationSources } from '../lib/operation-catalogue.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const SITE = 'a0000000-0000-4000-8000-000000000001';
const PINNED_CONTROL_DIGEST = 'c6dc31fa216794133a4114e97afa08981eb22d773301b30e00cbfb362d36467d';
const PINNED_OPERATION_DIGEST = '232acc772dd30c8ac0e92d074eb7f76f2af211ac7dd9e1eba1baeb8896b83d32';
const noop = () => {};
const styles = Array.from({ length: 11 }, (_, index) => `style-${String(index).padStart(2, '0')}.css`);
const standardResources = [
  '<code path="bundle.js" order="1"/>',
  ...styles.map((file, index) => `<css path="${file}" order="${index + 2}"/>`),
].join('');
const standardFiles = {
  'bundle.js': 'window.ComponentFramework.registerControl("Synthetic.Editor",class{});',
  ...Object.fromEntries(styles.map((file) => [file, '.a{color:red}'])),
};
const guid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

async function workspace(t) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-solution-io-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeFiles(root, files) {
  for (const [relative, text] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fsp.writeFile(path.join(root, relative), text);
  }
}

async function writeControl(
  control,
  { name = 'tst_Synthetic.Editor', resources = standardResources, files = {} } = {},
) {
  await writeFiles(control, {
    'ControlManifest.xml': `<manifest><control namespace="Synthetic" constructor="Editor" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="bound"/><resources>${resources}</resources></control></manifest>`,
    'ControlManifest.xml.data.xml': `<CustomControl><Name>${name}</Name></CustomControl>`,
    ...standardFiles,
    ...files,
  });
}

// One in-flight gauge for both the injected reader and the wrapped open: the active count rises while a read awaits.
function gauge() {
  const state = { active: 0, peak: 0 };
  return {
    state,
    async run(task) {
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        return await task();
      } finally {
        state.active -= 1;
      }
    },
  };
}

// Serial reference: the same reads, one after another, in call order.
function serialized() {
  let queue = Promise.resolve();
  return (task) => {
    const run = queue.then(task);
    queue = run.then(noop, noop);
    return run;
  };
}

async function withOpen(wrap, task) {
  const original = fsp.open;
  fsp.open = (file, ...rest) => wrap(String(file), () => original.call(fsp, file, ...rest));
  try {
    return await task();
  } finally {
    fsp.open = original;
  }
}

function unhandledRejections(t) {
  const seen = [];
  const listener = (reason) => seen.push(reason);
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));
  return async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return seen;
  };
}

// Digest of the output with the workspace root replaced by <root> and, on Windows, the two separators swapped inside
// those root paths (a bijection, so a path that mixes or changes separators still changes the digest), plus the
// root-derived token: the pinned value is the same on every platform and every temp folder.
function digestOf(value, root) {
  const portable = (item) => (path.sep === '\\' ? item.replace(/[\\/]/g, (sep) => (sep === '\\' ? '/' : '\\')) : item);
  const text = JSON.stringify(value, (_, item) => {
    if (item instanceof Map) return [...item];
    if (typeof item === 'string' && (item === root || item.startsWith(root + path.sep))) {
      return `<root>${portable(item.slice(root.length))}`;
    }
    return item;
  }).replace(/__sim-static\/pcf\/[0-9a-f]{24}/g, '__sim-static/pcf/<token>');
  assert.equal(text.includes(JSON.stringify(root).slice(1, -1)), false, 'the workspace root is replaced everywhere');
  return createHash('sha256').update(text).digest('hex');
}

function assertSameCatalogue(actual, expected) {
  assert.deepStrictEqual([...actual.controls], [...expected.controls]);
  assert.deepStrictEqual([...actual.assets], [...expected.assets]);
  assert.deepStrictEqual(actual.diagnostics, expected.diagnostics);
}

async function writeComponent(root, folder, { id, name, type, site = SITE, statecode = 0, content = '{}', file }) {
  const fileLine = file ? `<filecontent>${file}</filecontent>` : '';
  await writeFiles(path.join(root, folder), {
    'powerpagecomponent.xml': `<?xml version="1.0" encoding="utf-8"?><powerpagecomponent powerpagecomponentid="${id}"><name>${name}</name><powerpagecomponenttype>${type}</powerpagecomponenttype><statecode>${statecode}</statecode><powerpagesiteid>${site}</powerpagesiteid><content>${content}</content>${fileLine}</powerpagecomponent>`,
    ...(file ? { [`filecontent/${file}`]: `// ${name}` } : {}),
  });
}

async function writeOperationFixture(dir) {
  const root = path.join(dir, 'powerpagecomponents');
  const logic = (number) => ({ id: guid(number), name: `tst_Logic_${number}`, type: 35, file: `logic-${number}.js` });
  const flow = (number) => ({
    id: guid(number),
    name: `tst_Flow_${number}`,
    type: 33,
    content: `{"flowapiurl":"/_api/cloudflow/v1.0/trigger/11111111-1111-4111-8111-${String(number).padStart(12, '0')}","processid":"${guid(number + 100)}"}`,
  });
  const components = [logic(1), logic(2), logic(3), logic(4), logic(5), flow(6), flow(7), flow(8)];
  for (const component of components) await writeComponent(root, `c${component.id.slice(-2)}`, component);
  await writeComponent(root, 'other-site', { id: guid(9), name: 'tst_Other', type: 35, site: guid(99), file: 'x.js' });
  await writeComponent(root, 'inactive', { id: guid(10), name: 'tst_Inactive', type: 35, statecode: 1, file: 'y.js' });
  return { layers: [{ dir }], website: { id: SITE } };
}

test('PCF declared resources are read concurrently', async (t) => {
  const dir = await workspace(t);
  await writeControl(path.join(dir, 'Controls', 'tst_Synthetic.Editor'));
  const reads = gauge();
  const catalogue = await importCodeComponents([{ dir }], {
    readFile: (file, options) => reads.run(() => readLocalFile(file, options)),
  });
  assert.equal(catalogue.controls.size, 1);
  assert.ok(reads.state.peak > 1, `expected overlapping PCF reads, saw ${reads.state.peak}`);
});

test('PCF catalogue output is pinned to the pre-change import', async (t) => {
  const dir = await workspace(t);
  const resx = [
    '<root>',
    '<data name="Title"><value>Title</value></data>',
    '<data name="Title"><value>Again</value></data>',
    '<data><value>unnamed</value></data>',
    '</root>',
  ].join('');
  await writeControl(path.join(dir, 'Controls', 'tst_Synthetic.Editor'), {
    resources: `${standardResources}<resx path="strings/Labels.resx" order="20"/>`,
    files: { 'strings/Labels.resx': resx },
  });
  const catalogue = await importCodeComponents([{ dir }]);
  assert.equal(digestOf({ ...catalogue, controls: [...catalogue.controls] }, dir), PINNED_CONTROL_DIGEST);
  assert.equal(catalogue.assets.size, 13, 'the code, the eleven stylesheets and the resx are all declared');
});

test('PCF catalogue order and supersede match a serialized reading', async (t) => {
  const dir = await workspace(t);
  const first = path.join(dir, 'first');
  const second = path.join(dir, 'second');
  await writeControl(path.join(first, 'Controls', 'a_Synthetic'));
  await writeControl(path.join(first, 'Controls', 'c_Other'), { name: 'tst_Other.Editor' });
  await writeControl(path.join(second, 'Controls', 'b_Synthetic'), {
    resources: '<code path="bundle.js" order="1"/><css path="absent.css" order="2"/>',
  });
  const layers = [{ dir: first }, { dir: second }];
  const reads = gauge();
  const concurrent = await importCodeComponents(layers, {
    readFile: (file, options) => reads.run(() => readLocalFile(file, options)),
  });
  const once = serialized();
  const reference = await importCodeComponents(layers, {
    readFile: (file, options) => once(() => readLocalFile(file, options)),
  });
  assertSameCatalogue(concurrent, reference);
  assert.equal(
    concurrent.controls.has('tst_Synthetic.Editor'),
    false,
    'the later declaration supersedes the earlier control',
  );
  assert.deepStrictEqual([...concurrent.controls.keys()], ['tst_Other.Editor']);
  assert.ok(
    concurrent.diagnostics.some(
      (item) => item.code === 'PCF_IMPORT_FAILED' && item.file.endsWith('ControlManifest.xml'),
    ),
  );
});

test('operation sources are read concurrently', async (t) => {
  const dir = await workspace(t);
  const { layers, website } = await writeOperationFixture(dir);
  const opens = gauge();
  const sources = await withOpen(
    (file, run) => opens.run(run),
    () => importSolutionOperationSources(layers, website),
  );
  assert.equal(sources.serverLogics.length + sources.cloudFlows.length, 8);
  assert.ok(opens.state.peak > 1, `expected overlapping component reads, saw ${opens.state.peak}`);
});

test('operation source output is pinned and ordered like a serialized reading', async (t) => {
  const dir = await workspace(t);
  const { layers, website } = await writeOperationFixture(dir);
  const sources = await importSolutionOperationSources(layers, website);
  const byId = (items) => items.toSorted((a, b) => a.id.localeCompare(b.id));
  assert.equal(
    digestOf({ serverLogics: byId(sources.serverLogics), cloudFlows: byId(sources.cloudFlows) }, dir),
    PINNED_OPERATION_DIGEST,
  );
  const once = serialized();
  const reference = await withOpen(
    (file, run) => once(run),
    () => importSolutionOperationSources(layers, website),
  );
  assert.deepStrictEqual(sources, reference);
});

test('a control file is opened once when the model-driven import reuses the PCF catalogue', async (t) => {
  const dir = await workspace(t);
  const control = path.join(dir, 'Controls', 'tst_Synthetic.Editor');
  await writeControl(control);
  const opened = new Map();
  const count = (file) => opened.set(file, (opened.get(file) ?? 0) + 1);
  const expected = ['ControlManifest.xml', 'ControlManifest.xml.data.xml', 'bundle.js', ...styles].map((file) =>
    path.join(control, file),
  );
  const { imported, catalogue } = await withOpen(
    (file, run) => {
      count(file);
      return run();
    },
    async () => {
      const catalogue = await importCodeComponents([{ dir }], { retainBytes: true });
      const imported = await importModelDrivenResources([{ type: 'directory', dir }], { codeComponents: catalogue });
      return { imported, catalogue };
    },
  );
  assert.equal(catalogue.controls.size, 1);
  assert.equal(imported.pcf.controls.length, 1);
  for (const file of expected) assert.equal(opened.get(file), 1, `${file} is opened once`);
});

test('the model-driven byte budget still rejects the admitted PCF bytes above its total', async (t) => {
  const dir = await workspace(t);
  const control = path.join(dir, 'Controls', 'tst_Synthetic.Editor');
  await writeControl(control);
  const sizes = await Promise.all(
    ['ControlManifest.xml', 'ControlManifest.xml.data.xml', 'bundle.js', ...styles].map(
      async (file) => (await fsp.stat(path.join(control, file))).size,
    ),
  );
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const layers = [{ type: 'directory', dir }];
  const fits = await importModelDrivenResources(layers, {
    codeComponents: await importCodeComponents([{ dir }]),
    limits: { bytes: total },
  });
  assert.equal(
    fits.diagnostics.some((item) => item.code === 'MODEL_CLIENT_IMPORT_LIMIT'),
    false,
  );
  const over = await importModelDrivenResources(layers, {
    codeComponents: await importCodeComponents([{ dir }]),
    limits: { bytes: total - 1 },
  });
  assert.equal(over.diagnostics[0].code, 'MODEL_CLIENT_IMPORT_LIMIT');
});

test('a PCF resource read that fails mid-control keeps the serial diagnostic and leaves no pending read', async (t) => {
  const dir = await workspace(t);
  const control = path.join(dir, 'Controls', 'tst_Synthetic.Editor');
  await writeControl(control);
  const pending = unhandledRejections(t);
  const catalogue = await importCodeComponents([{ dir }], {
    readFile: async (file, options) => {
      if (file.endsWith('style-05.css')) throw new Error('injected read failure');
      return readLocalFile(file, options);
    },
  });
  assert.equal(catalogue.controls.size, 0);
  assert.deepStrictEqual(catalogue.diagnostics, [
    { code: 'PCF_IMPORT_FAILED', file: path.join(control, 'ControlManifest.xml'), message: 'injected read failure' },
  ]);
  assert.deepStrictEqual(await pending(), []);
});

test('a failing operation source read rejects with the serial error after every read settles', async (t) => {
  const dir = await workspace(t);
  const { layers, website } = await writeOperationFixture(dir);
  const failing = path.join(dir, 'powerpagecomponents', 'c03', 'powerpagecomponent.xml');
  const opens = gauge();
  const pending = unhandledRejections(t);
  await withOpen(
    (file, run) => {
      if (file === failing) return Promise.reject(new Error('injected open failure'));
      return opens.run(run);
    },
    () => assert.rejects(importSolutionOperationSources(layers, website), { message: 'injected open failure' }),
  );
  assert.equal(opens.state.active, 0, 'no component read is still pending');
  assert.deepStrictEqual(await pending(), []);
});
