// What the Power Pages and model-driven hosts detect but do not run reaches preflight as requirement rows with a level,
// and the offline preflight shares the running host's composition.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preflight, preflightExitCode, buildPreflightReport } from '../lib/capability-report.mjs';
import { buildSourceGraph } from '../lib/source-graph.mjs';
import { platformChangeDiagnostics } from '../lib/platform-changes.mjs';
import { createSimulator } from '../api.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

// gap: a served modern list whose settings configure an action the local adapter does not serve (a real unsupported row).
async function site(t, authorization, { gap = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-surfaces-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'website.yml'), `adx_websiteid: 77777777-7777-4777-8777-777777777777\nadx_name: Invented\nadx_enhancedauthorization: ${authorization}`);
  await fs.writeFile(path.join(dir, 'Home.webpage.yml'), 'adx_webpageid: 77777777-7777-4777-8777-777777777778\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true');
  if (gap) {
    await fs.writeFile(path.join(dir, 'Home.webpage.copy.html'), "{% include 'entity_list' key: 'x_cases' isModern: 'true' %}");
    await fs.writeFile(path.join(dir, 'Cases.list.yml'), `adx_entitylistid: 77777777-7777-4777-8777-777777777779\nadx_name: x_cases\nadx_entityname: x_case\nadx_settings: '${JSON.stringify({ ItemActions: [{ Type: 'CrmEntityFormView-AssociateAction' }] })}'`);
  }
  return dir;
}

// powerpagesite enhancedauthorization 1-3: the local runtime runs the
// enhanced model (portal-authorization.mjs) for every non-zero state, so the row is satisfied with the fidelity note.
test('enhanced authorization states 1, 2 and 3 are satisfied rows with a fidelity note; the legacy model adds no row', async t => {
  for (const state of [1, 2, 3]) {
    const report = await preflight({ sourceDir: await site(t, state), strict: true, packs: [], env: {} });
    const row = report.requirements.find(item => item.id === 'portal:enhanced-authorization');
    assert.deepEqual([row.status, row.reason, row.blocking, row.resolution], ['satisfied', 'ENHANCED_AUTHORIZATION', false, { by: 'source' }], `state ${state}`);
    assert.match(row.message, /Fidelity: the privilege depth/);
    assert.ok(report.diagnostics.some(item => item.code === 'ENHANCED_AUTHORIZATION' && item.fidelity));
    assert.equal(preflightExitCode(report), 0);
  }
  const legacy = await preflight({ sourceDir: await site(t, 0), strict: true, packs: [], env: {} });
  assert.ok(!legacy.requirements.some(item => item.id.startsWith('portal:')));
});

test('a scenario scopes the portal rows', async t => {
  const dir = await site(t, 3, { gap: true });
  const unrelated = await preflight({ sourceDir: dir, scenario: { id: 'fx', requires: ['table:*'] }, packs: [], env: {} });
  assert.equal(unrelated.requirements.find(item => item.id === 'portal:modern-list/x_cases').blocking, false);
  const scoped = await preflight({ sourceDir: dir, scenario: { id: 'fx', requires: ['portal:*'] }, packs: [], env: {} });
  assert.equal(scoped.requirements.find(item => item.id === 'portal:modern-list/x_cases').blocking, true);
  assert.equal(scoped.requirements.find(item => item.id === 'portal:enhanced-authorization').blocking, false);
});

test('a modern list the adapter cannot serve and the document control are contract rows', () => {
  const diagnostics = platformChangeDiagnostics({ lists: [{ name: 'x_map', metadata: { adx_map_enabled: true } }],
    pages: [{ url: '/', html: "{% include 'entity_list' key: 'x_map' isModern: 'true' %}" }] });
  const forms = [{ id: '77777777-7777-4777-8777-777777777790', entity: 'x_item', name: 'Item main', file: 'C:/fx/form.xml',
    xml: '<form><control id="docs"><parameters><TargetEntityType>sharepointdocumentlocation</TargetEntityType></parameters></control></form>' }];
  const graph = buildSourceGraph({ metadata: { forms }, portal: { diagnostics, forms: [{ metadata: { adx_entityname: 'x_item', adx_formname: 'Item main' } }] } });
  const rows = Object.fromEntries(graph.requirements().filter(row => row.kind === 'portal').map(row => [row.id, [row.status, row.reason, row.level]]));
  assert.deepEqual(rows, {
    'portal:modern-list': ['unsupported', 'MODERN_LIST_RENDERED_CLASSIC', 'contract'],
    'portal:sharepoint-documents': ['unsupported', 'PORTAL_SHAREPOINT_DOCUMENTS_LOCAL', 'contract'],
  });
  // A served modern list (local markup) is information only.
  const served = platformChangeDiagnostics({ pages: [{ url: '/', html: "{% include 'entity_list' key: 'x_list' isModern: 'true' %}" }] });
  assert.ok(!buildSourceGraph({ portal: { diagnostics: served } }).requirements().length);
});

