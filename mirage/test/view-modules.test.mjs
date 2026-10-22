import test from 'node:test';
import assert from 'node:assert/strict';
import { HELP } from '../admin/help-content.mjs';
import { escapeHtml } from '../admin/ui-kit.mjs';
import { docsLinks } from '../lib/docs-links.mjs';
import { view as services } from '../admin/view-services.mjs';
import { view as flows } from '../admin/view-flows.mjs';
import { view as capabilities } from '../admin/view-capabilities.mjs';
import { view as packs } from '../admin/view-packs.mjs';

const docs = docsLinks('0.9.4', 'https://git.example.test/invented/paqvilo');
const context = ({ responses = {}, state = {}, data = {}, caps = { powerPages: true } } = {}) => {
  const requested = [];
  return {
    requested, data, help: HELP, escape: escapeHtml,
    state: () => state, session: () => ({}), capabilities: () => caps, docs: () => docs, links: () => ({}),
    pager: () => ({ page: 1, size: 10, search: '' }), open: () => false, toggle() {},
    refresh: async () => {}, notify() {}, setButtonPending: () => true, askConfirmation() {},
    async request(path) {
      requested.push(path);
      const answer = responses[path.split('?')[0]];
      if (answer instanceof Error) throw answer;
      return structuredClone(answer ?? {});
    },
  };
};
const openCount = html => (html.match(/<details[^>]*\sopen[\s>]/g) ?? []).length;
const safeMarkup = html => {
  assert.doesNotMatch(html, /\sstyle=/);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.doesNotMatch(html, /javascript:/i);
};
const assertTables = (html, keys) => { for (const key of keys) assert.match(html, new RegExp(`data-table="${key}"`), key); };

const dashboard = {
  nodes: [
    { id: 'provider:storage', kind: 'provider', label: 'Storage', status: 'ready', detail: { providers: [{ id: 'local', kind: 'local', level: 'behaviour', ready: true, routes: ['dataverseFiles', 'sharepointDocuments'] }, { id: 'fx-blob', kind: 'azurite', level: 'contract', ready: false, routes: [] }] } },
    { id: 'provider:storage-route:dataverseFiles', kind: 'provider', label: 'dataverseFiles', status: 'ready', detail: { provider: 'local' } },
    { id: 'provider:storage-route:sharepointDocuments', kind: 'provider', label: 'sharepointDocuments', status: 'ready', detail: { provider: 'local' } },
    { id: 'external:azurite', kind: 'external', label: 'Azurite', status: 'declared', detail: { providers: ['fx-blob'] } },
    { id: 'provider:messaging', kind: 'provider', label: 'Message bus', status: 'ready', level: 'behaviour', detail: { id: 'local', endpoints: 1 } },
    { id: 'provider:connectors', kind: 'provider', label: 'Connectors', status: 'ready', detail: { providers: [{ id: 'memory-queue', level: 'behaviour', operations: 5 }, { id: 'http', level: 'behaviour', operations: 1 }] } },
    { id: 'connection:fx_files', kind: 'connection', label: 'fx_files', status: 'declared', detail: { provider: 'fixture', connector: 'shared_sharepointonline', principal: 'named' } },
    { id: 'provider:secrets', kind: 'provider', label: 'Secret references', status: 'ready', detail: { keys: 2 } },
    { id: 'provider:local-service:fx-functions', kind: 'provider', label: 'fx-functions', status: 'declared', level: 'contract', detail: { service: 'http', required: false } },
    { id: 'provider:service-fixture:powerbi', kind: 'provider', label: 'powerbi', status: 'disabled', detail: { operations: { inventory: 2 } } },
    { id: 'provider:powerfx', kind: 'provider', label: 'Power Fx', status: 'ready', level: 'contract', detail: { name: 'powerfx' } },
    { id: 'app:canvas', kind: 'app', label: 'Canvas apps', status: 'ready', detail: { apps: 1 } },
    { id: 'app:code', kind: 'app', label: 'Code apps', status: 'disabled', detail: { apps: 0 } },
    { id: 'org:jobs', kind: 'org', label: 'Background jobs', status: 'ready', detail: { scheduler: { manual: false, closed: false, executed: 4, faults: 0, failures: 0 }, recentErrors: [{ kind: 'plugin', code: 'FX_FAILED' }] } },
    { id: 'org:plugins', kind: 'org', label: 'Plug-in steps', status: 'ready', detail: { webhooks: [{ name: 'Invented hook', host: 'localhost', loopback: true }, { name: 'Remote hook', host: 'hooks.example.test', loopback: false }] } },
  ],
  activity: { messages: { active: 2, locked: 0, scheduled: 1, deadLettered: 0 }, storage: { byProvider: [{ id: 'local', objects: 3, bytes: 120 }] },
    jobs: { pending: 1, scheduled: 0, running: 0, failures: 1, poisoned: 0 }, asyncOperations: { byState: { Completed: 4 } }, webhooks: { delivered: 2, failed: 0, notContacted: 1 } },
};
const servicesResponses = {
  '/dashboard': dashboard,
  '/messages': { configured: true, entities: [{ entity: 'fx-orders', stats: { active: 2, locked: 0, scheduled: 1, deadLettered: 0 } }], endpoints: { 'fx-endpoint': 'local/fx-orders' } },
  '/outbox': { configured: true, entries: [{ id: 'o1', channel: 'email', to: ['someone@example.test'], subject: 'Invented subject', state: 'queued', createdOn: '2026-10-22T10:00:00Z', correlationId: 'c1' }] },
  '/flow-waits': [{ id: 'fx-approval', kind: 'approval', runId: 'run-1', processId: 'p1', timeoutAt: '2026-10-23T10:00:00Z', overdue: false }],
  '/environment': { environmentVariables: { available: true, definitions: [{ id: 'd1', schemaName: 'fx_ApiSecret', secret: true, secretStatus: { bound: true, status: 'resolved' } }, { id: 'd2', schemaName: 'fx_Plain', secret: false }] } },
};

