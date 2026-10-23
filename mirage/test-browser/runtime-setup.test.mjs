import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { startSetupServer } from '../../lense/setup/server.mjs';

// These cases exercise the All settings view of /_setup/ (Quick setup is the default for a new browser).
const allSettings = page => page.context().addInitScript(() => { try { localStorage.setItem('paqvilo-setup-view', 'all'); } catch { /* no storage */ } });

const APP = '77777777-7777-4777-8777-777777777777';
async function capture(page, name) {
  if (!process.env.PAQVILO_UI_SCREENSHOTS) return;
  const directory = path.resolve(process.env.PAQVILO_UI_SCREENSHOTS); await fs.mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name + '.png') });
}
async function work(t) {
  const container = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-runtime-ui-'));
  const root = path.join(container, 'workspace'); await fs.mkdir(root);
  const resources = [];
  t.after(async () => { try { for (const close of resources.reverse()) await close(); } finally { await fs.rm(container, { recursive: true, force: true }); } });
  const browser = await chromium.launch(browserLaunchOptions()); resources.push(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10000);
  await allSettings(page);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  return { root, page, errors, resources };
}
async function organization(t, options = {}) {
  const context = await work(t), { root } = context, solution = path.join(root, 'solution');
  const files = {
    'Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedUI</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'Entities/x_item/Entity.xml': '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type><displaynames><displayname description="Name" languagecode="1033"/></displaynames></attribute></attributes></entity></EntityInfo></Entity>',
    'AppModules/x_workspace/AppModule.xml': `<AppModule><UniqueName>x_workspace</UniqueName><AppModuleId>{${APP}}</AppModuleId><LocalizedNames><LocalizedName description="Invented workspace" languagecode="1033"/></LocalizedNames><AppModuleComponents><AppModuleComponent type="1" schemaName="x_item"/></AppModuleComponents></AppModule>`,
  };
  const sharedTargetId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  if (options.polymorphic) {
    files['Entities/x_item/Entity.xml'] = files['Entities/x_item/Entity.xml'].replace('</attributes>', '<attribute PhysicalName="x_customer"><Name>x_customer</Name><Type>lookup</Type><displaynames><displayname description="Customer" languagecode="1033"/></displaynames></attribute></attributes>');
    for (const entity of ['x_targeta', 'x_targetb']) files[`Entities/${entity}/Entity.xml`] = `<Entity><Name>${entity}</Name><EntityInfo><entity Name="${entity}"><EntitySetName>${entity}s</EntitySetName><PrimaryIdAttribute>${entity}id</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="${entity}id"><Name>${entity}id</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>`;
    files['Other/Relationships.xml'] = '<EntityRelationships>' + ['x_targeta', 'x_targetb'].map(entity => `<EntityRelationship Name="x_item_${entity}"><EntityRelationshipType>OneToMany</EntityRelationshipType><ReferencingEntityName>x_item</ReferencingEntityName><ReferencedEntityName>${entity}</ReferencedEntityName><ReferencingAttributeName>x_customer</ReferencingAttributeName><ReferencedAttributeName>${entity}id</ReferencedAttributeName></EntityRelationship>`).join('') + '</EntityRelationships>';
    files['Entities/x_item/FormXml/main/item.xml'] = '<systemform><formid>{88888888-8888-4888-8888-888888888888}</formid><type>2</type><form><tabs>' + [['general', 'General', 'x_name', 'Name'], ['customer', 'Customer details', 'x_customer', 'Customer']].map(([name, title, field, label]) => `<tab name="${name}"><labels><label description="${title}" languagecode="1033"/></labels><columns><column><sections><section name="${name}"><rows><row><cell><labels><label description="${label}" languagecode="1033"/></labels><control datafieldname="${field}"/></cell></row></rows></section></sections></column></columns></tab>`).join('') + '</tabs></form></systemform>';
  }
  for (const [relative, content] of Object.entries(files)) { const file = path.join(solution, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); }
  const project = path.join(root, 'mirage.project.json');
  const runtime = options.runtime ?? { kind: 'model-driven', defaultApp: APP };
  await fs.writeFile(project, JSON.stringify({ version: 2, runtime, simulation: options.simulation ?? { level: 'dry-run' }, solutions: [{ id: 'core', path: './solution' }], dataverse: options.dataverse ?? { enabled: false } }));
  const sim = await createSimulator({ solutionRoots: [solution], projectRoot: root, runtime, watch: false,
    stateFile: path.join(root, 'state.json'), simulation: { level: 'dry-run' }, dataverse: { enabled: false },
    initial: { mappings: { x_item: { entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name' } }, tables: { x_item: [{ x_itemid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', x_name: 'Visible local row' }], ...(options.polymorphic ? { x_targeta: [{ x_targetaid: sharedTargetId, x_name: 'First target' }], x_targetb: [{ x_targetbid: sharedTargetId, x_name: 'Second target' }] } : {}) } },
    setup: { project }, ...options });
  context.resources.push(() => sim.close()); return { ...context, sim, project };
}