test('custom page SubAreas and virtual PCF controls without platform libraries are rows; supplied libraries admit the control', () => {
  const metadata = { modelDrivenApps: [{ uniqueName: 'fx_app', navigation: [{ id: 'a', groups: [{ id: 'g', items: [
    { id: 'fx_page', code: 'MD_NAV_CUSTOM_PAGE', kind: 'custom', page: 'x_custompage', supported: false },
    { id: 'fx_items', entity: 'x_item', supported: true }] }] }] }] };
  const control = { name: 'fx_ReactGrid', controlType: 'virtual', libraries: [{ name: 'React', version: '16.14.0' }] };
  const rows = buildSourceGraph({ metadata, clientResources: { pcf: { controls: [control] } } }).requirements();
  assert.deepEqual(rows.map(row => [row.id, row.status, row.reason, row.level]), [
    ['model-driven:custom-page/fx_app/fx_page', 'unsupported', 'MD_NAV_CUSTOM_PAGE', 'inventory'],
    ['model-driven:pcf/fx_reactgrid', 'unsupported', 'PCF_VIRTUAL_UNSUPPORTED', 'contract'],
  ]);
  const supplied = { pcf: { controls: [control], platformLibraries: [{ name: 'React', version: '16.14.0' }, { name: 'ReactDOM', version: '16.14.0' }] } };
  assert.ok(!buildSourceGraph({ clientResources: supplied }).requirements().length);
  // The level follows the shell's rule: the app's own type-300 component with its canvas app in the sources is a
  // behaviour placeholder; an item the parser marked supported but that the app does not include stays unsupported.
  const pageApp = components => ({ modelDrivenApps: [{ uniqueName: 'fx_app', components, navigation: [{ id: 'a', groups: [{ id: 'g', items: [
    { id: 'fx_page', code: 'MD_NAV_CUSTOM_PAGE', kind: 'custom', page: 'x_custompage', supported: true }] }] }] }] });
  const pageRow = components => buildSourceGraph({ metadata: pageApp(components), scan: { inventory: [{ component: 'canvasapp', name: 'x_custompage', level: 'inventory' }] } })
    .requirements().filter(row => row.id.startsWith('model-driven:custom-page/')).map(row => [row.status, row.reason, row.level]);
  assert.deepEqual(pageRow([{ type: 300, entity: 'x_custompage' }]), [['placeholder', 'CANVAS_NOT_RENDERED', 'behaviour']]);
  assert.deepEqual(pageRow([]), [['unsupported', 'MD_NAV_CUSTOM_PAGE', 'inventory']]);
});

test('mobile offline is a behaviour capability (model-driven/offline.mjs)', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-offline-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = await preflight({ runtime: { kind: 'dataverse-api' }, solutionRoots: [root], scenario: { id: 'fx', requires: ['model-driven:offline'] }, packs: [], env: {}, projectRoot: root });
  const row = report.requirements.find(item => item.id === 'model-driven:offline');
  assert.deepEqual([row.status, row.resolution.level, row.blocking], ['satisfied', 'behaviour', false]);
});

test('a scenario naming a host surface brings its gap rows into scope and is satisfied only without gaps', async t => {
  const dir = await site(t, 3, { gap: true });
  for (const requires of [['portalRendering'], ['portalRendering/*']]) {
    const report = await preflight({ sourceDir: dir, scenario: { id: 'fx', requires }, packs: [], env: {} });
    const gap = report.requirements.find(item => item.id === 'portal:modern-list/x_cases');
    const surface = report.requirements.find(item => item.id === 'portalRendering');
    assert.deepEqual([gap.surface, gap.inScope, gap.blocking], ['portalRendering', true, true], requires[0]);
    assert.deepEqual([surface.status, surface.blocking], ['unsupported', true], requires[0]);
    assert.match(surface.message, /portal:modern-list\/x_cases/);
    assert.doesNotMatch(surface.message, /portal:enhanced-authorization/);
    assert.equal(preflightExitCode(report), 1);
  }
  // The enhanced model alone leaves the surface satisfied.
  const enhanced = await preflight({ sourceDir: await site(t, 3), scenario: { id: 'fx', requires: ['portalRendering'] }, packs: [], env: {} });
  assert.equal(enhanced.requirements.find(item => item.id === 'portalRendering').status, 'satisfied');
  const clean = await preflight({ sourceDir: await site(t, 0), scenario: { id: 'fx', requires: ['portalRendering', 'staff'] }, packs: [], env: {} });
  assert.deepEqual(clean.requirements.filter(item => ['portalRendering', 'staff'].includes(item.id)).map(item => item.status), ['satisfied', 'satisfied']);
  assert.equal(preflightExitCode(clean), 0);
});

