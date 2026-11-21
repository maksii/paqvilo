// @test-kind contract: the model-driven panel names its rows and files for people (display names, paths under the source folder), Paqvilo's own designed behaviour on invented sources.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  modelDrivenPanelData,
  modelDrivenPanelInspection,
  modelDrivenSourceDir,
  modelDrivenSourceFiles,
} from '../lense/model-driven-panel.mjs';

const root = path.resolve('/invented/sources'),
  core = path.join(root, 'core'),
  base = path.join(root, 'base'),
  formFile = path.join(core, 'Entities', 'x_item', 'FormXml', 'main', '{aa000000-0000-4000-8000-000000000001}.xml'),
  tableFile = path.join(core, 'Entities', 'x_item', 'Entity.xml'),
  baseTable = path.join(base, 'Entities', 'account', 'Entity.xml');

const state = (extra = {}) => ({
  origin: 'http://127.0.0.1:1',
  token: 'invented',
  revision: 1,
  resources: [],
  diagnostics: [],
  sourceDir: modelDrivenSourceDir([
    { type: 'directory', input: core },
    { type: 'directory', input: base },
  ]),
  context: {
    pageType: 'entityrecord',
    entity: 'x_item',
    formId: 'aa000000-0000-4000-8000-000000000001',
    appId: 'aa000000-0000-4000-8000-000000000002',
  },
  catalogue: {
    forms: [
      {
        id: 'aa000000-0000-4000-8000-000000000001',
        entity: 'x_item',
        name: 'Item',
        type: 'main',
        formType: 2,
        source: formFile,
        controls: [],
        events: [],
      },
    ],
    tables: [
      { logicalName: 'x_item', label: 'Item', source: tableFile },
      { logicalName: 'account', label: '', source: baseTable },
    ],
    views: [],
    apps: [],
    commands: [],
  },
  ...extra,
});

test('the source folder holds every selected root, and none is guessed across unrelated roots', () => {
  assert.equal(state().sourceDir, root);
  assert.equal(modelDrivenSourceDir([{ type: 'directory', input: core }]), core);
  assert.equal(modelDrivenSourceDir([{ type: 'zip', input: path.join(core, 'x.zip') }]), core);
  assert.equal(modelDrivenSourceDir([]), '');
  // Roots that share only the filesystem root (a drive on Windows) have no source folder.
  const top = path.parse(root).root;
  assert.equal(
    modelDrivenSourceDir([
      { type: 'directory', input: path.join(top, 'a', 'x') },
      { type: 'directory', input: path.join(top, 'b', 'y') },
    ]),
    '',
  );
  assert.equal(
    modelDrivenSourceDir([
      { type: 'directory', input: path.join(top, 'a', 'x') },
      { type: 'directory', input: path.join(top, 'a', 'y') },
    ]),
    path.join(top, 'a'),
  );
});

test('Explore and Inspect rows show display names and paths under the source folder, never absolute paths or GUID titles', () => {
  const data = modelDrivenPanelData(state(), { cfg: {} });
  assert.equal(data.sourceDir, root);
  const form = data.sourceCatalogue.find((item) => item.kind === 'form');
  assert.deepEqual(
    { title: form.title, rel: form.rel, path: form.path },
    {
      title: 'Item · main form',
      rel: 'core/Entities/x_item/FormXml/main/{aa000000-0000-4000-8000-000000000001}.xml',
      path: formFile,
    },
  );
  assert.deepEqual(
    data.sourceCatalogue.filter((item) => item.kind === 'table').map((item) => [item.title, item.rel]),
    [
      ['Item · table', 'core/Entities/x_item/Entity.xml'],
      ['account · table', 'base/Entities/account/Entity.xml'],
    ],
  );
  assert.equal(data.page.name, 'Item · main form');
  assert.deepEqual(data.page.sources, [{ rel: form.rel, label: 'FormXml' }]);

  const report = modelDrivenPanelInspection(state());
  assert.deepEqual(
    report.pageSources.map((item) => [item.name, item.ref, item.path]),
    [
      ['Item · main form', form.rel, formFile],
      ['Item · table', 'core/Entities/x_item/Entity.xml', tableFile],
    ],
  );
  // The header names the open form; its GUID stays in formId.
  assert.equal(report.modelDriven.formName, 'Item');
  assert.equal(report.modelDriven.formType, 'main');
});

