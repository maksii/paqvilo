import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { assertNoElements } from './assert-markup.mjs';
import { HELP } from '../admin/help-content.mjs';
import { escapeHtml } from '../admin/ui-kit.mjs';
import { docsLinks } from '../lib/docs-links.mjs';
import { view as services } from '../admin/view-services.mjs';
import { view as flows } from '../admin/view-flows.mjs';
import { view as capabilities } from '../admin/view-capabilities.mjs';
import { view as packs } from '../admin/view-packs.mjs';
import {
  view as trace,
  filterQuery,
  hashOf,
  previousWindow,
  duration,
  localTime,
  utcOffset,
  actorText,
  sessionText,
  spanFilter,
  compareTrees,
  FILTERS,
  MODULES,
  LIVE_INTERVAL_MS,
} from '../admin/view-trace.mjs';
import { PRODUCT_OF } from '../admin/dashboard-map.mjs';
import { createTraceStore, SPAN_KINDS, SPAN_STATUSES } from '../lib/trace-store.mjs';
import { bar, tabs } from '../admin/ui-kit.mjs';
import fs from 'node:fs/promises';

const sample = JSON.parse(await fs.readFile(new URL('./fixtures/trace-sample.json', import.meta.url), 'utf8'));

const docs = docsLinks('0.9.4', 'https://git.example.test/invented/paqvilo');
const context = ({ responses = {}, state = {}, data = {}, caps = { powerPages: true } } = {}) => {
  const requested = [];
  return {
    requested,
    data,
    help: HELP,
    escape: escapeHtml,
    state: () => state,
    session: () => ({}),
    capabilities: () => caps,
    docs: () => docs,
    links: () => ({}),
    pager: () => ({ page: 1, size: 10, search: '' }),
    open: () => false,
    toggle() {},
    refresh: async () => {},
    notify() {},
    setButtonPending: () => true,
    askConfirmation() {},
    forgotten: [],
    forgetDraft(formId) {
      this.forgotten.push(formId);
    },
    async request(path) {
      requested.push(path);
      const answer = responses[path.split('?')[0]];
      if (answer instanceof Error) throw answer;
      return structuredClone(answer ?? {});
    },
  };
};
const openCount = (html) => (html.match(/<details[^>]*\sopen[\s>]/g) ?? []).length;
const safeMarkup = (html) => {
  assert.doesNotMatch(html, /\sstyle=/);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.doesNotMatch(html, /javascript:/i);
};
const assertTables = (html, keys) => {
  for (const key of keys) assert.match(html, new RegExp(`data-table="${key}"`), key);
};

const dashboard = {
  nodes: [
    {
      id: 'provider:storage',
      kind: 'provider',
      label: 'Storage',
      status: 'ready',
      detail: {
        providers: [
          {
            id: 'local',
            kind: 'local',
            level: 'behaviour',
            ready: true,
            routes: ['dataverseFiles', 'sharepointDocuments'],
          },
          { id: 'fx-blob', kind: 'azurite', level: 'contract', ready: false, routes: [] },
        ],
      },
    },
    {
      id: 'provider:storage-route:dataverseFiles',
      kind: 'provider',
      label: 'dataverseFiles',
      status: 'ready',
      detail: { provider: 'local' },
    },
    {
      id: 'provider:storage-route:sharepointDocuments',
      kind: 'provider',
      label: 'sharepointDocuments',
      status: 'ready',
      detail: { provider: 'local' },
    },
    {
      id: 'external:azurite',
      kind: 'external',
      label: 'Azurite',
      status: 'declared',
      detail: { providers: ['fx-blob'] },
    },
    {
      id: 'provider:messaging',
      kind: 'provider',
      label: 'Message bus',
      status: 'ready',
      level: 'behaviour',
      detail: { id: 'local', endpoints: 1 },
    },
    {
      id: 'provider:connectors',
      kind: 'provider',
      label: 'Connectors',
      status: 'ready',
      detail: {
        providers: [
          { id: 'memory-queue', level: 'behaviour', operations: 5 },
          { id: 'http', level: 'behaviour', operations: 1 },
        ],
      },
    },
    {
      id: 'connection:fx_files',
      kind: 'connection',
      label: 'fx_files',
      status: 'declared',
      detail: { provider: 'fixture', connector: 'shared_sharepointonline', principal: 'named' },
    },
    { id: 'provider:secrets', kind: 'provider', label: 'Secret references', status: 'ready', detail: { keys: 2 } },
    {
      id: 'provider:local-service:fx-functions',
      kind: 'provider',
      label: 'fx-functions',
      status: 'declared',
      level: 'contract',
      detail: { service: 'http', required: false },
    },
    {
      id: 'provider:service-fixture:powerbi',
      kind: 'provider',
      label: 'powerbi',
      status: 'disabled',
      detail: { operations: { inventory: 2 } },
    },
    {
      id: 'provider:powerfx',
      kind: 'provider',
      label: 'Power Fx',
      status: 'ready',
      level: 'contract',
      detail: { name: 'powerfx' },
    },
    { id: 'app:canvas', kind: 'app', label: 'Canvas apps', status: 'ready', detail: { apps: 1 } },
    { id: 'app:code', kind: 'app', label: 'Code apps', status: 'disabled', detail: { apps: 0 } },
    {
      id: 'org:jobs',
      kind: 'org',
      label: 'Background jobs',
      status: 'ready',
      detail: {
        scheduler: { manual: false, closed: false, executed: 4, faults: 0, failures: 0 },
        recentErrors: [{ kind: 'plugin', code: 'FX_FAILED' }],
      },
    },
    {
      id: 'org:plugins',
      kind: 'org',
      label: 'Plug-in steps',
      status: 'ready',
      detail: {
        webhooks: [
          { name: 'Invented hook', host: 'localhost', loopback: true },
          { name: 'Remote hook', host: 'hooks.example.test', loopback: false },
        ],
      },
    },
  ],
  activity: {
    messages: { active: 2, locked: 0, scheduled: 1, deadLettered: 0 },
    storage: { byProvider: [{ id: 'local', objects: 3, bytes: 120 }] },
    jobs: { pending: 1, scheduled: 0, running: 0, failures: 1, poisoned: 0 },
    asyncOperations: { byState: { Completed: 4 } },
    webhooks: { delivered: 2, failed: 0, notContacted: 1 },
  },
};
const servicesResponses = {
  '/dashboard': dashboard,
  '/messages': {
    configured: true,
    entities: [{ entity: 'fx-orders', stats: { active: 2, locked: 0, scheduled: 1, deadLettered: 0 } }],
    endpoints: { 'fx-endpoint': 'local/fx-orders' },
  },
  '/outbox': {
    configured: true,
    entries: [
      {
        id: 'o1',
        channel: 'email',
        to: ['someone@example.test'],
        subject: 'Invented subject',
        state: 'queued',
        createdOn: '2026-10-22T10:00:00Z',
        correlationId: 'c1',
      },
    ],
  },
  '/flow-waits': [
    {
      id: 'fx-approval',
      kind: 'approval',
      runId: 'run-1',
      processId: 'p1',
      timeoutAt: '2026-10-23T10:00:00Z',
      overdue: false,
    },
  ],
  '/environment': {
    environmentVariables: {
      available: true,
      definitions: [
        { id: 'd1', schemaName: 'fx_ApiSecret', secret: true, secretStatus: { bound: true, status: 'resolved' } },
        { id: 'd2', schemaName: 'fx_Plain', secret: false },
      ],
    },
  },
};

test('services view loads its routes and renders every panel collapsed except storage', async () => {
  const ctx = context({
    responses: servicesResponses,
    state: { inventory: { total: 2, components: { customcontrol: { count: 2, levels: { inventory: 2 } } } } },
  });
  await services.load(ctx);
  assert.deepEqual(ctx.requested.sort(), ['/dashboard', '/environment', '/flow-waits', '/messages', '/outbox']);
  const html = services.render(ctx);
  safeMarkup(html);
  assert.equal(openCount(html), 1);
  assert.match(html, /data-ui-section="services:storage" open/);
  assertTables(html, [
    'svc-storage-providers',
    'svc-storage-routes',
    'svc-endpoints',
    'svc-entities',
    'svc-outbox',
    'svc-connector-providers',
    'svc-connections',
    'svc-approvals',
    'svc-secrets',
    'svc-local-services',
    'svc-fixtures',
  ]);
  for (const id of [
    'storage',
    'messaging',
    'outbox',
    'connectors',
    'secrets',
    'local-services',
    'service-fixtures',
    'powerfx',
    'apps',
    'sharepoint',
  ])
    assert.match(html, new RegExp(`id="help-services-${id}"`), id);
  assert.match(html, /data-svc-purge="fx-orders"/);
  assert.match(html, /data-svc-probe="fx-functions"/);
  assert.match(html, /memory-queue sends through the local message bus: 2 active/);
  assert.match(html, /fx_ApiSecret/);
  assert.doesNotMatch(html, /fx_Plain/);
  assert.match(html, /PCF controls \(Solution inventory\)<\/dt><dd>2/);
  // The heading is the sidebar label and takes focus on landing; the eyebrow names the sidebar group the host passes.
  assert.match(html, /<h1 id="view-title" tabindex="-1">Providers &amp; services<\/h1>/);
  assert.match(services.render({ ...ctx, group: () => 'Platform' }), /<span class="eyebrow">PLATFORM<\/span>/);
});

test('services view states honest empty and unconfigured states', async () => {
  const ctx = context({
    responses: {
      '/dashboard': { nodes: [], activity: {} },
      '/messages': { configured: false, entities: [], endpoints: {} },
      '/outbox': { configured: false, entries: [] },
      '/flow-waits': new Error('This runtime has no flow run store.'),
      '/environment': new Error('Not found'),
    },
  });
  await services.load(ctx);
  const html = services.render(ctx);
  safeMarkup(html);
  assert.equal(openCount(html), 1);
  assert.match(html, /No message bus is configured\. Declare one under providers\.messaging in \/_setup\/\./);
  // Panel help: one plain lead sentence; the rest and the doc link sit behind an (i) tooltip named after the panel.
  assert.match(
    html,
    /id="help-services-messaging">The local message bus: [^<]*?\.<span class="ui-info"><button type="button" class="ui-info-button" aria-label="About Messaging" aria-describedby="help-services-messaging-more">i<\/button><span class="ui-info-pop" role="tooltip" id="help-services-messaging-more"><span class="ui-info-text">Service endpoints[^<]*<\/span><span class="ui-info-docs"><a class="ui-doc" href="https:\/\/git\.example\.test\/invented\/paqvilo\/blob\/v0\.9\.4\/mirage\/docs\/messaging-and-outbox\.md#local-message-bus"/,
  );
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
  try {
    assert.match(services.render(ctx), /data-ui-section="services:outbox" open/);
  } finally {
    delete globalThis.location;
  }
});

const runs = [
  { id: 'run-1', processId: 'p1', status: 'Waiting', starttime: '2026-10-22T09:00:00Z', triggertype: 'automated' },
  { id: 'run-2', processId: 'p1', status: 'Succeeded', starttime: '2026-10-22T08:00:00Z' },
];
test('flows view renders runs, waits, background work and webhooks; the run deep link loads a journal', async () => {
  globalThis.location = { hash: '#flows?run=run-2' };
  const ctx = context({
    responses: {
      '/flow-runs': runs,
      '/flow-waits': [{ id: 'fx-approval', kind: 'approval', runId: 'run-1', overdue: true }],
      '/dashboard': dashboard,
      '/flow-runs/run-2': {
        ...runs[1],
        journal: { Send_email: { status: 'Succeeded', outputs: { statusCode: 200 } } },
      },
    },
  });
  try {
    await flows.load(ctx);
  } finally {
    delete globalThis.location;
  }
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
  const ctx = context({
    responses: { '/flow-runs': missing, '/flow-waits': missing, '/dashboard': { nodes: [], activity: {} } },
  });
  await flows.load(ctx);
  const html = flows.render(ctx);
  safeMarkup(html);
  assert.equal(openCount(html), 1);
  assert.match(html, /Flow runs could not be read: This runtime has no flow run store\. \(HTTP 404\)/);
  assert.match(
    html,
    /data-ui-section="flows:waits"><summary><span class="ui-section-title">Waits &amp; approvals<\/span><span class="ui-section-summary">unavailable/,
  );
  assert.match(html, /No webhook \(contract 8\) service endpoint is registered\./);
  assert.match(html, /This runtime reports no scheduler status\./);
});