test('services view loads its routes and renders every panel collapsed except storage', async () => {
  const ctx = context({ responses: servicesResponses, state: { inventory: { total: 2, components: { customcontrol: { count: 2, levels: { inventory: 2 } } } } } });
  await services.load(ctx);
  assert.deepEqual(ctx.requested.sort(), ['/dashboard', '/environment', '/flow-waits', '/messages', '/outbox']);
  const html = services.render(ctx);
  safeMarkup(html);
  assert.equal(openCount(html), 1);
  assert.match(html, /data-ui-section="services:storage" open/);
  assertTables(html, ['svc-storage-providers', 'svc-storage-routes', 'svc-endpoints', 'svc-entities', 'svc-outbox', 'svc-connector-providers', 'svc-connections', 'svc-approvals', 'svc-secrets', 'svc-local-services', 'svc-fixtures']);
  for (const id of ['storage', 'messaging', 'outbox', 'connectors', 'secrets', 'local-services', 'service-fixtures', 'powerfx', 'apps', 'sharepoint']) assert.match(html, new RegExp(`id="help-services-${id}"`), id);
  assert.match(html, /data-svc-purge="fx-orders"/);
  assert.match(html, /data-svc-probe="fx-functions"/);
  assert.match(html, /memory-queue sends through the local message bus: 2 active/);
  assert.match(html, /fx_ApiSecret/);
  assert.doesNotMatch(html, /fx_Plain/);
  assert.match(html, /PCF controls \(Solution inventory\)<\/dt><dd>2/);
  assert.match(html, /<h1>Providers &amp; services<\/h1>/);
});