test('mobile offline profiles and an offline app without its profile are model-driven:offline rows on the staff surface', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-offline-profiles-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (name, text) => { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), text); };
  await write('Other/Solution.xml', '<ImportExportXml><SolutionManifest><UniqueName>FxOffline</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>');
  await write('MobileOfflineProfiles/fx_field.xml', '<MobileOfflineProfile><MobileOfflineProfileId>{77777777-7777-4777-8777-777777777791}</MobileOfflineProfileId><Name>fx_field</Name></MobileOfflineProfile>');
  // A profile record without parsed items cannot be evaluated; an app naming an absent profile keeps its row.
  const graph = buildSourceGraph({ scan: { inventory: [{ component: 'mobileofflineprofile', name: 'fx_field', id: '77777777-7777-4777-8777-777777777791', level: 'behaviour', dependencies: [] }] },
    metadata: { modelDrivenApps: [{ uniqueName: 'fx_app', components: [{ type: 161, id: '77777777-7777-4777-8777-777777777792' }] }] } });
  assert.deepEqual(graph.requirements().map(row => [row.id, row.status, row.reason, row.surface]), [
    ['model-driven:offline/fx_app', 'unsupported', 'MD_OFFLINE_PROFILE_MISSING', 'staff'],
    ['model-driven:offline/fx_field', 'unsupported', 'MD_OFFLINE_FILTER_UNSUPPORTED', 'staff'],
  ]);
  // The profile read from the sources is evaluated: its row is satisfied.
  const report = await preflight({ runtime: { kind: 'dataverse-api' }, solutionRoots: [root], strict: true, packs: [], env: {}, projectRoot: root });
  const row = report.requirements.find(item => item.id === 'model-driven:offline/fx_field');
  assert.deepEqual([row.status, row.blocking], ['satisfied', false]);
  assert.ok(!report.requirements.some(item => item.id.startsWith('mobileofflineprofile:')));
});

test('a served modern list with actions the adapter does not serve is a blocking portal:modern-list/<list> row on portalRendering', () => {
  const list = { name: 'x_cases', metadata: { adx_settings: JSON.stringify({ ItemActions: [{ Type: 'CrmEntityFormView-AssociateAction' }, { Type: 'CrmEntityFormView-EditAction' }] }) } };
  const diagnostics = platformChangeDiagnostics({ lists: [list], pages: [{ url: '/', html: "{% include 'entity_list' key: 'x_cases' isModern: 'true' %}" }] });
  const graph = buildSourceGraph({ portal: { diagnostics } });
  const [row] = graph.requirements();
  assert.deepEqual([row.id, row.status, row.reason, row.level, row.surface], ['portal:modern-list/x_cases', 'unsupported', 'MODERN_LIST_FEATURES_UNSERVED', 'contract', 'portalRendering']);
  const report = buildPreflightReport({ graph, strict: true });
  const reported = report.requirements.find(item => item.id === 'portal:modern-list/x_cases');
  assert.equal(reported.blocking, true);
  assert.match(reported.message, /CrmEntityFormView-AssociateAction/);
  assert.equal(preflightExitCode(report), 1);
});

test('a virtual code component under a portal source is a portal:pcf row with the same refusal', () => {
  const control = { name: 'fx_ReactGrid', controlType: 'virtual', libraries: [{ name: 'React', version: '16.14.0' }] };
  const supplied = { pcf: { controls: [control], platformLibraries: [{ name: 'React', version: '16.14.0' }, { name: 'ReactDOM', version: '16.14.0' }] } };
  const rows = buildSourceGraph({ portal: { diagnostics: [] }, clientResources: supplied }).requirements();
  assert.deepEqual(rows.map(row => [row.id, row.reason, row.surface]), [['portal:pcf/fx_reactgrid', 'PCF_VIRTUAL_UNSUPPORTED', 'portalRendering']]);
});

