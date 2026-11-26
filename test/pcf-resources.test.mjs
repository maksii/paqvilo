// @test-kind contract: code component (PCF) resources of a portal page mapped to Solution files by Lense (lense/pcf-resources.mjs, lense/session.mjs, lense/panel.mjs, lense/source-inspection.mjs); invented control and loopback-free fake browser; the declaration shape follows a live page, the mapping and its refusals are Paqvilo's design
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  decodeHtmlAttribute,
  pcfDeclarations,
  joinPcfDeclaration,
  SolutionResourceIndex,
  PCF_RESOURCE_PATH,
} from '../lense/pcf-resources.mjs';
import { importCodeComponents } from '../mirage/lib/code-components.mjs';
import { OverlaySession } from '../lense/session.mjs';
import { interceptOrigin } from '../lense/intercept.mjs';
import { enablePanel } from '../lense/panel.mjs';
import { createSourceInspector } from '../lense/source-inspection.mjs';
import { createFixture, SITE, tempDirSync } from './fixture.mjs';
import { fakeBrowser, pausedAnswers as answers } from './fake-browser.mjs';

const ORIGIN = 'https://portal.example.com';
const SCHEMA = 'inv_Invented.Widget';
const G = {
  bundle: '0a0a0a0a-1111-4111-8111-000000000001',
  first: '0a0a0a0a-1111-4111-8111-000000000002',
  second: '0a0a0a0a-1111-4111-8111-000000000003',
  strings: '0a0a0a0a-1111-4111-8111-000000000004',
  config: '0a0a0a0a-1111-4111-8111-0000000000c0',
};
const BUNDLE = 'window.InventedWidget = function () { return "local bundle"; };\n';
const FIRST_CSS = '.invented-first { color: green; }\n';
const SECOND_CSS = '.invented-second { color: blue; }\n';

const manifest = (resources) =>
  `<manifest><control namespace="Invented" constructor="Widget" version="1.0.0" display-name-key="Widget" description-key="Invented control." control-type="standard" api-version="1.3.18"><property name="value" display-name-key="Value" description-key="Value." of-type="SingleLine.Text" usage="bound" required="false" /><resources>${resources}</resources></control></manifest>`;
const DEFAULT_RESOURCES =
  '<code path="bundle.js" order="1" /><css path="css/first.css" order="1" /><css path="css/second.css" order="1" /><resx path="strings/Widget.1033.resx" version="1.0.0" />';

/** An unpacked Solution with one invented code component; `resources` replaces the manifest's resource list. */
function solution(t, { resources = DEFAULT_RESOURCES, schema = SCHEMA, extra = {} } = {}) {
  const root = tempDirSync('paqvilo-pcf-solution-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const control = path.join(root, 'Controls', schema);
  const files = {
    'ControlManifest.xml': manifest(resources),
    'ControlManifest.xml.data.xml': `<?xml version="1.0" encoding="utf-8"?><CustomControl><Name>${schema}</Name><FileName>/Controls/${schema}/ControlManifest.xml</FileName></CustomControl>`,
    'bundle.js': BUNDLE,
    'css/first.css': FIRST_CSS,
    'css/second.css': SECOND_CSS,
    'strings/Widget.1033.resx': '<root><data name="Hello"><value>Hello</value></data></root>',
    ...extra,
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(control, rel)), { recursive: true });
    fs.writeFileSync(path.join(control, rel), text);
  }
  return { root: fs.realpathSync.native(root), control: fs.realpathSync.native(control) };
}

/** The declaration a live page writes, HTML-entity encoded as the platform encodes it. */
function declaration({ name = SCHEMA, resources } = {}) {
  const config = {
    SubscribedFunctionalities: {},
    Properties: [{ Name: 'value', DisplayName: "Invented's value", Type: 6 }],
    Resources: resources ?? [
      { Type: 2, Path: null, ModifiedPath: '', LoadingOrder: 0, IsControlSpecific: true },
      {
        Type: 3,
        Path: JSON.stringify({ Id: 'ManifestTemplate', Data: { ConstructorName: 'Invented.Widget' } }),
        ModifiedPath: '',
        LoadingOrder: 1,
        IsControlSpecific: false,
      },
      { Type: 2, Path: G.strings, ModifiedPath: '', LoadingOrder: 3, IsControlSpecific: true },
      { Type: 0, Path: G.bundle.toUpperCase(), ModifiedPath: '', LoadingOrder: 4, IsControlSpecific: true },
      { Type: 1, Path: G.first, ModifiedPath: '', LoadingOrder: 4, IsControlSpecific: true },
      { Type: 1, Path: G.second, ModifiedPath: '', LoadingOrder: 4, IsControlSpecific: true },
      {
        Type: 3,
        Path: '{"Id":"FormattingData","Data":{}}',
        ModifiedPath: '',
        LoadingOrder: 8,
        IsControlSpecific: false,
      },
    ],
    Name: name,
    IsCdnControl: false,
  };
  return JSON.stringify(config)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll(' ', '&#32;');
}