const capabilityState = {
  capabilityReport: {
    modules: [
      {
        name: 'fx-module',
        kind: 'organization-module',
        level: 'behaviour',
        operations: [{ name: 'run' }],
        stateOwner: 'fx',
      },
      { name: 'fx-placeholder', kind: 'operation', level: 'inventory', operations: [] },
    ],
    missing: [{ module: 'fx-module', requires: 'fx-dependency' }],
    unsupported: [{ id: 'fx-placeholder', level: 'inventory', reason: 'Placeholder' }],
  },
  inventory: {
    total: 3,
    components: { canvasapp: { count: 1, levels: { inventory: 1 } }, table: { count: 2, levels: { behaviour: 2 } } },
  },
  status: { scenarios: [{ id: 'fx-scenario', name: 'Invented scenario' }] },
};
test('capabilities view renders report, missing, unsupported, inventory and scenario preflight buttons', async () => {
  const ctx = context({ state: capabilityState });
  await capabilities.load(ctx);
  ctx.data.capabilities.result = {
    summary: { total: 2, satisfied: 1, missing: 1, blocking: 1 },
    requirements: [
      { id: 'table:x_item', kind: 'table', status: 'satisfied', inScope: true, blocking: false },
      {
        id: 'local-service:fx',
        kind: 'local-service',
        status: 'missing',
        inScope: true,
        blocking: true,
        message: 'unreachable',
      },
    ],
  };
  ctx.data.capabilities.ran = { requires: ['table:*'], strict: true };
  const html = capabilities.render(ctx);
  safeMarkup(html);
  assertTables(html, [
    'cap-modules',
    'cap-missing',
    'cap-unsupported',
    'cap-inventory',
    'cap-result-missing',
    'cap-result-satisfied',
    'cap-scenarios',
  ]);
  assert.match(html, /<select id="cap-level" data-cap-level aria-describedby="cap-level-help">/);
  assert.match(html, /<small class="ui-field-help" id="cap-level-help">Only records at this level/);
  // Columns whose values are jargon explain them behind an (i) in the header; Source inventory has its own help.
  assert.match(
    html,
    /<th scope="col">Level<span class="ui-info"><button type="button" class="ui-info-button" aria-label="About Level">i<\/button><span class="ui-info-pop" role="tooltip"><span class="ui-info-text">inventory: listed from source only\./,
  );
  assert.match(html, /id="help-capabilities-inventory">Solution components Paqvilo reads but does not host/);
  for (const id of ['report', 'missing', 'unsupported', 'preflight'])
    assert.match(html, new RegExp(`id="help-capabilities-${id}"`));
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
  assert.doesNotMatch(
    capabilities.render(context({ state: capabilityState, caps: { powerPages: false } })),
    /data-cap-scenario/,
  );
});

const packsPayload = {
  packs: [
    {
      id: 'fx-pack',
      name: '<script>alert(1)</script>',
      description: 'Invented',
      module: 'pack/fx-pack.mjs',
      registration: { source: 'project', setupLink: '/_setup/#packs' },
      matched: false,
      matchReason: 'matches({ portal }) did not return true',
      exports: { serverLogics: 2, cloudFlows: 1 },
      presets: [{ id: 'fx-empty', name: 'Empty' }],
      configurationPresets: 0,
      personas: 1,
      personaCatalog: { groups: 1, personas: 2, contexts: 0, scenarios: 1 },
      dataFiles: [{ file: 'data/fx.json', tables: ['x_item'], writable: true }],
      diagnostics: [{ code: 'PACK_EXPORT_UNKNOWN', severity: 'warning', message: 'Unknown export fxTypo' }],
    },
  ],
  failed: [],
  library: [
    { id: 'fx-empty', name: 'Empty', pack: 'fx-pack', source: 'builtin' },
    { id: 'saved', name: 'Saved', pack: null, source: 'stored' },
  ],
  setupLink: '/_setup/#packs',
};
test('packs view escapes names, shows matched status, provenance columns and expands details on request', async () => {
  const ctx = context({ responses: { '/packs': packsPayload } });
  await packs.load(ctx);
  let html = packs.render(ctx);
  safeMarkup(html);
  assert.equal(openCount(html), 1);
  assertNoElements(html, ['script']);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assertTables(html, ['packs-registered', 'packs-library']);
  assert.match(html, /<th scope="col">Pack<\/th><th scope="col">Source<span class="ui-info">/);
  assert.match(html, /not matched/);
  assert.match(html, /<span class="ui-section-title">Add or change a pack<\/span>/);
  assert.match(html, /href="\/_setup\/#packs">Project setup: Data packs →/);
  for (const id of ['registered', 'presets', 'lifecycle']) assert.match(html, new RegExp(`id="help-packs-${id}"`));
  const button = { dataset: { packDetails: 'fx-pack' } };
  const revealed = [];
  assert.equal(
    packs.handle(
      { ...ctx, reveal: (selector) => revealed.push(selector) },
      { type: 'click', target: { closest: (selector) => (selector === '[data-pack-details]' ? button : null) } },
    ),
    true,
  );
  // The details open below the table, so the app scrolls to them.
  assert.deepEqual(revealed, ['[data-ui-section="packs:detail:fx-pack"]']);
  html = packs.render(ctx);
  assertTables(html, [
    'packs-fx-pack-exports',
    'packs-fx-pack-presets',
    'packs-fx-pack-data',
    'packs-fx-pack-diagnostics',
  ]);
  assert.match(html, /PACK_EXPORT_UNKNOWN/);
});

test('packs view states that no pack is registered', async () => {
  const ctx = context({ responses: { '/packs': { packs: [], failed: [], library: [], setupLink: '/_setup/#packs' } } });
  await packs.load(ctx);
  const html = packs.render(ctx);
  safeMarkup(html);
  assert.match(
    html,
    /No data pack is registered\. Write pack\/&lt;id&gt;\.mjs, register it under dataPacks in \/_setup\/#packs, then restart\./,
  );
  assert.match(html, /No data preset is available\./);
});

test('view modules declare their id, label, icon, required route and hosts', () => {
  assert.deepEqual(
    [services, flows, capabilities, packs, trace].map((item) => [
      item.id,
      item.label,
      item.icon,
      item.requires[0],
      item.hosts.join(),
    ]),
    [
      ['services', 'Providers & services', '⛁', '/__sim/api/dashboard', 'power-pages,standalone'],
      ['flows', 'Flows & jobs', '⟲', '/__sim/api/flow-runs', 'power-pages,standalone'],
      ['capabilities', 'Capabilities & preflight', '✓', '/__sim/api/dashboard', 'power-pages,standalone'],
      ['packs', 'Data packs', '▣', '/__sim/api/packs', 'power-pages,standalone'],
      ['trace', 'Traces', '⋔', '/__sim/api/trace', 'power-pages,standalone'],
    ],
  );
});

test('services summaries say unavailable for failed reads and never claim "not configured" without the host saying so', async () => {
  const ctx = context({
    responses: {
      '/dashboard': dashboard,
      '/messages': Object.assign(new Error('Bus offline'), { status: 503 }),
      '/outbox': {},
      '/flow-waits': [],
      '/environment': {},
    },
  });
  await services.load(ctx);
  const html = services.render(ctx);
  assert.match(
    html,
    /<span class="ui-section-title">Messaging<\/span><span class="ui-section-summary">unavailable<\/span>/,
  );
  assert.match(html, /The message bus could not be read: Bus offline \(HTTP 503\)/);
  assert.match(
    html,
    /<span class="ui-section-title">Outbox<\/span><span class="ui-section-summary">not reported<\/span>/,
  );
  assert.match(html, /This host did not report its outbox\./);
  assert.match(html, /<select id="svc-outbox-channel" name="channel" aria-describedby="svc-outbox-channel-help">/);
});

test('module handlers answer true synchronously while their request runs', async () => {
  let release;
  const ctx = context({ state: capabilityState });
  ctx.request = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = [];
  ctx.setButtonPending = (button, on, failed) => {
    pending.push([on, Boolean(failed)]);
    return true;
  };
  await capabilities.load(ctx);
  const form = { dataset: {}, querySelector: () => null };
  const event = {
    type: 'submit',
    preventDefault() {},
    submitter: {},
    target: { closest: (selector) => (selector === '[data-cap-preflight-form]' ? form : null) },
  };
  globalThis.FormData = class {
    constructor() {
      this.values = new Map([['requires', 'table:*']]);
    }
    get(name) {
      return this.values.get(name) ?? null;
    }
  };
  try {
    assert.equal(capabilities.handle(ctx, event), true);
  } finally {
    delete globalThis.FormData;
  }
  await new Promise((resolve) => setTimeout(resolve));
  assert.deepEqual(pending, [[true, false]]);
  release({ summary: { total: 0 }, requirements: [] });
  await new Promise((resolve) => setTimeout(resolve));
  assert.deepEqual(pending, [
    [true, false],
    [false, false],
  ]);
  assert.deepEqual(ctx.data.capabilities.ran.requires, ['table:*']);
});

// ---- Traces (`#trace`): the fixture is a real trace-store answer (query, stats with overall and roots, settings, tree).
const traceResponses = (overrides = {}) => ({
  '/trace': sample.query,
  '/trace/stats': sample.stats,
  '/trace/settings': sample.settings,
  [`/trace/id/${sample.tree.trace.traceId}`]: sample.tree,
  ...overrides,
});
/** The shared fake context with a pager per key. */
const traceContext = (options = {}) => {
  const ctx = context(options);
  const pagers = new Map();
  ctx.pager = (key) => {
    if (!pagers.has(key)) pagers.set(key, { page: 1, size: 10, search: '' });
    return pagers.get(key);
  };
  return ctx;
};
const stepSpan = sample.tree.spans.find((span) => span.kind === 'plugin-step');
const jobSpan = sample.tree.spans.find((span) => span.kind === 'job');
const rootSpan = sample.tree.spans.find((span) => span.kind === 'http');
const traceId = sample.tree.trace.traceId;
/** A delegated event whose target answers `closest(selector)` from `found`. */
const uiEvent = (type, found, extra = {}) => ({
  type,
  preventDefault() {},
  ...extra,
  target: { closest: (selector) => found[selector] ?? null },
});
class FakeFormData {
  constructor(form) {
    this.fields = Object.entries(form.values ?? {});
  }
  get(name) {
    return this.fields.find(([key]) => key === name)?.[1] ?? null;
  }
  [Symbol.iterator]() {
    return this.fields[Symbol.iterator]();
  }
}
const count = (html, pattern) => (html.match(pattern) ?? []).length;
// The values a rendered <select id> offers after its empty "Any ..." option, in order.
const selectOptions = (html, id) =>
  [...new RegExp(`<select id="${id}"[^>]*>(.*?)</select>`).exec(html)[1].matchAll(/<option value="([^"]+)"/g)].map(
    ([, value]) => value,
  );

test('kit bar and tabs carry geometry and state as attributes only', () => {
  const html = bar({ offset: 0.25, width: 0.5, className: 'ui-series-1 is-async', marks: [0.3], label: 'a <b>' });
  assert.match(html, /<rect class="ui-bar-fill ui-series-1 is-async" x="250" y="1" width="500" height="10">/);
  assert.match(html, /<rect class="ui-bar-mark" x="300"/);
  assert.match(html, /aria-label="a &lt;b&gt;"/);
  // A bar past the end is clamped into the track, and a zero-length one stays visible.
  assert.match(bar({ offset: 1.2, width: 0 }), /x="997" y="1" width="3"/);
  safeMarkup(html);
  const tabbed = tabs({
    key: 'fx',
    label: 'Fx',
    items: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
    selected: 'b',
    panelHtml: '<p>B</p>',
  });
  assert.match(tabbed, /role="tablist" aria-label="Fx"/);
  assert.match(tabbed, /id="fx-tab-a" aria-selected="false" aria-controls="fx-panel" tabindex="-1"/);
  assert.match(tabbed, /id="fx-tab-b" aria-selected="true" aria-controls="fx-panel" tabindex="0"/);
  assert.match(tabbed, /role="tabpanel" id="fx-panel" aria-labelledby="fx-tab-b"><p>B<\/p>/);
});

test('trace view states an empty store and a host without traces honestly', async () => {
  const empty = {
    items: [],
    total: 0,
    page: 1,
    pageSize: 10,
    pageCount: 1,
    retained: 0,
    dropped: 0,
    latestSequence: 0,
  };
  const noSpans = { count: 0, from: null, to: null, bucketMs: null, byKind: {}, byStatus: {}, timeline: [] };
  const ctx = traceContext({ responses: traceResponses({ '/trace': empty, '/trace/stats': noSpans }) });
  await trace.load(ctx);
  let html = trace.render(ctx);
  safeMarkup(html);
  assert.match(html, /<h1 id="view-title" tabindex="-1">Traces<\/h1>/);
  assert.match(html, /No trace matches\. Traces appear as this runtime answers requests and runs jobs\./);
  assert.match(html, /No span matches, so there is no timeline\./);
  assert.doesNotMatch(html, /data-ui-section="trace:detail"/);
  for (const id of ['filters', 'overview', 'list', 'settings']) assert.match(html, new RegExp(`id="help-trace-${id}"`));
  assert.match(html, /data-ui-section="trace:settings">/, 'settings start collapsed');
  // Empty stats: no percentile is invented.
  assert.match(html, /Root p50 \/ p95<\/span><strong class="ui-tile-value">—<\/strong><span class="ui-tile-detail">—</);
  // Live is offered on both hosts: each serves /_sim/events?channels=trace.
  assert.match(html, /data-trace-action="live" aria-pressed="false"/);
  assert.match(
    trace.render({ ...ctx, capabilities: () => ({ powerPages: false }) }),
    /data-trace-action="live" aria-pressed="false"/,
  );

  const missing = Object.assign(new Error('Not found'), { status: 404 });
  const bare = traceContext({ responses: { '/trace': missing, '/trace/stats': missing, '/trace/settings': missing } });
  await trace.load(bare);
  html = trace.render(bare);
  safeMarkup(html);
  assert.match(html, /Traces could not be read: Not found \(HTTP 404\)/);
  assert.match(html, /Trace statistics could not be read: Not found \(HTTP 404\)/);
  assert.match(html, /Trace settings could not be read: Not found \(HTTP 404\)/);
  assert.match(
    html,
    /<span class="ui-section-title">Traces<\/span><span class="ui-section-summary">unavailable<\/span>/,
  );
});

