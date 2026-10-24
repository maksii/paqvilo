import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { createSimulator } from '../server.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
test('Stop drains accepted GET observers before closing their backend and rejects late reads', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-shutdown-read-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'website.yml'), 'adx_websiteid: invented\nadx_name: Invented Read Shutdown');
  await fs.writeFile(
    path.join(dir, 'settings.sitesetting.yml'),
    '- adx_name: Webapi/widget/enabled\n  adx_value: true\n- adx_name: Webapi/widget/fields\n  adx_value: title',
  );
  const app = await createSimulator({
    sourceDir: dir,
    watch: false,
    stateFile: path.join(dir, '.paqvilo/state.json'),
    initial: {
      version: 1,
      mappings: {
        widget: { entitySet: 'widgets', idColumn: 'widgetid' },
        x_log: { entitySet: 'x_logs', idColumn: 'x_logid' },
      },
      tables: { widget: [{ widgetid: 'one', title: 'Accepted read' }], x_log: [] },
      plugins: [],
      permissions: [],
      settings: { permissionMode: 'permissive' },
    },
  });
  let release, enter;
  const gate = new Promise((resolve) => {
      release = resolve;
    }),
    entered = new Promise((resolve) => {
      enter = resolve;
    });
  ownedFixture(t).add(async () => {
    release();
    await app.close();
  });
  const read = app.store.readOperation.bind(app.store);
  app.store.readOperation = async (fn) => {
    enter();
    await gate;
    return read(fn);
  };
  const profile = {
    userId: '20000000-0000-0000-0000-000000000001',
    evidence: 'Invented observer backend',
    grants: [{ entity: 'x_log', operations: ['create'] }],
  };
  app.store.setPluginPipeline(
    (context) => {
      if (context.stage === 20)
        localOrganizationService(app.store, profile).create('x_log', { title: 'Accepted GET recorded' });
    },
    (context) => context.entity === 'widget' && context.operation === 'retrievemultiple',
  );
  const response = fetch(app.url + '/_api/widgets?$select=title');
  response.catch(() => {});
  await entered;
  const stopped = app.close();
  const late = await fetch(app.url + '/_api/widgets');
  assert.equal(late.status, 503);
  await late.text();
  release();
  const accepted = await response;
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).value[0].title, 'Accepted read');
  await stopped;
  const saved = JSON.parse(await fs.readFile(path.join(dir, '.paqvilo/state.json'), 'utf8'));
  assert.deepEqual(
    saved.tables.x_log.map((row) => row.title),
    ['Accepted GET recorded'],
  );
});
test('Stop rejects new HTTP writes and drains an accepted streaming mutation plus its automatic imported flow', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-shutdown-flow-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const flow = '10000000-0000-0000-0000-000000000001';
  const files = {
    'website.yml': 'adx_websiteid: invented\nadx_name: Invented Shutdown',
    'enabled.sitesetting.yml': 'adx_name: Webapi/widget/enabled\nadx_value: true',
    'fields.sitesetting.yml': 'adx_name: Webapi/widget/fields\nadx_value: title',
    'pack.mjs': `export default{id:'invented-trigger',name:'Invented',description:'Invented',matches:()=>true,presets:()=>({}),flowIdentities:{'${flow}':{userId:'20000000-0000-0000-0000-000000000001',evidence:'Invented',grants:[{entity:'widget',operations:['read']},{entity:'x_log',operations:['create']}]}}};`,
  };
  for (const [file, source] of Object.entries(files)) await fs.writeFile(path.join(dir, file), source);
  await fs.mkdir(path.join(dir, 'Workflows'));
  const definition = {
    properties: {
      definition: {
        triggers: {
          row: {
            type: 'OpenApiConnectionWebhook',
            inputs: {
              host: { apiId: '/apis/shared_commondataserviceforapps', operationId: 'SubscribeWebhookTrigger' },
              parameters: { message: 1, entityname: 'widget', scope: 4, filteringattributes: '' },
            },
          },
        },
        actions: {
          create: {
            type: 'OpenApiConnection',
            inputs: {
              host: { apiId: '/apis/shared_commondataserviceforapps', operationId: 'CreateRecord' },
              parameters: { entityName: 'x_logs', 'item/title': "@triggerBody()['title']" },
            },
          },
        },
      },
    },
  };
  await fs.writeFile(path.join(dir, 'Workflows/flow.json'), JSON.stringify(definition));
  await fs.writeFile(
    path.join(dir, 'Workflows/flow.json.data.xml'),
    `<Workflow WorkflowId="${flow}" Name="Invented automatic flow"><StateCode>1</StateCode></Workflow>`,
  );
  const app = await createSimulator({
    sourceDir: dir,
    solutionRoots: [dir],
    port: 0,
    watch: false,
    stateFile: path.join(dir, '.paqvilo/state.json'),
    dataPacks: [{ module: path.join(dir, 'pack.mjs') }],
    initial: {
      version: 1,
      mappings: {
        widget: { entitySet: 'widgets', idColumn: 'widgetid' },
        x_log: { entitySet: 'x_logs', idColumn: 'x_logid' },
      },
      tables: { widget: [], x_log: [] },
      plugins: [],
      permissions: [{ entity: 'widget', scope: 'global', operations: ['create'], roles: ['Editor'] }],
      settings: { permissionMode: 'enforce' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        identityScope: 'configured',
        identity: { id: 'caller', roles: ['Editor'], roleSource: 'override' },
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  const accepted = once(app.server, 'request'),
    request = http.request(app.url + '/_api/widgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf },
    }),
    response = new Promise((resolve, reject) => {
      request.on('response', (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      request.on('error', reject);
    });
  request.write('{"title":');
  await accepted;
  const stopped = app.close();
  const late = await fetch(app.url + '/_api/widgets', {
    method: 'POST',
    headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf },
    body: JSON.stringify({ title: 'Late rejected' }),
  });
  assert.equal(late.status, 503);
  request.end('"Accepted before stop"}');
  assert.equal(await response, 204);
  await stopped;
  const saved = JSON.parse(await fs.readFile(path.join(dir, '.paqvilo/state.json'), 'utf8'));
  assert.equal(saved.tables.widget.length, 1);
  assert.equal(saved.tables.widget[0].title, 'Accepted before stop');
  assert.equal(saved.tables.x_log.length, 1);
  assert.equal(saved.tables.x_log[0].title, 'Accepted before stop');
  assert.ok(app.state().diagnostics.some((n) => n.code === 'FLOW_TRIGGER_COMPLETED'));
});