const page = (config = declaration(), id = G.config) =>
  `<!doctype html><html><head><link href="/_pcfwebresource/${G.first}" rel="stylesheet"><link href="/_pcfwebresource/${G.second}" rel="stylesheet"></head><body><div><span id="${id}_Container" class="flexbox"><script type="text/javascript" src="/_pcfwebresource/${G.bundle}?1700000000000"></script><span id="PcfControlConfig_${id}" data-pcf-control="${config}"></span></span></div></body></html>`;

test('a declaration is read from its entity-encoded attribute, with the requested resource types in page order', () => {
  assert.equal(decodeHtmlAttribute('&quot;a&#32;b&#39;&amp;&#x41;&lt;&unknown;'), '"a b\'&A<&unknown;');
  const html =
    page() + `<span id="PcfControlConfig_field" data-pcf-control='${declaration({ name: 'inv_Other.Thing' })}'></span>`;
  assert.deepEqual(pcfDeclarations(html), [
    {
      name: SCHEMA,
      resources: [
        { type: 2, guid: G.strings },
        { type: 0, guid: G.bundle },
        { type: 1, guid: G.first },
        { type: 1, guid: G.second },
      ],
      properties: ['value'],
    },
    {
      name: 'inv_Other.Thing',
      properties: ['value'],
      resources: [
        { type: 2, guid: G.strings },
        { type: 0, guid: G.bundle },
        { type: 1, guid: G.first },
        { type: 1, guid: G.second },
      ],
    },
  ]);
  // An unreadable declaration or a name that is not a schema name declares nothing.
  assert.deepEqual(pcfDeclarations('<span data-pcf-control="{not json"></span>'), []);
  assert.deepEqual(pcfDeclarations(page(declaration({ name: '../../etc/x' }))), []);
  assert.deepEqual(pcfDeclarations('<p>no code components</p>'), []);
});

test('declared resources join to the manifest by kind and order', async (t) => {
  const { root, control } = solution(t);
  const catalogue = await importCodeComponents([{ dir: root }]);
  const [declared] = pcfDeclarations(page());
  const joined = joinPcfDeclaration({ ...declared, name: SCHEMA.toLowerCase() }, catalogue);
  assert.equal(joined.control, SCHEMA);
  assert.equal(joined.componentKey, 'pcf:inv_invented.widget');
  assert.deepEqual(
    joined.resources.map(({ guid, kind, order, path: rel, file }) => ({ guid, kind, order, rel, file })),
    [
      { guid: G.bundle, kind: 'code', order: 0, rel: 'bundle.js', file: path.join(control, 'bundle.js') },
      { guid: G.first, kind: 'css', order: 0, rel: 'css/first.css', file: path.join(control, 'css', 'first.css') },
      { guid: G.second, kind: 'css', order: 1, rel: 'css/second.css', file: path.join(control, 'css', 'second.css') },
      {
        guid: G.strings,
        kind: 'resx',
        order: 0,
        rel: 'strings/Widget.1033.resx',
        file: path.join(control, 'strings', 'Widget.1033.resx'),
      },
    ],
  );
});

