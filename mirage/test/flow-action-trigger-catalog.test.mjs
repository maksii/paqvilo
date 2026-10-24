// Catalog and catalogassignment rows are imported from the Solution (catalogs/<name>/catalog.xml,
// Assets/catalogassignments.xml), so "When an action is performed" fires for the action assigned to its catalog and category
// and not for an unassigned one; an organization whose Solution ships no catalog records FLOW_TRIGGER_CATALOG_UNCHECKED once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

const ASSIGNED = '77777777-7777-4777-8777-0000000000e5', UNASSIGNED = '77777777-7777-4777-8777-0000000000e6', CLIENT = '77777777-7777-4777-8777-0000000000e7';
const trigger = message => ({ properties: { definition: { triggers: { performed: { type: 'OpenApiConnectionWebhook', inputs: { host: { apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps', operationId: 'BusinessEventsTrigger' },
  parameters: { catalog: 'x_invented', category: 'x_events', entityname: 'none', sdkmessagename: message } } } }, actions: { Note: { type: 'Compose', runAfter: {}, inputs: 'fired' } } } } });
const api = name => `<customapi uniquename="${name}"><bindingtype>0</bindingtype><isfunction>0</isfunction><name>${name}</name></customapi>`;
const flow = (id, name, message) => ({ [`Workflows/${name}.json`]: JSON.stringify(trigger(message)),
  [`Workflows/${name}.json.data.xml`]: `<Workflow WorkflowId="{${id}}" Name="${name}"><Category>5</Category><StateCode>1</StateCode></Workflow>` });
const CATALOGS = {
  'catalogs/x_invented/catalog.xml': '<catalog uniquename="x_invented"><displayname default="Invented"/><iscustomizable>0</iscustomizable><name>Invented</name></catalog>',
  'catalogs/x_events/catalog.xml': '<catalog uniquename="x_events"><displayname default="Events"/><iscustomizable>0</iscustomizable><name>Invented events</name><parentcatalogid><uniquename>x_invented</uniquename></parentcatalogid></catalog>',
  'Assets/catalogassignments.xml': '<catalogassignments><catalogassignment catalogid.uniquename="x_events" object.uniquename="x_Notify" objectidtype="customapi"><iscustomizable>0</iscustomizable><name>Notify</name></catalogassignment></catalogassignments>',
};

async function simulator(t, extra) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-action-catalog-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedCatalog</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'customapis/x_Notify/customapi.xml': api('x_Notify'), 'customapis/x_Other/customapi.xml': api('x_Other'),
    ...flow(ASSIGNED, 'assigned', 'x_Notify'), ...flow(UNASSIGNED, 'unassigned', 'x_Other'), ...extra };
  for (const [name, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, 'solution', name)), { recursive: true }); await fs.writeFile(path.join(root, 'solution', name), text); }
  const sim = await createSimulator({ runtime: { kind: 'dataverse-api' }, solutionRoots: [path.join(root, 'solution')], projectRoot: root, port: 0, watch: false,
    simulation: { level: 'dry-run' }, dataverse: { enabled: true, tls: false, tds: { enabled: false } } });
  ownedFixture(t).add(() => sim.close());
  const simApi = async (method, suffix, payload) => (await fetch(sim.url + '/_sim/api' + suffix, { method, headers: { 'x-sim-csrf': sim.csrf, 'content-type': 'application/json' }, body: JSON.stringify(payload) })).status;
  const enabled = { mode: 'exported', activation: 'local-enabled' };
  assert.equal(await simApi('PATCH', '/config', { operations: { [`cloud-flow:${ASSIGNED}`]: enabled, [`cloud-flow:${UNASSIGNED}`]: enabled } }), 200);
  const { secret } = await (await fetch(sim.url + '/_sim/api/dataverse/applications', { method: 'POST', headers: { 'x-sim-csrf': sim.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ appId: CLIENT, displayName: 'Invented client', roles: ['System Administrator'] }) })).json();
  const token = await (await fetch(sim.dataverse.authority + '/oauth2/v2.0/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT, client_secret: secret, scope: sim.dataverse.origin + '/.default' }) })).json();
  const perform = async name => assert.equal((await fetch(sim.dataverse.origin + '/api/data/v9.2/' + name, { method: 'POST', headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' }, body: '{}' })).status, 204);
  const runs = async id => { await sim.settle(); return (sim.store.state.tables.flowrun ?? []).filter(row => String(row.workflowid).toLowerCase() === id).map(row => row.status); };
  const notes = code => sim.state().diagnostics.filter(entry => entry.code === code);
  return { sim, perform, runs, notes };
}

test('a Solution catalog and assignment: the assigned action fires its trigger, an unassigned one does not', { timeout: 60000 }, async t => {
  const { sim, perform, runs, notes } = await simulator(t, CATALOGS);
  const catalogs = sim.store.state.tables.catalog ?? [];
  assert.deepEqual(catalogs.map(row => row.uniquename).sort(), ['x_events', 'x_invented']);
  assert.equal(catalogs.find(row => row.uniquename === 'x_events').parentcatalogid, catalogs.find(row => row.uniquename === 'x_invented').catalogid);
  const [assignment] = sim.store.state.tables.catalogassignment;
  assert.equal(assignment.object, sim.store.state.tables.customapi.find(row => row.uniquename === 'x_Notify').customapiid);
  await perform('x_Notify');
  await perform('x_Other');
  assert.deepEqual(await runs(ASSIGNED), ['Succeeded']);
  assert.deepEqual(await runs(UNASSIGNED), [], 'x_Other is not assigned to the x_events category');
  assert.deepEqual(notes('FLOW_TRIGGER_NOT_CATALOGED').map(entry => entry.operationKey), [`cloud-flow:${UNASSIGNED}`]);
  assert.equal(notes('FLOW_TRIGGER_CATALOG_UNCHECKED').length, 0);
});

test('a Solution without catalogs fires by action name and records FLOW_TRIGGER_CATALOG_UNCHECKED once per trigger', { timeout: 60000 }, async t => {
  const { perform, runs, notes } = await simulator(t, {});
  await perform('x_Notify');
  await perform('x_Notify');
  assert.deepEqual(await runs(ASSIGNED), ['Succeeded', 'Succeeded']);
  assert.deepEqual(notes('FLOW_TRIGGER_CATALOG_UNCHECKED').map(entry => entry.operationKey), [`cloud-flow:${ASSIGNED}`]);
});
