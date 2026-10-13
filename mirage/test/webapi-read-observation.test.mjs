import test from 'node:test';
import assert from 'node:assert/strict';
import {DataStore} from '../lib/data.mjs';
import {DataError} from '../lib/data-error.mjs';
import {handleWebApi} from '../lib/webapi-handler.mjs';
import {dispatchSdkCall} from '../lib/plugin-clr.mjs';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const recordId = '10000000-0000-0000-0000-000000000001';
function fixture() {
  const store = new DataStore({state: {
    mappings: {widget: {entitySet: 'widgets', idColumn: 'widgetid', fields: {title: {type: 'string'}}}},
    tables: {widget: [{widgetid: recordId, title: 'Recorded', versionnumber: 1}]},
    permissions: [{entity: 'widget', scope: 'global', operations: ['read'], roles: ['Reader']}],
    settings: {permissionMode: 'enforce'},
  }});
  return store;
}
async function request(store, path, headers = {}) {
  const events = [], res = {
    headersSent: false,
    writeHead(status, headers) { this.headersSent = true; events.push({status, headers}); },
    end(body) { events.push({body}); },
  };
  const url = new URL(path, 'http://localhost');
  await handleWebApi({method: 'GET', headers}, res, url, {
    store, identity: {contactId: recordId, roles: ['Reader']},
    portal: {settings: {'Webapi/widget/enabled': 'true', 'Webapi/widget/fields': 'title'}},
    origin: url.origin, origins: [url.origin],
    json(out, status, body, headers) { out.writeHead(status, headers); out.end(body); },
  });
  return events;
}

test('read responses wait for the SDK observation persistence boundary, including raw properties and 304', async () => {
  for (const [path, headers, expected] of [
    ['/_api/widgets?$select=title', {}, 200],
    ['/_api/widgets?fetchXml=' + encodeURIComponent('<fetch><entity name="widget"><attribute name="title"/></entity></fetch>'), {}, 200],
    [`/_api/widgets(${recordId})/title/$value`, {}, 200],
    [`/_api/widgets(${recordId})`, {'if-none-match': 'W/"1"'}, 304],
  ]) {
    const store = fixture(); let completed = false;
    store.readOperation = async fn => { await fn(); completed = true; };
    const events = await request(store, path, headers);
    assert.equal(completed, true);
    assert.equal(events[0].status, expected);
    const failure = fixture();
    failure.readOperation = async fn => { await fn(); throw new DataError('Invented persistence conflict', 409, 'StateConflict'); };
    const rejected = await request(failure, path, headers);
    assert.equal(rejected.length, 2, 'No successful response escapes before commit');
    assert.equal(rejected[0].status, 409);
    assert.match(rejected[1].body.error.message, /persistence conflict/);
  }
});

test('API transport marks observer reads explicitly without making direct SDK reads portal calls', async () => {
  const store = fixture(), calls = [];
  const query = store.query.bind(store), fetchXml = store.fetchXml.bind(store), get = store.get.bind(store);
  store.readOperation = async fn => fn();
  store.query = (...args) => { calls.push(args[4]); return query(...args); };
  store.fetchXml = (...args) => { calls.push(args[2]); return fetchXml(...args); };
  store.get = (...args) => { calls.push(args[3]); return get(...args); };
  await request(store, '/_api/widgets?$select=title');
  await request(store, '/_api/widgets?fetchXml=' + encodeURIComponent('<fetch><entity name="widget"><attribute name="title"/></entity></fetch>'));
  await request(store, `/_api/widgets(${recordId})/title`);
  assert.ok(calls.length >= 4);
  assert.ok(calls.every(options => options.portalRequest === true));
});

test('permission-generated Dataverse query limits retain a CDS execution error envelope', async () => {
  for (const innerCode of ['0x8004430c', '0x8004430d']) {
    const store = fixture();
    store.query = () => { throw new DataError('Invented Dataverse query budget exceeded', 400, 'UnsupportedQuery', {innerCode}); };
    const events = await request(store, '/_api/widgets?$select=title');
    assert.equal(events[0].status, 400);
    assert.equal(events[1].body.error.code, '9004010D');
  }
});

test('HTTP read observer records through its own SDK grants, including a later failed read', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'paqvilo-read-observation-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  for (const failAfterRead of [false, true]) {
    const store = fixture();
    store.state.mappings.observation = {entitySet: 'observations', idColumn: 'observationid'};
    store.state.tables.observation = [];
    store.file = path.join(directory, `${failAfterRead}.json`);
    await store.init();
    const phases = [];
    const userId = '20000000-0000-0000-0000-000000000001';
    store.setPluginPipeline(context => {
      phases.push({stage: context.stage, portalRequest: context.portalRequest});
      if (context.stage === 20) dispatchSdkCall({store,
        profile: {userId, evidence: 'Invented read observation backend', grants: [{entity: 'observation', operations: ['create']}]},
        message: {method: 'Create', userId, arguments: [{$type: 'Entity', logicalName: 'observation', attributes: {title: 'Incoming query recorded'}}]},
      });
      if (context.stage === 40 && failAfterRead) throw new DataError('Invented late read rejection', 400, 'PluginValidation');
    }, ({entity, operation}) => entity === 'widget' && operation === 'retrievemultiple');
    const events = await request(store, '/_api/widgets?$select=title');
    assert.equal(events[0].status, failAfterRead ? 400 : 200);
    assert.deepEqual(phases, [10, 20, 40].map(stage => ({stage, portalRequest: true})));
    assert.equal(store.tableRows('observation').length, 1);
    assert.equal(store.tableRows('observation')[0].title, 'Incoming query recorded');
    assert.equal(JSON.parse(await readFile(store.file, 'utf8')).tables.observation.length, 1);
    assert.deepEqual(store.rows('observation', {contactId: recordId, roles: ['Reader']}), []);
  }
});