test('a kind whose counts differ is refused alone, and a control without any matching kind or sources is refused', async (t) => {
  const { root, control } = solution(t, {
    resources: '<code path="bundle.js" order="1" /><css path="css/first.css" order="1" />',
  });
  const catalogue = await importCodeComponents([{ dir: root }]);
  const [declared] = pcfDeclarations(page());
  // The bundle still maps; the style sheets the page and the manifest count differently are a change to deploy.
  assert.deepEqual(joinPcfDeclaration(declared, catalogue), {
    control: SCHEMA,
    componentKey: 'pcf:inv_invented.widget',
    manifestFile: catalogue.controls.get(SCHEMA).file,
    mismatches: [{ kind: 'css', declared: 2, manifest: 1 }],
    refusedGuids: [G.first, G.second],
    resources: [
      {
        guid: G.bundle,
        kind: 'code',
        order: 0,
        path: 'bundle.js',
        file: path.join(control, 'bundle.js'),
        controlRoot: control,
      },
    ],
    unresolvedResx: [G.strings],
  });
  // Both kinds differ: nothing maps and the control is refused.
  const [both] = pcfDeclarations(
    page(
      declaration({
        resources: [
          { Type: 0, Path: G.bundle },
          { Type: 0, Path: G.first },
          { Type: 1, Path: G.second },
          { Type: 1, Path: G.strings },
        ],
      }),
    ),
  );
  assert.deepEqual(joinPcfDeclaration(both, catalogue), {
    refused: 'pcf-manifest-mismatch',
    control: SCHEMA,
    componentKey: 'pcf:inv_invented.widget',
    manifestFile: catalogue.controls.get(SCHEMA).file,
    detail: { kind: 'code', declared: 2, manifest: 1 },
    mismatches: [
      { kind: 'code', declared: 2, manifest: 1 },
      { kind: 'css', declared: 2, manifest: 1 },
    ],
  });
  // A parameter the local manifest renamed is a change to deploy; the resources still map.
  const full = await importCodeComponents([{ dir: solution(t).root }]);
  const [renamed] = pcfDeclarations(
    page().replace('&quot;Name&quot;:&quot;value&quot;', '&quot;Name&quot;:&quot;oldValue&quot;'),
  );
  const joined = joinPcfDeclaration(renamed, full);
  assert.deepEqual(joined.mismatches, [{ kind: 'property', declared: ['oldValue'], manifest: ['value'] }]);
  assert.equal(joined.resources.length, 4);
  // A page that lists fewer parameters than the manifest (an output, an unbound input) is no change: whether the live
  // Properties list carries every manifest property is not established.
  const more = await importCodeComponents([
    {
      dir: solution(t, {
        resources: DEFAULT_RESOURCES,
        extra: {
          'ControlManifest.xml': manifest(DEFAULT_RESOURCES).replace(
            '<resources>',
            '<property name="result" of-type="SingleLine.Text" usage="output" /><resources>',
          ),
        },
      }).root,
    },
  ]);
  const [subset] = pcfDeclarations(page());
  assert.equal(joinPcfDeclaration(subset, more).mismatches, undefined);
  assert.deepEqual(joinPcfDeclaration({ ...declared, name: 'inv_Missing.Control' }, catalogue), {
    refused: 'pcf-control-not-in-sources',
    control: 'inv_Missing.Control',
  });
  // Style sheets with different load orders: the order the page lists them in is not established.
  const ordered = solution(t, {
    resources:
      '<code path="bundle.js" order="1" /><css path="css/first.css" order="2" /><css path="css/second.css" order="1" />',
  });
  const orderedCatalogue = await importCodeComponents([{ dir: ordered.root }]);
  assert.deepEqual(joinPcfDeclaration(declared, orderedCatalogue).mismatches, [{ kind: 'css', order: 'differs' }]);
  // A declared code or style entry without a GUID path cannot name a file.
  const [unnamed] = pcfDeclarations(
    page(
      declaration({
        resources: [
          { Type: 0, Path: null },
          { Type: 1, Path: G.first },
          { Type: 1, Path: G.second },
        ],
      }),
    ),
  );
  assert.equal(joinPcfDeclaration(unnamed, catalogue).refused, 'pcf-manifest-mismatch');
});

