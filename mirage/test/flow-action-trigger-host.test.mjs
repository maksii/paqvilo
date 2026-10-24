// End to end through the Dataverse Web API: "When an action is performed" (BusinessEventsTrigger) starts a
// tracked run for a committed custom API action, and never for one inside a $batch changeset that rolls back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

const FLOW = '77777777-7777-4777-8777-0000000000e1', CLIENT = '77777777-7777-4777-8777-0000000000e2';
const ENTITY = '<Entity><Name>x_case</Name><EntityInfo><entity Name="x_case"><EntitySetName>x_cases</EntitySetName><PrimaryIdAttribute>x_caseid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_caseid"><Name>x_caseid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type><MaxLength>10</MaxLength></attribute></attributes></entity></EntityInfo></Entity>';
const DEF = { properties: { definition: { triggers: { performed: { type: 'OpenApiConnectionWebhook', inputs: { host: { apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps', operationId: 'BusinessEventsTrigger' },
  parameters: { catalog: 'x_invented', category: 'x_events', entityname: 'none', sdkmessagename: 'x_Notify' } } } }, actions: { Note: { type: 'Compose', runAfter: {}, inputs: 'fired' } } } } };
const files = {
  'Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedAction</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  'Entities/x_case/Entity.xml': ENTITY,
  'customapis/x_Notify/customapi.xml': '<customapi uniquename="x_Notify"><bindingtype>0</bindingtype><isfunction>0</isfunction><name>x_Notify</name></customapi>',
  'Workflows/performed.json': JSON.stringify(DEF),
  'Workflows/performed.json.data.xml': `<Workflow WorkflowId="{${FLOW}}" Name="Invented action trigger"><Category>5</Category><StateCode>1</StateCode></Workflow>`,
};

test('a committed custom API action starts one run; the same action in a rolled-back changeset starts none', { timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-action-host-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, 'solution', name)), { recursive: true }); await fs.writeFile(path.join(root, 'solution', name), text); }
  const sim = await createSimulator({ runtime: { kind: 'dataverse-api' }, solutionRoots: [path.join(root, 'solution')], projectRoot: root, port: 0, watch: false,
    simulation: { level: 'dry-run' }, dataverse: { enabled: true, tls: false, tds: { enabled: false } } });
  ownedFixture(t).add(() => sim.close());
  const simApi = async (method, suffix, payload) => { const r = await fetch(sim.url + '/_sim/api' + suffix, { method, headers: { 'x-sim-csrf': sim.csrf, ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) }); return { status: r.status, body: await r.text() }; };
  assert.equal((await simApi('PATCH', '/config', { operations: { [`cloud-flow:${FLOW}`]: { mode: 'exported', activation: 'local-enabled' } } })).status, 200);
  const { secret } = JSON.parse((await simApi('POST', '/dataverse/applications', { appId: CLIENT, displayName: 'Invented client', roles: ['System Administrator'] })).body);
  const token = await (await fetch(sim.dataverse.authority + '/oauth2/v2.0/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT, client_secret: secret, scope: sim.dataverse.origin + '/.default' }) })).json();
  const auth = { authorization: `Bearer ${token.access_token}` }, base = sim.dataverse.origin + '/api/data/v9.2/';
  const runs = async () => { await sim.settle(); return (sim.store.state.tables.flowrun ?? []).filter(row => String(row.workflowid).toLowerCase() === FLOW).map(row => [row.status, row.triggertype]); };

  const b = 'batch_inv', c = 'changeset_inv';
  const batch = [`--${b}`, `Content-Type: multipart/mixed; boundary=${c}`, '',
    `--${c}`, 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', 'Content-ID: 1', '', `POST ${base}x_Notify HTTP/1.1`, 'Content-Type: application/json', '', '{}',
    `--${c}`, 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', 'Content-ID: 2', '', `PATCH ${base}x_cases(77777777-7777-4777-8777-77777777ffff) HTTP/1.1`, 'Content-Type: application/json', 'If-Match: *', '', JSON.stringify({ x_name: 'gone' }),
    `--${c}--`, `--${b}--`, ''].join('\r\n');
  const rolledBack = await fetch(base + '$batch', { method: 'POST', headers: { ...auth, 'content-type': `multipart/mixed; boundary=${b}` }, body: batch });
  assert.match(await rolledBack.text(), /HTTP\/1\.1 404/);
  assert.deepEqual(await runs(), [], 'a rolled-back action starts no run');

  const direct = await fetch(base + 'x_Notify', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(direct.status, 204);
  assert.deepEqual(await runs(), [['Succeeded', 'Automated']]);
});