test('services view states honest empty and unconfigured states', async () => {
  const ctx = context({ responses: { '/dashboard': { nodes: [], activity: {} }, '/messages': { configured: false, entities: [], endpoints: {} }, '/outbox': { configured: false, entries: [] },
    '/flow-waits': new Error('This runtime has no flow run store.'), '/environment': new Error('Not found') } });
  await services.load(ctx);
  const html = services.render(ctx);
  safeMarkup(html);
  assert.equal(openCount(html), 1);
  assert.match(html, /No message bus is configured\. Declare one under providers\.messaging in \/_setup\/\./);
  assert.match(html, /id="help-services-messaging"[^>]*>[^<]*<a class="ui-doc" href="https:\/\/git\.example\.test\/invented\/paqvilo\/blob\/v0\.9\.4\/mirage\/docs\/messaging-and-outbox\.md#local-message-bus"/);
  assert.match(html, /No storage provider is described by this runtime/);
  assert.match(html, /No outbox is configured/);
  assert.match(html, /Flow waits could not be read: This runtime has no flow run store\./);
  assert.match(html, /No local service is declared/);
  assert.match(html, /Secret environment variables could not be read on this host: Not found/);
});

test('services deep link opens the named panel', async () => {
  const ctx = context({ responses: servicesResponses });
  await services.load(ctx);
  globalThis.location = { hash: '#services?panel=outbox' };
  try { assert.match(services.render(ctx), /data-ui-section="services:outbox" open/); } finally { delete globalThis.location; }
});

const runs = [{ id: 'run-1', processId: 'p1', status: 'Waiting', starttime: '2026-10-22T09:00:00Z', triggertype: 'automated' }, { id: 'run-2', processId: 'p1', status: 'Succeeded', starttime: '2026-10-22T08:00:00Z' }];
test('flows view renders runs, waits, background work and webhooks; the run deep link loads a journal', async () => {
  globalThis.location = { hash: '#flows?run=run-2' };
  const ctx = context({ responses: { '/flow-runs': runs, '/flow-waits': [{ id: 'fx-approval', kind: 'approval', runId: 'run-1', overdue: true }], '/dashboard': dashboard,
    '/flow-runs/run-2': { ...runs[1], journal: { Send_email: { status: 'Succeeded', outputs: { statusCode: 200 } } } } } });
  try { await flows.load(ctx); } finally { delete globalThis.location; }
  assert.ok(ctx.requested.includes('/flow-runs/run-2'));
  const html = flows.render(ctx);
  safeMarkup(html);
  assert.equal(openCount(html), 1);
  assertTables(html, ['flow-runs', 'flow-waits', 'flow-job-errors', 'flow-async', 'flow-webhooks']);
  for (const id of ['runs', 'waits', 'background', 'webhooks']) assert.match(html, new RegExp(`id="help-flows-${id}"`));
  assert.match(html, /data-ui-section="flows:journal">/);
  assert.match(html, /Send_email/);
  assert.match(html, /hooks\.example\.test/);
  assert.match(html, /not contacted/);
});

test('flows view says when the host has no flow run store', async () => {
  const missing = Object.assign(new Error('This runtime has no flow run store.'), { status: 404 });
  const ctx = context({ responses: { '/flow-runs': missing, '/flow-waits': missing, '/dashboard': { nodes: [], activity: {} } } });
  await flows.load(ctx);
  const html = flows.render(ctx);
  safeMarkup(html);
  assert.equal(openCount(html), 1);
  assert.match(html, /Flow runs could not be read: This runtime has no flow run store\. \(HTTP 404\)/);
  assert.match(html, /data-ui-section="flows:waits"><summary><span class="ui-section-title">Waits &amp; approvals<\/span><span class="ui-section-summary">unavailable/);
  assert.match(html, /No webhook \(contract 8\) service endpoint is registered\./);
  assert.match(html, /This runtime reports no scheduler status\./);
});