// @test-kind security: a page-declared name or path never selects a file outside the manifest's resources inside a configured Solution root
test('only manifest-declared files inside a configured Solution root are ever mapped', async (t) => {
  const { root, control } = solution(t, {
    resources:
      '<code path="../escape.js" order="1" /><css path="css/first.css" order="1" /><css path="css/second.css" order="1" />',
  });
  fs.writeFileSync(path.join(path.dirname(control), 'escape.js'), 'outside the control folder');
  const catalogue = await importCodeComponents([{ dir: root }]);
  // The catalogue refuses a manifest that names a file outside its control folder: the control is not in the sources.
  const [declared] = pcfDeclarations(page());
  const index = new SolutionResourceIndex();
  const sourceDir = fs.realpathSync.native(tempDirSync('paqvilo-pcf-export-'));
  t.after(() => fs.rmSync(sourceDir, { recursive: true, force: true }));
  const entries = index.notePcf([declared], { catalogue, roots: [root], sourceDir });
  assert.deepEqual(
    entries.map((entry) => [entry.url, entry.refused, entry.file]),
    [G.strings, G.bundle, G.first, G.second].map((guid) => [
      `/_pcfwebresource/${guid}`,
      'pcf-control-not-in-sources',
      undefined,
    ]),
  );
  // A catalogue file outside every configured Solution root is not mapped either.
  const good = solution(t);
  const goodCatalogue = await importCodeComponents([{ dir: good.root }]);
  const elsewhere = index.notePcf([declared], { catalogue: goodCatalogue, roots: [root], sourceDir });
  assert.ok(elsewhere.every((entry) => entry.refused === 'pcf-manifest-mismatch' && !entry.file));
  assert.equal(index.lookup(`/_pcfwebresource/${G.bundle}`).file, undefined);
  // A web resource name never leaves the WebResources folder, and needs its PAC declaration beside it.
  fs.mkdirSync(path.join(good.root, 'WebResources'), { recursive: true });
  fs.writeFileSync(path.join(good.root, 'WebResources', 'inv_banner.html'), '<p>local</p>');
  fs.writeFileSync(path.join(good.root, 'secret.html'), 'outside');
  fs.writeFileSync(path.join(good.root, 'secret.html.data.xml'), '<WebResource/>');
  const sources = { catalogue: goodCatalogue, roots: [good.root], sourceDir };
  assert.equal(index.noteWebResource('/_webresource/../secret.html', sources), null);
  assert.equal(index.noteWebResource('/_webresource/inv_banner.html', sources), null);
  fs.writeFileSync(path.join(good.root, 'WebResources', 'inv_banner.html.data.xml'), '<WebResource/>');
  const banner = index.noteWebResource('/_webresource/inv_banner.html', sources);
  assert.equal(banner.file, path.join(good.root, 'WebResources', 'inv_banner.html'));
  assert.equal(banner.rel, `@${path.basename(good.root)}/WebResources/inv_banner.html`);
});

// --- the session

async function overlay(t, { root, site = {}, mirage = false, online = {}, panel = false } = {}) {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  const session = new OverlaySession({
    origin: ORIGIN,
    sourceDir: fx.dir,
    sourceMaps: false,
    siteName: 'invented',
    mirageConfig: { solutionRoots: [root] },
    ...(mirage ? { mirage: true } : {}),
    site: { ...structuredClone(SITE), ...site },
  });
  const b = fakeBrowser({
    [ORIGIN + '/widget']: { headers: { 'content-type': 'text/html; charset=utf-8' }, body: page() },
    ...online,
  });
  const tab = b.openTab(`${ORIGIN}/widget`);
  let shown = null;
  if (panel) {
    shown = enablePanel(b.context, session, { open: async () => null, headless: true });
    t.after(() => shown.dispose());
    await shown.ready;
  }
  if (mirage && !panel) session.sourceInspector = createSourceInspector(session.cfg);
  t.after(await interceptOrigin(b.context, ORIGIN, session.route));
  const pause = answers(tab);
  let n = 0;
  const load = async (address, type = 'Script') => {
    const id = `r${++n}`;
    await pause(id, ORIGIN + address, { type });
    return b.answers(id).at(-1);
  };
  // The ledger keeps an address without its query values (a cache stamp keeps only its name).
  const ledger = (address) => session.requestSummary(tab.page).items.find((item) => item.url.split('?')[0] === address);
  return { session, tab, b, load, ledger, fx, panel: shown };
}

const body = (answer) => Buffer.from(answer.body ?? '', 'base64').toString();
const header = (answer, name) => answer.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value;