test('offline preflight and GET /_sim/api/preflight agree on provider, connector, outbox and storage rows', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-parity-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const solution = path.join(root, 'solution');
  await fs.mkdir(path.join(solution, 'Other'), { recursive: true });
  await fs.writeFile(path.join(solution, 'Other', 'Solution.xml'), '<ImportExportXml><SolutionManifest><UniqueName>FxParity</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>');
  const options = { runtime: { kind: 'dataverse-api' }, solutionRoots: [solution], projectRoot: root, simulation: { level: 'dry-run' },
    dataverse: { enabled: true, tls: false, tds: { enabled: false } } };
  const sim = await createSimulator({ ...options, port: 0, watch: false });
  ownedFixture(t).add(() => sim.close());
  const live = await (await fetch(`${sim.url}/_sim/api/preflight`)).json();
  const offline = await preflight({ ...options, packs: [], env: process.env });
  const shared = /^(?:provider:|connector:|outbox:|message-bus:)/;
  const rows = report => report.requirements.filter(row => shared.test(row.id)).map(row => [row.id, row.status]);
  const modules = report => report.modules.filter(record => shared.test(record.name)).map(record => [record.name, record.level]).sort();
  assert.ok(rows(live).length, 'the host reports provider rows');
  assert.deepEqual(rows(offline), rows(live));
  assert.ok(modules(live).length);
  assert.deepEqual(modules(offline), modules(live));
});

test('offline and live preflight judge a dashboard over a locally mapped table as its page does', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-dashboard-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const solution = path.join(root, 'solution');
  const write = async (name, text) => { await fs.mkdir(path.dirname(path.join(solution, name)), { recursive: true }); await fs.writeFile(path.join(solution, name), text); };
  const BOARD = '77777777-7777-4777-8777-7777777777b1';
  await write('Other/Solution.xml', '<ImportExportXml><SolutionManifest><UniqueName>FxBoards</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>');
  await write('Other/Customizations.xml', `<ImportExportXml><Dashboards><Dashboard><FormId>{${BOARD}}</FormId><LocalizedNames><LocalizedName description="Fx board" languagecode="1033"/></LocalizedNames><FormXml><forms type="dashboard"><systemform><formid>{${BOARD}}</formid><form><tabs><tab><columns><column><sections><section><rows><row><cell><labels><label description="Local list" languagecode="1033"/></labels><control id="l" classid="{E7A81278-8635-4D9E-8D4D-59480B391C5B}"><parameters><TargetEntityType>x_local</TargetEntityType></parameters></control></cell></row></rows></section></sections></column></columns></tab></tabs></form></systemform></forms></FormXml></Dashboard></Dashboards></ImportExportXml>`);
  await write('AppModules/fx_app/AppModule.xml', '<AppModule><UniqueName>fx_app</UniqueName><AppModuleId>{77777777-7777-4777-8777-7777777777b2}</AppModuleId></AppModule>');
  await write('AppModuleSiteMaps/fx_app/AppModuleSiteMap.xml', `<AppModuleSiteMap><AppModuleUniqueName>fx_app</AppModuleUniqueName><SiteMap><Area Id="a"><Group Id="g"><SubArea Id="board" DefaultDashboard="{${BOARD}}"/></Group></Area></SiteMap></AppModuleSiteMap>`);
  const options = { runtime: { kind: 'model-driven' }, solutionRoots: [solution], projectRoot: root, simulation: { level: 'dry-run' }, dataverse: { enabled: true, tls: false, tds: { enabled: false } },
    initial: { mappings: { x_local: { entitySet: 'x_locals', idColumn: 'x_localid', nameColumn: 'x_name', inferred: false } } } };
  const sim = await createSimulator({ ...options, port: 0, watch: false });
  ownedFixture(t).add(() => sim.close());
  const live = await (await fetch(`${sim.url}/_sim/api/preflight`)).json();
  const offline = await preflight({ ...options, packs: [], env: process.env });
  const rows = report => report.requirements.filter(row => /dashboard/.test(row.id)).map(row => [row.id, row.status, row.reason ?? null]);
  assert.deepEqual(rows(live), [['model-driven:dashboard/fx_app/board', 'satisfied', null]]);
  assert.deepEqual(rows(offline), rows(live));
  // Without the local mapping the list has no table: the row and the page agree it is not rendered.
  const unmapped = await preflight({ ...options, initial: null, packs: [], env: process.env });
  assert.deepEqual(rows(unmapped).find(row => row[0] === 'model-driven:dashboard/fx_app/board'), ['model-driven:dashboard/fx_app/board', 'unsupported', 'MD_DASHBOARD_COMPONENT_UNSUPPORTED']);
  const page = await (await fetch(`${sim.url}/_apps/api/index`)).json();
  assert.equal(page.apps.find(app => app.uniqueName === 'fx_app').dashboards[0].components[0].supported, true);
});