const capabilityState = {
  capabilityReport: { modules: [{ name: 'fx-module', kind: 'organization-module', level: 'behaviour', operations: [{ name: 'run' }], stateOwner: 'fx' }, { name: 'fx-placeholder', kind: 'operation', level: 'inventory', operations: [] }],
    missing: [{ module: 'fx-module', requires: 'fx-dependency' }], unsupported: [{ id: 'fx-placeholder', level: 'inventory', reason: 'Placeholder' }] },
  inventory: { total: 3, components: { canvasapp: { count: 1, levels: { inventory: 1 } }, table: { count: 2, levels: { behaviour: 2 } } } },
  status: { scenarios: [{ id: 'fx-scenario', name: 'Invented scenario' }] },
};
test('capabilities view renders report, missing, unsupported, inventory and scenario preflight buttons', async () => {
  const ctx = context({ state: capabilityState });
  await capabilities.load(ctx);
  ctx.data.capabilities.result = { summary: { total: 2, satisfied: 1, missing: 1, blocking: 1 }, requirements: [{ id: 'table:x_item', kind: 'table', status: 'satisfied', inScope: true, blocking: false }, { id: 'local-service:fx', kind: 'local-service', status: 'missing', inScope: true, blocking: true, message: 'unreachable' }] };
  ctx.data.capabilities.ran = { requires: ['table:*'], strict: true };
  const html = capabilities.render(ctx);
  safeMarkup(html);
  assertTables(html, ['cap-modules', 'cap-missing', 'cap-unsupported', 'cap-inventory', 'cap-result-missing', 'cap-result-satisfied', 'cap-scenarios']);
  assert.match(html, /<select id="cap-level" data-cap-level aria-describedby="cap-level-help">/);
  assert.match(html, /<small class="ui-field-help" id="cap-level-help">Only capability records at this level/);
  for (const id of ['report', 'missing', 'unsupported', 'preflight']) assert.match(html, new RegExp(`id="help-capabilities-${id}"`));
  assert.match(html, /data-cap-scenario="fx-scenario"/);
  assert.match(html, /Scope: table:\* · strict\./);
  assert.match(html, /data-ui-section="capabilities:result:missing" open/);
  assert.doesNotMatch(html, /data-ui-section="capabilities:result:satisfied" open/);
  ctx.data.capabilities.level = 'inventory';
  assert.doesNotMatch(capabilities.render(ctx), /<code>fx-module<\/code><\/td><td>organization-module/);
});

test('capabilities view states missing report and hides scenario buttons on standalone hosts', async () => {
  const ctx = context({ state: {}, caps: { powerPages: false } });
  await capabilities.load(ctx);
  const html = capabilities.render(ctx);
  safeMarkup(html);
  assert.equal(openCount(html), 1);
  assert.match(html, /This host sent no capability report in its state\./);
  assert.match(html, /No preflight has run in this session\./);
  assert.doesNotMatch(capabilities.render(context({ state: capabilityState, caps: { powerPages: false } })), /data-cap-scenario/);
});

const packsPayload = {
  packs: [{ id: 'fx-pack', name: '<script>alert(1)</script>', description: 'Invented', module: 'pack/fx-pack.mjs', registration: { source: 'project', setupLink: '/_setup/#packs' },
    matched: false, matchReason: 'matches({ portal }) did not return true', exports: { serverLogics: 2, cloudFlows: 1 }, presets: [{ id: 'fx-empty', name: 'Empty' }], configurationPresets: 0, personas: 1,
    personaCatalog: { groups: 1, personas: 2, contexts: 0, scenarios: 1 }, dataFiles: [{ file: 'data/fx.json', tables: ['x_item'], writable: true }], diagnostics: [{ code: 'PACK_EXPORT_UNKNOWN', severity: 'warning', message: 'Unknown export fxTypo' }] }],
  failed: [], library: [{ id: 'fx-empty', name: 'Empty', pack: 'fx-pack', source: 'builtin' }, { id: 'saved', name: 'Saved', pack: null, source: 'stored' }], setupLink: '/_setup/#packs',
};
test('packs view escapes names, shows matched status, provenance columns and expands details on request', async () => {
  const ctx = context({ responses: { '/packs': packsPayload } });
  await packs.load(ctx);
  let html = packs.render(ctx);
  safeMarkup(html);
  assert.equal(openCount(html), 1);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assertTables(html, ['packs-registered', 'packs-library']);
  assert.match(html, /<th scope="col">Pack<\/th><th scope="col">Source<\/th>/);
  assert.match(html, /not matched/);
  assert.match(html, /Add or change a pack/);
  assert.match(html, /href="\/_setup\/#packs">Open project setup/);
  for (const id of ['registered', 'presets', 'lifecycle']) assert.match(html, new RegExp(`id="help-packs-${id}"`));
  const button = { dataset: { packDetails: 'fx-pack' } };
  assert.equal(packs.handle(ctx, { type: 'click', target: { closest: selector => (selector === '[data-pack-details]' ? button : null) } }), true);
  html = packs.render(ctx);
  assertTables(html, ['packs-fx-pack-exports', 'packs-fx-pack-presets', 'packs-fx-pack-data', 'packs-fx-pack-diagnostics']);
  assert.match(html, /PACK_EXPORT_UNKNOWN/);
});