test('the resources a page declares are answered from the Solution files and recorded as local', async (t) => {
  const { root } = solution(t);
  const { load, ledger, session, b } = await overlay(t, { root });
  await load('/widget', 'Document');
  const script = await load(`/_pcfwebresource/${G.bundle}?1700000000000`);
  assert.equal(script.method, 'Fetch.fulfillRequest');
  assert.equal(body(script), BUNDLE);
  assert.match(header(script, 'content-type'), /javascript/);
  const style = await load(`/_pcfwebresource/${G.second}`, 'Stylesheet');
  assert.equal(body(style), SECOND_CSS);
  assert.match(header(style, 'content-type'), /^text\/css/);
  const rel = `@${path.basename(root)}/Controls/${SCHEMA}/bundle.js`;
  // The ledger names the file and the control; the query (a cache stamp) is never kept.
  assert.deepEqual(
    (({ url, class: kind, rel: file, kind: resource, control, status }) => ({
      url,
      kind,
      file,
      resource,
      control,
      status,
    }))(ledger(`${ORIGIN}/_pcfwebresource/${G.bundle}`)),
    {
      url: `${ORIGIN}/_pcfwebresource/${G.bundle}?1700000000000=%5Bredacted%5D`,
      kind: 'local',
      file: rel,
      resource: 'pcf-resource',
      control: SCHEMA,
      status: 200,
    },
  );
  assert.equal(session.solutionSource(rel).file, path.join(root, 'Controls', SCHEMA, 'bundle.js'));
  assert.equal(session.rel(path.join(root, 'Controls', SCHEMA, 'bundle.js')), rel);
  assert.deepEqual(session.pcfResourcesFor(b.context.tabs[0].page), [
    { url: `/_pcfwebresource/${G.bundle}`, control: SCHEMA, kind: 'code', path: 'bundle.js' },
    { url: `/_pcfwebresource/${G.first}`, control: SCHEMA, kind: 'css', path: 'css/first.css' },
    { url: `/_pcfwebresource/${G.second}`, control: SCHEMA, kind: 'css', path: 'css/second.css' },
    { url: `/_pcfwebresource/${G.strings}`, control: SCHEMA, kind: 'resx', path: 'strings/Widget.1033.resx' },
  ]);
  // Only the document was asked of the portal.
  assert.deepEqual(
    b.fetched.map((request) => new URL(request.url).pathname),
    ['/widget'],
  );
  // A GUID no declaration maps stays what it is without a mapping.
  await load('/_pcfwebresource/0a0a0a0a-1111-4111-8111-00000000ffff');
  assert.deepEqual(
    (({ class: kind, platform, reason }) => ({ kind, platform, reason }))(
      ledger(`${ORIGIN}/_pcfwebresource/0a0a0a0a-1111-4111-8111-00000000ffff`),
    ),
    { kind: 'platform-asset', platform: 'web-resource', reason: undefined },
  );
});

test('a paused or out-of-scope resource goes to the portal and the ledger says why', async (t) => {
  const { root } = solution(t);
  // Scope "changed vs Git": the Solution folder is committed in its own repository and unchanged there.
  for (const args of [
    ['init', '-q'],
    ['add', '.'],
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'x'],
  ])
    execFileSync('git', args, { cwd: root });
  const { load, ledger, session } = await overlay(t, { root, site: { scope: 'changed' } });
  await load('/widget', 'Document');
  const unchanged = await load(`/_pcfwebresource/${G.bundle}`);
  assert.equal(unchanged.method, 'Fetch.continueRequest');
  assert.deepEqual(
    (({ class: kind, kind: resource, reason }) => ({ kind, resource, reason }))(
      ledger(`${ORIGIN}/_pcfwebresource/${G.bundle}`),
    ),
    { kind: 'export', resource: 'pcf-resource', reason: 'out-of-scope' },
  );
  // An edit makes it a change: it is served.
  const first = path.join(root, 'Controls', SCHEMA, 'css', 'first.css');
  fs.writeFileSync(first, '.invented-first { color: red; }\n');
  session.refresh([first]);
  assert.equal(session.classifyChanges([first]).relevant.length, 1);
  const edited = await load(`/_pcfwebresource/${G.first}`, 'Stylesheet');
  assert.equal(body(edited), '.invented-first { color: red; }\n');
  assert.equal(session.solutionEdited(`@${path.basename(root)}/Controls/${SCHEMA}/css/first.css`), true);
  // Paused: not served, whatever the scope.
  session.disabled.add(`@${path.basename(root)}/Controls/${SCHEMA}/css/first.css`);
  const paused = await load(`/_pcfwebresource/${G.first}`, 'Stylesheet');
  assert.equal(paused.method, 'Fetch.continueRequest');
  assert.equal(ledger(`${ORIGIN}/_pcfwebresource/${G.first}`).reason, 'paused');
});