test('a row opens its file by the relative path it shows, and only files of the selected sources', () => {
  const files = modelDrivenSourceFiles(state());
  assert.equal(files.get('core/Entities/x_item/FormXml/main/{aa000000-0000-4000-8000-000000000001}.xml'), formFile);
  assert.equal(files.get(formFile), formFile);
  assert.equal(files.get('base/Entities/account/Entity.xml'), baseTable);
  assert.equal(files.get('core/Entities/x_other/Entity.xml'), undefined);
  assert.equal(files.get('../outside.xml'), undefined);
});

test('the panel data says whether the session is a local simulation, which has no deployed files to switch to', () => {
  assert.equal(modelDrivenPanelData(state({ localSimulation: true }), { cfg: {} }).localSimulation, true);
  assert.equal(modelDrivenPanelData(state(), { cfg: {} }).localSimulation, false);
});

test('without a source folder the rows keep their files as they are', () => {
  const data = modelDrivenPanelData(state({ sourceDir: undefined }), { cfg: {} });
  assert.equal(data.sourceCatalogue.find((item) => item.kind === 'form').rel, formFile);
});

test('without a Git baseline Issues says why in model-driven words; with one it says nothing', () => {
  const withResource = state({ resources: [{ name: 'x_item.js', paths: ['/webresources/x_item.js'] }] }),
    baseline = (git, baselineState = null) =>
      modelDrivenPanelData(withResource, { cfg: {}, git, baselineState })
        .notes.filter((note) => note.kind === 'baseline')
        .map((note) => note.reason);
  assert.deepEqual(baseline(null, { outsideRepository: true, unborn: false }), [
    'Your Solution sources are not in a Git checkout, so there is no Git baseline: Edited stays empty and "changed vs Git" overrides nothing. Keep the sources in a Git checkout to use them.',
  ]);
  // A repository before its first commit has no HEAD either; it is not "not a checkout".
  assert.match(
    baseline(null, { outsideRepository: false, unborn: true })[0],
    /^The Git repository of your Solution sources has no commits yet, .* Commit the sources to use them.$/,
  );
  // Git that gave no answer leaves the state unknown, without advice that may be wrong.
  assert.match(baseline(null)[0], /^Git did not report a HEAD commit for your Solution sources/);
  assert.match(
    baseline({ baseline: { available: false } }, { outsideRepository: false, unborn: false })[0],
    /^Git did not report a HEAD commit/,
  );
  assert.deepEqual(baseline({ commit: 'a'.repeat(40), baseline: { available: true, commit: 'a'.repeat(40) } }), []);
  assert.deepEqual(
    modelDrivenPanelData(state(), { cfg: {}, git: null }).notes,
    [],
    'without web resources nothing is compared with Git, so Issues has nothing to say',
  );
  for (const reason of [
    ...baseline(null),
    ...baseline(null, { outsideRepository: true }),
    ...baseline(null, { unborn: true }),
  ])
    assert.doesNotMatch(reason, /template|snippet|portal/i, 'no portal words in a model-driven note');
});

test('the panel names the app by its display name, never the configuration file', () => {
  const app = { id: 'aa000000-0000-4000-8000-000000000002', name: 'Invented operations', uniqueName: 'x_ops' };
  const named = (catalogue, cfg = { siteName: 'mirage.project.yml' }) =>
    modelDrivenPanelData(state({ catalogue: { ...state().catalogue, ...catalogue } }), { cfg }).site;
  assert.equal(
    named({ apps: [app, { ...app, id: 'aa000000-0000-4000-8000-000000000003', name: 'Other' }] }),
    'Invented operations',
  );
  // The page's app id may arrive in braces and upper case.
  assert.equal(
    modelDrivenPanelData(
      state({
        context: { ...state().context, appId: '{AA000000-0000-4000-8000-000000000002}' },
        catalogue: { ...state().catalogue, apps: [app, { ...app, id: 'x', name: 'Other' }] },
      }),
      { cfg: {} },
    ).site,
    'Invented operations',
  );
  assert.equal(named({ apps: [] }), 'mirage.project.yml', 'without an app the configured name stays');
});