test('packs view states that no pack is registered', async () => {
  const ctx = context({ responses: { '/packs': { packs: [], failed: [], library: [], setupLink: '/_setup/#packs' } } });
  await packs.load(ctx);
  const html = packs.render(ctx);
  safeMarkup(html);
  assert.match(html, /No data pack is registered\. Write pack\/&lt;id&gt;\.mjs, register it under dataPacks in \/_setup\/#packs, then restart\./);
  assert.match(html, /No data preset is available\./);
});

test('view modules export the D3 contract', () => {
  assert.deepEqual([services, flows, capabilities, packs].map(item => [item.id, item.label, item.icon, item.requires[0], item.hosts.join()]), [
    ['services', 'Providers & services', '⛁', '/__sim/api/dashboard', 'power-pages,standalone'],
    ['flows', 'Flows & jobs', '⟲', '/__sim/api/flow-runs', 'power-pages,standalone'],
    ['capabilities', 'Capabilities & preflight', '✓', '/__sim/api/dashboard', 'power-pages,standalone'],
    ['packs', 'Data packs', '▣', '/__sim/api/packs', 'power-pages,standalone'],
  ]);
});

test('services summaries say unavailable for failed reads and never claim "not configured" without the host saying so', async () => {
  const ctx = context({ responses: { '/dashboard': dashboard, '/messages': Object.assign(new Error('Bus offline'), { status: 503 }), '/outbox': {}, '/flow-waits': [], '/environment': {} } });
  await services.load(ctx);
  const html = services.render(ctx);
  assert.match(html, /<span class="ui-section-title">Messaging<\/span><span class="ui-section-summary">unavailable<\/span>/);
  assert.match(html, /The message bus could not be read: Bus offline \(HTTP 503\)/);
  assert.match(html, /<span class="ui-section-title">Outbox<\/span><span class="ui-section-summary">not reported<\/span>/);
  assert.match(html, /This host did not report its outbox\./);
  assert.match(html, /<select id="svc-outbox-channel" name="channel" aria-describedby="svc-outbox-channel-help">/);
});

test('module handlers answer true synchronously while their request runs', async () => {
  let release;
  const ctx = context({ state: capabilityState });
  ctx.request = () => new Promise(resolve => { release = resolve; });
  const pending = [];
  ctx.setButtonPending = (button, on, failed) => { pending.push([on, Boolean(failed)]); return true; };
  await capabilities.load(ctx);
  const form = { dataset: {}, querySelector: () => null };
  const event = { type: 'submit', preventDefault() {}, submitter: {}, target: { closest: selector => (selector === '[data-cap-preflight-form]' ? form : null) } };
  globalThis.FormData = class { constructor() { this.values = new Map([['requires', 'table:*']]); } get(name) { return this.values.get(name) ?? null; } };
  try { assert.equal(capabilities.handle(ctx, event), true); } finally { delete globalThis.FormData; }
  await new Promise(resolve => setTimeout(resolve));
  assert.deepEqual(pending, [[true, false]]);
  release({ summary: { total: 0 }, requirements: [] });
  await new Promise(resolve => setTimeout(resolve));
  assert.deepEqual(pending, [[true, false], [false, false]]);
  assert.deepEqual(ctx.data.capabilities.ran.requires, ['table:*']);
});