test('a Solution folder without Git is served in scope "changed" as in scope "all"', async (t) => {
  const { root } = solution(t);
  const { load } = await overlay(t, { root, site: { scope: 'changed' } });
  await load('/widget', 'Document');
  assert.equal(body(await load(`/_pcfwebresource/${G.bundle}`)), BUNDLE);
});

test('a refused join is never served and names its reason', async (t) => {
  const { root } = solution(t, {
    resources: '<code path="bundle.js" order="1" /><css path="css/first.css" order="1" />',
  });
  const { load, ledger, session } = await overlay(t, {
    root,
    online: {
      [ORIGIN + '/other']: {
        headers: { 'content-type': 'text/html' },
        body: page(declaration({ name: 'inv_Missing.Control' }))
          .replaceAll(G.bundle, '0a0a0a0a-1111-4111-8111-0000000000b0')
          .replaceAll(G.bundle.toUpperCase(), '0a0a0a0a-1111-4111-8111-0000000000b0'),
      },
    },
  });
  await load('/widget', 'Document');
  // The style sheets differ from the page's declaration: they go to the portal; the matching bundle is still local.
  assert.equal((await load(`/_pcfwebresource/${G.bundle}`)).method, 'Fetch.fulfillRequest');
  assert.equal((await load(`/_pcfwebresource/${G.first}`, 'Stylesheet')).method, 'Fetch.continueRequest');
  const manifestRel = `@${path.basename(root)}/Controls/${SCHEMA}/ControlManifest.xml`;
  assert.deepEqual(
    session.rewriter.unsupported.filter((row) => row.pcfDeployment).map((row) => [row.rel, row.reason]),
    [
      [
        manifestRel,
        `code component ${SCHEMA} changed its css resources (2 on the page, 1 in the manifest) in ControlManifest.xml; deploy the control before those changes can be previewed`,
      ],
    ],
  );
  session.rewriter.refresh();
  assert.equal(session.rewriter.unsupported.filter((row) => row.pcfDeployment).length, 1, 'kept across a refresh');
  assert.deepEqual(
    (({ class: kind, kind: resource, control, reason, rel }) => ({ kind, resource, control, reason, rel }))(
      ledger(`${ORIGIN}/_pcfwebresource/${G.first}`),
    ),
    {
      kind: 'export',
      resource: 'pcf-resource',
      control: SCHEMA,
      reason: 'pcf-manifest-mismatch',
      rel: `@${path.basename(root)}/Controls/${SCHEMA}/ControlManifest.xml`,
    },
  );
  await load('/other', 'Document');
  await load('/_pcfwebresource/0a0a0a0a-1111-4111-8111-0000000000b0');
  assert.deepEqual(
    (({ class: kind, platform, control, reason }) => ({ kind, platform, control, reason }))(
      ledger(`${ORIGIN}/_pcfwebresource/0a0a0a0a-1111-4111-8111-0000000000b0`),
    ),
    {
      kind: 'platform-asset',
      platform: 'web-resource',
      control: 'inv_Missing.Control',
      reason: 'pcf-control-not-in-sources',
    },
  );
});

test('a save in a mapped control folder is a relevant change and the folder is announced for watching', async (t) => {
  const { root, control } = solution(t);
  const { load, session } = await overlay(t, { root });
  const announced = [];
  session.on('watch', (folders) => announced.push(...folders));
  await load('/widget', 'Document');
  assert.deepEqual(announced, [control]);
  assert.deepEqual(session.watchPaths, [control]);
  const saved = path.join(control, 'bundle.js');
  assert.deepEqual(session.classifyChanges([saved, path.join(control, 'bundle.js~')]), {
    relevant: [saved],
    ignored: [path.join(control, 'bundle.js~')],
    structural: false,
  });
  fs.writeFileSync(saved, 'window.InventedWidget = "saved";\n');
  assert.deepEqual(session.refresh([saved]).files, [saved]);
  assert.equal(body(await load(`/_pcfwebresource/${G.bundle}`)), 'window.InventedWidget = "saved";\n');
});

