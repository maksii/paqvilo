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
  view as activity,
  traceQuery,
  auditQuery,
  hashOf,
  previousWindow,
  duration,
  whoText,
  whoFilters,
  whyOf,
  tabsFor,
  spanFilter,
  compareTrees,
  FILTERS,
  MODULES,
  LIVE_INTERVAL_MS,
} from '../admin/view-activity.mjs';
import { PRODUCT_OF } from '../admin/dashboard-map.mjs';
import { createTraceStore, SPAN_KINDS, SPAN_STATUSES } from '../lib/trace-store.mjs';
import { bar, tabs } from '../admin/ui-kit.mjs';
import fs from 'node:fs/promises';

const sample = JSON.parse(await fs.readFile(new URL('./fixtures/trace-sample.json', import.meta.url), 'utf8'));
const activitySample = JSON.parse(
  await fs.readFile(new URL('./fixtures/activity-sample.json', import.meta.url), 'utf8'),
);

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
  // D-M-7: no title block. The visually hidden H1 is the sidebar label and takes focus on landing; the view's
  // "How this works" is one (i) that the shell moves next to the breadcrumb.
  assert.match(html, /<h1 id="view-title" class="ui-sr-only" tabindex="-1">Providers &amp; services<\/h1>/);
  assert.match(
    html,
    /<span class="ui-info ui-chrome-help" data-chrome-help><button type="button" class="ui-info-button" aria-label="About Providers &amp; services">i<\/button>/,
  );
  assert.doesNotMatch(services.render({ ...ctx, group: () => 'Platform' }), /class="eyebrow"|class="ui-guide"/);
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
  // Panel help (D-M-6): no visible sentence; the whole text and the doc link sit behind one (i) named after the panel.
  assert.match(
    html,
    /<p class="ui-section-help"><span class="ui-info"><button type="button" class="ui-info-button" aria-label="About Messaging" aria-describedby="help-services-messaging">i<\/button><span class="ui-info-pop" role="tooltip" id="help-services-messaging"><span class="ui-info-text">The local message bus: [^<]*Service endpoints[^<]*<\/span><span class="ui-info-docs"><a class="ui-doc" href="https:\/\/git\.example\.test\/invented\/paqvilo\/blob\/v0\.9\.4\/mirage\/docs\/messaging-and-outbox\.md#local-message-bus"/,
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
  // D-M-7: the runs table is the page (no section around it); its filters are a drawer opened from the toolbar.
  assert.equal(openCount(html), 0);
  assertTables(html, ['flow-runs', 'flow-waits', 'flow-job-errors', 'flow-async', 'flow-webhooks']);
  for (const id of ['waits', 'background', 'webhooks']) assert.match(html, new RegExp(`id="help-flows-${id}"`));
  // D-M-8: the count is in the bottom controls bar, not at the top left.
  assert.match(html, /<span class="ui-table-count">2 results<\/span>/);
  assert.doesNotMatch(html, /<span class="ui-page-summary">2 runs/);
  assert.match(
    html,
    /data-filter-toggle="flows-filters" aria-controls="flows-filters" aria-expanded="false">Filters<\/button>/,
  );
  assert.match(
    html,
    /<aside class="ui-filter-drawer" id="flows-filters" aria-labelledby="flows-filters-title" hidden>.*<form id="flow-runs-form"/s,
  );
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
  assert.equal(openCount(html), 0);
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
  assert.match(
    html,
    /<span class="ui-info-pop ui-field-help" role="tooltip" id="cap-level-help">Only records at this level/,
  );
  // Columns whose values are jargon explain them behind an (i) in the header; Source inventory has its own help.
  assert.match(
    html,
    // Every data column sorts (DV-N4c-1): the label is the sort button.
    /<th scope="col" aria-sort="none"><button type="button" class="ui-sort" data-table-sort="cap-modules" data-sort-key="col-2">Level<span class="ui-sort-mark" aria-hidden="true">↕<\/span><\/button><span class="ui-info"><button type="button" class="ui-info-button" aria-label="About Level">i<\/button><span class="ui-info-pop" role="tooltip"><span class="ui-info-text">inventory: listed from source only\./,
  );
  assert.match(
    html,
    /id="help-capabilities-inventory"><span class="ui-info-text">Solution components Paqvilo reads but does not host/,
  );
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
  assert.match(
    html,
    /<th scope="col" aria-sort="none"><button[^>]*>Pack<span class="ui-sort-mark" aria-hidden="true">↕<\/span><\/button><\/th><th scope="col" aria-sort="none"><button[^>]*>Source<span class="ui-sort-mark" aria-hidden="true">↕<\/span><\/button><span class="ui-info">/,
  );
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
    [services, flows, capabilities, packs, activity].map((item) => [
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
      ['activity', 'Activity', '⋔', '/__sim/api/trace', 'power-pages,standalone'],
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

// ---- Activity (`#activity`): trace-sample.json is a real trace-store answer (query, stats, settings, tree);
// activity-sample.json holds the audit, log, findings, render-source and page answers in N1's shapes.
const withAudit = (summary) => ({ ...summary, auditId: activitySample.auditIds[summary.traceId] ?? null });
const activityQuery = {
  ...sample.query,
  items: [...sample.query.items.map(withAudit), activitySample.throw],
  total: 3,
};
const traceId = sample.tree.trace.traceId;
const traceTree = { ...sample.tree, trace: withAudit(sample.tree.trace) };
/** A tree answer with nested `children` built from its flat spans. */
function nested(tree) {
  const nodes = new Map(tree.spans.map((span) => [span.spanId, { ...span, children: [] }]));
  const children = [];
  for (const node of nodes.values()) (nodes.get(node.parentSpanId)?.children ?? children).push(node);
  return { ...tree, children };
}
const pageTree = nested(activitySample.pageTree);
const pageQuery = {
  items: [{ ...activitySample.pageTree.trace, root: activitySample.pageTree.root }],
  total: 1,
  page: 1,
  pageSize: 200,
  pageCount: 1,
};
/** Answers by full path first, then by path without the query. */
const activityResponses = (overrides = {}) => ({
  '/trace': activityQuery,
  '/trace?kind=render&pageSize=200': pageQuery,
  '/trace/stats': sample.stats,
  '/trace/settings': sample.settings,
  [`/trace/id/${traceId}`]: traceTree,
  '/trace/id/fx-page': pageTree,
  '/audit': activitySample.audit,
  '/logs': activitySample.logs,
  '/diagnostics': activitySample.diagnostics,
  '/render-sources': activitySample.renderSources,
  ...overrides,
});
/** The shared fake context with a pager per key, the workspace state and the host's channels. */
const activityContext = ({ responses = activityResponses(), state = activitySample.state, ...options } = {}) => {
  const ctx = context({ responses, state, ...options });
  const pagers = new Map();
  ctx.pager = (key) => {
    if (!pagers.has(key)) pagers.set(key, { page: 1, size: 10, search: '' });
    return pagers.get(key);
  };
  ctx.eventChannels = () => state?.status?.eventChannels ?? null;
  ctx.request = async (path) => {
    ctx.requested.push(path);
    const answer = responses[path] ?? responses[path.split('?')[0]];
    if (answer instanceof Error) throw answer;
    return structuredClone(answer ?? {});
  };
  return ctx;
};
const STANDALONE = { status: { routes: ['/trace', '/diagnostics', '/dashboard'], eventChannels: ['trace'] } };
const stepSpan = sample.tree.spans.find((span) => span.kind === 'plugin-step');
const jobSpan = sample.tree.spans.find((span) => span.kind === 'job');
const rootSpan = sample.tree.spans.find((span) => span.kind === 'http');
const sdkSpan = sample.tree.spans.find((span) => span.kind === 'sdk-call');
const dataverseSpan = sample.tree.spans.find((span) => span.kind === 'dataverse');
/** A delegated event whose target answers `closest(selector)` from `found`. */
const uiEvent = (type, found, extra = {}) => ({
  type,
  preventDefault() {},
  ...extra,
  target: { closest: (selector) => found[selector] ?? null },
});
const click = (selector, dataset) => uiEvent('click', { [selector]: { dataset } });
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
/** A failure as ctx.request throws it for a JSON error answer. */
const refused = (status, error) => Object.assign(new Error(error.message), { status, details: { error } });
/** Installs fake history, FormData and document.getElementById (recording focus) for the duration of `run`. */
async function withDom(run, rows = []) {
  const hashes = [],
    focused = [];
  globalThis.history = { replaceState: (state, title, url) => hashes.push(url) };
  globalThis.FormData = FakeFormData;
  globalThis.document = {
    getElementById: (id) => ({ focus: () => focused.push(id), select() {} }),
    querySelectorAll: (selector) => (selector === '[data-activity-open]' ? rows : []),
  };
  try {
    await run({ hashes, focused });
  } finally {
    delete globalThis.history;
    delete globalThis.FormData;
    delete globalThis.document;
  }
}
/** Runs `run` with the process time zone set to `zone`. */
async function inZone(zone, run) {
  const saved = process.env.TZ;
  process.env.TZ = zone;
  try {
    await run();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}
/** A trace tree of `count` spans chained parent to child, one module each (cycling through `modules`). */
function chainTree(count, modules = MODULES) {
  const id = 'fx-chain';
  const spans = Array.from({ length: count }, (_, index) => ({
    traceId: id,
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
  return nested({
    trace: { traceId: id, startedAt: spans[0].startedAt, durationMs: count, totalDurationMs: count, spanCount: count },
    root: spans[0],
    spans,
  });
}
class FakeEventSource {
  static CLOSED = 2;
  static made = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    FakeEventSource.made.push(this);
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
/** Runs `run` with a fake EventSource (and fetch answering `status`), restoring both after. */
async function withStreams(run, status = 404) {
  const saved = { EventSource: globalThis.EventSource, fetch: globalThis.fetch };
  const fetched = [];
  FakeEventSource.made = [];
  globalThis.EventSource = FakeEventSource;
  globalThis.fetch = async (url) => {
    fetched.push(url);
    return { status, body: { cancel: async () => {} } };
  };
  try {
    await run({ sources: FakeEventSource.made, fetched });
  } finally {
    Object.assign(globalThis, saved);
  }
}

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

test('an empty runtime shows the guided empty state; a host without activity says so (D-M-3)', async () => {
  const empty = { items: [], total: 0, page: 1, pageSize: 10, pageCount: 1, retained: 0, dropped: 0 };
  const ctx = activityContext({ responses: activityResponses({ '/trace': empty }) });
  await activity.load(ctx);
  let html = activity.render(ctx);
  safeMarkup(html);
  // The page chrome (D-M-7): the H1 stays for focus but is visually hidden; filters open in the drawer.
  assert.match(html, /<h1 id="view-title" class="ui-sr-only" tabindex="-1">Activity<\/h1>/);
  assert.match(html, /data-filter-toggle="activity-filter-drawer"/);
  assert.match(html, /<aside class="ui-filter-drawer" id="activity-filter-drawer"[^>]*hidden>/);
  // Nothing recorded yet: three steps, then where the startup findings are.
  assert.match(
    html,
    /<strong>Nothing recorded yet\.<\/strong><span class="ui-info">.*?<\/span><\/span><\/p><ol><li><a href="\/" target="_blank" rel="noopener">Open the portal ↗<\/a><\/li>/,
  );
  assert.match(html, /<li><a href="#access">Sign in as a test person ↗<\/a><\/li>/);
  assert.match(html, /<li>Activity appears here: select Live to follow it, or Refresh\.<\/li>/);
  // Only findings raised outside any activity count as startup findings (1 of the 3).
  assert.match(html, /Startup findings \(1\) are under <a href="#activity\?tab=findings">Findings<\/a>\./);
  assert.doesNotMatch(html, /data-ui-section="activity:detail"/);
  for (const id of ['activities']) assert.match(html, new RegExp(`id="help-activity-${id}"`));
  assert.match(html, /data-ui-section="activity:settings">/, 'settings start collapsed');
  // A filtered empty list says how to widen it instead of the guide.
  activity.route(ctx, new URLSearchParams({ result: 'denied' }));
  await activity.load(ctx);
  assert.match(activity.render(ctx), /No activity matches these filters\. Clear a filter, or widen the time range\./);
  // An id filter says how ids match (DV-N4-3).
  activity.route(ctx, new URLSearchParams({ who: 'visitor:accb980f' }));
  await activity.load(ctx);
  assert.match(
    activity.render(ctx),
    /Ids match by a prefix of 8 or more characters, tables by logical or entity set name/,
  );

  const missing = Object.assign(new Error('Not found'), { status: 404 });
  const bare = activityContext({
    responses: { '/trace': missing, '/trace/stats': missing, '/trace/settings': missing },
    state: STANDALONE,
  });
  await activity.load(bare);
  html = activity.render(bare);
  safeMarkup(html);
  assert.match(html, /Activities could not be read: Not found \(HTTP 404\)/);
  assert.match(html, /Tracing settings could not be read: Not found \(HTTP 404\)/);
});

test('Activities rows merge the audit facts, and a 500 row shows its error code (D-M-3, M2 §7 defect 7)', async () => {
  const ctx = activityContext();
  await activity.load(ctx);
  // One audit read for the whole page, by the listed trace ids.
  const audit = ctx.requested.filter((path) => path.startsWith('/audit'));
  assert.deepEqual(audit, [
    `/audit?traceId=${encodeURIComponent(activityQuery.items.map((item) => item.traceId).join(','))}&pageSize=100`,
  ]);
  const html = activity.render(ctx);
  safeMarkup(html);
  const list = html.slice(html.indexOf('data-table="activity-list"'));
  const headings = [...list.slice(0, list.indexOf('</thead>')).matchAll(/<th\b[^>]*>(?:<button[^>]*>)?([^<]*)/g)].map(
    (match) => match[1].trim(),
  );
  assert.deepEqual(headings, ['Time', 'Result', 'Activity', 'Duration', 'Steps', 'Errors', 'Audit', 'Compare']);
  // The 500: its result, HTTP badge and the first failed step's code, though the audit entry carries no error.
  const row = list.slice(list.indexOf('<tr data-activity-row="fx-throw"'));
  assert.match(
    row,
    /<span class="ui-badge ui-tone-bad">error<\/span> <span class="ui-badge ui-tone-bad">HTTP 500<\/span>/,
  );
  assert.match(row, /title="Invented\.Plugin\.Throw: 0x80040224: Pre-validation crashed"/);
  assert.match(row, /<td class="ui-trace-extra">live<\/td>/);
  // The create: provider, rows and its one read; the denied read: the portal error code.
  assert.match(list, /<td class="ui-trace-extra">local · 1 row · 1 read<\/td>/);
  assert.match(list, /<td class="ui-trace-extra">local · portal 90040120<\/td>/);
  // Who (D-M-2): name and contact, a visitor by its id.
  // Who is a link that filters by exactly that caller (the full id is in its address and title).
  assert.match(
    list,
    /<a class="ui-activity-who" href="#activity\?who=contact%3Ac0ffee00-0000-4000-8000-000000000001&amp;whoName=Invented\+Contact" title="Only activities of contact:c0ffee00-0000-4000-8000-000000000001">Invented Contact · contact:c0ffee00<\/a> · power-pages/,
  );
  assert.match(list, /href="#activity\?who=visitor%3Avisitor-2"[^>]*>Visitor visitor-<\/a> · power-pages/);
  assert.doesNotMatch(list, /\bsuccess\b/, 'the audit outcome reads as a result word');
  // Show reads lists the audit reads under their activity, each opening its own step.
  await withDom(async ({ hashes }) => {
    activity.handle(ctx, click('[data-activity-action]', { activityAction: 'reads' }));
    assert.equal(hashes.at(-1), '#activity?reads=1');
  });
  const reads = activity.render(ctx);
  assert.match(
    reads,
    new RegExp(`<tr class="is-read">.*?href="#activity/${traceId}/d654c55e-0000-4000-8000-000000000000\\?reads=1">`),
  );
  assert.match(reads, /entity-query<\/span> x_category<\/a><span class="ui-help ui-trace-origin">local · 3 rows</);
  assert.equal(whoText({ kind: 'anonymous', id: null, name: 'Anonymous' }, null), 'Anonymous');
  assert.equal(whoText({ kind: 'staff', id: 'a4300000-1111', name: null }, null), 'staff:a4300000');
  assert.equal(whoText(null, { visitorId: 'v1234567890', sessionKey: null }), 'Visitor v1234567');
  assert.equal(whoText(null, null), '—');
});

test('a Who chip names the caller a link named; the log type is a drawer filter (DV-N4b-6, DV-N4b-10)', async () => {
  const ctx = activityContext();
  // Backend operations links a plug-in step by its actor and names it: the chip shows the name, the address keeps both.
  activity.route(
    ctx,
    new URLSearchParams({
      actorKind: 'plugin',
      actorId: 'e2e00000-0000-4000-8000-000000000011',
      whoName: 'Order pre-validation',
    }),
  );
  await activity.load(ctx);
  let html = activity.render(ctx);
  assert.match(html, /aria-label="Remove filter Who: Order pre-validation · plugin:e2e00000"/);
  assert.equal(
    hashOf(ctx.data.activity),
    'activity?who=plugin%3Ae2e00000-0000-4000-8000-000000000011&whoName=Order+pre-validation',
  );
  // Without a name the chip says kind and short id; removing the Who filter drops its name.
  activity.route(ctx, new URLSearchParams({ who: 'plugin:e2e00000-0000-4000-8000-000000000011' }));
  assert.match(activity.render(ctx), /aria-label="Remove filter Who: plugin:e2e00000"/);
  await withDom(async () => {
    activity.route(ctx, new URLSearchParams({ who: 'plugin:x', whoName: 'Order pre-validation' }));
    activity.handle(ctx, click('[data-activity-unfilter]', { activityUnfilter: 'who' }));
  });
  assert.equal(ctx.data.activity.whoName, null);
  // The Log stream's type sits in the filter drawer and applies like any choice.
  activity.route(ctx, new URLSearchParams({ tab: 'log' }));
  await activity.load(ctx);
  html = activity.render(ctx);
  assert.match(
    html,
    /<aside class="ui-filter-drawer"[^]*<select id="activity-log-type" name="type" data-activity-select/,
  );
  await withDom(async ({ hashes }) => {
    activity.handle(
      ctx,
      uiEvent('change', {
        '[data-activity-filters] [data-activity-select]': {},
        '[data-activity-select]': { name: 'type', value: 'request' },
      }),
    );
    assert.equal(hashes.at(-1), '#activity?tab=log&type=request');
  });
  // The lines come first; the counts, pager and help sit under them (D-M-7).
  html = activity.render(ctx);
  const panel = html.slice(html.indexOf('id="activity-tabs-panel"'));
  assert.ok(panel.indexOf('data-table="activity-log"') < panel.indexOf('class="ui-table-foot"'));
  assert.match(panel, /^[^>]*><div class="ui-data-table" data-data-table="activity-log">/);
});

test('with tracing off, Live follows the request audit through the log channel, or says it needs tracing (DV-N4b-4)', async () => {
  const off = { ...sample.settings, settings: { ...sample.settings.settings, level: 'off' } };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await withStreams(async ({ sources }) => {
      const ctx = activityContext({ responses: activityResponses({ '/trace/settings': off }) });
      activity.route(ctx, new URLSearchParams({ live: '1' }));
      await activity.load(ctx);
      const log = sources.find((source) => source.url === '/__sim/events?channels=logs');
      assert.ok(log, sources.map((source) => source.url).join());
      log.emit('open');
      assert.match(activity.render(ctx), /role="status">Following the request audit · Streaming</);
      // A finished request reads the audit list again (once per interval); other lines do not.
      ctx.requested.length = 0;
      log.emit(
        'log',
        JSON.stringify({ sequence: 99, type: 'startup', time: '2026-10-22T09:00:09.000Z', level: 'info' }),
      );
      mock.timers.tick(LIVE_INTERVAL_MS);
      await ctx.data.activity.reloading;
      assert.deepEqual(ctx.requested, []);
      log.emit('log', JSON.stringify({ ...activitySample.logs.items[2], sequence: 100 }));
      mock.timers.tick(LIVE_INTERVAL_MS);
      await ctx.data.activity.reloading;
      assert.deepEqual(ctx.requested, ['/audit?page=1&pageSize=10']);
      activity.leave(ctx);
    });
    // A host without the log channel cannot follow the audit: Live says tracing is needed.
    await withStreams(async ({ sources }) => {
      const state = {
        status: { ...activitySample.state.status, eventChannels: ['trace'], routes: ['/trace', '/audit'] },
      };
      const ctx = activityContext({ responses: activityResponses({ '/trace/settings': off }), state });
      activity.route(ctx, new URLSearchParams({ live: '1' }));
      await activity.load(ctx);
      assert.ok(!sources.some((source) => source.url.includes('channels=logs')));
      assert.match(activity.render(ctx), /role="status">Live needs tracing on \(⚙ Settings\)</);
      activity.leave(ctx);
    });
  } finally {
    mock.timers.reset();
  }
});

test('filters round-trip through the address; #activity alone is unfiltered (D-M-3, M2 §7 defect 3)', async () => {
  const ctx = activityContext();
  const link = new URLSearchParams({
    range: '15m',
    result: 'error,denied',
    who: 'contact:c0ffee00',
    table: 'x_item',
    recordId: 'item-1',
    host: 'power-pages',
    q: 'REJECT',
    kind: 'plugin-step',
    live: '1',
    tab: 'stats',
  });
  activity.route(ctx, link, [traceId, stepSpan.spanId]);
  const d = ctx.data.activity;
  assert.deepEqual(
    [d.range, d.filters.result, d.filters.who, d.tab, d.live, d.traceId, d.spanId],
    ['15m', 'error,denied', 'contact:c0ffee00', 'stats', true, traceId, stepSpan.spanId],
  );
  // The address of that state is the link it came from: the open activity and step as path segments.
  const hash = hashOf(d);
  assert.equal(
    hash,
    `activity/${traceId}/${stepSpan.spanId}?range=15m&result=error%2Cdenied&who=contact%3Ac0ffee00&table=x_item&recordId=item-1&host=power-pages&q=REJECT&kind=plugin-step&tab=stats&live=1`,
  );
  const [path, query] = hash.split('?');
  const again = activityContext();
  activity.route(again, new URLSearchParams(query), path.split('/').slice(1));
  assert.equal(hashOf(again.data.activity), hash);
  // The store query: result as is, who as actor kind and id, table as entity, q as search, range as from.
  const store = traceQuery(d, Date.parse('2026-10-22T10:00:00Z'));
  assert.equal(
    store.toString(),
    'result=error%2Cdenied&actorKind=contact&actorId=c0ffee00&entity=x_item&recordId=item-1&host=power-pages&search=REJECT&kind=plugin-step&from=2026-10-22T09%3A45%3A00.000Z',
  );
  assert.deepEqual(whoFilters('visitor:accb980f'), { visitorId: 'accb980f' });
  assert.deepEqual(whoFilters('anonymous'), { actorKind: 'anonymous' });
  assert.deepEqual(whoFilters('c0ffee00'), { actorId: 'c0ffee00' });
  // Older keys from #trace links (and the CLI) land on the new ones.
  activity.route(
    ctx,
    new URLSearchParams({
      entity: 'x_order',
      search: 'slow',
      sessionKey: 'visitor:v1',
      actorKind: 'staff',
      actorId: 's1',
    }),
  );
  assert.deepEqual(
    [d.filters.table, d.filters.q, d.filters.session, d.filters.who, d.traceId, d.live, d.tab],
    ['x_order', 'slow', 'visitor:v1', 'staff:s1', null, false, 'activities'],
  );
  assert.equal(hashOf(d), 'activity?who=staff%3As1&table=x_order&q=slow&session=visitor%3Av1');
  // The audit keys #audit links carry map to the audit query (the shell's redirect keeps them).
  activity.route(
    ctx,
    new URLSearchParams({
      path: '/order/',
      provider: 'live',
      auditKind: 'page',
      httpStatus: '5xx',
      result: 'ok',
      who: 'c0ffee00',
      auditId: 'fx-a',
    }),
  );
  assert.equal(
    auditQuery(d).toString(),
    'path=%2Forder%2F&provider=live&kind=page&status=5xx&contactId=c0ffee00&correlationId=fx-a&outcome=success',
  );
  // A visitor (or a session) filters the audit by the browser session its entries name.
  activity.route(ctx, new URLSearchParams({ path: '/order/', who: 'visitor:ad87d220' }));
  assert.equal(auditQuery(d).toString(), 'path=%2Forder%2F&sessionKey=visitor%3Aad87d220');
  activity.route(ctx, new URLSearchParams({ path: '/order/', session: 'contact:c0ffee00' }));
  assert.equal(auditQuery(d).toString(), 'path=%2Forder%2F&sessionKey=contact%3Ac0ffee00');
  // `#activity` alone is the unfiltered list with nothing open: no sticky state (the open activity included).
  activity.route(ctx, new URLSearchParams({ result: 'error' }), [traceId]);
  d.sort = { by: 'duration', order: 'asc' };
  activity.route(ctx, new URLSearchParams());
  assert.deepEqual(
    FILTERS.filter((name) => d.filters[name]),
    [],
  );
  assert.deepEqual(
    [d.range, d.sort.by, d.traceId, d.spanId, d.compare, d.tab, d.live],
    ['all', 'start', null, null, null, 'activities', false],
  );
  assert.equal(hashOf(d), 'activity');
  // Submitting the bar puts exactly the filters in the address, then loads.
  await activity.load(ctx);
  await withDom(async ({ hashes }) => {
    const form = { values: { range: 'all', result: 'error', who: '', table: ' x_item ', q: '' } };
    ctx.requested.length = 0;
    assert.equal(activity.handle(ctx, uiEvent('submit', { '[data-activity-filters]': form })), true);
    await ctx.data.activity.reloading;
    assert.deepEqual(hashes, ['#activity?result=error&table=x_item']);
    assert.ok(ctx.requested.includes('/trace?result=error&entity=x_item&page=1&pageSize=10'), ctx.requested.join());
    // A choice in the bar applies at once.
    activity.handle(
      ctx,
      uiEvent('change', {
        '[data-activity-filters] [data-activity-select]': {},
        '[data-activity-select]': { name: 'host', value: 'dataverse-api' },
      }),
    );
    await ctx.data.activity.reloading;
    assert.equal(hashes.at(-1), '#activity?result=error&table=x_item&host=dataverse-api');
  });
});

test('the Why line names the first failed or denied step, before anything else (D-M-3)', async () => {
  // The store's firstError wins; else the deepest failed step; else how it ended.
  assert.deepEqual(
    whyOf({
      trace: { ...activitySample.throw },
      spans: [
        {
          spanId: 'fx-throw-step',
          kind: 'plugin-step',
          name: 'Invented.Plugin.Throw',
          status: 'error',
          depth: 4,
          error: { code: '0x80040224', message: 'Pre-validation crashed' },
        },
      ],
    }),
    {
      tone: 'bad',
      text: 'plug-in step “Invented.Plugin.Throw” failed: 0x80040224: Pre-validation crashed',
      spanId: 'fx-throw-step',
    },
  );
  const permission = {
    spanId: 'fx-perm',
    kind: 'permission',
    name: 'read x_secret',
    status: 'denied',
    depth: 1,
    sequence: 2,
    events: [{ type: 'permission', message: 'No table permission grants read.', attributes: { result: 'deny' } }],
  };
  assert.deepEqual(whyOf({ trace: { status: 'denied' }, spans: [permission] }), {
    tone: 'warn',
    text: 'permission check “read x_secret” was denied: No table permission grants read.',
    spanId: 'fx-perm',
  });
  assert.equal(
    whyOf({ trace: { status: 'ok', durationMs: 9 }, root: { attributes: { statusCode: 200 } }, spans: [] }).text,
    'Ended ok with HTTP 200 in 9.00 ms; no step failed.',
  );
  assert.equal(whyOf({ trace: { status: 'running' }, spans: [{}, {}] }).text, 'Still running: 2 steps so far.');
  // In the detail pane the Why line is the first thing under the heading, linking to its step.
  const ctx = activityContext();
  activity.route(ctx, new URLSearchParams(), [traceId]);
  await activity.load(ctx);
  const html = activity.render(ctx);
  const detail = html.slice(html.indexOf('data-ui-section="activity:detail"'));
  assert.ok(detail.indexOf('id="activity-why"') < detail.indexOf('<dl class="ui-kv">'), 'Why comes before the facts');
  assert.match(
    detail,
    new RegExp(
      `<p class="ui-notice ui-tone-bad ui-activity-why" id="activity-why"><strong>Why:</strong> job “Invented\\.Plugin\\.PostCreate \\(async\\)” failed: FX_FAILED: Invented failure <a href="#activity/${traceId}/${jobSpan.spanId}" id="activity-why-step">Show this step</a></p>`,
    ),
  );
});

test('tabs follow what the host serves; the standalone host has no Log stream and says so (D-M-1, D-M-3)', async () => {
  const ctx = activityContext();
  assert.deepEqual(
    tabsFor(ctx).map(([id]) => id),
    ['activities', 'log', 'findings', 'pages', 'stats'],
  );
  await activity.load(ctx);
  let html = activity.render(ctx);
  assert.match(html, /role="tablist" aria-label="Activity workspace"/);
  assert.match(html, /id="activity-tabs-tab-findings" aria-selected="false"[^>]*>Findings \(3\)<\/button>/);
  assert.doesNotMatch(html, /has no server log stream/);
  const standalone = activityContext({ state: STANDALONE });
  assert.deepEqual(
    tabsFor(standalone).map(([id]) => id),
    ['activities', 'findings', 'stats'],
  );
  await activity.load(standalone);
  html = activity.render(standalone);
  assert.match(html, /No server log stream on this host\./);
  assert.doesNotMatch(html, /activity-tabs-tab-log|activity-tabs-tab-pages/);
  assert.ok(
    !standalone.requested.some((path) => /^\/(audit|logs|render-sources)/.test(path)),
    standalone.requested.join(),
  );
  // A `tab=log` link on that host shows Activities; the bundle export needs /activity, so only activity files remain.
  activity.route(standalone, new URLSearchParams({ tab: 'log' }));
  html = activity.render(standalone);
  assert.match(html, /id="activity-tabs-tab-activities" aria-selected="true"/);
  assert.doesNotMatch(html, /value="bundle"/);
  assert.match(html, /href="\/__sim\/api\/trace\/export\?format=ndjson" download aria-label="Export filtered">/);
  // Keys that do not apply to the open tab stay as chips, dimmed, and say so.
  activity.route(ctx, new URLSearchParams({ tab: 'findings', table: 'x_item', q: 'denied' }));
  html = activity.render(ctx);
  assert.match(
    html,
    /class="ui-chip is-dimmed" id="activity-chip-table"[^>]*aria-label="Remove filter Table: x_item \(does not apply to Findings\)" title="Does not apply to Findings">/,
  );
  assert.match(html, /class="ui-chip" id="activity-chip-q"/);
  // Arrow keys move between the tabs the host serves, and the address follows.
  await withDom(async ({ hashes }) => {
    activity.handle(
      ctx,
      uiEvent(
        'keydown',
        { '[role="tab"][data-tab]': { dataset: { tab: 'activity-tabs', tabId: 'findings' } } },
        { key: 'ArrowRight' },
      ),
    );
    assert.equal(ctx.data.activity.tab, 'pages');
    assert.equal(hashes.at(-1), '#activity?table=x_item&q=denied&tab=pages');
  });
});

test('tracing off: Activities lists the request audit with a banner; audit-only filters read the audit too (D-M-3)', async () => {
  const off = { ...sample.settings, settings: { ...sample.settings.settings, level: 'off' } };
  const ctx = activityContext({ responses: activityResponses({ '/trace/settings': off }) });
  await activity.load(ctx);
  assert.ok(ctx.requested.includes('/audit?page=1&pageSize=10'), ctx.requested.join());
  assert.ok(!ctx.requested.some((path) => path.startsWith('/trace?')), 'no trace list while tracing is off');
  let html = activity.render(ctx);
  safeMarkup(html);
  assert.match(html, /Tracing is off: showing the request audit only; turn it on in ⚙ Settings to see steps\./);
  // Never a blank page: each entry, its result word, HTTP status and error, linking to its activity when it has one.
  assert.match(
    html,
    new RegExp(
      `<a href="#activity/${traceId}/${rootSpan.spanId}" id="activity-audit-fx-audit-create">POST /_api/x_items</a>`,
    ),
  );
  assert.match(
    html,
    /<span class="ui-badge ui-tone-warn">denied<\/span> <span class="ui-badge ui-tone-warn">HTTP 403<\/span>/,
  );
  assert.match(html, /TABLE_PERMISSION_DENIED: No table permission grants read\./);
  // An anonymous entry names its visitor (the browser session the audit records), with a link to its activities.
  assert.match(
    html,
    /<a class="ui-activity-who" href="#activity\?who=visitor%3Aad87d220-0000-4000-8000-000000000002"[^>]*>Visitor ad87d220<\/a> · x_secret/,
  );
  assert.doesNotMatch(html, />Anonymous</);
  // The Lense link `#audit?path=/order/` arrives as `#activity?path=/order/`: the audit, filtered by path.
  const on = activityContext();
  activity.route(on, new URLSearchParams({ path: '/order/' }));
  await activity.load(on);
  assert.ok(on.requested.includes('/audit?page=1&pageSize=10&path=%2Forder%2F'), on.requested.join());
  html = activity.render(on);
  assert.match(html, /Listing request audit entries: Path is a fact only the audit keeps\./);
  // A host without the audit says the audit keys cannot filter it, and lists activities.
  const standalone = activityContext({ state: STANDALONE });
  activity.route(standalone, new URLSearchParams({ provider: 'live' }));
  await activity.load(standalone);
  assert.match(
    activity.render(standalone),
    /This host keeps no request audit, so Provider cannot filter its activities\./,
  );
});

test('one time format: local HH:MM:SS.mmm, the date and UTC on hover, the zone named once (D-M-2)', async () => {
  await inZone('Etc/GMT-2', async () => {
    const ctx = activityContext();
    activity.route(ctx, new URLSearchParams({ tab: 'stats' }));
    await activity.load(ctx);
    let html = activity.render(ctx);
    // The zone is named once, in the toolbar's summary.
    assert.equal(count(html, /Times local \(UTC\+02:00\)/g), 1);
    assert.match(html, /<span class="ui-page-summary">Times local \(UTC\+02:00\)<\/span>/);
    assert.match(
      html,
      /<time class="ui-mono" datetime="2026-10-22T09:00:00\.000Z" title="2026-10-22 11:00:00\.000 UTC\+02:00 · 2026-10-22T09:00:00\.000Z">11:00:00\.000<\/time>/,
    );
    assert.doesNotMatch(html, />2026-10-22[ T]\d/, 'no other time format');
    activity.route(ctx, new URLSearchParams());
    await activity.load(ctx);
    html = activity.render(ctx);
    assert.match(
      html,
      /<td><time class="ui-mono" datetime="2026-10-22T09:00:00\.100Z" title="[^"]+">11:00:00\.100<\/time><\/td>/,
    );
  });
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

test('keyboard: / focuses the search, ↑/↓ move between activities, Enter opens, Escape closes step then activity', async () => {
  const ctx = activityContext();
  activity.route(ctx, new URLSearchParams(), [traceId, stepSpan.spanId]);
  await activity.load(ctx);
  const rows = ['a', 'b', 'c'].map((id) => ({
    id,
    focus() {
      moved.push(id);
    },
  }));
  const moved = [];
  await withDom(async ({ hashes, focused }) => {
    const key = (key, found = {}) => uiEvent('keydown', found, { key });
    // `/` focuses the search, but is typed into a field like any letter.
    assert.equal(activity.handle(ctx, key('/')), true);
    assert.deepEqual(focused, ['activity-q']);
    assert.equal(activity.handle(ctx, key('/', { 'input, select, textarea, [contenteditable="true"]': {} })), false);
    // ↓ from the second row moves to the third; ↑ from the first stays; ↓ from outside enters the list.
    assert.equal(activity.handle(ctx, key('ArrowDown', { '[data-activity-open]': rows[1] })), true);
    assert.equal(activity.handle(ctx, key('ArrowUp', { '[data-activity-open]': rows[0] })), true);
    assert.equal(activity.handle(ctx, key('ArrowDown')), true);
    assert.deepEqual(moved, ['c', 'a']);
    // Escape closes the step (focus back on its label), then the activity (focus back on its row).
    assert.equal(
      activity.handle(ctx, key('Escape', { 'input, select, textarea, [contenteditable="true"]': {} })),
      false,
    );
    assert.equal(activity.handle(ctx, key('Escape')), true);
    assert.equal(ctx.data.activity.spanId, null);
    assert.equal(focused.at(-1), `activity-span-${stepSpan.spanId}`);
    assert.equal(hashes.at(-1), `#activity/${traceId}`);
    assert.equal(activity.handle(ctx, key('Escape')), true);
    assert.equal(ctx.data.activity.traceId, null);
    assert.equal(focused.at(-1), `activity-open-${traceId}`);
    assert.equal(hashes.at(-1), '#activity');
    assert.equal(activity.handle(ctx, key('Escape')), false, 'nothing to close');
    // Enter on a row is a click on its button: it opens that activity and lands on its heading.
    const revealed = [];
    ctx.reveal = (selector) => revealed.push(selector);
    activity.handle(ctx, click('[data-activity-open]', { activityOpen: traceId }));
    assert.deepEqual(revealed, ['#activity-detail-title']);
    assert.equal(hashes.at(-1), `#activity/${traceId}`);
    await ctx.data.activity.reloading;
  }, rows);
  const html = activity.render(ctx);
  assert.match(
    html,
    /<input type="search" id="activity-q" name="q" form="activity-filters" class="ui-activity-search" data-activity-search value="" aria-label="Search activities" aria-keyshortcuts="\/" placeholder="Search activities…"><button type="button" class="ui-button ui-small ui-filter-toggle"/,
  );
  assert.match(
    html,
    new RegExp(`id="activity-open-${traceId}" data-activity-open="${traceId}" aria-keyshortcuts="ArrowUp ArrowDown"`),
  );
  assert.match(html, /id="activity-close-trace" data-activity-action="close-trace" aria-keyshortcuts="Escape"/);
  // The list footer: Compare carries its own (i), then Show reads, then the tab's (i): never two bare (i) side by side.
  assert.match(
    html,
    /<span class="ui-activity-compare"><button[^>]*id="activity-compare"[^>]*aria-describedby="activity-pick-help"[^>]*>[^<]*<\/button><span class="ui-info">[^]*?aria-label="About Compare"/,
  );
  const foot = html.slice(html.indexOf('<span class="ui-activity-compare">'));
  assert.ok(
    foot.indexOf('About Compare') < foot.indexOf('id="activity-reads"') &&
      foot.indexOf('id="activity-reads"') < foot.indexOf('About Activities'),
  );
  // Keys from outside the view (focus on the page body) reach the view once: mounted attaches one listener.
  const listeners = [];
  globalThis.document = {
    querySelector: () => null,
    getElementById: (id) => (id === 'content' ? { contains: () => false } : { focus() {} }),
    addEventListener: (type, listener) => listeners.push([type, listener]),
    removeEventListener: (type, listener) =>
      listeners.splice(
        listeners.findIndex(([, item]) => item === listener),
        1,
      ),
    querySelectorAll: () => [],
  };
  try {
    activity.mounted(ctx);
    activity.mounted(ctx);
    assert.equal(listeners.length, 1);
    activity.leave(ctx);
    assert.equal(listeners.length, 0);
  } finally {
    delete globalThis.document;
  }
});

test('Log stream: server history and Live lines merge by sequence; findings fold; lines open their activity (defect 4)', async () => {
  const ctx = activityContext();
  activity.route(ctx, new URLSearchParams({ tab: 'log' }));
  await activity.load(ctx);
  assert.ok(ctx.requested.includes('/logs?limit=500'), ctx.requested.join());
  let html = activity.render(ctx);
  safeMarkup(html);
  // Startup lines are there (history), newest first; the two finding lines are folded behind a counter.
  assert.match(html, /portal-import: Imported the portal export \(3 pages\)\. · 41\.0 ms/);
  assert.match(html, /Sources reloaded: runtime revision 2\./);
  assert.match(html, /Plugin rule Require item name on create x_item: applied · changed x_name/);
  assert.match(
    html,
    /id="activity-show-findings" data-activity-action="show-findings" aria-pressed="false">\+2 findings<\/button>/,
  );
  assert.doesNotMatch(html, /CASCADE_REPARENT_NOT_SIMULATED/);
  assert.ok(html.indexOf('Sources reloaded') < html.indexOf('portal-import'), 'newest first');
  // A line written during an activity opens it (and its step); a startup line has no link.
  assert.match(
    html,
    new RegExp(
      `href="#activity/${traceId}/4a6c818d-f625-4d31-a655-55976ebc5fd3\\?tab=log" aria-label="Open the activity of log line 3">Open activity →</a>`,
    ),
  );
  assert.equal(count(html, /Open activity →/g), 2);
  activity.handle(ctx, click('[data-activity-action]', { activityAction: 'show-findings' }));
  html = activity.render(ctx);
  assert.match(html, /CASCADE_REPARENT_NOT_SIMULATED: x_item cascade reparent is not simulated\./);
  assert.equal(count(html, /Open activity →/g), 3);
  // The bar's search and the type narrow the lines.
  activity.route(ctx, new URLSearchParams({ tab: 'log', q: 'x_secret', type: 'diagnostic' }));
  await activity.load(ctx);
  html = activity.render(ctx);
  assert.equal(count(html, /<tr class="ui-log-row/g), 1);
  assert.ok(ctx.requested.includes('/logs?limit=500&type=diagnostic'));
  // Live: the log channel adds lines without duplicates (the history already holds sequence 6).
  await withStreams(async ({ sources }) => {
    activity.route(ctx, new URLSearchParams({ tab: 'log', live: '1' }));
    await activity.load(ctx);
    const log = sources.find((source) => source.url === '/__sim/events?channels=logs');
    assert.ok(log, sources.map((source) => source.url).join());
    assert.ok(sources.some((source) => source.url === '/__sim/events?channels=trace&events=trace-end'));
    log.emit('log', JSON.stringify({ type: 'connected', sequence: 6, retained: 6 }));
    log.emit('log', JSON.stringify(activitySample.logs.items[5]));
    log.emit(
      'log',
      JSON.stringify({
        sequence: 7,
        type: 'request',
        time: '2026-10-22T09:00:05.000Z',
        level: 'error',
        traceId: 'fx-throw',
        spanId: 'fx-throw-root',
        entry: {
          method: 'POST',
          path: '/_api/x_items',
          status: 500,
          durationMs: 12,
          error: { code: '0x80040224', message: 'Pre-validation crashed' },
        },
      }),
    );
    assert.equal(ctx.data.activity.lines.size, 7);
    html = activity.render(ctx);
    assert.match(html, /POST \/_api\/x_items → 500 · 12\.0 ms · 0x80040224: Pre-validation crashed/);
    activity.leave(ctx);
    assert.ok(sources.every((source) => source.readyState === FakeEventSource.CLOSED));
  });
});

test('Findings group by code; each links to its activity or says it was startup (D-M-3, D-M-4)', async () => {
  const ctx = activityContext();
  activity.route(ctx, new URLSearchParams({ tab: 'findings' }));
  await activity.load(ctx);
  const html = activity.render(ctx);
  safeMarkup(html);
  assert.match(html, /3 findings in 2 codes · 2 during an activity/);
  // A group whose occurrences differ shows its first message and how many others it holds (DV-N4b-7).
  assert.match(
    html,
    /<code>TABLE_PERMISSION_DENIED<\/code><\/td><td><span[^>]*>2<\/span><\/td><td><details class="ui-finding-group"[^>]*><summary><span class="ui-finding-first">No table permission grants read on x_secret\. · \/_api\/x_secrets · \+1 other message<\/span>/,
  );
  // The larger group first.
  assert.ok(
    html.indexOf('activity:finding:TABLE_PERMISSION_DENIED') <
      html.indexOf('activity:finding:CASCADE_REPARENT_NOT_SIMULATED'),
  );
  assert.match(
    html,
    new RegExp(
      `href="#activity/6e354c10-c74e-45e2-b4fd-a4e3d04530e5/e2250b6c-0947-4758-b351-405c3453d9c5\\?tab=findings">Open activity →</a>`,
    ),
  );
  assert.match(html, /<span class="ui-help">startup \/ outside any request<\/span>/);
  assert.match(
    html,
    /<a class="ui-button ui-small" href="\/_api\/x_secrets" target="_blank" rel="noopener">Open page ↗<\/a>/,
  );
  assert.match(html, /solution\/Entities\/x_item\/Entity\.xml/);
  // The range narrows findings with a time; a load finding (no time) stays.
  activity.route(ctx, new URLSearchParams({ tab: 'findings', from: '2026-10-22T09:00:00.500Z' }));
  await activity.load(ctx);
  assert.match(activity.render(ctx), /2 findings in 2 codes · 1 during an activity/);
});

test('every Activity table sorts from its headers: log, findings, pages and the Stats breakdown (DV-N4c-1)', async () => {
  const ctx = activityContext();
  const rendered = async (tab) => {
    activity.route(ctx, new URLSearchParams({ tab }));
    await activity.load(ctx);
    const html = activity.render(ctx);
    safeMarkup(html);
    return html;
  };
  const defaults = {
    log: ['activity-log', 'Time', 'descending'],
    findings: ['activity-findings', 'Count', 'descending'],
    pages: ['activity-pages', 'Page', 'ascending'],
    stats: ['activity-breakdown', 'Steps', 'descending'],
  };
  for (const [tab, [id, label, order]] of Object.entries(defaults)) {
    const html = await rendered(tab);
    assert.match(
      html,
      new RegExp(
        `<th scope="col" aria-sort="${order}"><button type="button" class="ui-sort" data-table-sort="${id}"[^>]*>${label}<`,
      ),
      tab,
    );
    assert.match(html, new RegExp(`<div class="ui-data-table" data-data-table="${id}">`), tab);
  }
  // A header choice (the shell sets the table's sort) reorders the rows on the client.
  const findings = await rendered('findings');
  assert.ok(
    findings.indexOf('activity:finding:TABLE_PERMISSION_DENIED') <
      findings.indexOf('activity:finding:CASCADE_REPARENT_NOT_SIMULATED'),
  );
  ctx.pager('activity-findings').sort = { key: 'code', order: 'asc' };
  const byCode = await rendered('findings');
  assert.ok(
    byCode.indexOf('activity:finding:CASCADE_REPARENT_NOT_SIMULATED') <
      byCode.indexOf('activity:finding:TABLE_PERMISSION_DENIED'),
  );
  assert.match(
    byCode,
    /<th scope="col" aria-sort="ascending"><button type="button" class="ui-sort" data-table-sort="activity-findings" data-sort-key="code">/,
  );
  const stats = await rendered('stats');
  assert.ok(stats.indexOf('<code>http</code>') < stats.indexOf('<code>dataverse</code>'), 'most steps first');
  ctx.pager('activity-breakdown').sort = { key: 'name', order: 'asc' };
  const byName = await rendered('stats');
  assert.ok(byName.indexOf('<code>dataverse</code>') < byName.indexOf('<code>http</code>'));
  const pages = await rendered('pages');
  assert.ok(pages.indexOf('<code>/</code>') < pages.indexOf('<code>/order/</code>'), 'Home before Order');
  ctx.pager('activity-pages').sort = { key: 'name', order: 'desc' };
  const byPage = await rendered('pages');
  assert.ok(byPage.indexOf('<code>/order/</code>') < byPage.indexOf('<code>/</code>'));
});

test('a finding without a message says its human name first, its ids only when it names nothing (DV-N4c-6, DV-N4d-2)', async () => {
  const step = '1a2b3c4d-0000-4000-8000-000000000001';
  const diagnostics = {
    diagnostics: [
      {
        code: 'FLOW_ACTION',
        severity: 'info',
        action: 'Send_mail',
        type: 'OpenApiConnection',
        mode: 'exported',
        status: 'Succeeded',
      },
      { code: 'FX_DESCRIBED', severity: 'info', description: 'Async step finished' },
      {
        code: 'CONNECTOR_INVOKE',
        severity: 'warn',
        connectorId: 'shared_invented',
        error: { message: 'Fixture missing' },
      },
      {
        code: 'FLOW_TRIGGER_COMPLETED',
        severity: 'info',
        operationKey: 'flow-trigger:8d2e7f10',
        chainId: 'chain-2',
        status: 'Succeeded',
        runId: 'run-1',
        sourceFile: 'Workflows/When-an-order-is-created-8D2E7F10-0000-4000-8000-000000000002.json',
        payloadScope: 'Local committed row snapshot; native payload parity requires separate capture',
      },
      { code: 'FX_NAMED', severity: 'info', stepId: step, name: 'Order pre-validation', entity: 'x_order' },
      {
        code: 'PLUGIN_ASYNC_COMPLETED',
        severity: 'info',
        stepId: step,
        chainId: 'chain-1',
        sourceFile: `SdkMessageProcessingSteps/{${step}}.xml`,
        mode: 'exported',
      },
    ],
  };
  const ctx = activityContext({ responses: activityResponses({ '/diagnostics': diagnostics }) });
  activity.route(ctx, new URLSearchParams({ tab: 'findings' }));
  await activity.load(ctx);
  const html = activity.render(ctx);
  const first = (text) => assert.ok(html.includes(`<span class="ui-finding-first">${text}</span>`), text);
  first('Send_mail · type OpenApiConnection · mode exported');
  first('Async step finished');
  first('Fixture missing');
  // The flow's name from its export file, not its operation key, chain, run id or file path; long notes stay out.
  first('When an order is created · status Succeeded');
  first('Order pre-validation · entity x_order');
  // Nothing names the step: its id is the fallback (never the file path).
  first(`mode exported · stepId ${step}`);
  assert.doesNotMatch(html, /<span class="ui-finding-first"><\/span>/);
  assert.doesNotMatch(html, /<span class="ui-finding-first">[^<]*(?:Workflows|SdkMessageProcessingSteps)/);
});

test('the detail tabs carry their (i) on the tab strip row, not on a line of its own (DV-N4c-3)', async () => {
  const ctx = activityContext();
  activity.route(ctx, new URLSearchParams({ detail: 'request' }), [traceId]);
  await activity.load(ctx);
  const html = activity.render(ctx);
  assert.match(
    html,
    /role="tablist" aria-label="Activity detail">(?:<button[^>]*>[^<]*<\/button>)+<\/div><span class="ui-activity-tabhelp"><span class="ui-info">/,
  );
  assert.doesNotMatch(html, /<p class="ui-activity-tabhelp">/);
  activity.route(ctx, new URLSearchParams({ detail: 'steps' }), [traceId]);
  await activity.load(ctx);
  assert.doesNotMatch(activity.render(ctx), /class="ui-activity-tabhelp"/, 'Steps keeps its (i) in its tool row');
});

test('one click on Errors & denied filters what failed, shows a chip and a second click clears it (T1)', async () => {
  const ctx = activityContext();
  activity.route(ctx, new URLSearchParams());
  await activity.load(ctx);
  assert.match(activity.render(ctx), /id="activity-errors" data-activity-action="errors" aria-pressed="false"/);
  await withDom(async ({ hashes }) => {
    ctx.requested.length = 0;
    assert.equal(activity.handle(ctx, click('[data-activity-action]', { activityAction: 'errors' })), true);
    await ctx.data.activity.reloading;
    assert.deepEqual(hashes, ['#activity?result=error%2Cdenied']);
    assert.ok(
      ctx.requested.some((path) => path.startsWith('/trace?result=error%2Cdenied&')),
      ctx.requested.join(),
    );
    let html = activity.render(ctx);
    assert.match(html, /id="activity-errors" data-activity-action="errors" aria-pressed="true"/);
    assert.match(html, /id="activity-chip-result" data-activity-unfilter="result"/);
    activity.handle(ctx, click('[data-activity-action]', { activityAction: 'errors' }));
    await ctx.data.activity.reloading;
    assert.equal(hashes.at(-1), '#activity');
    html = activity.render(ctx);
    assert.match(html, /aria-pressed="false" aria-label="Errors and denied only"/);
    assert.doesNotMatch(html, /id="activity-chip-result"/);
  });
});

test('the Log stream has a one-click Startup filter in place of Errors & denied; the breakdown has a bottom bar (T7, DV-N4d-3)', async () => {
  const ctx = activityContext();
  activity.route(ctx, new URLSearchParams({ tab: 'log' }));
  await activity.load(ctx);
  let html = activity.render(ctx);
  assert.match(
    html,
    /id="activity-startup" data-activity-action="startup" aria-pressed="false" aria-label="Startup lines only"/,
  );
  assert.doesNotMatch(html, /id="activity-errors"/, 'Result does not apply to the log stream');
  await withDom(async ({ hashes }) => {
    assert.equal(activity.handle(ctx, click('[data-activity-action]', { activityAction: 'startup' })), true);
    await ctx.data.activity.reloading;
    assert.deepEqual(hashes, ['#activity?tab=log&type=startup']);
    html = activity.render(ctx);
    assert.match(html, /id="activity-startup" data-activity-action="startup" aria-pressed="true"/);
    assert.match(html, /id="activity-chip-type" data-activity-unfilter="type"/);
    activity.handle(ctx, click('[data-activity-action]', { activityAction: 'startup' }));
    await ctx.data.activity.reloading;
    assert.equal(hashes.at(-1), '#activity?tab=log');
    assert.doesNotMatch(activity.render(ctx), /id="activity-chip-type"/);
  });
  // Findings and Pages & render have no quick filter; Stats keeps Errors & denied.
  for (const [tab, expected] of [
    ['findings', null],
    ['pages', null],
    ['stats', 'activity-errors'],
  ]) {
    activity.route(ctx, new URLSearchParams({ tab }));
    await activity.load(ctx);
    html = activity.render(ctx);
    assert.equal(/id="activity-(?:errors|startup)"/.exec(html)?.[0] ?? null, expected && `id="${expected}"`, tab);
  }
  // The Stats breakdown ends with the same bottom bar as the other tables.
  const breakdown = html.slice(html.indexOf('data-data-table="activity-breakdown"'));
  assert.match(
    breakdown,
    /^[^]*?<\/table><\/div><div class="ui-table-foot"><span class="ui-table-count">\d+ results?<\/span>/,
  );
});

test('every Activity table has its search in its toolbar row with Filters, and the bottom bar (D-M-11 item 4)', async () => {
  const ctx = activityContext();
  const labels = { activities: 'activities', log: 'log lines', findings: 'findings', pages: 'pages', stats: 'steps' };
  const tables = {
    activities: 'activity-list',
    log: 'activity-log',
    findings: 'activity-findings',
    pages: 'activity-pages',
    stats: 'activity-breakdown',
  };
  for (const [tab, label] of Object.entries(labels)) {
    activity.route(ctx, new URLSearchParams({ tab }));
    await activity.load(ctx);
    const html = activity.render(ctx);
    // One search box, the `q=` filter, in the toolbar row right before Filters; the drawer holds no second one.
    assert.equal(count(html, /id="activity-q"/g), 1, tab);
    assert.match(
      html,
      new RegExp(
        `aria-label="Search ${label}" aria-keyshortcuts="/" placeholder="Search ${label}…"><button type="button" class="ui-button ui-small ui-filter-toggle"`,
      ),
      tab,
    );
    const drawer = html.slice(html.indexOf('<aside class="ui-filter-drawer"'), html.indexOf('</aside>'));
    assert.doesNotMatch(drawer, /name="q"/, tab);
    // The bottom bar: count, rows per page and Previous/Next, even on one page.
    const table = html.slice(html.indexOf(`data-data-table="${tables[tab]}"`));
    assert.match(
      table,
      new RegExp(
        `^[^]*?<div class="ui-table-foot">[^]*?<span class="ui-table-count">[0-9]+ results?[^<]*</span><label class="ui-table-size">Rows <select data-table-size="${tables[tab]}"[^]*?data-table-page="${tables[tab]}" data-delta="-1"[^>]*>Previous</button><button[^>]*data-table-page="${tables[tab]}" data-delta="1"`,
      ),
      tab,
    );
  }
  // The breakdown, a table inside Stats, has its own search in the bar above it; it filters its rows by name.
  let html = activity.render(ctx);
  assert.match(html, /<div class="ui-table-bar"><input type="search" data-table-search="activity-breakdown"/);
  ctx.pager('activity-breakdown').search = 'verse';
  html = activity.render(ctx);
  const rows = html.slice(html.indexOf('data-data-table="activity-breakdown"'));
  assert.ok(rows.includes('<code>dataverse</code>') && !rows.includes('<code>http</code>'));
  // It has Filters · n of its own (more than one sortable column); a column filter narrows its rows.
  assert.match(
    rows,
    /<div class="ui-table-bar"><input type="search" data-table-search="activity-breakdown"[^>]*><button[^>]*data-filter-toggle="activity-breakdown-filters"/,
  );
  ctx.pager('activity-breakdown').search = '';
  ctx.pager('activity-breakdown').filters = { errors: '1' };
  const filtered = activity.render(ctx).split('data-data-table="activity-breakdown"')[1];
  assert.ok(
    filtered.includes('<code>job</code>') && !filtered.includes('<code>http</code>'),
    'only the kind with 1 error',
  );
  ctx.pager('activity-breakdown').filters = {};
  // A change in the search applies `q=` like the drawer's fields; Enter does the same through the form.
  await withDom(async ({ hashes }) => {
    activity.route(ctx, new URLSearchParams());
    activity.handle(
      ctx,
      uiEvent('change', {
        '[data-activity-filters] input[name], [data-activity-search]': { name: 'q', value: ' REJECT ' },
      }),
    );
    await ctx.data.activity.reloading;
    assert.deepEqual(hashes, ['#activity?q=REJECT']);
    assert.ok(
      ctx.requested.some((path) => path.startsWith('/trace?search=REJECT&')),
      ctx.requested.join(),
    );
  });
});

test('the Rendered tab and Pages & render resolve template sources to path:line (D-M-3, M2 §7 defect 6)', async () => {
  const ctx = activityContext();
  activity.route(ctx, new URLSearchParams({ detail: 'rendered' }), ['fx-page']);
  await activity.load(ctx);
  // One read resolves every source reference of the tree.
  assert.ok(ctx.requested.includes('/render-sources?refs=fx-ref-order%2Cfx-ref-gone'), ctx.requested.join());
  let html = activity.render(ctx);
  safeMarkup(html);
  assert.match(html, /id="activity-detail-tab-rendered" aria-selected="true"[^>]*>Rendered \(4\)<\/button>/);
  assert.match(
    html,
    /<code class="ui-source" title="\/fx\/site\/web-templates\/order\/Order\.webtemplate\.source\.html">web-templates\/order\/Order\.webtemplate\.source\.html:3<\/code> <span class="ui-help">webtemplate · Order<\/span>/,
  );
  assert.match(html, /source not found \(changed since load\)/);
  assert.match(html, /<code>6-34<\/code>/, 'a Liquid read names its call site');
  assert.doesNotMatch(html, /fx-ref-order</, 'no bare reference id is shown');
  assert.match(
    html,
    /Rendering evidence for <code>\/order\/<\/code>: <span class="ui-badge ui-tone-ok">evidence passed<\/span>/,
  );
  // Pages & render: the last activity of each route, its evidence, and its template sources on request.
  activity.route(ctx, new URLSearchParams({ tab: 'pages' }));
  await activity.load(ctx);
  assert.ok(ctx.requested.includes('/trace?kind=render&pageSize=200'));
  html = activity.render(ctx);
  assert.match(
    html,
    /<a href="#activity\/fx-page\?tab=pages"><time[^>]+>[^<]+<\/time><\/a> <span class="ui-badge ui-tone-ok">ok<\/span>/,
  );
  assert.match(html, /<span class="ui-help">not opened yet<\/span>/);
  assert.match(
    html,
    /<a class="ui-button ui-small" href="\/__sim\/evidence\/local\.png" target="_blank" rel="noopener">local screenshot ↗<\/a>/,
  );
  assert.doesNotMatch(html, /x\.png/, 'only /__sim/ evidence files are linked');
  ctx.requested.length = 0;
  await withDom(async () => {
    activity.handle(ctx, click('[data-activity-sources]', { activitySources: '/order/' }));
    await ctx.data.activity.reloading;
  });
  assert.deepEqual(ctx.requested, ['/trace/id/fx-page', '/render-sources?refs=fx-ref-order%2Cfx-ref-gone']);
  assert.match(
    activity.render(ctx),
    /Template sources of <code>\/order\/<\/code>.*web-templates\/order\/Order\.webtemplate\.source\.html:3/s,
  );
});

test('a hostile finding is shown escaped; stale evidence says so in Pages & render', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const findings = {
    diagnostics: [{ code: 'FX_HOSTILE', severity: 'warning', message: hostile, path: `/fx/${hostile}` }],
    requests: [],
  };
  const stale = { ...activitySample.state, evidence: { ...activitySample.state.evidence, stale: true } };
  const ctx = activityContext({ responses: activityResponses({ '/diagnostics': findings }), state: stale });
  activity.route(ctx, new URLSearchParams({ tab: 'findings' }));
  await activity.load(ctx);
  // The escaped text still reads onerror=, so the check is on parsed elements, not on the text.
  let html = activity.render(ctx);
  assertNoElements(html, ['img']);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  activity.route(ctx, new URLSearchParams({ tab: 'pages' }));
  await activity.load(ctx);
  html = activity.render(ctx);
  assert.match(html, /<span class="ui-badge ui-tone-warn">stale evidence<\/span>/);
  // Page, Last activity (both sortable) and the actions; on a phone activity.css stacks each row (DV-N4c-1).
  const list = html.slice(html.indexOf('data-table="activity-pages"'));
  assert.equal(count(list.slice(0, list.indexOf('</thead>')), /<th /g), 3);
  assert.match(list, /<td class="ui-actions"><a class="ui-button ui-small" href="\/order\/" target="_blank"/);
});

test('the Request tab shows the audit entry and its reads; Log & findings reads the lines of the activity', async () => {
  const ctx = activityContext();
  activity.route(ctx, new URLSearchParams({ detail: 'request' }), [traceId]);
  await activity.load(ctx);
  assert.ok(ctx.requested.includes(`/audit?traceId=${traceId}&pageSize=100`));
  let html = activity.render(ctx);
  safeMarkup(html);
  assert.match(
    html,
    /<dt>Request<\/dt><dd><span class="ui-badge ui-tone-neutral">api<\/span> <code>POST \/_api\/x_items<\/code>/,
  );
  assert.match(
    html,
    /<dt>Result<\/dt><dd><span class="ui-badge ui-tone-ok">ok<\/span> <span class="ui-badge ui-tone-neutral">HTTP 201<\/span>/,
  );
  assert.match(html, /<dt>Duration<\/dt><dd>21\.0 ms · save 1\.50 ms \(journal\)<\/dd>/);
  assert.match(html, /<dt>Audit id<\/dt><dd><code>fx-audit-create<\/code> · sequence 11<\/dd>/);
  assert.match(html, /data-table="activity-reads"/);
  // Log & findings: the lines and findings that name this activity.
  activity.route(ctx, new URLSearchParams({ detail: 'log' }), [traceId]);
  await activity.load(ctx);
  assert.ok(ctx.requested.includes(`/logs?traceId=${traceId}&limit=500`));
  assert.ok(ctx.requested.includes(`/diagnostics?traceId=${traceId}`));
  html = activity.render(ctx);
  // Finding lines are listed once, under Findings (the fake host answers every line: 6, two of them findings).
  assert.match(html, /<h4>Log lines \(4\)<\/h4>/);
  assert.doesNotMatch(
    html.slice(html.indexOf('<h4>Log lines'), html.indexOf('<h4>Findings')),
    /TABLE_PERMISSION_DENIED/,
  );
  assert.match(html, /<h4>Findings \(3\)<\/h4>/);
  // A host without the audit shows the root step's facts instead.
  const standalone = activityContext({ state: STANDALONE });
  activity.route(standalone, new URLSearchParams({ detail: 'request' }), [traceId]);
  await activity.load(standalone);
  assert.match(activity.render(standalone), /No request audit on this host: the root step’s facts\./);
});

test('Export bundle follows the filters; the activity files remain as other formats (D-M-3)', async () => {
  const ctx = activityContext();
  activity.route(ctx, new URLSearchParams({ result: 'error', table: 'x_item' }));
  await activity.load(ctx);
  let html = activity.render(ctx);
  assert.match(
    html,
    /<a class="ui-button ui-small" id="activity-export" href="\/__sim\/api\/activity\/export\?result=error&amp;entity=x_item&amp;format=bundle" download aria-label="Export filtered"><span class="ui-wide">Export<\/span>/,
  );
  activity.handle(ctx, uiEvent('change', { '[data-activity-export-format]': { value: 'bundle-otlp' } }));
  assert.match(
    activity.render(ctx),
    /href="\/__sim\/api\/activity\/export\?result=error&amp;entity=x_item&amp;format=bundle&amp;traces=otlp"/,
  );
  activity.handle(ctx, uiEvent('change', { '[data-activity-export-format]': { value: 'otlp' } }));
  html = activity.render(ctx);
  assert.match(html, /href="\/__sim\/api\/trace\/export\?result=error&amp;entity=x_item&amp;format=otlp" download/);
  assert.match(html, /<option value="otlp" selected>Activities OTLP<\/option>/);
});

test('Stats: KPIs, timeline, breakdown, slowest steps and latest errors; root percentiles under any filter', async () => {
  const ctx = activityContext();
  activity.route(ctx, new URLSearchParams({ tab: 'stats' }));
  await activity.load(ctx);
  assert.deepEqual(
    ctx.requested.filter((path) => path.startsWith('/trace/stats')),
    ['/trace/stats'],
  );
  const html = activity.render(ctx);
  safeMarkup(html);
  assertTables(html, ['activity-breakdown']);
  // Named like Health's counter; it counts only the kept, filtered activities (Health counts since start).
  assert.match(
    html,
    /Plug-in step runs<\/span><strong class="ui-tile-value">1<\/strong><span class="ui-tile-detail">in the kept, filtered activities</,
  );
  assert.match(
    html,
    /Root p50 \/ p95<\/span><strong class="ui-tile-value">3\.00 ms \/ 21\.0 ms<\/strong><span class="ui-tile-detail">max 21\.0 ms</,
  );
  assert.match(
    html,
    /Steps<\/span><strong class="ui-tile-value">9<\/strong><span class="ui-tile-detail">p50 \/ p95 10\.0 ms \/ 21\.0 ms</,
  );
  assert.match(html, /Failed steps<\/span><strong class="ui-tile-value">1</);
  assert.equal(count(html, /data-activity-bucket="/g), sample.stats.timeline.length);
  assert.match(html, /<rect class="ui-histogram-errors" x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+">/);
  const slowest = html.slice(html.indexOf('id="activity-slowest-title"'), html.indexOf('id="activity-errors-title"'));
  assert.match(
    slowest,
    new RegExp(
      `<li class="data-line"><a href="#activity/${traceId}/${rootSpan.spanId}\\?tab=stats"><span[^>]*>http</span> <span class="ui-span-ref-name">POST /_api/x_items</span></a> <span class="ui-span-ref-meta">21\\.0 ms · `,
    ),
  );
  assert.match(
    html.slice(html.indexOf('id="activity-errors-title"')),
    /<span class="ui-span-ref-error">FX_FAILED: Invented failure<\/span>/,
  );
  const filtered = {
    ...structuredClone(sample.stats),
    overall: { count: 1, errors: 0, p50: 3, p95: 3, max: 3 },
    roots: { count: 1, errors: 0, p50: 21, p95: 21, max: 21 },
  };
  const narrow = activityContext({ responses: activityResponses({ '/trace/stats': filtered }) });
  activity.route(narrow, new URLSearchParams({ tab: 'stats', table: 'x_category' }));
  await activity.load(narrow);
  assert.ok(narrow.requested.includes('/trace/stats?entity=x_category'));
  assert.match(activity.render(narrow), /Root p50 \/ p95<\/span><strong class="ui-tile-value">21\.0 ms \/ 21\.0 ms</);
  // Every result with its meaning; the result filter and the step filters offer the store's values.
  activity.route(ctx, new URLSearchParams());
  await activity.load(ctx);
  ctx.data.activity.more = true;
  const list = activity.render(ctx);
  // Each result's meaning is in the (i) of the Result column (no permanent legend under the list).
  const legend = list.match(
    /<th scope="col">Result<span class="ui-info">.*?<span class="ui-info-text">([^<]*)<\/span>/,
  )[1];
  assert.deepEqual(
    [...legend.matchAll(/(?:^| )([a-z]+): /g)].map(([, name]) => name).sort(),
    [...SPAN_STATUSES].sort(),
  );
  assert.deepEqual(selectOptions(list, 'activity-status').sort(), [...SPAN_STATUSES].sort());
  assert.deepEqual(selectOptions(list, 'activity-kind'), [...SPAN_KINDS]);
  assert.deepEqual(selectOptions(list, 'activity-result'), [
    'error,denied',
    'ok',
    'error',
    'denied',
    'running',
    'cancelled',
  ]);
});

test('the open activity draws its steps as a waterfall or a tree with a step drawer and its pivots', async () => {
  const ctx = activityContext();
  activity.route(ctx, new URLSearchParams(), [traceId, stepSpan.spanId]);
  await activity.load(ctx);
  let html = activity.render(ctx);
  safeMarkup(html);
  assertNoElements(html, ['script', 'iframe']);
  assert.match(html, new RegExp(`<tr data-activity-row="${traceId}" class="is-selected">`));
  assert.equal(count(html, /<li class="data-line ui-waterfall-row/g), sample.tree.spans.length);
  assert.match(html, /ui-waterfall-row ui-depth-4 is-selected/);
  assert.match(html, new RegExp(`<rect class="ui-bar-fill ui-series-${MODULES.indexOf('jobs')} is-error is-async"`));
  assert.match(html, /<h3 id="activity-span-title">Invented\.Plugin\.PreCreate<\/h3>/);
  assert.match(html, /Validating the invented item/);
  assert.match(
    html,
    /<dt>Input<\/dt><dd><details class="ui-payload"><summary>Show<\/summary><pre class="ui-example">\{\n {2}&quot;Target&quot;/,
  );
  // Pivots replace the filters with one and close the activity; Parent request opens the root step.
  assert.match(html, /href="#activity\?session=contact%3Ac0ffee00[^"]*">Same session/);
  assert.match(html, /href="#activity\?who=plugin%3Astep-1">Same who/);
  assert.match(html, /href="#activity\?table=x_item">Same table/);
  assert.match(html, new RegExp(`href="#activity/${traceId}/${rootSpan.spanId}">Parent request`));
  // The activity's own Related links: same session, same who, same record and the job it staged.
  assert.match(
    html,
    /<p class="ui-drawer-actions ui-activity-related"><span class="ui-help">Related:<\/span> <a class="ui-button ui-small" href="#activity\?session=/,
  );
  assert.match(html, /href="#records\?entity=asyncoperation&amp;id=job-1">Job ↗<\/a>/);
  // Tree: nested details, one per step with children; the address remembers the choice.
  await withDom(async ({ hashes }) => {
    activity.handle(ctx, click('[data-activity-steps-as]', { activityStepsAs: 'tree' }));
    assert.equal(hashes.at(-1), `#activity/${traceId}/${stepSpan.spanId}?steps=tree`);
  });
  html = activity.render(ctx);
  assert.match(html, /<ul class="ui-tree" aria-label="Step tree">/);
  assert.equal(count(html, /<details open data-ui-section="activity:node:/g), 5);
  assert.match(html, /id="activity-steps-tree" data-activity-steps-as="tree" aria-pressed="true"/);
  assert.match(html, /· 1 event</);
  // Detail tabs move with the arrow keys: Steps → Log & findings → Rendered.
  await withDom(async () => {
    const tab = (id) => ({ '[role="tab"][data-tab]': { dataset: { tab: 'activity-detail', tabId: id } } });
    activity.handle(ctx, uiEvent('keydown', tab('steps'), { key: 'ArrowRight' }));
    assert.equal(ctx.data.activity.detail, 'log');
    activity.handle(ctx, uiEvent('keydown', tab('log'), { key: 'ArrowRight' }));
    assert.equal(ctx.data.activity.detail, 'rendered');
    activity.handle(ctx, click('[role="tab"][data-tab]', { tab: 'activity-detail', tabId: 'steps' }));
  });
  // Child activities: the steps under this step in other activities.
  ctx.request = async (path) => {
    ctx.requested.push(path);
    return { items: [{ traceId }, { traceId: 'fx-child' }] };
  };
  activity.handle(ctx, click('[data-activity-children]', { activityChildren: stepSpan.spanId }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(ctx.requested.includes(`/trace/spans?parentSpanId=${stepSpan.spanId}&pageSize=200`));
  assert.match(activity.render(ctx), /<a href="#activity\/fx-child\?steps=tree">Activity <code>fx-child<\/code><\/a>/);
  // A step recorded at summary says so; a staged job links to its staging step.
  ctx.data.activity.spanId = jobSpan.spanId;
  html = activity.render(ctx);
  assert.match(
    html,
    /<dt>Input<\/dt><dd>not captured \(level summary\)<span class="ui-info">.*?This step was recorded at level summary, which keeps attributes and events only\./,
  );
  assert.match(html, /staged-by: <a href="#activity\//);
  assert.match(html, /FX_FAILED: Invented failure/);
});

test('Live follows ended activities and the open activity’s own steps, and turns off with a notice when refused', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await withStreams(async ({ sources, fetched }) => {
      const ctx = activityContext({ state: { status: { ...activitySample.state.status, eventChannels: undefined } } });
      await activity.load(ctx);
      await withDom(async ({ hashes }) => {
        activity.handle(ctx, click('[data-activity-action]', { activityAction: 'live' }));
        assert.equal(hashes.at(-1), '#activity?live=1');
      });
      assert.deepEqual(
        sources.map((source) => source.url),
        ['/__sim/events?channels=trace&events=trace-end'],
      );
      sources[0].emit('open');
      assert.match(
        activity.render(ctx),
        /aria-pressed="true" aria-label="Live">● <span class="ui-wide">Live: on<\/span><span class="ui-narrow">Live<\/span><\/button><span class="ui-help" role="status">Streaming</,
      );
      // Ended activities reload the list once per interval (trailing), never the settings.
      ctx.requested.length = 0;
      sources[0].emit('trace', JSON.stringify({ type: 'trace-end', trace: { traceId: 'fx-other' } }));
      sources[0].emit('trace', JSON.stringify({ type: 'trace-end', trace: { traceId: 'fx-other-2' } }));
      assert.deepEqual(ctx.requested, [], 'nothing is fetched before the interval ends');
      mock.timers.tick(LIVE_INTERVAL_MS);
      await ctx.data.activity.reloading;
      assert.equal(ctx.requested[0], '/trace?page=1&pageSize=10');
      assert.ok(ctx.requested.every((path) => !path.startsWith('/trace/settings')));
      // A running open activity follows its own steps through a filtered stream.
      const running = { ...traceTree, trace: { ...traceTree.trace, status: 'running' } };
      ctx.data.activity.traceId = traceId;
      ctx.data.activity.tree = running;
      ctx.data.activity.keys.tree = traceId;
      await activity.load(ctx);
      assert.equal(sources[1].url, `/__sim/events?channels=trace&events=span-end&traceId=${traceId}`);
      // A refused stream (an HTTP error answer) closes for good: Live turns off and says why.
      sources[0].readyState = FakeEventSource.CLOSED;
      sources[0].emit('error');
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(fetched, ['/__sim/events?channels=trace&events=trace-end']);
      const html = activity.render(ctx);
      safeMarkup(html);
      assert.match(html, /aria-pressed="false" aria-label="Live"><span class="ui-wide">Live: off<\/span>/);
      assert.match(
        html,
        /This host does not serve the live stream \(\/_sim\/events\?channels=trace&amp;events=trace-end\)\./,
      );
      assert.ok(sources.every((source) => source.readyState === FakeEventSource.CLOSED));
      // A host whose channels lack `trace`: Live is disabled and says why.
      ctx.eventChannels = () => ['logs'];
      assert.match(
        activity.render(ctx),
        /id="activity-live" disabled data-activity-action="live" aria-pressed="false" aria-label="Live"><span class="ui-wide">Live: off<\/span><span class="ui-narrow">Live<\/span><\/button><span class="ui-help" role="status">This host does not stream activity</,
      );
      activity.leave(ctx);
    });
  } finally {
    mock.timers.reset();
  }
});

test('activity text is escaped everywhere', async () => {
  const tree = structuredClone(traceTree);
  const hostile = '<img src=x onerror=alert(1)>"\'';
  for (const span of tree.spans) span.name = hostile;
  const rename = (nodes) =>
    nodes.forEach((node) => {
      node.name = hostile;
      rename(node.children);
    });
  rename(tree.children);
  const query = structuredClone(activityQuery);
  for (const item of query.items) item.root.name = hostile;
  const logs = structuredClone(activitySample.logs);
  for (const line of logs.items) line.message = hostile;
  const ctx = activityContext({
    responses: activityResponses({ '/trace': query, [`/trace/id/${traceId}`]: tree, '/logs': logs }),
  });
  activity.route(ctx, new URLSearchParams(), [traceId, tree.spans[1].spanId]);
  await activity.load(ctx);
  for (const as of ['waterfall', 'tree']) {
    ctx.data.activity.stepsAs = as;
    const html = activity.render(ctx);
    assertNoElements(html, ['img', 'script']);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;/);
  }
  activity.route(ctx, new URLSearchParams({ tab: 'log' }));
  await activity.load(ctx);
  assertNoElements(activity.render(ctx), ['img', 'script']);
});

test('pivots, buckets, sorting and paging update the address and fetch only what they change', async () => {
  const ctx = activityContext();
  await activity.load(ctx);
  await withDom(async ({ hashes }) => {
    const settle = () => ctx.data.activity.reloading;
    const fetched = async (action) => {
      ctx.requested.length = 0;
      await action();
      await settle();
      return [...ctx.requested];
    };
    // Opening a row reads only its tree.
    assert.deepEqual(
      await fetched(() => activity.handle(ctx, click('[data-activity-open]', { activityOpen: traceId }))),
      [`/trace/id/${traceId}`],
    );
    assert.equal(hashes.at(-1), `#activity/${traceId}`);
    assert.deepEqual(
      await fetched(() => activity.handle(ctx, click('[data-table-page]', { tablePage: 'activity-list', delta: '1' }))),
      [
        '/trace?page=2&pageSize=10',
        `/audit?traceId=${encodeURIComponent(activityQuery.items.map((item) => item.traceId).join(','))}&pageSize=100`,
      ],
    );
    assert.deepEqual(
      (
        await fetched(() => activity.handle(ctx, click('[data-table-sort="activity-list"]', { sortKey: 'duration' })))
      )[0],
      '/trace?sort=duration&order=desc&page=1&pageSize=10',
    );
    assert.equal(
      (
        await fetched(() => activity.handle(ctx, click('[data-table-sort="activity-list"]', { sortKey: 'duration' })))
      )[0],
      '/trace?sort=duration&order=asc&page=1&pageSize=10',
    );
    assert.equal(hashes.at(-1), `#activity/${traceId}?sort=duration&order=asc`);
    const html = activity.render(ctx);
    assert.match(
      html,
      /<th scope="col" class="ui-trace-extra" aria-sort="ascending"><button type="button" class="ui-sort" data-table-sort="activity-list" data-sort-key="duration">Duration<span class="ui-sort-mark" aria-hidden="true">▲<\/span>/,
    );
    assert.match(html, /<caption class="ui-sr-only">Activities by duration, ascending<\/caption>/);
    // A deep link that changes only the open activity reads only that activity.
    activity.route(ctx, new URLSearchParams({ sort: 'duration', order: 'asc' }), ['fx-page']);
    assert.deepEqual(await fetched(() => activity.load(ctx)), ['/trace/id/fx-page']);
    // A breakdown Filter adds that key (the who of an actor key); a timeline bucket narrows the time.
    activity.route(ctx, new URLSearchParams({ tab: 'stats' }));
    await activity.load(ctx);
    activity.handle(ctx, click('[data-activity-pivot]', { activityPivot: 'actor', value: 'contact:c0ffee00' }));
    await settle();
    assert.equal(ctx.data.activity.filters.who, 'contact:c0ffee00');
    const bucket = sample.stats.timeline[0].bucketStart;
    activity.handle(
      ctx,
      uiEvent('keydown', { '[data-activity-bucket]': { dataset: { activityBucket: bucket } } }, { key: 'Enter' }),
    );
    await settle();
    assert.equal(ctx.data.activity.filters.from, bucket);
    assert.equal(ctx.data.activity.range, 'custom');
    // Submitting the bar unchanged keeps the exact bucket time its input shows to the second.
    ctx.data.activity.filters.from = '2026-10-22T09:00:00.005Z';
    ctx.data.activity.more = true;
    const shown = activity.render(ctx).match(/id="activity-from" name="from" type="datetime-local" value="([^"]+)"/)[1];
    activity.handle(
      ctx,
      uiEvent('submit', { '[data-activity-filters]': { values: { range: 'custom', from: shown } } }),
    );
    await settle();
    assert.equal(ctx.data.activity.filters.from, '2026-10-22T09:00:00.005Z');
    // Clear all removes every filter and focuses the search.
    activity.handle(ctx, click('[data-activity-action]', { activityAction: 'clear-filters' }));
    await settle();
    assert.equal(hashes.at(-1), '#activity?tab=stats');
    // Leaving and coming back reads everything again.
    activity.leave(ctx);
    activity.route(ctx, new URLSearchParams(), [traceId]);
    const again = await fetched(() => activity.load(ctx));
    assert.ok(
      again.includes('/trace/settings') &&
        again.includes(`/trace/id/${traceId}`) &&
        again.includes('/trace?page=1&pageSize=10'),
      again.join(),
    );
  });
});

test('settings save with PUT and switch the list between activities and the audit; clear asks first', async () => {
  const ctx = activityContext();
  await activity.load(ctx);
  const writes = [],
    notes = [];
  const read = ctx.request;
  const off = { ...sample.settings, settings: { ...sample.settings.settings, level: 'off' } };
  ctx.request = (path, init) => {
    if (!init?.method) return read(path, init);
    writes.push([init.method, path, init.body]);
    return Promise.resolve(path === '/trace/settings' ? structuredClone(off) : {});
  };
  ctx.notify = (text) => notes.push(text);
  let finished;
  const done = new Promise((resolve) => (finished = resolve));
  ctx.setButtonPending = (button, on) => (on ? true : finished());
  let confirmed;
  ctx.askConfirmation = (title, message, action, label) => {
    confirmed = { title, label, action };
  };
  await withDom(async () => {
    ctx.requested.length = 0;
    const form = { values: { level: 'off' }, querySelector: () => ({}) };
    assert.equal(
      activity.handle(ctx, uiEvent('submit', { '[data-activity-settings]': form }, { submitter: {} })),
      true,
    );
    await done;
    await ctx.data.activity.reloading;
  });
  assert.deepEqual(writes[0], ['PUT', '/trace/settings', JSON.stringify({ level: 'off', persist: false })]);
  assert.deepEqual(notes, ['Tracing level off.']);
  assert.ok(ctx.requested.includes('/audit?page=1&pageSize=10'), 'tracing off: the list reads the audit');
  const html = activity.render(ctx);
  safeMarkup(html);
  assert.match(
    html,
    /<input type="radio" id="activity-level-off" name="level" value="off" checked aria-describedby="activity-level-off-help">/,
  );
  assert.match(html, /id="activity-level-off-help">Nothing is recorded as steps\./);
  assert.match(
    html,
    /id="activity-limit-payloadBytes" name="payloadBytes" type="number" min="256" max="1048576" step="1" required value="16384"/,
  );
  activity.handle(ctx, click('[data-activity-action]', { activityAction: 'clear' }));
  assert.deepEqual([confirmed.title, confirmed.label], ['Clear activities?', 'Clear activities']);
  assert.equal(writes.length, 1, 'nothing is cleared before the confirmation');
  await withDom(() => confirmed.action());
  assert.deepEqual(writes[1], ['POST', '/trace/clear', '{}']);
  assert.equal(notes.at(-1), 'Activities cleared.');
});

test('an activity no longer retained says so; a slow load never overwrites a newer one', async () => {
  const gone = Object.assign(new Error('No retained trace has this id.'), { status: 404 });
  const ctx = activityContext({ responses: activityResponses({ '/trace/id/fx-gone': gone }) });
  activity.route(ctx, new URLSearchParams(), ['fx-gone']);
  await activity.load(ctx);
  const html = activity.render(ctx);
  safeMarkup(html);
  assert.match(
    html,
    /No retained activity has the id fx-gone \(it never existed or was dropped as the oldest beyond the limit\)\./,
  );
  assert.match(html, /data-activity-action="close-trace"/);

  const slow = activityContext({ responses: {} });
  const gates = [];
  slow.request = (path) => new Promise((resolve) => gates.push({ path, resolve }));
  const answer = (gate, marker) =>
    gate.resolve(
      gate.path.startsWith('/trace?')
        ? { items: [], total: 0, page: 1, pageSize: 10, pageCount: 1, marker }
        : gate.path.startsWith('/trace/id/')
          ? { trace: { traceId: 'fx-new' }, spans: [], children: [], marker }
          : { marker },
    );
  slow.data.activity = { settings: structuredClone(sample.settings) };
  activity.route(slow, new URLSearchParams({ kind: 'webapi' }));
  const older = activity.load(slow);
  const olderGates = gates.splice(0);
  activity.route(slow, new URLSearchParams({ kind: 'render' }), ['fx-new']);
  const newer = activity.load(slow);
  await new Promise((resolve) => setImmediate(resolve));
  const newerGates = gates.splice(0);
  assert.ok(
    newerGates.some((gate) => gate.path === '/trace/id/fx-new'),
    newerGates.map((gate) => gate.path).join(),
  );
  for (const gate of newerGates) answer(gate, 'new');
  for (const gate of olderGates) answer(gate, 'old');
  await Promise.all([older, newer]);
  const d = slow.data.activity;
  assert.equal(d.list.marker, 'new');
  assert.equal(d.tree.marker, 'new');
  assert.equal(d.filters.kind, 'render');
});

test('drafts are forgotten whenever the address replaces them; focus lands and returns', async () => {
  const ctx = activityContext();
  await activity.load(ctx);
  await withDom(async ({ focused }) => {
    const settle = () => ctx.data.activity.reloading;
    const forgets = async (action) => {
      ctx.forgotten.length = 0;
      action();
      await settle();
      assert.ok(ctx.forgotten.includes('activity-filters'), ctx.forgotten.join());
    };
    await forgets(() =>
      activity.handle(
        ctx,
        uiEvent('submit', { '[data-activity-filters]': { values: { kind: 'webapi', table: 'account' } } }),
      ),
    );
    await forgets(() => activity.handle(ctx, click('[data-activity-unfilter]', { activityUnfilter: 'kind' })));
    assert.equal(focused.at(-1), 'activity-chip-table');
    await forgets(() => activity.route(ctx, new URLSearchParams({ kind: 'http', status: 'error' })));
    // Landing: a step lands on the drawer before the render; closing returns focus to its label and row.
    activity.route(ctx, new URLSearchParams(), [traceId]);
    await activity.load(ctx);
    const order = [];
    ctx.reveal = (selector) => order.push(`reveal ${selector}`);
    ctx.render = () => order.push('render');
    activity.handle(ctx, click('[data-activity-span]', { activitySpan: stepSpan.spanId }));
    assert.deepEqual(
      order.slice(0, 2),
      ['reveal #activity-span-drawer', 'render'],
      'the landing is set before the render',
    );
    activity.handle(ctx, click('[data-activity-action]', { activityAction: 'close-span' }));
    assert.equal(focused.at(-1), `activity-span-${stepSpan.spanId}`);
    activity.handle(ctx, click('[data-activity-action]', { activityAction: 'close-trace' }));
    assert.equal(focused.at(-1), `activity-open-${traceId}`);
  });
  const revealed = [];
  ctx.reveal = (selector) => revealed.push(selector);
  activity.route(ctx, new URLSearchParams(), [traceId, stepSpan.spanId]);
  activity.route(ctx, new URLSearchParams(), [traceId]);
  activity.route(ctx, new URLSearchParams({ compare: `${traceId},fx-b` }));
  activity.route(ctx, new URLSearchParams({ kind: 'http' }));
  assert.deepEqual(revealed, [
    '#activity-span-drawer',
    '#activity-detail-title',
    '[data-ui-section="activity:compare"]',
  ]);
  // Controls that re-render the view carry ids, so the shell's render restores focus to them.
  await activity.load(ctx);
  const html = activity.render(ctx);
  for (const id of [
    'activity-apply',
    'activity-clear-all',
    'activity-live',
    'activity-refresh',
    `activity-open-${traceId}`,
  ])
    assert.match(html, new RegExp(`id="${id}"`), id);
});

test('every module has its own colour, and deep activities stop indenting', async () => {
  const css = await fs.readFile(new URL('../admin/ui-kit.css', import.meta.url), 'utf8');
  const fills = [...css.matchAll(/\.ui-series-(\d+) \{\s*fill: (#[0-9a-f]{6});/g)].map((match) => match[2]);
  assert.equal(fills.length, MODULES.length);
  assert.equal(new Set(fills).size, MODULES.length, 'no two modules share a colour');
  const ctx = activityContext({ responses: activityResponses({ '/trace/id/fx-chain': chainTree(MODULES.length) }) });
  activity.route(ctx, new URLSearchParams(), ['fx-chain']);
  await activity.load(ctx);
  let html = activity.render(ctx);
  for (const index of MODULES.keys()) assert.match(html, new RegExp(`ui-bar-fill ui-series-${index}"`));
  ctx.data.activity.tree = chainTree(30);
  html = activity.render(ctx);
  assert.equal(count(html, /ui-waterfall-row ui-depth-12/g), 18);
  assert.doesNotMatch(html, /ui-depth-1[3-9]|ui-depth-2\d/);
  assert.match(html, />d29</);
  ctx.data.activity.stepsAs = 'tree';
  html = activity.render(ctx);
  assert.equal(count(html, /<ul role="group" class="is-flat">/g), 17);
});

test('step search and errors-only filter the steps; the JSON tab and copy buttons', async () => {
  const ctx = activityContext();
  activity.route(ctx, new URLSearchParams(), [traceId]);
  await activity.load(ctx);
  const filter = spanFilter(sample.tree, { spanSearch: 'X_CATEGORY' });
  assert.deepEqual([...filter.matched], [sdkSpan.spanId]);
  assert.equal(filter.shown.size, 6, 'the match and its five ancestors');
  await withDom(async ({ hashes }) => {
    activity.handle(ctx, uiEvent('input', { '[data-activity-span-search]': { value: 'x_category' } }));
    assert.match(hashes.at(-1), /\?spanSearch=x_category$/);
    let html = activity.render(ctx);
    assert.equal(count(html, /<li class="data-line ui-waterfall-row/g), 6);
    assert.equal(count(html, /is-context/g), 5);
    assert.match(html, /role="status">1 of 7 steps match</);
    activity.handle(ctx, uiEvent('input', { '[data-activity-span-search]': { value: '' } }));
    activity.handle(ctx, uiEvent('change', { '[data-activity-errors-only]': { checked: true } }));
    assert.match(hashes.at(-1), /\?errorsOnly=true$/);
    html = activity.render(ctx);
    assert.equal(count(html, /<li class="data-line ui-waterfall-row/g), 3);
    activity.handle(ctx, uiEvent('change', { '[data-activity-errors-only]': { checked: false } }));
  });
  ctx.data.activity.detail = 'json';
  const html = activity.render(ctx);
  safeMarkup(html);
  assert.match(html, new RegExp(`<pre class="ui-example ui-json" tabindex="0"[^>]*>\\{\\n {2}&quot;trace&quot;`));
  assert.match(
    html,
    new RegExp(`href="/__sim/api/trace/export\\?traceId=${traceId}&amp;format=json" download>Download activity`),
  );
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
      activity.handle(ctx, click('[data-activity-copy]', { activityCopy: 'id' }));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual([copied, notes], [[traceId], ['Activity id copied.']]);
      globalThis.location = { origin: 'http://127.0.0.1:1', pathname: '/_sim/' };
      activity.handle(ctx, click('[data-activity-copy]', { activityCopy: 'link' }));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(copied.at(-1), `http://127.0.0.1:1/_sim/#activity/${traceId}?detail=json`);
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { clipboard: { writeText: async () => Promise.reject(new Error('NotAllowedError')) } },
      });
      activity.handle(ctx, click('[data-activity-copy]', { activityCopy: 'id' }));
      await new Promise((resolve) => setImmediate(resolve));
    });
  } finally {
    delete globalThis.location;
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
  }
  assert.match(
    activity.render(ctx),
    new RegExp(
      `<textarea id="activity-copy-fallback" readonly rows="2" aria-describedby="activity-copy-fallback-help">${traceId}</textarea>`,
    ),
  );
});

test('chips remove one filter, and the p95 tile compares with the previous equal-length window', async () => {
  const ctx = activityContext();
  const read = ctx.request;
  const previous = { ...structuredClone(sample.stats), roots: { count: 1, errors: 0, p50: 10, p95: 10, max: 10 } };
  ctx.request = (path) => (/&to=/.test(path) ? (ctx.requested.push(path), Promise.resolve(previous)) : read(path));
  activity.route(ctx, new URLSearchParams({ kind: 'webapi', range: '15m', tab: 'stats' }));
  // A clock that moves on every reading: the current and the previous window still meet, because a load reads it once.
  let clock = Date.parse('2026-10-22T10:00:00.000Z');
  const ticking = mock.method(Date, 'now', () => (clock += 7));
  try {
    await activity.load(ctx);
  } finally {
    ticking.mock.restore();
  }
  const stats = ctx.requested.filter((path) => path.startsWith('/trace/stats'));
  assert.equal(stats.length, 2);
  const current = new URLSearchParams(stats[0].split('?')[1]),
    shifted = new URLSearchParams(stats[1].split('?')[1]);
  assert.equal(Date.parse(shifted.get('to')) + 1 - Date.parse(shifted.get('from')), 900_000);
  assert.equal(Date.parse(shifted.get('to')) + 1, Date.parse(current.get('from')));
  let html = activity.render(ctx);
  assert.match(
    html,
    /Root p95 vs before<\/span><strong class="ui-tile-value">\+110%<\/strong><span class="ui-tile-detail">21\.0 ms now · 10\.0 ms in the previous 15 m 0 s</,
  );
  assert.equal(previousWindow({ filters: {}, range: 'all' }), null);
  assert.match(
    html,
    /data-activity-unfilter="range" aria-label="Remove filter Last 15 minutes">Last 15 minutes <span aria-hidden="true">×<\/span>/,
  );
  assert.match(html, /data-activity-unfilter="kind" aria-label="Remove filter Step kind: webapi">/);
  await withDom(async ({ hashes }) => {
    activity.handle(ctx, click('[data-activity-unfilter]', { activityUnfilter: 'kind' }));
    await ctx.data.activity.reloading;
    assert.equal(hashes.at(-1), '#activity?range=15m&tab=stats');
    activity.handle(ctx, click('[data-activity-unfilter]', { activityUnfilter: 'range' }));
    await ctx.data.activity.reloading;
    assert.equal(hashes.at(-1), '#activity?tab=stats');
  });
  html = activity.render(ctx);
  assert.doesNotMatch(html, /ui-chips/);
  assert.match(
    html,
    /Root p95 vs before<\/span><strong class="ui-tile-value">—<\/strong><span class="ui-tile-detail">choose a time range to compare</,
  );
});

test('two activities compare side by side with per-step duration deltas and added or missing steps', async () => {
  const other = structuredClone(traceTree);
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
  const ctx = activityContext({ responses: activityResponses({ '/trace/id/fx-b': other }) });
  await activity.load(ctx);
  await withDom(async ({ hashes }) => {
    for (const id of [traceId, 'fx-b'])
      activity.handle(
        ctx,
        uiEvent('change', { '[data-activity-pick]': { checked: true, dataset: { activityPick: id } } }),
      );
    assert.match(
      activity.render(ctx),
      /id="activity-compare" data-activity-action="compare" aria-describedby="activity-pick-help">Compare the 2 ticked activities/,
    );
    ctx.requested.length = 0;
    activity.handle(ctx, click('[data-activity-action]', { activityAction: 'compare' }));
    await ctx.data.activity.reloading;
    assert.deepEqual(ctx.requested, [`/trace/id/${traceId}`, '/trace/id/fx-b']);
    assert.equal(hashes.at(-1), `#activity?compare=${traceId}%2Cfx-b`);
  });
  const html = activity.render(ctx);
  safeMarkup(html);
  assert.match(html, /data-ui-section="activity:compare" open/);
  assert.equal(count(html, /<ul class="ui-tree" aria-label="Step tree of activity [AB]">/g), 2);
  assert.match(
    html,
    /Retrieve x_category<\/span> <span class="ui-tree-facts">8\.00 ms <span class="ui-badge ui-tone-warn">\+5\.00 ms<\/span>/,
  );
  assert.match(html, /<dt>Root duration<\/dt><dd>21\.0 ms → 26\.0 ms \(\+5\.00 ms\)<\/dd>/);
  activity.route(ctx, new URLSearchParams({ compare: 'only-one' }));
  assert.equal(ctx.data.activity.compare, null);
});

test('the step drawer shows its path from the root, one-click Parent and Root, and named link targets', async () => {
  const linked = { traceId: 'fx-other-trace', spanId: 'fx-linked-span', kind: 'flow-run', name: 'Invented flow' };
  const ctx = activityContext({ responses: activityResponses({ '/trace/span/fx-linked-span': linked }) });
  activity.route(ctx, new URLSearchParams(), [traceId, sdkSpan.spanId]);
  await activity.load(ctx);
  let html = activity.render(ctx);
  safeMarkup(html);
  const path = html.match(/<nav class="ui-crumbs" aria-label="Step path"><ol>(.*?)<\/ol><\/nav>/)[1];
  assert.equal(count(path, /<li/g), 6, 'root, webapi, dataverse, stage, step, the step');
  assert.match(
    path,
    new RegExp(
      `^<li><a href="#activity/${traceId}/${rootSpan.spanId}"><span[^>]*>http</span> POST /_api/x_items</a></li>`,
    ),
  );
  assert.match(
    html,
    new RegExp(
      `id="activity-span-root" href="#activity/${traceId}/${rootSpan.spanId}" aria-label="Root step: http POST /_api/x_items">Root</a>`,
    ),
  );
  assert.match(
    html,
    new RegExp(
      `id="activity-span-parent" href="#activity/${traceId}/${stepSpan.spanId}" aria-label="Parent step: plugin-step Invented.Plugin.PreCreate">Parent</a>`,
    ),
  );
  assert.ok(!ctx.requested.some((item) => item.startsWith('/trace/span/')), 'targets inside the activity need no read');
  ctx.data.activity.spanId = rootSpan.spanId;
  assert.match(activity.render(ctx), /<dt>Parent<\/dt><dd>none \(root\)/);
  await withDom(async () => {
    activity.handle(ctx, click('[data-activity-span]', { activitySpan: jobSpan.spanId }));
    await new Promise((resolve) => setImmediate(resolve));
  });
  html = activity.render(ctx);
  assert.match(
    html,
    /triggered: <a href="#activity\/fx-other-trace\/fx-linked-span"><span class="ui-badge ui-tone-neutral">flow-run<\/span> Invented flow<\/a>/,
  );
  assert.deepEqual(
    ctx.requested.filter((item) => item.startsWith('/trace/span/')),
    ['/trace/span/fx-linked-span'],
  );
  // A target that is no longer retained keeps its link and says so; a failed one is still named.
  const gone = activityContext({
    responses: activityResponses({
      '/trace/span/fx-linked-span': refused(404, { code: 'SpanNotFound', message: 'No retained span has this id.' }),
    }),
  });
  activity.route(gone, new URLSearchParams(), [traceId, jobSpan.spanId]);
  await activity.load(gone);
  assert.match(
    activity.render(gone),
    /triggered: <a href="[^"]+">step <code>fx-linke<\/code><\/a> in activity <code>fx-other<\/code> \(no longer retained\)/,
  );
});

test('flow run, system job and plug-in step ids link to their views; a missing payload names its reason', async () => {
  const tree = structuredClone(traceTree);
  tree.spans.find((span) => span.kind === 'sdk-call').attributes.runId = 'run-1';
  tree.spans.find((span) => span.kind === 'plugin-stage').attributes.secure = true;
  const ctx = activityContext({ responses: activityResponses({ [`/trace/id/${traceId}`]: tree }) });
  activity.route(ctx, new URLSearchParams(), [traceId, stepSpan.spanId]);
  await activity.load(ctx);
  let html = activity.render(ctx);
  assert.match(
    html,
    /<a href="#operations\?key=plugin-step%3Astep-1" aria-label="Open plug-in step step-1 in Backend operations"><code>step-1<\/code><\/a>/,
  );
  assert.match(html, /href="#activity\?table=x_item&amp;recordId=item-1">Same record</);
  assert.match(html, /href="#flows\?run=run-1">Flow run ↗<\/a>/);
  ctx.data.activity.spanId = dataverseSpan.spanId;
  html = activity.render(ctx);
  assert.match(
    html,
    /<dt>Input<\/dt><dd>none<span class="ui-info">.*?This step was recorded at level full and its operation passed no input to the trace\./,
  );
  ctx.data.activity.spanId = tree.spans.find((span) => span.kind === 'plugin-stage').spanId;
  assert.match(
    activity.render(ctx),
    /<dt>Input<\/dt><dd>not captured \(sealed flow run\)<span class="ui-info">.*?This step belongs to a sealed flow run/,
  );
});

test('a filter the runtime refuses is named in a banner with a way out', async () => {
  const bogus = refused(400, {
    code: 'InvalidTraceFilter',
    message: 'status must be one of ok, error, denied, cancelled, running (got "bogus").',
    parameter: 'status',
  });
  const ctx = activityContext({ responses: activityResponses({ '/trace': bogus, '/trace/stats': bogus }) });
  activity.route(ctx, new URLSearchParams({ status: 'bogus' }));
  await activity.load(ctx);
  const html = activity.render(ctx);
  safeMarkup(html);
  assert.match(
    html,
    /<p class="ui-notice ui-tone-bad">The Step result \(status\) filter value &quot;bogus&quot; is not valid: status must be one of ok, error, denied, cancelled, running \(got &quot;bogus&quot;\)\. Nothing is listed until you change or remove it\.<\/p>/,
  );
  assert.match(
    html,
    /id="activity-unfilter-invalid" data-activity-unfilter="status">Remove the Step result filter<\/button>/,
  );
  assert.match(html, /<option value="bogus" selected>bogus \(not a listed value\)<\/option>/);
  // More filters opens by itself when one of its filters was refused.
  assert.match(html, /id="activity-more-filters" data-ui-section="activity:more"/);
  assert.match(html, /id="activity-more" data-activity-action="more" aria-expanded="true"/);
  // A refused `entity` (the store's name) is named as the Table filter.
  const table = activityContext({
    responses: activityResponses({
      '/trace': refused(400, { code: 'InvalidTraceFilter', message: 'bad', parameter: 'entity' }),
    }),
  });
  activity.route(table, new URLSearchParams({ table: 'x' }));
  await activity.load(table);
  assert.match(activity.render(table), /Remove the Table filter/);
});

test("Find steps matches exactly the steps the store's search matches", () => {
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
    assert.deepEqual([...spanFilter(tree, { spanSearch: query }).matched].sort(), listed, query);
  }
});

test('the list sits beside the open activity at 1200 px and wider and keeps its scroll position', async () => {
  const ctx = activityContext();
  await activity.load(ctx);
  let html = activity.render(ctx);
  // The tab strip is in the chrome's toolbar; its panel opens the layout, so the table starts right under the toolbar.
  assert.match(html, /<span class="ui-page-actions"><span class="ui-tablist ui-activity-tabstrip" role="tablist"/);
  assert.match(
    html,
    /<div class="ui-trace-layout"><div class="ui-trace-main"><div class="ui-tabpanel ui-activity-panel" role="tabpanel" id="activity-tabs-panel" aria-labelledby="activity-tabs-tab-activities"><div class="ui-data-table" data-data-table="activity-list"><div class="ui-table-wrap">/,
  );
  assert.doesNotMatch(html, /ui-trace-side/);
  activity.route(ctx, new URLSearchParams({ kind: 'http' }), [traceId]);
  await activity.load(ctx);
  html = activity.render(ctx);
  assert.match(html, /<div class="ui-trace-layout has-detail"><div class="ui-trace-main">/);
  assert.match(
    html,
    new RegExp(
      `<div class="ui-trace-side" data-trace-side="${traceId}\\|"><section class="ui-activity-detail" data-ui-section="activity:detail"`,
    ),
  );
  const column = (key, top) => ({ dataset: { traceSide: key }, scrollTop: top });
  let shown = column(`${traceId}|`, 640);
  globalThis.document = { querySelector: (selector) => (selector === '.ui-trace-side' ? shown : null) };
  try {
    activity.render(ctx);
    shown = column(`${traceId}|`, 0);
    activity.mounted(ctx);
    assert.equal(shown.scrollTop, 640);
    activity.render(ctx);
    ctx.data.activity.traceId = 'fx-other';
    shown = column('fx-other|', 0);
    activity.mounted(ctx);
    assert.equal(shown.scrollTop, 0);
  } finally {
    delete globalThis.document;
  }
  // The Activity sheet uses ui-kit tokens only (the dark theme follows from them) and never scrolls the page sideways.
  const css = await fs.readFile(new URL('../admin/activity.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgb\(/i);
  assert.match(css, /\.ui-log-text \{[^}]*overflow-wrap: anywhere;/);
  const index = await fs.readFile(new URL('../admin/index.html', import.meta.url), 'utf8');
  assert.match(index, /<link rel="stylesheet" href="\/__sim\/activity\.css" \/>/);
});

test('flow run details link to their activity', async () => {
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
  assert.match(flows.render(ctx), /<a class="ui-button ui-small" href="#activity\/fx-trace\/fx-span">Activity →<\/a>/);
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
  for (const name of ['ui-kit.css', 'shell.css', 'style.css', 'dashboard.css', 'persona-picker.css', 'activity.css']) {
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
  assert.deepEqual([product.band, product.group, product.name], ['organization', 'monitor', 'Activity']);
});