test('trace view renders KPIs, timeline, list, waterfall, tree and the drawer of a deep-linked span', async () => {
  const ctx = traceContext({ responses: traceResponses() });
  trace.route(ctx, new URLSearchParams({ traceId, spanId: stepSpan.spanId }));
  await trace.load(ctx);
  assert.ok(ctx.requested.includes(`/trace/id/${traceId}`));
  assert.ok(ctx.requested.includes('/trace/settings'));
  assert.ok(ctx.requested.includes('/trace?page=1&pageSize=10'));
  // One stats read: `overall` and `roots` replace a second depth=0 read.
  assert.deepEqual(
    ctx.requested.filter((path) => path.startsWith('/trace/stats')),
    ['/trace/stats'],
  );
  let html = trace.render(ctx);
  safeMarkup(html);
  assertNoElements(html, ['script', 'iframe']);
  assertTables(html, ['trace-list', 'trace-breakdown', 'trace-events']);
  // KPI tiles from /trace/stats: span figures from `overall`, root percentiles from `roots`, kinds from byKind.
  assert.match(html, /Plug-in steps run<\/span><strong class="ui-tile-value">1</);
  assert.match(
    html,
    /Root p50 \/ p95<\/span><strong class="ui-tile-value">3\.00 ms \/ 21\.0 ms<\/strong><span class="ui-tile-detail">max 21\.0 ms</,
  );
  assert.match(
    html,
    /Spans<\/span><strong class="ui-tile-value">9<\/strong><span class="ui-tile-detail">p50 \/ p95 10\.0 ms \/ 21\.0 ms</,
  );
  assert.match(html, /Errors<\/span><strong class="ui-tile-value">1</);
  assert.doesNotMatch(html, /roots of several kinds/);
  // Counts read as words: one error, not "1 errors".
  assert.match(html, /<span class="ui-badge[^"]*">1 error<\/span>/);
  assert.doesNotMatch(html, /1 errors|1 spans/);
  // The timeline: one focusable bucket per stats bucket, geometry as SVG attributes.
  assert.equal(count(html, /data-trace-bucket="/g), sample.stats.timeline.length);
  assert.match(html, /<rect class="ui-histogram-errors" x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+">/);
  // The list: one row per trace, opening on click, span counts by kind in one compact line; the open trace is marked.
  assert.equal(count(html, /<tr data-trace-open="/g), sample.query.items.length);
  assert.match(html, /plugin-step 1/);
  assert.match(html, new RegExp(`<tr data-trace-open="${traceId}" class="is-selected">`));
  // Waterfall: one row per span, indented by depth, coloured by module, async and errors marked, events as ticks.
  assert.equal(count(html, /<li class="ui-waterfall-row/g), sample.tree.spans.length);
  assert.match(html, /ui-waterfall-row ui-depth-4 is-selected/);
  assert.match(html, new RegExp(`<rect class="ui-bar-fill ui-series-${MODULES.indexOf('jobs')} is-error is-async"`));
  assert.match(html, /class="ui-bar-mark"/);
  // The drawer: facts, attributes, events, captured payloads, pivots.
  assert.match(html, /<h3 id="trace-span-title">Invented\.Plugin\.PreCreate<\/h3>/);
  assert.match(html, /Validating the invented item/);
  assert.match(html, /<summary>Input<\/summary><pre class="ui-example">\{\n {2}&quot;Target&quot;/);
  assert.match(html, /href="#trace\?sessionKey=contact%3Ac0ffee00[^"]*">Same session/);
  assert.match(html, /href="#trace\?actorKind=plugin&amp;actorId=step-1">Same actor/);
  assert.match(html, /href="#trace\?entity=x_item">Same table/);
  assert.match(html, new RegExp(`href="#trace\\?traceId=${traceId}&amp;spanId=${rootSpan.spanId}">Parent request`));
  assert.match(html, new RegExp(`data-trace-children="${stepSpan.spanId}"`));

  // The tree tab: nested details (native keyboard expand and collapse), one per span with children.
  const treeTab = { '[role="tab"][data-tab]': { dataset: { tab: 'trace-detail', tabId: 'tree' } } };
  assert.equal(trace.handle(ctx, uiEvent('click', treeTab)), true);
  html = trace.render(ctx);
  safeMarkup(html);
  assert.match(html, /<ul class="ui-tree" aria-label="Span tree">/);
  assert.equal(count(html, /<details open data-ui-section="trace:node:/g), 5);
  assert.match(html, /id="trace-detail-tab-tree" aria-selected="true"/);
  // The tree has its own help, and counts read as words ("1 event").
  assert.match(html, /id="help-trace-tree">Every span nested under its parent/);
  assert.doesNotMatch(html, /Bars start where the span started/);
  assert.match(html, /· 1 event</);
  assert.doesNotMatch(html, /1 events/);
  // Arrow keys move between tabs: Tree → JSON → Waterfall.
  trace.handle(ctx, uiEvent('keydown', treeTab, { key: 'ArrowRight' }));
  assert.equal(ctx.data.trace.tab, 'json');
  trace.handle(
    ctx,
    uiEvent(
      'keydown',
      { '[role="tab"][data-tab]': { dataset: { tab: 'trace-detail', tabId: 'json' } } },
      { key: 'ArrowRight' },
    ),
  );
  assert.equal(ctx.data.trace.tab, 'waterfall');

  // Child traces: the spans under this span in other traces.
  ctx.request = async (path) => {
    ctx.requested.push(path);
    return { items: [{ traceId }, { traceId: 'fx-child' }] };
  };
  trace.handle(ctx, uiEvent('click', { '[data-trace-children]': { dataset: { traceChildren: stepSpan.spanId } } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(ctx.requested.includes(`/trace/spans?parentSpanId=${stepSpan.spanId}&pageSize=200`));
  assert.match(trace.render(ctx), /<a href="#trace\?traceId=fx-child">Trace <code>fx-child<\/code><\/a>/);

  // A span recorded at summary says so (its own level, not the runtime's); a staged job links to its staging span.
  ctx.data.trace.spanId = jobSpan.spanId;
  html = trace.render(ctx);
  assert.match(
    html,
    /Input: not captured: this span was recorded at level summary, which keeps attributes and events only\./,
  );
  assert.match(html, /staged-by: <a href="#trace\?traceId=/);
  assert.match(html, /FX_FAILED: Invented failure/);
});

test('trace view keeps root percentiles under a span filter that matches no root', async () => {
  const filtered = {
    ...structuredClone(sample.stats),
    count: 1,
    overall: { count: 1, errors: 0, p50: 3, p95: 3, max: 3 },
    roots: { count: 1, errors: 0, p50: 21, p95: 21, max: 21 },
    byKind: { 'sdk-call': { count: 1, errors: 0, p50: 3, p95: 3, max: 3 } },
  };
  const ctx = traceContext({ responses: traceResponses({ '/trace/stats': filtered }) });
  trace.route(ctx, new URLSearchParams({ entity: 'x_category' }));
  await trace.load(ctx);
  assert.ok(ctx.requested.includes('/trace/stats?entity=x_category'));
  const html = trace.render(ctx);
  assert.match(html, /Root p50 \/ p95<\/span><strong class="ui-tile-value">21\.0 ms \/ 21\.0 ms</);
  assert.match(
    html,
    /Spans<\/span><strong class="ui-tile-value">1<\/strong><span class="ui-tile-detail">p50 \/ p95 3\.00 ms \/ 3\.00 ms</,
  );
});

test('trace Live follows the trace channel and turns off with a notice when a host refuses it', async () => {
  const saved = { EventSource: globalThis.EventSource, fetch: globalThis.fetch };
  const sources = [];
  class FakeEventSource {
    static CLOSED = 2;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = {};
      sources.push(this);
    }
    addEventListener(type, listener) {
      (this.listeners[type] ??= []).push(listener);
    }
    emit(type, data) {
      for (const listener of this.listeners[type] ?? []) listener({ data });
    }
    close() {
      this.readyState = FakeEventSource.CLOSED;
    }
  }
  const fetched = [];
  globalThis.EventSource = FakeEventSource;
  globalThis.fetch = async (url) => {
    fetched.push(url);
    return { status: 404, body: { cancel: async () => {} } };
  };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const ctx = traceContext({ responses: traceResponses() });
    await trace.load(ctx);
    const live = { '[data-trace-action]': { dataset: { traceAction: 'live' } } };
    assert.equal(trace.handle(ctx, uiEvent('click', live)), true);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].url, '/__sim/events?channels=trace');
    sources[0].emit('open');
    assert.match(
      trace.render(ctx),
      /aria-pressed="true">Live: on<\/button><span class="ui-help" role="status">Streaming</,
    );
    // Ended traces reload the list and stats once per interval (trailing), never the settings or a tree.
    ctx.requested.length = 0;
    sources[0].emit('trace', JSON.stringify({ type: 'trace-end' }));
    sources[0].emit('trace', JSON.stringify({ type: 'trace-end' }));
    assert.deepEqual(ctx.requested, [], 'nothing is fetched before the interval ends');
    mock.timers.tick(LIVE_INTERVAL_MS);
    await ctx.data.trace.reloading;
    assert.deepEqual(ctx.requested, ['/trace?page=1&pageSize=10', '/trace/stats']);
    // A refused stream (an HTTP error answer) closes for good: Live turns off and says why.
    sources[0].readyState = FakeEventSource.CLOSED;
    sources[0].emit('error');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fetched, ['/__sim/events?channels=trace']);
    const html = trace.render(ctx);
    safeMarkup(html);
    assert.match(html, /aria-pressed="false">Live: off/);
    assert.match(html, /This host does not serve the live trace stream \(\/_sim\/events\?channels=trace\)\./);
    // Selecting Live again retries and clears the notice.
    trace.handle(ctx, uiEvent('click', live));
    assert.equal(sources.length, 2);
    assert.doesNotMatch(trace.render(ctx), /does not serve the live trace stream/);
    trace.leave(ctx);
    assert.equal(sources[1].readyState, FakeEventSource.CLOSED);
  } finally {
    mock.timers.reset();
    Object.assign(globalThis, saved);
  }
});

test('trace view escapes span text everywhere', async () => {
  const tree = structuredClone(sample.tree);
  const hostile = '<img src=x onerror=alert(1)>"\'';
  for (const span of tree.spans) span.name = hostile;
  const rename = (nodes) =>
    nodes.forEach((node) => {
      node.name = hostile;
      rename(node.children);
    });
  rename(tree.children);
  const query = structuredClone(sample.query);
  for (const item of query.items) item.root.name = hostile;
  const ctx = traceContext({ responses: traceResponses({ '/trace': query, [`/trace/id/${traceId}`]: tree }) });
  trace.route(ctx, new URLSearchParams({ traceId, spanId: tree.spans[1].spanId }));
  await trace.load(ctx);
  for (const tab of ['waterfall', 'tree']) {
    ctx.data.trace.tab = tab;
    const html = trace.render(ctx);
    // The escaped text still reads onerror=, so the check is on parsed elements, not on the text.
    assertNoElements(html, ['img', 'script']);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;/);
  }
});

test('trace deep links set filters, range and the open trace; filterQuery and hashOf agree', () => {
  const ctx = traceContext();
  trace.route(ctx, new URLSearchParams({ kind: 'plugin-step', entity: 'x_item', range: '15m', hasErrors: 'true' }));
  const d = ctx.data.trace;
  assert.equal(d.filters.kind, 'plugin-step');
  assert.equal(d.filters.module, '');
  assert.equal(d.range, '15m');
  assert.equal(d.traceId, null);
  const query = filterQuery(d, Date.parse('2026-10-22T10:00:00Z'));
  assert.equal(query.get('from'), '2026-10-22T09:45:00.000Z');
  assert.equal(query.get('kind'), 'plugin-step');
  assert.equal(query.get('hasErrors'), 'true');
  assert.equal(hashOf(d), 'trace?kind=plugin-step&entity=x_item&hasErrors=true&range=15m');
  // A link that names only a trace and span keeps the filters (audit, flow and waterfall links).
  trace.route(ctx, new URLSearchParams({ traceId: 'fx-trace', spanId: 'fx-span' }));
  assert.deepEqual([d.filters.kind, d.traceId, d.spanId], ['plugin-step', 'fx-trace', 'fx-span']);
  // A pivot link replaces every filter and closes the trace; an explicit from makes the range custom.
  trace.route(ctx, new URLSearchParams({ sessionKey: 'visitor-1', from: '2026-10-22T09:00:00.000Z' }));
  assert.deepEqual(
    FILTERS.filter((name) => d.filters[name]),
    ['from', 'sessionKey'],
  );
  assert.equal(d.range, 'custom');
  assert.equal(d.traceId, null);
  assert.equal(filterQuery(d).get('from'), '2026-10-22T09:00:00.000Z');
  // `#trace?panel=…` changes nothing; `#trace` alone is the default view its address shows (DV-C-12).
  trace.route(ctx, new URLSearchParams({ traceId: 'fx-trace', spanId: 'fx-span' }));
  trace.route(ctx, new URLSearchParams({ panel: 'settings' }));
  assert.equal(d.filters.sessionKey, 'visitor-1');
  assert.equal(d.traceId, 'fx-trace');
  d.sort = { by: 'duration', order: 'asc' };
  trace.route(ctx, new URLSearchParams());
  assert.deepEqual(
    FILTERS.filter((name) => d.filters[name]),
    [],
  );
  assert.deepEqual(
    [d.range, d.sort.by, d.sort.order, d.traceId, d.spanId, d.compare],
    ['all', 'start', 'desc', null, null, null],
  );
  assert.equal(hashOf(d), 'trace');
});

test('trace filters, pivots, buckets, paging and rows update ctx.data and the address, then load', async () => {
  const ctx = traceContext({ responses: traceResponses() });
  await trace.load(ctx);
  const hashes = [];
  globalThis.history = { replaceState: (state, title, url) => hashes.push(url) };
  globalThis.FormData = FakeFormData;
  const settle = () => ctx.data.trace.reloading;
  try {
    const form = { values: { range: 'all', kind: 'plugin-step', entity: ' x_item ', from: '', hasErrors: 'true' } };
    ctx.requested.length = 0;
    assert.equal(trace.handle(ctx, uiEvent('submit', { '[data-trace-filters]': form })), true);
    await settle();
    assert.equal(ctx.data.trace.filters.entity, 'x_item');
    assert.deepEqual(hashes, ['#trace?kind=plugin-step&entity=x_item&hasErrors=true']);
    assert.ok(ctx.requested.includes('/trace?kind=plugin-step&entity=x_item&hasErrors=true&page=1&pageSize=10'));
    assert.ok(ctx.requested.includes('/trace/stats?kind=plugin-step&entity=x_item&hasErrors=true'));

    // Breakdown Filter adds that key; an actor key splits into kind and id.
    trace.handle(
      ctx,
      uiEvent('click', { '[data-trace-pivot]': { dataset: { tracePivot: 'actor', value: 'contact:c0ffee00' } } }),
    );
    await settle();
    assert.deepEqual([ctx.data.trace.filters.actorKind, ctx.data.trace.filters.actorId], ['contact', 'c0ffee00']);

    // A timeline bucket narrows the time range to that bucket (Enter on the focused bucket).
    const bucket = sample.stats.timeline[0].bucketStart;
    trace.handle(
      ctx,
      uiEvent('keydown', { '[data-trace-bucket]': { dataset: { traceBucket: bucket } } }, { key: 'Enter' }),
    );
    await settle();
    assert.equal(ctx.data.trace.filters.from, bucket);
    assert.equal(ctx.data.trace.filters.to, new Date(Date.parse(bucket) + sample.stats.bucketMs - 1).toISOString());
    assert.equal(ctx.data.trace.range, 'custom');
    // Submitting the form unchanged keeps the exact bucket times the inputs show to the second.
    ctx.data.trace.filters.from = '2026-10-22T09:00:00.005Z';
    const shown = trace.render(ctx).match(/id="trace-from" name="from" type="datetime-local" value="([^"]+)"/)[1];
    trace.handle(ctx, uiEvent('submit', { '[data-trace-filters]': { values: { range: 'custom', from: shown } } }));
    await settle();
    assert.equal(ctx.data.trace.filters.from, '2026-10-22T09:00:00.005Z');

    // Reset clears every filter; Next page asks the store for page 2.
    trace.handle(ctx, uiEvent('click', { '[data-trace-action]': { dataset: { traceAction: 'reset' } } }));
    await settle();
    assert.equal(hashes.at(-1), '#trace');
    ctx.requested.length = 0;
    trace.handle(ctx, uiEvent('click', { '[data-table-page="trace-list"]': { dataset: { delta: '1' } } }));
    await settle();
    assert.ok(ctx.requested.includes('/trace?page=2&pageSize=10'), ctx.requested.join());

    // A row opens its trace; the tree loads and the detail panel opens.
    ctx.requested.length = 0;
    trace.handle(ctx, uiEvent('click', { '[data-trace-open]': { dataset: { traceOpen: traceId } } }));
    await settle();
    assert.ok(ctx.requested.includes(`/trace/id/${traceId}`));
    assert.equal(hashes.at(-1), `#trace?traceId=${traceId}`);
    assert.match(trace.render(ctx), /data-ui-section="trace:detail" open/);
    // Selecting a span puts it in the address.
    trace.handle(ctx, uiEvent('click', { '[data-trace-span]': { dataset: { traceSpan: stepSpan.spanId } } }));
    assert.equal(hashes.at(-1), `#trace?traceId=${traceId}&spanId=${stepSpan.spanId}`);
  } finally {
    delete globalThis.history;
    delete globalThis.FormData;
  }
});

test('trace settings save with PUT { level, persist }; clear asks first, then posts', async () => {
  const ctx = traceContext({ responses: traceResponses() });
  await trace.load(ctx);
  const writes = [];
  const read = ctx.request;
  const off = { ...sample.settings, settings: { ...sample.settings.settings, level: 'off' } };
  ctx.request = (path, init) => {
    if (!init?.method) return read(path, init);
    writes.push([init.method, path, init.body]);
    return Promise.resolve(path === '/trace/settings' ? structuredClone(off) : {});
  };
  const notes = [];
  ctx.notify = (text) => notes.push(text);
  const pendingStates = [];
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  ctx.setButtonPending = (button, on) => {
    pendingStates.push(on);
    if (!on) finished();
    return true;
  };
  let confirmed;
  ctx.askConfirmation = (title, message, action, label) => {
    confirmed = { title, label, action };
  };
  globalThis.FormData = FakeFormData;
  try {
    const form = { values: { level: 'off' }, querySelector: () => ({}) };
    assert.equal(trace.handle(ctx, uiEvent('submit', { '[data-trace-settings]': form }, { submitter: {} })), true);
    await done;
  } finally {
    delete globalThis.FormData;
  }
  assert.deepEqual(writes[0], ['PUT', '/trace/settings', JSON.stringify({ level: 'off', persist: false })]);
  assert.deepEqual(pendingStates, [true, false]);
  assert.deepEqual(notes, ['Tracing level off.']);
  // The level-off notice and the per-level performance notes.
  ctx.data.trace.settings = structuredClone(off);
  const html = trace.render(ctx);
  safeMarkup(html);
  assert.match(html, /Tracing is off: new requests are not recorded\./);
  assert.match(
    html,
    /<input type="radio" id="trace-level-off" name="level" value="off" checked aria-describedby="trace-level-off-help">/,
  );
  assert.match(html, /id="trace-level-full-help">Summary plus redacted inputs and outputs/);
  // The retention limits are editable (DV-C-20), bounded like mirage.trace.
  assert.match(
    html,
    /<input id="trace-limit-payloadBytes" name="payloadBytes" type="number" min="256" max="1048576" step="1" required value="16384" aria-describedby="trace-limit-payloadBytes-help">/,
  );
  assert.match(
    html,
    /id="trace-limit-traces" name="traces" type="number" min="10" max="10000" step="1" required value="500"/,
  );
  assert.doesNotMatch(html, /read-only/);

  trace.handle(ctx, uiEvent('click', { '[data-trace-action]': { dataset: { traceAction: 'clear' } } }));
  assert.deepEqual([confirmed.title, confirmed.label], ['Clear traces?', 'Clear traces']);
  assert.equal(writes.length, 1, 'nothing is cleared before the confirmation');
  await confirmed.action();
  assert.deepEqual(writes[1], ['POST', '/trace/clear', '{}']);
  assert.equal(notes.at(-1), 'Traces cleared.');
});

test('a trace that is no longer retained says so and offers to close it', async () => {
  const gone = Object.assign(new Error('No retained trace has this id.'), { status: 404 });
  const ctx = traceContext({ responses: traceResponses({ '/trace/id/fx-gone': gone }) });
  trace.route(ctx, new URLSearchParams({ traceId: 'fx-gone' }));
  await trace.load(ctx);
  const html = trace.render(ctx);
  safeMarkup(html);
  assert.match(
    html,
    /No retained trace has the id fx-gone \(it never existed or was dropped as the oldest beyond the limit\)\./,
  );
  assert.match(html, /data-trace-action="close-trace"/);
});

// ---- Traces round 2: drafts, stale loads, partial loads, focus, time, colours, deep traces, list, search, compare.
/** Installs fake history, FormData and document.getElementById (recording focus) for the duration of `run`. */
async function withDom(run) {
  const hashes = [],
    focused = [];
  globalThis.history = { replaceState: (state, title, url) => hashes.push(url) };
  globalThis.FormData = FakeFormData;
  globalThis.document = {
    getElementById: (id) => ({ focus: () => focused.push(id), select() {} }),
  };
  try {
    await run({ hashes, focused });
  } finally {
    delete globalThis.history;
    delete globalThis.FormData;
    delete globalThis.document;
  }
}
const click = (selector, dataset) => uiEvent('click', { [selector]: { dataset } });
/** A trace tree of `count` spans chained parent to child, one module each (cycling through `modules`). */
function chainTree(count, modules = MODULES) {
  const traceId = 'fx-chain';
  const spans = Array.from({ length: count }, (_, index) => ({
    traceId,
    spanId: `fx-span-${index}`,
    parentSpanId: index ? `fx-span-${index - 1}` : null,
    sequence: index + 1,
    kind: 'http',
    name: `GET /fx/level-${index}/with_a_long_name_that_keeps_going_${'x'.repeat(40)}`,
    module: modules[index % modules.length],
    startedAt: new Date(Date.parse('2026-10-22T09:00:00.000Z') + index).toISOString(),
    durationMs: count - index,
    status: 'ok',
    depth: index,
    async: false,
    events: [],
    attributes: {},
    links: [],
  }));
  const nodes = spans.map((span) => ({ ...span, children: [] }));
  nodes.forEach((node, index) => index && nodes[index - 1].children.push(node));
  return {
    trace: { traceId, startedAt: spans[0].startedAt, durationMs: count, totalDurationMs: count, spanCount: count },
    root: spans[0],
    spans,
    children: [nodes[0]],
  };
}

test('trace filter and settings drafts are forgotten whenever the view state replaces them (R2C-1)', async () => {
  const ctx = traceContext({ responses: traceResponses() });
  await trace.load(ctx);
  await withDom(async () => {
    const settle = () => ctx.data.trace.reloading;
    const forgets = async (action, form = 'trace-filters') => {
      ctx.forgotten.length = 0;
      action();
      await settle();
      assert.deepEqual(ctx.forgotten, [form]);
    };
    await forgets(() =>
      trace.handle(
        ctx,
        uiEvent('submit', { '[data-trace-filters]': { values: { kind: 'webapi', entity: 'account' } } }),
      ),
    );
    await forgets(() => trace.handle(ctx, click('[data-trace-action]', { traceAction: 'reset' })));
    assert.equal(ctx.data.trace.filters.kind, '');
    await forgets(() =>
      trace.handle(ctx, click('[data-trace-bucket]', { traceBucket: sample.stats.timeline[0].bucketStart })),
    );
    await forgets(() => trace.handle(ctx, click('[data-trace-pivot]', { tracePivot: 'kind', value: 'render' })));
    await forgets(() => trace.handle(ctx, click('[data-trace-unfilter]', { traceUnfilter: 'kind' })));
    await forgets(() => trace.route(ctx, new URLSearchParams({ kind: 'http', status: 'error' })));
    // The settings form: a save replaces the radios with the saved level; so does a level changed elsewhere.
    const read = ctx.request;
    ctx.request = (path, init) =>
      init?.method === 'PUT' ? Promise.resolve(structuredClone(sample.settings)) : read(path, init);
    let saved;
    const done = new Promise((resolve) => (saved = resolve));
    ctx.setButtonPending = (button, on) => (on ? true : saved());
    ctx.forgotten.length = 0;
    trace.handle(ctx, uiEvent('submit', { '[data-trace-settings]': { values: { level: 'full' } } }, { submitter: {} }));
    await done;
    assert.deepEqual(ctx.forgotten, ['trace-settings-form']);
    const summary = { ...sample.settings, settings: { ...sample.settings.settings, level: 'summary' } };
    ctx.request = (path) => Promise.resolve(path === '/trace/settings' ? structuredClone(summary) : {});
    ctx.forgotten.length = 0;
    await trace.load(ctx, ['settings']);
    assert.deepEqual(ctx.forgotten, ['trace-settings-form']);
    assert.match(trace.render(ctx), /id="trace-level-summary" name="level" value="summary" checked/);
  });
});

test('a slow load never overwrites the answer of a newer one, per part (R2C-7)', async () => {
  const ctx = traceContext();
  const gates = [];
  ctx.request = (path) => new Promise((resolve) => gates.push({ path, resolve }));
  const answer = (gate, marker) =>
    gate.resolve(
      gate.path.startsWith('/trace?')
        ? { items: [], total: 0, page: 1, pageSize: 10, pageCount: 1, marker }
        : { trace: { traceId: 'fx-new' }, marker },
    );
  trace.route(ctx, new URLSearchParams({ kind: 'webapi' }));
  const older = trace.load(ctx);
  const olderGates = gates.splice(0);
  trace.route(ctx, new URLSearchParams({ kind: 'render', traceId: 'fx-new' }));
  const newer = trace.load(ctx);
  const newerGates = gates.splice(0);
  assert.ok(newerGates.some((gate) => gate.path === '/trace/id/fx-new'));
  // The newer answers arrive first, then the older ones.
  for (const gate of newerGates) answer(gate, 'new');
  await newer;
  for (const gate of olderGates) answer(gate, 'old');
  await older;
  const d = ctx.data.trace;
  assert.equal(d.list.marker, 'new');
  assert.equal(d.tree.marker, 'new');
  assert.equal(d.stats.marker, 'new');
  assert.equal(d.settings.marker, 'new');
  assert.equal(d.filters.kind, 'render');
});

test('each trace action fetches only what it changes (R2C-22)', async () => {
  const ctx = traceContext({ responses: traceResponses() });
  await trace.load(ctx);
  await withDom(async ({ hashes }) => {
    const settle = () => ctx.data.trace.reloading;
    const fetched = async (action) => {
      ctx.requested.length = 0;
      await action();
      await settle();
      return [...ctx.requested];
    };
    assert.deepEqual(await fetched(() => trace.handle(ctx, click('[data-trace-open]', { traceOpen: traceId }))), [
      `/trace/id/${traceId}`,
    ]);
    assert.deepEqual(await fetched(() => trace.handle(ctx, click('[data-table-page="trace-list"]', { delta: '1' }))), [
      '/trace?page=2&pageSize=10',
    ]);
    // Sortable columns: a heading sorts descending, the same heading again ascending; only the list is read.
    assert.deepEqual(await fetched(() => trace.handle(ctx, click('[data-trace-sort]', { traceSort: 'duration' }))), [
      '/trace?sort=duration&order=desc&page=1&pageSize=10',
    ]);
    assert.deepEqual(await fetched(() => trace.handle(ctx, click('[data-trace-sort]', { traceSort: 'duration' }))), [
      '/trace?sort=duration&order=asc&page=1&pageSize=10',
    ]);
    assert.equal(hashes.at(-1), `#trace?sort=duration&order=asc&traceId=${traceId}`);
    const html = trace.render(ctx);
    assert.match(
      html,
      /<th scope="col" aria-sort="ascending"><button type="button" class="ui-sort" id="trace-sort-duration"/,
    );
    assert.match(html, /<th scope="col" aria-sort="none"><button type="button" class="ui-sort" id="trace-sort-start"/);
    assert.match(html, /<caption class="ui-sr-only">Traces by duration, ascending<\/caption>/);
    // A deep link that changes only the open trace reads only that trace; one naming a panel reads nothing.
    trace.route(ctx, new URLSearchParams({ traceId: 'fx-other' }));
    assert.deepEqual(await fetched(() => trace.load(ctx)), ['/trace/id/fx-other']);
    trace.route(ctx, new URLSearchParams({ panel: 'settings' }));
    assert.deepEqual(await fetched(() => trace.load(ctx)), []);
    // The shell's own refresh (no deep link) reads everything again.
    assert.equal((await fetched(() => trace.load(ctx))).length, 4);
    // Leaving and coming back reads everything, whatever the link says.
    trace.leave(ctx);
    trace.route(ctx, new URLSearchParams({ traceId }));
    assert.equal((await fetched(() => trace.load(ctx))).length, 4);
  });
});

test('trace focus lands on the drawer, returns to the span label and the row, and survives re-renders (R2C-8)', async () => {
  const ctx = traceContext({ responses: traceResponses() });
  trace.route(ctx, new URLSearchParams({ traceId }));
  await trace.load(ctx);
  await withDom(async ({ focused }) => {
    const order = [];
    ctx.reveal = (selector) => order.push(`reveal ${selector}`);
    ctx.render = () => order.push('render');
    trace.handle(ctx, click('[data-trace-span]', { traceSpan: stepSpan.spanId }));
    assert.deepEqual(order, ['reveal #trace-span-drawer', 'render'], 'the landing is set before the render');
    trace.handle(ctx, click('[data-trace-action]', { traceAction: 'close-span' }));
    assert.deepEqual(focused, [`trace-span-${stepSpan.spanId}`]);
    trace.handle(ctx, click('[data-trace-action]', { traceAction: 'close-trace' }));
    assert.deepEqual(focused.at(-1), `trace-open-${traceId}`);
  });
  // Controls that re-render the view carry ids, so the shell's render restores focus to them.
  const html = trace.render(ctx);
  for (const id of [
    'trace-apply',
    'trace-reset',
    'trace-live',
    'trace-refresh',
    'trace-sort-start',
    `trace-open-${traceId}`,
  ])
    assert.match(html, new RegExp(`id="${id}"`), id);
  const app = await fs.readFile(new URL('../admin/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /focused\?\.dataset\?\.tablePage && \$\('#content'\)\.contains\(focused\)/);
});

test('trace times are local with the UTC offset and long durations read in minutes and hours (R2C-5, R2C-19)', async () => {
  const saved = process.env.TZ;
  process.env.TZ = 'Etc/GMT-2';
  try {
    assert.equal(localTime('2026-10-22T09:00:00.005Z'), '2026-10-22 11:00:00.005');
    assert.equal(utcOffset(new Date('2026-10-22T09:00:00Z')), 'UTC+02:00');
    const ctx = traceContext({ responses: traceResponses() });
    await trace.load(ctx);
    const html = trace.render(ctx);
    assert.match(html, /local time \(UTC\+02:00\)/);
    assert.match(
      html,
      /<time class="ui-mono" datetime="2026-10-22T09:00:00\.000Z" title="2026-10-22T09:00:00\.000Z">2026-10-22 11:00:00\.000<\/time>/,
    );
    assert.doesNotMatch(html, /2026-10-22 09:00:00\.000</);
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
  assert.deepEqual([3, 12.34, 1500, 59_000, 90_500, 1_800_000, 3_600_000, 5_430_000, null].map(duration), [
    '3.00 ms',
    '12.3 ms',
    '1.50 s',
    '59.00 s',
    '1 m 31 s',
    '30 m 0 s',
    '1 h 0 m',
    '1 h 31 m',
    'running',
  ]);
});

test('every module has its own colour with enough contrast, and deep traces stop indenting (R2C-10, R2C-11)', async () => {
  const css = await fs.readFile(new URL('../admin/ui-kit.css', import.meta.url), 'utf8');
  const fills = [...css.matchAll(/\.ui-series-(\d+) \{\s*fill: (#[0-9a-f]{6});/g)].map((match) => match[2]);
  assert.equal(fills.length, MODULES.length);
  assert.equal(new Set(fills).size, MODULES.length, 'no two modules share a colour');
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((at) => {
      const c = parseInt(hex.slice(at, at + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const track = luminance('#eef1f8');
  for (const fill of fills) assert.ok((track + 0.05) / (luminance(fill) + 0.05) >= 3, `${fill} against the track`);
  assert.match(css, /\.ui-series-other \{\s*fill: #7b8698;/);

  // One span per module: each gets its own series class; an unknown module is neutral.
  const ctx = traceContext({ responses: { ...traceResponses(), '/trace/id/fx-chain': chainTree(MODULES.length) } });
  trace.route(ctx, new URLSearchParams({ traceId: 'fx-chain' }));
  await trace.load(ctx);
  let html = trace.render(ctx);
  for (const index of MODULES.keys()) assert.match(html, new RegExp(`ui-bar-fill ui-series-${index}"`));
  const other = chainTree(1, ['fx-unknown']);
  ctx.data.trace.tree = { ...other, trace: { ...other.trace, traceId: 'fx-chain' } };
  assert.match(trace.render(ctx), /ui-bar-fill ui-series-other"/);

  // 30 levels deep: the waterfall indent stops at 12 and shows the depth; the tree stops indenting and keeps
  // one line per span with the full name in its title.
  ctx.data.trace.tree = chainTree(30);
  html = trace.render(ctx);
  assert.equal(count(html, /ui-waterfall-row ui-depth-12/g), 18);
  assert.doesNotMatch(html, /ui-depth-1[3-9]|ui-depth-2\d/);
  assert.match(html, />d29</);
  assert.match(html, /<span class="ui-waterfall-name" title="GET \/fx\/level-29\//);
  ctx.data.trace.tab = 'tree';
  html = trace.render(ctx);
  assert.equal(count(html, /<ul role="group" class="is-flat">/g), 17);
  assert.match(
    html,
    /class="ui-tree-span" id="trace-span-fx-span-29" data-trace-span="fx-span-29" aria-pressed="false" title="GET/,
  );
  assert.match(css, /\.ui-tree-span \{[^}]*white-space: nowrap;[^}]*\}/);
  assert.match(css, /\.ui-tree-span \{[^}]*text-decoration: none;/);
});

test('the trace list keeps status, duration and the open control in view, with compact counts (R2C-4, R2C-15)', async () => {
  const ctx = traceContext({ responses: traceResponses() });
  await trace.load(ctx);
  const html = trace.render(ctx);
  const list = html.slice(html.indexOf('data-table="trace-list"'));
  // Each heading label is the text before its first nested tag (the sort arrow and info button follow it).
  const headings = [...list.slice(0, list.indexOf('</thead>')).matchAll(/<th\b[^>]*>(?:<button[^>]*>)?([^<]*)/g)].map(
    (match) => match[1].trim(),
  );
  assert.deepEqual(headings, ['Started', 'Status', 'Duration', 'Root', 'Spans', 'Errors', 'Tables', 'Compare']);
  assert.doesNotMatch(list, />Open<\/button>/);
  assert.doesNotMatch(list, /ui-badge-row/);
  assert.match(
    list,
    new RegExp(
      `<button type="button" class="ui-link-button ui-trace-root" id="trace-open-${traceId}" data-trace-open="${traceId}"`,
    ),
  );
  // Origin line: host, actor without a repeated kind, session from its key.
  assert.match(list, /power-pages · contact Invented Contact · contact c0ffee00/);
  assert.match(list, /power-pages · anonymous · visitor visitor-/);
  assert.match(list, /<span class="ui-badge ui-tone-warn">2 denied<\/span>/);
  assert.equal(actorText({ kind: 'anonymous', id: null, name: 'Anonymous' }), 'anonymous');
  assert.equal(actorText({ kind: 'contact', id: 'a4300000-1111', name: null }), 'contact a4300000');
  assert.equal(sessionText({ visitorId: null, sessionKey: 'contact:a4300000-1111' }), 'contact a4300000');
  assert.equal(sessionText({ visitorId: 'v1234567890', sessionKey: null }), 'visitor v1234567');
  assert.equal(sessionText(null), '—');
});

test('trace facts name the HTTP status, and the timeline is one tab stop with arrow keys (R2C-17, R2C-18)', async () => {
  const ctx = traceContext({ responses: traceResponses() });
  trace.route(ctx, new URLSearchParams({ traceId }));
  await trace.load(ctx);
  let html = trace.render(ctx);
  assert.match(
    html,
    /<dt>Status<\/dt><dd><span class="ui-badge ui-tone-ok">ok<\/span>[^<]*<span[^>]*>1 error<\/span> · HTTP 201<\/dd>/,
  );
  assert.equal(count(html, /class="ui-histogram-bucket" role="button" id="trace-bucket-\d+" tabindex="0"/g), 1);
  assert.match(html, /id="trace-bucket-0" tabindex="0"/);
  await withDom(async ({ focused }) => {
    const bucket = (index, key) =>
      uiEvent(
        'keydown',
        {
          '[data-trace-bucket]': {
            dataset: { traceBucket: sample.stats.timeline[index].bucketStart, bucketIndex: String(index) },
          },
        },
        { key },
      );
    trace.handle(ctx, bucket(0, 'ArrowRight'));
    assert.deepEqual(focused, ['trace-bucket-1']);
    html = trace.render(ctx);
    assert.match(html, /id="trace-bucket-1" tabindex="0"/);
    assert.match(html, /id="trace-bucket-0" tabindex="-1"/);
    trace.handle(ctx, bucket(1, 'End'));
    assert.equal(focused.at(-1), `trace-bucket-${sample.stats.timeline.length - 1}`);
    trace.handle(ctx, bucket(sample.stats.timeline.length - 1, 'ArrowRight'));
    assert.equal(focused.at(-1), 'trace-bucket-0', 'arrows wrap');
  });
  const css = await fs.readFile(new URL('../admin/ui-kit.css', import.meta.url), 'utf8');
  assert.match(css, /\.ui-histogram-bucket:focus-visible \.ui-histogram-hit \{\s*stroke: var\(--ui-focus\);/);
});

test('span search and errors-only filter the waterfall and tree; the JSON tab and copy buttons (D-R2-21)', async () => {
  const ctx = traceContext({ responses: traceResponses() });
  trace.route(ctx, new URLSearchParams({ traceId }));
  await trace.load(ctx);
  const sdk = sample.tree.spans.find((span) => span.kind === 'sdk-call');
  const filter = spanFilter(sample.tree, { spanSearch: 'X_CATEGORY' });
  assert.deepEqual([...filter.matched], [sdk.spanId]);
  assert.equal(filter.shown.size, 6, 'the match and its five ancestors');
  await withDom(async ({ hashes }) => {
    trace.handle(ctx, uiEvent('input', { '[data-trace-span-search]': { value: 'x_category' } }));
    assert.match(hashes.at(-1), /&spanSearch=x_category$/);
    let html = trace.render(ctx);
    assert.equal(count(html, /<li class="ui-waterfall-row/g), 6);
    assert.equal(count(html, /is-context/g), 5);
    assert.match(html, /role="status">1 of 7 spans match</);
    assert.match(
      html,
      /<input type="search" id="trace-span-search" data-trace-span-search value="x_category" aria-describedby="trace-span-search-help">/,
    );
    ctx.data.trace.tab = 'tree';
    assert.equal(count(trace.render(ctx), /data-trace-span="/g), 6);
    // Errors only: the failed job and its ancestors.
    trace.handle(ctx, uiEvent('input', { '[data-trace-span-search]': { value: '' } }));
    trace.handle(ctx, uiEvent('change', { '[data-trace-errors-only]': { checked: true } }));
    assert.match(hashes.at(-1), /&errorsOnly=true$/);
    ctx.data.trace.tab = 'waterfall';
    html = trace.render(ctx);
    assert.equal(count(html, /<li class="ui-waterfall-row/g), 3);
    assert.match(html, new RegExp(`data-trace-span="${jobSpan.spanId}"`));
    trace.handle(ctx, uiEvent('change', { '[data-trace-errors-only]': { checked: false } }));
  });
  // JSON: the whole trace, a download through the streamed export and a copy button.
  ctx.data.trace.tab = 'json';
  const html = trace.render(ctx);
  safeMarkup(html);
  assert.match(html, /id="help-trace-json">The whole trace as the runtime answers it/);
  assert.match(html, new RegExp(`<pre class="ui-example ui-json" tabindex="0"[^>]*>\\{\\n {2}&quot;trace&quot;`));
  assert.match(
    html,
    new RegExp(`href="/__sim/api/trace/export\\?traceId=${traceId}&amp;format=json" download>Download trace`),
  );
  // Copy: the clipboard when allowed, a selected read-only field with help when refused.
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const copied = [],
    notes = [];
  ctx.notify = (text) => notes.push(text);
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText: async (text) => copied.push(text) } },
    });
    await withDom(async () => {
      trace.handle(ctx, click('[data-trace-copy]', { traceCopy: 'id' }));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual([copied, notes], [[traceId], ['Trace id copied.']]);
      globalThis.location = { origin: 'http://127.0.0.1:1', pathname: '/_sim/' };
      trace.handle(ctx, click('[data-trace-copy]', { traceCopy: 'link' }));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(copied.at(-1), `http://127.0.0.1:1/_sim/#trace?traceId=${traceId}`);
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { clipboard: { writeText: async () => Promise.reject(new Error('NotAllowedError')) } },
      });
      trace.handle(ctx, click('[data-trace-copy]', { traceCopy: 'id' }));
      await new Promise((resolve) => setImmediate(resolve));
    });
  } finally {
    delete globalThis.location;
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
  }
  const fallback = trace.render(ctx);
  assert.match(
    fallback,
    new RegExp(
      `<textarea id="trace-copy-fallback" readonly rows="2" aria-describedby="trace-copy-fallback-help">${traceId}</textarea>`,
    ),
  );
  assert.match(fallback, /id="trace-copy-fallback-help">The browser refused clipboard access/);
});

test('filter chips remove one filter, and the p95 tile compares with the previous equal-length window', async () => {
  const ctx = traceContext({ responses: traceResponses() });
  const read = ctx.request;
  const previous = { ...structuredClone(sample.stats), roots: { count: 1, errors: 0, p50: 10, p95: 10, max: 10 } };
  ctx.request = (path) => (/&to=/.test(path) ? (ctx.requested.push(path), Promise.resolve(previous)) : read(path));
  trace.route(ctx, new URLSearchParams({ kind: 'webapi', range: '15m' }));
  const before = Date.now();
  await trace.load(ctx);
  const stats = ctx.requested.filter((path) => path.startsWith('/trace/stats'));
  assert.equal(stats.length, 2);
  const current = new URLSearchParams(stats[0].split('?')[1]),
    shifted = new URLSearchParams(stats[1].split('?')[1]);
  const length = Date.parse(shifted.get('to')) + 1 - Date.parse(shifted.get('from'));
  assert.equal(length, 900_000);
  assert.equal(Date.parse(shifted.get('to')) + 1, Date.parse(current.get('from')));
  assert.equal(shifted.get('kind'), 'webapi');
  assert.ok(Date.parse(current.get('from')) >= before - 900_000);
  let html = trace.render(ctx);
  // sample roots p95 21 ms against 10 ms before: +110%.
  assert.match(
    html,
    /Root p95 vs before<\/span><strong class="ui-tile-value">\+110%<\/strong><span class="ui-tile-detail">21\.0 ms now · 10\.0 ms in the previous 15 m 0 s</,
  );
  assert.equal(previousWindow({ filters: {}, range: 'all' }), null);
  // Chips: one per active filter and the range; × removes only that one.
  assert.match(html, /<div class="ui-chips" role="group" aria-label="Active filters">/);
  assert.match(
    html,
    /data-trace-unfilter="range" aria-label="Remove filter Last 15 minutes">Last 15 minutes <span aria-hidden="true">×<\/span>/,
  );
  assert.match(html, /data-trace-unfilter="kind" aria-label="Remove filter Span kind: webapi">/);
  await withDom(async ({ hashes }) => {
    trace.handle(ctx, click('[data-trace-unfilter]', { traceUnfilter: 'kind' }));
    await ctx.data.trace.reloading;
    assert.equal(hashes.at(-1), '#trace?range=15m');
    trace.handle(ctx, click('[data-trace-unfilter]', { traceUnfilter: 'range' }));
    await ctx.data.trace.reloading;
    assert.equal(hashes.at(-1), '#trace');
  });
  html = trace.render(ctx);
  assert.doesNotMatch(html, /ui-chips/);
  assert.match(
    html,
    /Root p95 vs before<\/span><strong class="ui-tile-value">—<\/strong><span class="ui-tile-detail">choose a time range to compare</,
  );
});

test('two traces compare side by side with per-span duration deltas and added or missing spans', async () => {
  const other = structuredClone(sample.tree);
  other.trace.traceId = 'fx-b';
  other.trace.durationMs = 26;
  const adjust = (nodes) =>
    nodes.forEach((node) => {
      if (node.kind === 'sdk-call') node.durationMs += 5;
      node.children = node.children.filter((child) => child.kind !== 'job');
      if (node.kind === 'plugin-step')
        node.children.push({ ...node.children[0], spanId: 'fx-new', name: 'Retrieve x_extra', children: [] });
      adjust(node.children);
    });
  adjust(other.children);
  const result = compareTrees(sample.tree, other);
  assert.deepEqual(
    result.matched.filter((item) => item.delta).map((item) => [item.b.name, item.delta]),
    [['Retrieve x_category', 5]],
  );
  assert.deepEqual(
    result.added.map((item) => item.node.name),
    ['Retrieve x_extra'],
  );
  assert.deepEqual(
    result.missing.map((item) => item.node.name),
    ['Invented.Plugin.PostCreate (async)'],
  );

  const ctx = traceContext({ responses: { ...traceResponses(), '/trace/id/fx-b': other } });
  await trace.load(ctx);
  await withDom(async ({ hashes }) => {
    // Tick two rows, then Compare: both trees load and the pair is in the address.
    for (const id of [traceId, 'fx-b'])
      trace.handle(ctx, uiEvent('change', { '[data-trace-pick]': { checked: true, dataset: { tracePick: id } } }));
    assert.match(trace.render(ctx), /id="trace-compare" data-trace-action="compare">Compare the 2 ticked traces/);
    ctx.requested.length = 0;
    trace.handle(ctx, click('[data-trace-action]', { traceAction: 'compare' }));
    await ctx.data.trace.reloading;
    assert.deepEqual(ctx.requested, [`/trace/id/${traceId}`, '/trace/id/fx-b']);
    assert.equal(hashes.at(-1), `#trace?compare=${traceId}%2Cfx-b`);
  });
  const html = trace.render(ctx);
  safeMarkup(html);
  assert.match(html, /data-ui-section="trace:compare" open/);
  assert.match(html, /id="help-trace-compare">Two traces side by side\./);
  assert.equal(count(html, /<ul class="ui-tree" aria-label="Span tree of trace [AB]">/g), 2);
  assert.match(
    html,
    /Retrieve x_category<\/span> <span class="ui-tree-facts">8\.00 ms <span class="ui-badge ui-tone-warn">\+5\.00 ms<\/span>/,
  );
  assert.match(
    html,
    /Retrieve x_extra<\/span> <span class="ui-tree-facts">[^<]+<span class="ui-badge ui-tone-info">only in B</,
  );
  assert.match(
    html,
    /Invented\.Plugin\.PostCreate \(async\)<\/span> <span class="ui-tree-facts">[^<]+<span class="ui-badge ui-tone-info">only in A</,
  );
  assert.match(html, /<dt>Root duration<\/dt><dd>21\.0 ms → 26\.0 ms \(\+5\.00 ms\)<\/dd>/);
  assertTables(html, ['trace-compare']);
  // The deep link alone opens the same comparison without touching the filters.
  const linked = traceContext({ responses: { ...traceResponses(), '/trace/id/fx-b': other } });
  trace.route(linked, new URLSearchParams({ kind: 'http' }));
  trace.route(linked, new URLSearchParams({ compare: `${traceId},fx-b` }));
  assert.deepEqual(linked.data.trace.compare, [traceId, 'fx-b']);
  assert.equal(linked.data.trace.filters.kind, 'http');
  trace.route(linked, new URLSearchParams({ compare: 'only-one' }));
  assert.equal(linked.data.trace.compare, null);
});

test('export links the streamed route with the chosen format; Live follows the host eventChannels (F31)', async () => {
  const ctx = traceContext({ responses: traceResponses() });
  trace.route(ctx, new URLSearchParams({ kind: 'webapi' }));
  await trace.load(ctx);
  assert.match(
    trace.render(ctx),
    /<a class="ui-button ui-small" id="trace-export" href="\/__sim\/api\/trace\/export\?kind=webapi&amp;format=ndjson" download>Export filtered traces<\/a>/,
  );
  trace.handle(ctx, uiEvent('change', { '[data-trace-export-format]': { value: 'otlp' } }));
  let html = trace.render(ctx);
  assert.match(html, /href="\/__sim\/api\/trace\/export\?kind=webapi&amp;format=otlp" download/);
  assert.match(html, /<option value="otlp" selected>OTLP JSON<\/option>/);
  assert.match(html, /id="trace-export-format-help">The file Export downloads/);

  const saved = { EventSource: globalThis.EventSource, fetch: globalThis.fetch };
  const sources = [],
    fetched = [];
  globalThis.EventSource = class {
    static CLOSED = 2;
    constructor(url) {
      this.url = url;
      this.listeners = {};
      sources.push(this);
    }
    addEventListener(type, listener) {
      (this.listeners[type] ??= []).push(listener);
    }
    close() {
      this.readyState = 2;
    }
  };
  globalThis.fetch = async (url) => fetched.push(url);
  try {
    // A host whose channels lack `trace`: Live is disabled and says why, and nothing connects.
    ctx.eventChannels = () => ['logs'];
    html = trace.render(ctx);
    assert.match(
      html,
      /id="trace-live" disabled data-trace-action="live" aria-pressed="false">Live: off<\/button><span class="ui-help" role="status">This host does not stream traces</,
    );
    trace.handle(ctx, click('[data-trace-action]', { traceAction: 'live' }));
    assert.equal(sources.length, 0);
    // A host that lists `trace` (either host): Live connects; a closed stream needs no probe request.
    ctx.eventChannels = () => ['trace'];
    trace.handle(ctx, click('[data-trace-action]', { traceAction: 'live' }));
    assert.equal(sources.length, 1);
    sources[0].readyState = 2;
    for (const listener of sources[0].listeners.error) listener({});
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fetched, []);
    assert.match(trace.render(ctx), /The live trace stream closed\. Select Live to connect again, or refresh traces\./);
  } finally {
    trace.leave(ctx);
    Object.assign(globalThis, saved);
  }
});

test('flow run details and audit rows link to their trace', async () => {
  globalThis.location = { hash: '#flows?run=run-2' };
  const ctx = context({
    responses: {
      '/flow-runs': runs,
      '/flow-waits': [],
      '/dashboard': dashboard,
      '/flow-runs/run-2': { ...runs[1], traceId: 'fx-trace', traceSpanId: 'fx-span', journal: {} },
    },
  });
  try {
    await flows.load(ctx);
  } finally {
    delete globalThis.location;
  }
  assert.match(
    flows.render(ctx),
    /<a class="ui-button ui-small" href="#trace\?traceId=fx-trace&amp;spanId=fx-span">Open trace<\/a>/,
  );
  const app = await fs.readFile(new URL('../admin/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /\$\{item\.traceId \? ` <a class="button small" href="#trace\?/);
  assert.match(app, /\['Monitor', \['dashboard', 'overview', 'logs', 'audit', 'trace', 'evidence'\]\]/);
});

// ---- Traces round 3 (DV-C findings, D-R3-1, D-R3-15..17, D-R3-29).
const sdkSpan = sample.tree.spans.find((span) => span.kind === 'sdk-call');
const dataverseSpan = sample.tree.spans.find((span) => span.kind === 'dataverse');
/** A failure as ctx.request throws it for a JSON error answer. */
const refused = (status, error) => Object.assign(new Error(error.message), { status, details: { error } });

test('trace deep links land on the drawer, the trace heading or the comparison; Enter lands on the trace (DV-C-3, DV-C-17)', async () => {
  const ctx = traceContext({ responses: traceResponses() });
  const revealed = [];
  ctx.reveal = (selector) => revealed.push(selector);
  trace.route(ctx, new URLSearchParams({ traceId, spanId: stepSpan.spanId }));
  trace.route(ctx, new URLSearchParams({ traceId }));
  trace.route(ctx, new URLSearchParams({ compare: `${traceId},fx-b` }));
  trace.route(ctx, new URLSearchParams({ kind: 'http' }));
  trace.route(ctx, new URLSearchParams({ panel: 'settings' }));
  assert.deepEqual(revealed, ['#trace-span-drawer', '#trace-detail-title', '[data-ui-section="trace:compare"]']);
  // The trace heading exists while the trace loads, once it loaded and when it is gone, so the landing and every
  // later re-render keep focus on it.
  trace.route(ctx, new URLSearchParams({ traceId }));
  assert.match(
    trace.render(ctx),
    /<h3 id="trace-detail-title" tabindex="-1">Trace <code>a6b72bdc<\/code><\/h3><p role="status"/,
  );
  await trace.load(ctx);
  assert.match(
    trace.render(ctx),
    /<div class="ui-drawer-head"><h3 id="trace-detail-title" tabindex="-1">Trace <code>a6b72bdc/,
  );
  // A row opened with Enter (a click on its button) lands on the heading of the trace it opens.
  revealed.length = 0;
  await withDom(async () => {
    trace.handle(ctx, click('[data-trace-open]', { traceOpen: 'fx-other' }));
  });
  assert.deepEqual(revealed, ['#trace-detail-title']);
  await ctx.data.trace.reloading;
  assert.match(trace.render(ctx), /<h3 id="trace-detail-title" tabindex="-1">Trace <code>fx-other<\/code><\/h3>/);
});

test('the span drawer shows its path from the root, one-click Parent and Root, and named link targets (DV-C-4)', async () => {
  const linked = { traceId: 'fx-other-trace', spanId: 'fx-linked-span', kind: 'flow-run', name: 'Invented flow' };
  const ctx = traceContext({ responses: traceResponses({ '/trace/span/fx-linked-span': linked }) });
  trace.route(ctx, new URLSearchParams({ traceId, spanId: sdkSpan.spanId }));
  await trace.load(ctx);
  let html = trace.render(ctx);
  safeMarkup(html);
  const path = html.match(/<nav class="ui-crumbs" aria-label="Span path"><ol>(.*?)<\/ol><\/nav>/)[1];
  assert.equal(count(path, /<li/g), 6, 'root, webapi, dataverse, stage, step, the span');
  assert.match(
    path,
    new RegExp(
      `^<li><a href="#trace\\?traceId=${traceId}&amp;spanId=${rootSpan.spanId}"><span[^>]*>http</span> POST /_api/x_items</a></li>`,
    ),
  );
  assert.match(path, /<li aria-current="location"><span[^>]*>sdk-call<\/span> /);
  assert.match(
    html,
    new RegExp(
      `id="trace-span-root" href="#trace\\?traceId=${traceId}&amp;spanId=${rootSpan.spanId}" aria-label="Root span: http POST /_api/x_items">Root</a>`,
    ),
  );
  assert.match(
    html,
    new RegExp(
      `id="trace-span-parent" href="#trace\\?traceId=${traceId}&amp;spanId=${stepSpan.spanId}" aria-label="Parent span: plugin-step Invented.Plugin.PreCreate">Parent</a>`,
    ),
  );
  assert.match(
    html,
    /<dt>Parent<\/dt><dd><a href="[^"]+"><span class="ui-badge ui-tone-neutral">plugin-step<\/span> Invented\.Plugin\.PreCreate<\/a>/,
  );
  assert.ok(!ctx.requested.some((path) => path.startsWith('/trace/span/')), 'targets inside the trace need no read');
  // A root span has neither Parent nor Root.
  ctx.data.trace.spanId = rootSpan.spanId;
  html = trace.render(ctx);
  assert.match(html, /<dt>Parent<\/dt><dd>none \(root\)/);
  assert.doesNotMatch(html, /id="trace-span-(parent|root)"/);
  // Links: the staging span by kind and name from the trace; a target in another trace is read once.
  await withDom(async () => {
    trace.handle(ctx, click('[data-trace-span]', { traceSpan: jobSpan.spanId }));
    await new Promise((resolve) => setImmediate(resolve));
  });
  html = trace.render(ctx);
  assert.match(
    html,
    /staged-by: <a href="[^"]+"><span class="ui-badge ui-tone-neutral">webapi<\/span> POST x_items<\/a> in trace <code>a6b72bdc<\/code>/,
  );
  assert.match(
    html,
    /triggered: <a href="#trace\?traceId=fx-other-trace&amp;spanId=fx-linked-span"><span class="ui-badge ui-tone-neutral">flow-run<\/span> Invented flow<\/a>/,
  );
  assert.deepEqual(
    ctx.requested.filter((path) => path.startsWith('/trace/span/')),
    ['/trace/span/fx-linked-span'],
  );
  await trace.load(ctx, []);
  assert.equal(ctx.requested.filter((path) => path.startsWith('/trace/span/')).length, 1, 'read once');
  // A target that is no longer retained keeps its link and says so.
  const gone = traceContext({
    responses: traceResponses({
      '/trace/span/fx-linked-span': refused(404, { code: 'SpanNotFound', message: 'No retained span has this id.' }),
    }),
  });
  trace.route(gone, new URLSearchParams({ traceId, spanId: jobSpan.spanId }));
  await trace.load(gone);
  assert.match(
    trace.render(gone),
    /triggered: <a href="[^"]+">span <code>fx-linke<\/code><\/a> in trace <code>fx-other<\/code> \(no longer retained\)/,
  );
});

test('a parent or link target that failed is still named by kind and name; only a failed read is not (DV-Y8-1)', async () => {
  // The job failed (error object, status error): its child names it; a failed linked span read from another trace too.
  const tree = structuredClone(sample.tree);
  const child = {
    ...structuredClone(sdkSpan),
    spanId: 'fx-under-job',
    parentSpanId: jobSpan.spanId,
    name: 'Retrieve x_after',
    links: [{ traceId: 'fx-other-trace', spanId: 'fx-failed-span', relation: 'triggered' }],
  };
  tree.spans.push(child);
  const failed = {
    traceId: 'fx-other-trace',
    spanId: 'fx-failed-span',
    kind: 'connector',
    name: 'x_quotes/Quote',
    status: 'error',
    error: { code: 'QuoteBackendDown', message: 'Quote backend unavailable' },
  };
  const ctx = traceContext({
    responses: traceResponses({ [`/trace/id/${traceId}`]: tree, '/trace/span/fx-failed-span': failed }),
  });
  trace.route(ctx, new URLSearchParams({ traceId, spanId: child.spanId }));
  await trace.load(ctx);
  const html = trace.render(ctx);
  assert.match(
    html,
    /<dt>Parent<\/dt><dd><a href="[^"]+"><span class="ui-badge ui-tone-neutral">job<\/span> Invented\.Plugin\.PostCreate \(async\)<\/a>/,
  );
  assert.match(html, /aria-label="Parent span: job Invented\.Plugin\.PostCreate \(async\)">Parent<\/a>/);
  assert.match(
    html,
    /triggered: <a href="[^"]+"><span class="ui-badge ui-tone-neutral">connector<\/span> x_quotes\/Quote<\/a> in trace <code>fx-other<\/code><\/li>/,
  );
  assert.doesNotMatch(html, /span <code>(05fe8769|fx-faile)<\/code>/);
});

test('flow run, system job and plug-in step ids link to their views; Same record pivots on the record (DV-C-22, D-R3-1)', async () => {
  const tree = structuredClone(sample.tree);
  tree.spans.find((span) => span.kind === 'sdk-call').attributes.runId = 'run-1';
  const ctx = traceContext({ responses: traceResponses({ [`/trace/id/${traceId}`]: tree }) });
  trace.route(ctx, new URLSearchParams({ traceId, spanId: stepSpan.spanId }));
  await trace.load(ctx);
  let html = trace.render(ctx);
  assert.match(
    html,
    /<a href="#operations\?key=plugin-step%3Astep-1" aria-label="Open plug-in step step-1 in Backend operations"><code>step-1<\/code><\/a>/,
  );
  assert.match(html, /href="#trace\?entity=x_item&amp;recordId=item-1">Same record</);
  ctx.data.trace.spanId = jobSpan.spanId;
  html = trace.render(ctx);
  assert.match(
    html,
    /<a href="#records\?entity=asyncoperation&amp;id=job-1" aria-label="Open system job job-1 in Data records">/,
  );
  assert.doesNotMatch(html, />Same record</, 'a span without a record id has no record pivot');
  ctx.data.trace.spanId = sdkSpan.spanId;
  assert.match(
    trace.render(ctx),
    /<a href="#flows\?run=run-1" aria-label="Open flow run run-1 in Flows &amp; jobs"><code>run-1<\/code><\/a>/,
  );
  // recordId is a filter like the others: form field, deep link, query, chip.
  assert.ok(FILTERS.includes('recordId'));
  trace.route(ctx, new URLSearchParams({ entity: 'x_item', recordId: 'item-1' }));
  assert.equal(filterQuery(ctx.data.trace).toString(), 'entity=x_item&recordId=item-1');
  html = trace.render(ctx);
  assert.match(html, /<input id="trace-record" name="recordId" type="text" value="item-1"/);
  assert.match(html, /data-trace-unfilter="recordId" aria-label="Remove filter Record id: item-1"/);
});

test("a missing payload names the span's own capture level and the reason (DV-C-14)", async () => {
  const tree = structuredClone(sample.tree);
  const sealed = tree.spans.find((span) => span.kind === 'plugin-stage');
  sealed.attributes.secure = true;
  const ctx = traceContext({ responses: traceResponses({ [`/trace/id/${traceId}`]: tree }) });
  trace.route(ctx, new URLSearchParams({ traceId, spanId: dataverseSpan.spanId }));
  await trace.load(ctx);
  // The runtime is at summary now; the span was recorded at full, so that is what the drawer says.
  ctx.data.trace.settings = { ...sample.settings, settings: { ...sample.settings.settings, level: 'summary' } };
  let html = trace.render(ctx);
  assert.match(
    html,
    /Input: none: this span was recorded at level full and its operation passed no input to the trace\./,
  );
  assert.match(
    html,
    /Output: none: this span was recorded at level full and its operation passed no output to the trace\./,
  );
  assert.match(html, /<dt>Captured at<\/dt><dd>level full<\/dd>/);
  ctx.data.trace.spanId = sealed.spanId;
  html = trace.render(ctx);
  assert.match(
    html,
    /Input: not captured: this span belongs to a sealed flow run \(a Secret parameter or secure inputs or outputs\)/,
  );
  // A summary span, whatever the runtime level is now.
  ctx.data.trace.settings = structuredClone(sample.settings);
  ctx.data.trace.spanId = jobSpan.spanId;
  html = trace.render(ctx);
  assert.match(
    html,
    /Output: not captured: this span was recorded at level summary, which keeps attributes and events only\. Choose full under Settings and run the request again to capture the output\./,
  );
  assert.doesNotMatch(html, /opened before level full|or has none/);
});

test('Escape closes the span drawer, except while typing in a field (DV-C-17)', async () => {
  const ctx = traceContext({ responses: traceResponses() });
  trace.route(ctx, new URLSearchParams({ traceId, spanId: stepSpan.spanId }));
  await trace.load(ctx);
  await withDom(async ({ hashes, focused }) => {
    const escape = (found) => uiEvent('keydown', found, { key: 'Escape' });
    assert.equal(trace.handle(ctx, escape({ 'input, select, textarea': { value: 'x' } })), false);
    assert.equal(ctx.data.trace.spanId, stepSpan.spanId);
    assert.equal(trace.handle(ctx, escape({})), true);
    assert.equal(ctx.data.trace.spanId, null);
    assert.deepEqual(focused, [`trace-span-${stepSpan.spanId}`]);
    assert.equal(hashes.at(-1), `#trace?traceId=${traceId}`);
    assert.equal(trace.handle(ctx, escape({})), false, 'nothing to close');
  });
  assert.match(trace.render(ctx), /<button type="button" class="ui-button ui-small" data-trace-copy="id">/);
});

test('the overview names the slowest spans and latest errors, the list the first error, the legend every status (DV-C-11, D-R3-29)', async () => {
  const ctx = traceContext({ responses: traceResponses() });
  await trace.load(ctx);
  const html = trace.render(ctx);
  safeMarkup(html);
  const slowest = html.slice(html.indexOf('id="trace-slowest-title"'), html.indexOf('id="trace-errors-title"'));
  assert.match(
    slowest,
    new RegExp(
      `<li><a href="#trace\\?traceId=${traceId}&amp;spanId=${rootSpan.spanId}"><span[^>]*>http</span> <span class="ui-span-ref-name">POST /_api/x_items</span></a> <span class="ui-help">21\\.0 ms · `,
    ),
  );
  const errors = html.slice(html.indexOf('id="trace-errors-title"'));
  assert.match(
    errors,
    new RegExp(
      `spanId=${jobSpan.spanId}"><span[^>]*>job</span> <span class="ui-span-ref-name">Invented\\.Plugin\\.PostCreate \\(async\\)</span></a>`,
    ),
  );
  assert.match(errors, /<span class="ui-span-ref-error">FX_FAILED: Invented failure<\/span>/);
  // The list row of the failing trace: its first error by span name, code and message.
  assert.match(
    html,
    /<span class="ui-help ui-trace-error" title="FX_FAILED: Invented failure">Invented\.Plugin\.PostCreate \(async\): FX_FAILED: Invented failure<\/span>/,
  );
  // Every status the store records, with its meaning; the filter offers the same five.
  const legend = html.match(/<ul class="ui-status-legend" aria-label="Span statuses">(.*?)<\/ul>/)[1];
  assert.equal(count(legend, /<li>/g), 5);
  const meanings = [...legend.matchAll(/<li><span class="ui-badge [^"]*">([a-z]+)<\/span> ([^<]+)<\/li>/g)];
  assert.deepEqual(meanings.map(([, status]) => status).sort(), [...SPAN_STATUSES].sort());
  assert.ok(
    meanings.every(([, , meaning]) => meaning.trim()),
    'each status says what it means',
  );
  assert.match(legend, /<span class="ui-badge ui-tone-neutral">cancelled<\/span> stopped before it finished/);
  assert.match(html, /<option value="cancelled">cancelled<\/option>/);
  assert.deepEqual(selectOptions(html, 'trace-status').sort(), [...SPAN_STATUSES].sort());
  // The kind filter offers exactly the store's kinds, in its order (anything else is refused with 400).
  assert.deepEqual(selectOptions(html, 'trace-kind'), [...SPAN_KINDS]);
  // An empty store says so instead of listing nothing.
  const empty = traceContext({
    responses: traceResponses({ '/trace/stats': { ...sample.stats, slowest: [], errors: [] } }),
  });
  await trace.load(empty);
  assert.match(
    trace.render(empty),
    /No span has ended\.<\/p><\/section><section aria-labelledby="trace-errors-title"><h3 id="trace-errors-title">Latest errors<\/h3><p class="ui-help">No span ended in error\./,
  );
});

test('a filter the runtime refuses is named in a banner with a way out, not shown as "Any status" over nothing (D-R3-15)', async () => {
  const bogus = refused(400, {
    code: 'InvalidTraceFilter',
    message: 'status must be one of ok, error, denied, cancelled, running (got "bogus").',
    parameter: 'status',
  });
  const ctx = traceContext({ responses: traceResponses({ '/trace': bogus, '/trace/stats': bogus }) });
  trace.route(ctx, new URLSearchParams({ status: 'bogus' }));
  await trace.load(ctx);
  const html = trace.render(ctx);
  safeMarkup(html);
  assert.match(
    html,
    /<p class="ui-notice ui-tone-bad">The Span status \(status\) filter value &quot;bogus&quot; is not valid: status must be one of ok, error, denied, cancelled, running \(got &quot;bogus&quot;\)\. No trace is listed until you change or remove it\.<\/p>/,
  );
  assert.match(
    html,
    /id="trace-unfilter-invalid" data-trace-unfilter="status">Remove the Span status filter<\/button>/,
  );
  assert.match(html, /<option value="bogus" selected>bogus \(not a valid value\)<\/option>/);
  assert.doesNotMatch(html, /<option value="" selected>Any status/);
  assert.doesNotMatch(html, /could not be read/);
  assert.match(html, /data-ui-section="trace:filters" open/);
  // The banner's button removes the filter like its chip.
  await withDom(async ({ hashes }) => {
    ctx.request = async (path) => (
      ctx.requested.push(path),
      path.startsWith('/trace/stats') ? sample.stats : sample.query
    );
    trace.handle(ctx, click('[data-trace-unfilter]', { traceUnfilter: 'status' }));
    await ctx.data.trace.reloading;
    assert.equal(hashes.at(-1), '#trace');
  });
  assert.doesNotMatch(trace.render(ctx), /is not valid/);
  // The search hint lists what search covers.
  assert.match(
    HELP['trace.filters'].fields.search,
    /event types, messages and attributes, and at level full the captured input and output/,
  );
  assert.match(HELP['trace.detail'].fields.spanSearch, /matched like the Search filter/);
});

test("Find spans matches exactly the spans the store's search matches (DV-C-2)", () => {
  const traces = createTraceStore({ settings: { level: 'full' } });
  const root = traces.start({ kind: 'http', name: 'POST /_api/x_orders', module: 'portal' });
  traces.run(root, () => {
    const connector = traces.start({
      kind: 'connector',
      name: 'x_quotes/Quote',
      module: 'connectors',
      input: () => ({ x_name: 'Order SLOW' }),
    });
    connector.event('trace', { message: 'Quote backend unavailable', attributes: { code: 'QuoteBackendDown' } });
    connector.end({ status: 'error' });
    traces.start({ kind: 'flow-action', name: 'Notify', module: 'flows', attributes: { status: 'Skipped' } }).end();
  });
  root.end();
  const tree = traces.tree(root.traceId);
  for (const query of [
    'order slow',
    'backend unavailable',
    'quotebackenddown',
    'skipped',
    'POST /_api',
    'nothing like it',
  ]) {
    const listed = traces
      .spans({ search: query })
      .items.map((span) => span.spanId)
      .sort();
    const found = spanFilter(tree, { spanSearch: query });
    assert.deepEqual([...found.matched].sort(), listed, query);
  }
  // The search text is built once per span object: a later change to the same object does not rebuild it.
  const connector = tree.spans.find((span) => span.name === 'x_quotes/Quote');
  connector.name = 'renamed after the first search';
  assert.deepEqual([...spanFilter(tree, { spanSearch: 'x_quotes/quote' }).matched], [connector.spanId]);
  assert.equal(spanFilter(tree, { spanSearch: 'renamed after' }).matched.size, 0, 'built once per span');
});

test('trace settings save the retention limits as numbers; a smaller retention reloads the list (DV-C-20)', async () => {
  const ctx = traceContext({ responses: traceResponses() });
  await trace.load(ctx);
  const saved = { ...sample.settings, settings: { ...sample.settings.settings, traces: 100, spansPerTrace: 400 } };
  const writes = [],
    notes = [];
  const read = ctx.request;
  ctx.request = (path, init) => {
    if (init?.method) {
      writes.push(JSON.parse(init.body));
      return Promise.resolve(structuredClone(saved));
    }
    return read(path, init);
  };
  ctx.notify = (text) => notes.push(text);
  let done;
  const finished = new Promise((resolve) => (done = resolve));
  ctx.setButtonPending = (button, on) => (on ? true : done());
  ctx.requested.length = 0;
  await withDom(async () => {
    const form = { values: { level: 'full', traces: '100', spansPerTrace: '400', payloadBytes: '16384' } };
    trace.handle(ctx, uiEvent('submit', { '[data-trace-settings]': form }, { submitter: {} }));
    await finished;
    await ctx.data.trace.reloading;
  });
  assert.deepEqual(writes, [{ level: 'full', persist: false, traces: 100, spansPerTrace: 400, payloadBytes: 16384 }]);
  assert.deepEqual(notes, ['Tracing level full; keeps 100 traces, 400 spans per trace, 16384 payload bytes.']);
  assert.deepEqual(ctx.requested, ['/trace?page=1&pageSize=10', '/trace/stats']);
  assert.match(
    trace.render(ctx),
    /id="trace-limit-traces" name="traces" type="number" min="10" max="10000" step="1" required value="100"/,
  );
});

test('the list sits beside the open trace at 1200 px and wider; the filter form stays folded under its chips (DV-C-16)', async () => {
  const ctx = traceContext({ responses: traceResponses() });
  await trace.load(ctx);
  let html = trace.render(ctx);
  assert.match(
    html,
    /<div class="ui-trace-layout"><div class="ui-trace-main"><details class="ui-section" data-ui-section="trace:filters"><summary>/,
  );
  assert.doesNotMatch(html, /ui-trace-side/);
  // Filters, then the list, then the overview: the list is the first thing under the toolbar.
  assert.ok(html.indexOf('data-ui-section="trace:list"') < html.indexOf('data-ui-section="trace:overview"'));
  trace.route(ctx, new URLSearchParams({ kind: 'http', traceId }));
  await trace.load(ctx);
  html = trace.render(ctx);
  // Active filters show as chips; the form opens when the person opens it (the shell remembers that) or a filter is
  // refused, so the list stays in view.
  assert.match(html, /data-trace-unfilter="kind"/);
  assert.match(
    html,
    /<div class="ui-trace-layout has-detail"><div class="ui-trace-main"><details class="ui-section" data-ui-section="trace:filters"><summary>/,
  );
  assert.match(
    html,
    new RegExp(
      `</div><div class="ui-trace-side" data-trace-side="${traceId}\\|"><details class="ui-section" data-ui-section="trace:detail" open>`,
    ),
  );
  assert.match(html, /<th scope="col" class="ui-trace-extra">Tables<\/th>/);
  // The side column scrolls on its own; a re-render (Live, a loaded part, a span search) keeps its position for the same
  // trace, and another trace starts at its top.
  const column = (key, top) => ({ dataset: { traceSide: key }, scrollTop: top });
  let shown = column(`${traceId}|`, 640);
  globalThis.document = { querySelector: (selector) => (selector === '.ui-trace-side' ? shown : null) };
  try {
    trace.render(ctx);
    shown = column(`${traceId}|`, 0);
    trace.mounted(ctx);
    assert.equal(shown.scrollTop, 640);
    trace.render(ctx);
    ctx.data.trace.traceId = 'fx-other';
    shown = column('fx-other|', 0);
    trace.mounted(ctx);
    assert.equal(shown.scrollTop, 0);
  } finally {
    delete globalThis.document;
  }
  const css = await fs.readFile(new URL('../admin/ui-kit.css', import.meta.url), 'utf8');
  const wide = css.slice(css.indexOf('@media (min-width: 1200px)'));
  assert.match(
    wide,
    /\.ui-trace-layout\.has-detail \{\s*display: grid;\s*grid-template-columns: minmax\(0, 5fr\) minmax\(0, 7fr\);/,
  );
  assert.match(
    wide,
    /\.ui-trace-layout\.has-detail \.ui-trace-side \{\s*position: sticky;\s*top: 8px;\s*max-height: calc\(100vh - 16px\);\s*overflow: auto;/,
  );
  // Beside the list the waterfall names take over half the column and wrap rather than being cut (DV-Y8-6).
  const wideOnly = wide.slice(0, wide.indexOf('\n}\n'));
  assert.match(
    wideOnly,
    /\.ui-trace-side \.ui-waterfall-row \{\s*grid-template-columns: minmax\(0, 55%\) minmax\(80px, 1fr\) 84px;/,
  );
  assert.match(wideOnly, /\.ui-trace-side \.ui-waterfall-label \{\s*flex-wrap: wrap;/);
  assert.match(
    wideOnly,
    /\.ui-trace-side \.ui-waterfall-name \{\s*min-width: min\(100%, 8em\);\s*white-space: normal;\s*overflow-wrap: anywhere;/,
  );
  const phone = css.slice(css.indexOf('@media (max-width: 600px)'));
  assert.match(
    phone,
    /\.ui-waterfall-name,\s*\.ui-trace-root \.ui-trace-name,\s*\.ui-trace-origin,\s*\.ui-tree-span \{\s*white-space: normal;\s*overflow-wrap: anywhere;/,
  );
});

test('the /_sim/ admin follows the system dark theme through tokens only; the light theme is unchanged (DV-C-18)', async () => {
  const read = (name) => fs.readFile(new URL(`../admin/${name}`, import.meta.url), 'utf8');
  const kitCss = await read('ui-kit.css');
  const dark = kitCss.slice(kitCss.indexOf('@media (prefers-color-scheme: dark)'));
  assert.match(
    dark,
    /^@media \(prefers-color-scheme: dark\) \{\s*:root\[data-ui-theme='auto'\] \{\s*color-scheme: dark;/,
  );
  const defined = new Map([...dark.matchAll(/(--[\w-]+): (#[0-9a-f]{6});/g)].map((match) => [match[1], match[2]]));
  // Every colour token a sheet uses carries its light value as fallback and has a dark value.
  for (const name of ['ui-kit.css', 'shell.css', 'style.css', 'dashboard.css', 'persona-picker.css']) {
    const css = name === 'ui-kit.css' ? kitCss.slice(0, kitCss.indexOf('/* Dark theme')) : await read(name);
    assert.doesNotMatch(css, /@media \(prefers-color-scheme/, `${name}: dark values live in ui-kit.css only`);
    for (const [, role, hex, fallback] of css.matchAll(/var\(--ui-([clt])-([0-9a-f]{6}), ([^)]+)\)/g)) {
      assert.ok(defined.has(`--ui-${role}-${hex}`), `${name}: --ui-${role}-${hex} has a dark value`);
      const literal = fallback.toLowerCase();
      const expanded =
        literal === 'white'
          ? '#ffffff'
          : literal.length === 4
            ? `#${[...literal.slice(1)].map((c) => c + c).join('')}`
            : literal;
      assert.equal(expanded, `#${hex}`, `${name}: the fallback is the light value`);
    }
    // Translucent pale surfaces (the map bands) keep their alpha and turn dark.
    for (const [, hex, alpha, r, g, b, a] of css.matchAll(
      /var\(--ui-c-([0-9a-f]{6})-a(\d+), rgba\((\d+), (\d+), (\d+), ([\d.]+)\)\)/g,
    )) {
      assert.equal([r, g, b].map((c) => Number(c).toString(16).padStart(2, '0')).join(''), hex, name);
      assert.equal(Math.round(Number(a) * 100), Number(alpha), name);
      const value = dark.match(new RegExp(`--ui-c-${hex}-a${alpha}: rgba\\((\\d+), (\\d+), (\\d+), ([\\d.]+)\\);`));
      assert.ok(value, `${name}: --ui-c-${hex}-a${alpha} has a dark value`);
      assert.ok(Math.max(...value.slice(1, 4).map(Number)) < 80, `${name}: --ui-c-${hex}-a${alpha} is dark`);
    }
  }
  // Readable pairs in the dark theme (WCAG AA for text).
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((at) => {
      const c = parseInt(hex.slice(at, at + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const surface = defined.get('--ui-surface');
  assert.ok(luminance(surface) < 0.05, 'surfaces turn dark');
  for (const token of ['--ui-ink', '--ui-muted', '--ui-accent', '--ui-ok', '--ui-warn', '--ui-bad', '--ui-info'])
    assert.ok(ratio(defined.get(token), surface) >= 4.5, `${token} on --ui-surface`);
  assert.ok(ratio(defined.get('--ui-on-accent'), defined.get('--accent')) >= 4.5, 'primary button text');
  const html = await read('index.html');
  assert.match(html, /<html lang="en" data-ui-theme="auto">/);
  assert.match(html, /<meta name="color-scheme" content="light dark" \/>/);
});

test('the trace store sits in the Monitor group of the system map (DV-C-19)', () => {
  const product = PRODUCT_OF('org:trace', 'org', 'Tracing');
  assert.deepEqual([product.band, product.group, product.name], ['organization', 'monitor', 'Tracing']);
});