test('a Solution web resource a form frames is answered from its WebResources file', async (t) => {
  const { root } = solution(t);
  fs.mkdirSync(path.join(root, 'WebResources'), { recursive: true });
  fs.writeFileSync(path.join(root, 'WebResources', 'inv_banner.html'), '<p>local banner</p>');
  fs.writeFileSync(path.join(root, 'WebResources', 'inv_banner.html.data.xml'), '<WebResource/>');
  const { load, ledger, b } = await overlay(t, { root });
  await load('/widget', 'Document');
  const framed = await load('/_webresource/inv_banner.html', 'Document');
  assert.equal(body(framed), '<p>local banner</p>');
  assert.match(header(framed, 'content-type'), /^text\/html/);
  assert.deepEqual(
    (({ class: kind, kind: resource, rel }) => ({ kind, resource, rel }))(
      ledger(`${ORIGIN}/_webresource/inv_banner.html`),
    ),
    { kind: 'local', resource: 'web-resource', rel: `@${path.basename(root)}/WebResources/inv_banner.html` },
  );
  assert.ok(!b.fetched.some((request) => request.url.includes('_webresource')));
});

test('in front of Mirage the code component addresses Mirage serves are named and never answered locally', async (t) => {
  const { root } = solution(t);
  const catalogue = await importCodeComponents([{ dir: root }]);
  const url = catalogue.controls.get(SCHEMA).resources.find((resource) => resource.kind === 'code').url;
  const { load, ledger, session } = await overlay(t, { root, mirage: true });
  // The session's inspector reads the same Solution roots as Mirage.
  session.sourceInspector.codeComponents = async () => ({
    catalogue,
    roots: [root],
    sourceDir: fs.realpathSync.native(session.cfg.sourceDir),
  });
  await load('/widget', 'Document');
  const answer = await load(url);
  assert.equal(answer.method, 'Fetch.continueRequest');
  assert.deepEqual(
    (({ class: kind, kind: resource, control, reason, rel }) => ({ kind, resource, control, reason, rel }))(
      ledger(ORIGIN + url),
    ),
    {
      kind: 'export',
      resource: 'pcf-resource',
      control: SCHEMA,
      reason: 'mirage',
      rel: `@${path.basename(root)}/Controls/${SCHEMA}/bundle.js`,
    },
  );
  // Mirage serves no /_pcfwebresource/ address of a Solution control: one stays a platform asset.
  await load(`/_pcfwebresource/${G.bundle}`);
  assert.equal(ledger(`${ORIGIN}/_pcfwebresource/${G.bundle}`).class, 'platform-asset');
});

test('the panel lists, opens, pauses and compares a code component resource as a Solution file', async (t) => {
  const { root } = solution(t);
  const { load, session, panel, tab } = await overlay(t, {
    root,
    panel: true,
    online: {
      [`${ORIGIN}/_pcfwebresource/${G.bundle}`]: {
        headers: { 'content-type': 'text/javascript' },
        body: 'deployed();\n',
      },
    },
  });
  await load('/widget', 'Document');
  await load(`/_pcfwebresource/${G.bundle}`);
  const rel = `@${path.basename(root)}/Controls/${SCHEMA}/bundle.js`;
  const file = path.join(root, 'Controls', SCHEMA, 'bundle.js');
  const state = panel.stateFor(tab.page);
  const item = state.items.find((entry) => entry.url === `/_pcfwebresource/${G.bundle}`);
  assert.deepEqual(
    (({ kind, group, rel: name, title, path: where, control, componentKey, canPause, canDiff }) => ({
      kind,
      group,
      name,
      title,
      where,
      control,
      componentKey,
      canPause,
      canDiff,
    }))(item),
    {
      kind: 'pcf-resource',
      group: 'js',
      name: rel,
      title: 'bundle.js',
      where: file,
      control: SCHEMA,
      componentKey: 'pcf:inv_invented.widget',
      canPause: true,
      canDiff: true,
    },
  );
  const call = async (name, data) => {
    let answer;
    await session.api(
      {
        request: () => ({
          method: () => 'POST',
          headers: () => ({ 'x-paqvilo-token': state.token }),
          frame: () => ({ page: () => tab.page }),
          postData: async () => JSON.stringify(data),
        }),
        fulfill: async (response) => {
          answer = JSON.parse(response.body);
        },
      },
      name,
    );
    return answer;
  };
  const diff = await call('diff', { rel, url: `/_pcfwebresource/${G.bundle}` });
  assert.equal(diff.ok, true, diff.error);
  assert.equal(diff.against, 'deployed');
  assert.equal((await call('toggle', { rel, off: true })).ok, true);
  assert.ok(session.disabled.has(rel));
  assert.equal((await load(`/_pcfwebresource/${G.bundle}`)).method, 'Fetch.continueRequest');
  const paused = panel.stateFor(tab.page).paused.find((entry) => entry.rel === rel);
  assert.deepEqual((({ kind, url, title, path: where, control }) => ({ kind, url, title, where, control }))(paused), {
    kind: 'pcf-resource',
    url: `/_pcfwebresource/${G.bundle}`,
    title: 'bundle.js',
    where: file,
    control: SCHEMA,
  });
  // A name the session does not map is not a file of the sources.
  assert.equal(
    (await call('toggle', { rel: `@${path.basename(root)}/Controls/${SCHEMA}/missing.js`, off: true })).ok,
    false,
  );
});