test('standalone API administration hides portal surfaces and shows persistence destinations', { timeout: 30000 }, async t => {
  const { page, sim, errors } = await organization(t, { runtime: { kind: 'dataverse-api' }, dataverse: { enabled: true, tls: false, tds: { enabled: false } } });
  const requests = []; page.on('request', request => requests.push(new URL(request.url()).pathname));
  await page.goto(sim.url + '/_sim/#overview');
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor().catch(async error => { throw new Error(`${error.message}\n${await page.locator('body').innerText()}\n${errors.join('\n')}`); });
  assert.equal(await page.getByRole('link', { name: /^Open (portal|website)/ }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Model-driven apps', exact: true }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Portal identity & permissions', exact: true }).count(), 0);
  assert.match(await page.locator('#content').innerText(), /Dry run/);
  assert.match(await page.locator('#content').innerText(), /memory/);
  await capture(page, 'api-only-overview');
  assert.ok(!requests.some(path => /\/api\/(personas|session)$/.test(path)));
  await page.getByRole('link', { name: 'Organization identity & API', exact: true }).click();
  await page.getByRole('heading', { name: 'Organization identity & API' }).waitFor();
  assert.equal(await page.locator('#staff-session-form').count(), 0);
  await page.locator('[data-disclosure="dv-register"] > summary').click();
  await page.locator('#dv-app-form').waitFor();
  assert.equal(await page.locator('#dv-app-form').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Reset to imported defaults', exact: true }).count(), 0);
  await capture(page, 'organization-identity');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await capture(page, 'organization-mobile');
  await page.getByRole('link', { name: 'Runtime state', exact: true }).click();
  await page.getByRole('heading', { name: 'Runtime state', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Export state JSON', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});

test('model-driven avatar switches staff security and explicitly recovers local administration with API off', { timeout: 30000 }, async t => {
  const { page, sim, errors } = await organization(t);
  await page.goto(sim.url + '/_sim/#dataverse');
  await page.locator('[data-disclosure="dv-create-user"] > summary').click();
  await page.getByLabel('Full name', { exact: true }).fill('Read restricted staff');
  await page.getByLabel('Sign-in name (domainname)', { exact: true }).fill('staff@example.test');
  await page.locator('#dv-user-form').getByLabel('Basic User', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Create user', exact: true }).click();
  await page.getByText('User created.', { exact: true }).waitFor();
  await page.locator('#staff-user option').filter({ hasText: 'Read restricted staff' }).waitFor({ state: 'attached' });
  const listing = await page.request.get(sim.url + '/_sim/api/dataverse').then(response => response.json());
  const user = listing.users.find(row => row.fullname === 'Read restricted staff'); assert.ok(user);
  await page.goto(sim.url + '/main.aspx');
  await page.locator('tbody').getByRole('button', { name: 'Visible local row', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Staff profile', exact: true }).click();
  await page.getByRole('dialog').getByRole('heading', { name: 'Staff profile', exact: true }).waitFor();
  await capture(page, 'model-driven-profile');
  await page.getByLabel('Organization staff', { exact: true }).selectOption(user.systemuserid);
  await page.getByRole('button', { name: 'Use identity', exact: true }).click();
  await page.locator('#notice.error').waitFor();
  assert.equal(await page.locator('tbody').getByRole('button', { name: 'Visible local row', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'New', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Staff profile', exact: true }).click();
  await page.getByLabel('Organization staff', { exact: true }).selectOption('local-admin');
  await page.getByRole('button', { name: 'Use identity', exact: true }).click();
  await page.locator('tbody').getByRole('button', { name: 'Visible local row', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'New', exact: true }).isDisabled(), false);
  assert.deepEqual(errors, []);
});

test('file-backed model and admin commands are disabled for tables without DATA ownership', { timeout: 30000 }, async t => {
  const { page, sim, errors } = await organization(t, { simulation: { level: 'simulation' } });
  await page.goto(sim.url + '/main.aspx');
  await page.locator('tbody').getByRole('button', { name: 'Visible local row', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'New', exact: true }).isDisabled(), true);
  await page.locator('tbody').getByRole('button', { name: 'Visible local row', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel('Name', { exact: true }).isDisabled(), true);
  await page.goto(sim.url + '/_sim/#records');
  await page.getByLabel('Entity', { exact: true }).selectOption('x_item');
  await page.getByRole('cell', { name: 'Visible local row', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Create record', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Edit', exact: true }).isDisabled(), true);
  assert.deepEqual(errors, []);
});

test('polymorphic lookup keeps the second target across save and unrelated edits and rejects ambiguous manual IDs', { timeout: 30000 }, async t => {
  const { page, sim, errors } = await organization(t, { polymorphic: true });
  await page.goto(sim.url + '/main.aspx');
  await page.locator('tbody').getByRole('button', { name: 'Visible local row', exact: true }).click();
  await page.getByRole('tab', { name: 'Customer details', exact: true }).click();
  await page.getByRole('button', { name: 'Look up Customer', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await page.getByRole('button', { name: 'Lookup table', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'X Targetb', exact: true }).click();
  await page.getByRole('radio', { name: 'Select Second target', exact: true }).check();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('#notice').filter({ hasText: 'Record saved locally.' }).waitFor();
  const read = async () => (await page.request.get(sim.url + '/_apps/api/tables/x_item/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').then(response => response.json())).row;
  assert.equal((await read())['x_customer@Microsoft.Dynamics.CRM.lookuplogicalname'], 'x_targetb');
  await page.getByLabel('Name', { exact: true }).fill('Unrelated name edit');
  await page.getByRole('tab', { name: 'Customer details', exact: true }).click();
  const [patch] = await Promise.all([page.waitForRequest(request => request.method() === 'PATCH' && request.url().includes('/_apps/api/tables/x_item/')), page.getByRole('button', { name: 'Save', exact: true }).click()]);
  assert.deepEqual(patch.postDataJSON(), { x_name: 'Unrelated name edit' });
  await page.getByRole('heading', { name: 'Unrelated name edit', exact: true }).waitFor();
  assert.equal((await read())['x_customer@Microsoft.Dynamics.CRM.lookuplogicalname'], 'x_targetb');
  await page.getByRole('tab', { name: 'Customer details', exact: true }).click();
  assert.equal(await page.getByLabel('Customer', { exact: true }).inputValue(), 'Second target');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Ambiguous manual input');
  await page.getByRole('tab', { name: 'Customer details', exact: true }).click();
  await page.getByLabel('Customer', { exact: true }).fill('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.match(await page.getByLabel('Customer', { exact: true }).evaluate(input => input.validationMessage), /Select a record from the lookup results/);
  let writes = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/_apps/api/tables/x_item')) writes++; });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  assert.equal(writes, 0);
  assert.deepEqual(errors, []);
});

test('guided setup creates an API-only project with dry-run defaults and preserves unrelated settings', { timeout: 30000 }, async t => {
  const { root, page, errors, resources } = await work(t), project = path.join(root, 'mirage.project.json');
  const setup = await startSetupServer({ directory: root, project, processEnv: {} }); resources.push(() => setup.close());
  await page.goto(setup.url);
  const create = page.locator('form[data-form="create"]');
  // What to run: only the Dataverse Web API.
  await create.locator('input[name=part][value=website]').uncheck(); await create.locator('input[name=part][value=api]').check();
  await create.getByRole('button', { name: 'Create project file' }).click();
  await page.locator('#notice').filter({ hasText: /^Saved\./ }).waitFor();
  const raw = JSON.parse(await fs.readFile(project, 'utf8'));
  assert.equal(raw.runtime.kind, 'dataverse-api'); assert.equal(raw.simulation.level, 'dry-run');
  assert.equal(raw.portals, undefined); assert.equal(raw.references, undefined);
  const form = page.locator('form[data-form="runtime"]');
  assert.equal(await form.locator('[name="simulation-level"]').inputValue(), 'dry-run');
  await form.locator('[name="simulation-level"]').selectOption('deep');
  await form.getByRole('button', { name: 'Save runtime configuration' }).click();
  await page.locator('#notice').filter({ hasText: /^Saved\./ }).waitFor();
  const saved = JSON.parse(await fs.readFile(project, 'utf8'));
  assert.equal(saved.simulation.level, 'deep'); assert.deepEqual(saved.solutions, []);
  await page.locator('#runtime-configuration').scrollIntoViewIfNeeded(); await capture(page, 'standalone-setup');
  await fs.mkdir(path.join(root, 'portal')); await fs.writeFile(path.join(root, 'portal/website.yml'), 'adx_websiteid: invented\nadx_name: Invented portal\n');
  const next = page.locator('form[data-form="runtime"]');
  await next.locator('input[name=part][value=website]').check();
  await next.locator('[name="portal-path"]').fill('./portal');
  await next.getByRole('button', { name: 'Save runtime configuration' }).click();
  await page.locator('#portal-portal').waitFor();
  const withPortal = JSON.parse(await fs.readFile(project, 'utf8'));
  assert.deepEqual(withPortal.portals, [{ id: 'portal', path: './portal' }]);
  assert.equal(withPortal.defaultPortal, 'portal');
  assert.deepEqual(errors, []);
});

test('guided profile roundtrip preserves portal selections and unrelated authored fields', { timeout: 30000 }, async t => {
  const { root, page, errors, resources } = await work(t), project = path.join(root, 'mirage.project.json');
  await fs.mkdir(path.join(root, 'portal')); await fs.writeFile(path.join(root, 'portal/website.yml'), 'adx_websiteid: invented\nadx_name: Invented portal\n');
  const portals = [{ id: 'portal', path: './portal', authoredNote: { keep: 'portal sibling metadata' } }];
  await fs.writeFile(project, JSON.stringify({ version: 2, runtime: { kind: 'power-pages' }, defaultPortal: 'portal', portals, environmentVariables: { x_keep: 'authored value' } }));
  const setup = await startSetupServer({ directory: root, project, processEnv: {} }); resources.push(() => setup.close());
  await page.goto(setup.url);
  for (const kind of ['model-driven', 'power-pages']) {
    const form = page.locator('form[data-form="runtime"]');
    // Without the website the project runs its apps on the app host; with it, on the Power Pages host.
    await form.locator('input[name=part][value=website]').setChecked(kind === 'power-pages');
    await form.getByRole('button', { name: 'Save runtime configuration' }).click();
    await page.locator('#notice').filter({ hasText: /^Saved\./ }).waitFor();
    const saved = JSON.parse(await fs.readFile(project, 'utf8'));
    assert.equal(saved.runtime.kind, kind); assert.deepEqual(saved.portals, portals);
    assert.equal(saved.defaultPortal, 'portal'); assert.deepEqual(saved.environmentVariables, { x_keep: 'authored value' });
    assert.equal(saved.simulation, undefined, 'opening an old project does not silently select an explicit persistence policy');
  }
  assert.deepEqual(errors, []);
});

test('guided Solution path replacement and reordering keep referenced IDs and authored siblings', { timeout: 30000 }, async t => {
  const { root, page, errors, resources } = await work(t), project = path.join(root, 'mirage.project.json');
  for (const directory of ['portal', 'old-core', 'new-core', 'addon']) await fs.mkdir(path.join(root, directory));
  await fs.writeFile(path.join(root, 'portal/website.yml'), 'adx_websiteid: invented\nadx_name: Invented portal\n');
  const portal = { id: 'portal', path: './portal', solutions: ['core', 'addon'] };
  await fs.writeFile(project, JSON.stringify({ version: 2, portals: [portal], solutions: [{ id: 'core', root: './old-core', authoredNote: { keep: 'original sibling' } }, { id: 'addon', path: './addon' }] }));
  const setup = await startSetupServer({ directory: root, project, processEnv: {} }); resources.push(() => setup.close());
  await page.goto(setup.url);
  const saveSolutions = async paths => {
    // Solution folders of a project file are part of Exported files.
    await page.evaluate(() => { location.hash = '#portals'; });
    const form = page.locator('form[data-form="files"]'); await form.locator('[name="runtime-solutions"]').fill(paths.join('\n'));
    const [response] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/_setup/api/config') && response.request().method() === 'POST'), form.getByRole('button', { name: 'Save', exact: true }).click()]);
    assert.equal(response.status(), 200, await response.text());
    await page.locator('#notice').filter({ hasText: /^Saved\./ }).waitFor();
    return JSON.parse(await fs.readFile(project, 'utf8'));
  };
  let saved = await saveSolutions(['./new-core', './addon']);
  assert.deepEqual(saved.portals, [portal]);
  assert.deepEqual(saved.solutions[0], { id: 'core', root: './new-core', authoredNote: { keep: 'original sibling' } });
  saved = await saveSolutions(['./addon', './new-core']);
  assert.deepEqual(saved.solutions.map(item => item.id), ['addon', 'core']);
  assert.deepEqual(saved.solutions[1].authoredNote, { keep: 'original sibling' });
  const shorthand = { version: 2, runtime: { kind: 'model-driven' }, portals: [{ ...portal, solutions: ['solution-1', 'solution-2'] }], solutions: ['./new-core', './addon'] };
  await fs.writeFile(project, JSON.stringify(shorthand)); await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await page.locator('form[data-form="runtime"] input[name=part][value=website]:not(:checked)').waitFor();
  saved = await saveSolutions(['./addon', './new-core']);
  assert.deepEqual(saved.solutions, [{ id: 'solution-2', path: './addon' }, { id: 'solution-1', path: './new-core' }]);
  assert.deepEqual(saved.portals, shorthand.portals);
  assert.deepEqual(errors, []);
});

test('guided extension trust requires an explicit choice and survives setup refresh', { timeout: 30000 }, async t => {
  const { root, page, errors, resources } = await work(t), project = path.join(root, 'mirage.project.json');
  await fs.writeFile(project, JSON.stringify({ version: 2, runtime: { kind: 'model-driven' }, solutions: [], dataverse: { enabled: false }, simulation: { level: 'dry-run' } }));
  const setup = await startSetupServer({ directory: root, project, processEnv: {} }); resources.push(() => setup.close());
  await page.goto(setup.url);
  const trust = () => page.locator('form[data-form="runtime"] [name="trusted-extensions"]');
  await trust().waitFor(); assert.equal(await trust().isChecked(), false);
  for (const value of [true, false]) {
    await trust().setChecked(value);
    const [response] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/_setup/api/config') && response.request().method() === 'POST'),
      page.getByRole('button', { name: 'Save runtime configuration', exact: true }).click()]);
    assert.equal(response.status(), 200, await response.text());
    await page.locator('#notice').filter({ hasText: /^Saved\./ }).waitFor();
    assert.equal(JSON.parse(await fs.readFile(project, 'utf8')).modelDriven.trustedExtensions, value);
    await page.reload(); await trust().waitFor(); assert.equal(await trust().isChecked(), value);
  }
  assert.deepEqual(errors, []);
});


test('administration shows outstanding work and keeps failed save input available for retry', { timeout: 60000 }, async t => {
  const { page, sim, errors } = await organization(t, { runtime: { kind: 'dataverse-api' }, dataverse: { enabled: true, tls: false, tds: { enabled: false } } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let releaseRead; const reading = new Promise(resolve => { releaseRead = resolve; }); t.after(() => releaseRead());
  await page.route('**/__sim/api/state?summary=1', async route => { await reading; await route.continue(); });
  await page.goto(sim.url + '/_sim/#overview');
  await page.locator('#activity-feedback').filter({ hasText: 'Loading workspace data' }).waitFor();
  assert.equal(await page.locator('#content').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('#activity-feedback').evaluate(node => getComputedStyle(node, '::before').animationName), 'none');
  releaseRead(); await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Organization identity & API', exact: true }).click();
  await page.locator('[data-disclosure="dv-register"] > summary').click();
  await page.locator('#dv-app-form').waitFor();
  const form = page.locator('#dv-app-form'); await page.locator('#dv-app-name').fill('Uncommitted application');
  let releaseWrite, writes = 0; const writing = new Promise(resolve => { releaseWrite = resolve; }); t.after(() => releaseWrite());
  await page.route('**/__sim/api/dataverse/applications', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    writes++; await writing; await route.fulfill({ status: 422, json: { error: { message: 'Fixture rejected this application.' } } });
  });
  const submit = form.locator('button[type=submit]'); await submit.click();
  await page.locator('#activity-feedback').filter({ hasText: 'Applying local changes' }).waitFor();
  assert.equal(await submit.innerText(), 'Working…'); assert.equal(await submit.isDisabled(), true);
  assert.equal(await page.locator('#dv-app-name').isDisabled(), true);
  await page.getByRole('button', { name: '↻ Refresh', exact: true }).click();
  await page.locator('#refresh').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  assert.equal(await page.locator('#dv-app-name').isDisabled(), true, 'a workspace refresh cannot release an outstanding form operation');
  assert.equal(await page.locator('#dv-app-name').inputValue(), 'Uncommitted application');
  await form.evaluate(node => { node.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: node.querySelector('button[type=submit]') })); });
  await capture(page, 'admin-saving'); releaseWrite();
  await page.locator('#notification[role=alert]').filter({ hasText: 'Fixture rejected' }).waitFor();
  assert.equal(writes, 1); assert.equal(await page.locator('#dv-app-name').inputValue(), 'Uncommitted application');
  assert.equal(await page.locator('#dv-app-name').isDisabled(), false);
  assert.equal(await submit.isDisabled(), false); assert.notEqual(await submit.innerText(), 'Working…');
  // Shorten only the production deadline in this browser, and honor its real AbortSignal.
  await page.evaluate(() => {
    const originalTimeout = AbortSignal.timeout, originalFetch = window.fetch;
    window.__restoreAdminDeadlineFixture = () => { AbortSignal.timeout = originalTimeout; window.fetch = originalFetch; };
    const timeout = originalTimeout.bind(AbortSignal), fetch = originalFetch.bind(window);
    AbortSignal.timeout = milliseconds => timeout(milliseconds === 120000 ? 40 : milliseconds);
    window.fetch = (url, options) => String(url).endsWith('/dataverse/applications') && options?.method === 'POST'
      ? new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
      : fetch(url, options);
  });
  await submit.click();
  await page.locator('#notification[role=alert]').filter({ hasText: 'Its result may be unknown' }).waitFor();
  assert.equal(await submit.isDisabled(), false); assert.equal(await page.locator('#dv-app-name').inputValue(), 'Uncommitted application');
  assert.equal(writes, 1, 'timeouts never retry or dispatch a second application write');
  await page.evaluate(() => { window.__restoreAdminDeadlineFixture(); delete window.__restoreAdminDeadlineFixture; });
  await page.locator('#activity-feedback').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#content').getAttribute('aria-busy'), 'false');
  await page.getByRole('link', { name: 'Data records', exact: true }).click();
  await page.getByLabel('Entity', { exact: true }).selectOption('x_item');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  let releaseEdit; const editing = new Promise(resolve => { releaseEdit = resolve; }); t.after(() => releaseEdit());
  await page.route('**/__sim/api/records/x_item/*', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await editing; await route.fulfill({ status: 422, json: { error: { message: 'Fixture rejected this record.' } } });
  });
  await page.locator('#editor-form button[type=submit]').click();
  await page.locator('#editor-form[data-pending-action]').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#editor').evaluate(dialog => dialog.open), true, 'a dispatched save cannot silently dismiss its result');
  releaseEdit(); await page.locator('#editor-error').filter({ hasText: 'Fixture rejected this record' }).waitFor();
  assert.equal(await page.locator('#editor-json').isDisabled(), false);
  assert.deepEqual(errors, []);
});


test('administration serializes overlapping refreshes and awaits a fresh round after a saved record', { timeout: 60000 }, async t => {
  const { page, sim, errors } = await organization(t);
  await page.goto(sim.url + '/_sim/#records');
  await page.getByLabel('Entity', { exact: true }).selectOption('x_item');
  await page.getByRole('cell', { name: 'Visible local row', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const json = JSON.parse(await page.locator('#editor-json').inputValue()); json.x_name = 'Saved during refresh';
  await page.locator('#editor-json').fill(JSON.stringify(json));
  const gates = [], releases = []; for (let index = 0; index < 2; index++) gates.push(new Promise(resolve => { releases.push(resolve); }));
  t.after(() => releases.forEach(resolve => resolve()));
  let reads = 0, active = 0, maximum = 0, startedSecond;
  const secondRead = new Promise(resolve => { startedSecond = resolve; });
  await page.route('**/__sim/api/state?summary=1', async route => {
    const index = reads++; active++; maximum = Math.max(maximum, active);
    if (index === 1) startedSecond();
    const response = await route.fetch(); if (index < gates.length) await gates[index];
    active--; await route.fulfill({ response });
  });
  await page.locator('#refresh').evaluate(button => button.click());
  await page.waitForFunction(() => document.querySelector('#refresh').disabled);
  const saved = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().includes('/api/records/x_item/'));
  await page.locator('#editor-form button[type=submit]').click(); await saved;
  assert.equal(reads, 1, 'a save cannot start a racing state read');
  releases[0]();
  await page.waitForFunction(() => document.querySelector('#activity-feedback').textContent.includes('Loading'));
  await secondRead;
  assert.equal(await page.locator('#refresh').isDisabled(), true, 'the shared refresh remains pending until the fresh trailing round completes');
  releases[1](); await page.locator('#notification').filter({ hasText: 'Changes saved.' }).waitFor();
  assert.equal(reads, 2); assert.equal(maximum, 1);
  assert.equal(await page.locator('#refresh').isDisabled(), false);
  await page.getByRole('cell', { name: 'Saved during refresh', exact: true }).waitFor();
  assert.deepEqual(errors, []);
});


test('organization row actions share one lock with nested role forms through refresh and failure', { timeout: 60000 }, async t => {
  const { page, sim, errors } = await organization(t, { runtime: { kind: 'dataverse-api' }, dataverse: { enabled: true, tls: false, tds: { enabled: false } } });
  await page.goto(sim.url + '/_sim/#dataverse');
  await page.locator('[data-disclosure="dv-create-user"] > summary').click();
  await page.locator('#dv-user-name').fill('Pending roles fixture'); await page.locator('#dv-user-domain').fill('pending@example.test');
  await page.locator('#dv-user-form button[type=submit]').click();
  await page.locator('#notification').filter({ hasText: 'User created.' }).waitFor();
  const row = page.locator('tr[id^=dv-user-row-]').filter({ hasText: 'Pending roles fixture' });
  // One edit form for the selected user (RA-02): roles and password live in the editor, Disable stays on the row.
  if (!await page.locator('[data-disclosure="dv-users"][open]').count()) await page.locator('[data-disclosure="dv-users"] > summary').click();
  await row.getByRole('button', { name: 'Edit Pending roles fixture', exact: true }).click();
  const editor = page.locator('[data-dv-user-editor]');
  const roles = editor.locator('form[data-dv-user]'); await roles.locator('[data-dv-role]').first().check();
  const selected = await roles.locator('[data-dv-role]:checked').evaluateAll(nodes => nodes.map(node => node.dataset.dvRole));
  let release, writes = 0; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  await page.route('**/__sim/api/dataverse/users/*', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    writes++; await gate; await route.fulfill({ status: 422, json: { error: { message: 'Fixture refused the role change.' } } });
  });
  await roles.getByRole('button', { name: 'Save roles', exact: true }).click();
  await editor.locator('button[aria-busy=true]').waitFor();
  assert.equal(await row.getByRole('button', { name: 'Disable', exact: true }).isDisabled(), true);
  assert.equal(await editor.locator('input[type=password]').isDisabled(), true);
  await page.locator('#refresh').click(); await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  assert.equal(await row.getByRole('button', { name: 'Disable', exact: true }).isDisabled(), true);
  await row.locator('[data-dv-toggle-user]').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  release(); await page.locator('#notification').filter({ hasText: 'Fixture refused the role change.' }).waitFor();
  assert.equal(writes, 1, 'a sibling row action cannot overlap its role save');
  assert.equal(await row.getByRole('button', { name: 'Disable', exact: true }).isDisabled(), false);
  assert.equal(await editor.locator('input[type=password]').isDisabled(), false);
  assert.equal(await roles.getByRole('button', { name: 'Save roles', exact: true }).isDisabled(), false);
  assert.deepEqual(await roles.locator('[data-dv-role]:checked').evaluateAll(nodes => nodes.map(node => node.dataset.dvRole)), selected);
  assert.deepEqual(errors, []);
});