test('the inspection report lists the page code component resources for X-ray', async (t) => {
  const { root } = solution(t);
  const fx = createFixture();
  t.after(() => fx.cleanup());
  const inspector = createSourceInspector({
    origin: ORIGIN,
    sourceDir: fx.dir,
    siteName: 'invented',
    site: structuredClone(SITE),
    mirageConfig: { solutionRoots: [root] },
  });
  const { catalogue } = await inspector.codeComponents('/');
  assert.ok(catalogue.controls.has(SCHEMA));
  const { report } = await inspector.inspect('/', {
    assets: [{ kind: 'script', path: `/_pcfwebresource/${G.bundle}` }],
    controls: [],
    pcfResources: [
      { url: `/_pcfwebresource/${G.bundle}`, control: SCHEMA, kind: 'code', path: 'bundle.js' },
      { url: `/_pcfwebresource/${G.first}`, control: SCHEMA, kind: 'css', path: 'css/first.css' },
      // Not trusted: a path the manifest does not declare names no file.
      { url: `/_pcfwebresource/${G.second}`, control: SCHEMA, kind: 'css', path: '../../outside.css' },
      { url: `/_pcfwebresource/${G.strings}`, control: 'inv_Missing.Control', refused: 'pcf-control-not-in-sources' },
    ],
  });
  const rows = report.assets.filter((row) => PCF_RESOURCE_PATH.test(row.url));
  assert.deepEqual(
    rows.map(
      ({ name, url, kind, sourceFile, evidence, observed, componentKey, schemaName, resourceKind, resourcePath }) => ({
        name,
        url,
        kind,
        sourceFile,
        evidence,
        observed,
        componentKey,
        schemaName,
        resourceKind,
        resourcePath,
      }),
    ),
    [
      {
        name: `${SCHEMA}/bundle.js`,
        url: `/_pcfwebresource/${G.bundle}`,
        kind: 'script',
        sourceFile: path.join(root, 'Controls', SCHEMA, 'bundle.js'),
        evidence: 'pcf-declaration',
        observed: 'requested',
        componentKey: 'pcf:inv_invented.widget',
        schemaName: SCHEMA,
        resourceKind: 'code',
        resourcePath: 'bundle.js',
      },
      {
        name: `${SCHEMA}/css/first.css`,
        url: `/_pcfwebresource/${G.first}`,
        kind: 'stylesheet',
        sourceFile: path.join(root, 'Controls', SCHEMA, 'css', 'first.css'),
        evidence: 'pcf-declaration',
        observed: undefined,
        componentKey: 'pcf:inv_invented.widget',
        schemaName: SCHEMA,
        resourceKind: 'css',
        resourcePath: 'css/first.css',
      },
    ],
  );
  assert.deepEqual(
    report.unresolved.filter((row) => row.kind === 'pcf-resource').map((row) => [row.expression, row.owner]),
    [
      [`/_pcfwebresource/${G.second}`, SCHEMA],
      [`/_pcfwebresource/${G.strings}`, 'inv_Missing.Control'],
    ],
  );
});
