// `#services` view module: providers and services of the organization. DOM-free at module scope; reads
// GET /__sim/api/dashboard (nodes and activity), /messages, /outbox, /flow-waits and /environment through ctx.request
// (API-relative paths) and probes through GET /__sim/api/preflight on demand. Values of secrets, connection settings and
// endpoint queries never reach this view: the routes send names, counts, statuses and hostnames only.
import * as kit from './ui-kit.mjs';
import { HELP } from './help-content.mjs';
import { viewCommon } from './view-common.mjs';

const ID = 'services';
const { e, value, list, failure, failed, json, yes, activityCounts, fieldHelp, heading, panel, pending } = viewCommon({ id: ID, label: 'Providers & services', kit, help: HELP });
/** Panel summary of a route answer: its count when configured, "unavailable" on a failed read, "not configured" only when the host said so. */
const configured = (answer, count) => (answer?.error ? 'unavailable' : answer?.configured ? count : answer?.configured === false ? 'not configured' : 'not reported');

function storagePanel(ctx, d, node, byPrefix, activity) {
  const storage = node('provider:storage');
  if (!storage) return kit.notice('No storage provider is described by this runtime. Declare providers.storage in /_setup/ (Providers & services) and restart.', 'warn');
  const usage = Object.fromEntries((activity.storage?.byProvider ?? []).map(item => [item.id, item]));
  const providers = list(ctx, 'svc-storage-providers', storage.detail?.providers ?? [], [
    { label: 'Provider', render: item => `<code>${e(item.id)}</code>` },
    { label: 'Kind', render: item => e(item.kind ?? '—') },
    { label: 'Level', render: item => kit.levelBadge(item.level) },
    { label: 'Readiness', render: item => kit.statusBadge(item.ready ? 'ready' : 'declared') },
    { label: 'Routes', render: item => e((item.routes ?? []).join(', ') || '—') },
    { label: 'Writes', render: item => e(usage[item.id]?.writes ?? 0) },
    { label: 'Deletes', render: item => e(usage[item.id]?.deletes ?? 0) },
    { label: 'Bytes written', render: item => e(usage[item.id]?.bytesWritten ?? 0) },
  ], 'No storage provider is declared.', 'Storage providers');
  const routes = list(ctx, 'svc-storage-routes', byPrefix('provider:storage-route:'), [
    { label: 'Route', render: item => `<code>${e(item.label)}</code>` },
    { label: 'Provider', render: item => e(item.detail?.provider ?? '—') },
    { label: 'Status', render: item => kit.statusBadge(item.status) },
  ], 'No storage route is configured.', 'Storage routes');
  const azurite = node('external:azurite');
  const probe = d.storageProbe ? list(ctx, 'svc-storage-probe', d.storageProbe, [
    { label: 'Provider', render: item => `<code>${e(item.id)}</code>` },
    { label: 'Result', render: item => kit.badge(item.status, item.status === 'satisfied' ? 'ok' : 'bad') },
    { label: 'Message', render: item => e(item.message ?? '') },
  ], 'The preflight report has no Azurite provider row.', 'Last storage probe') : '<p class="ui-help">Not probed in this session.</p>';
  const declared = azurite
    ? `${kit.kv([['Declared providers', e((azurite.detail?.providers ?? []).join(', ')), { mono: true }], ['Status', kit.statusBadge(azurite.status)],
      ...(azurite.detail?.health ?? []).filter(item => item.reason).map(item => [`Reason (${e(item.id)})`, e(item.reason)])])}`
      + `<p><button type="button" class="ui-button ui-small" data-svc-probe-storage>Probe storage now</button></p>${probe}`
    : '<p class="ui-help">No Azurite provider is declared. Core talks to Azurite over the Blob REST API with Shared Key authorization once its connection string is set; without one the provider is declared only. Paqvilo never starts Azurite.</p>';
  return `<h3>Providers</h3>${providers}<h3>Routes</h3>${routes}<h3>Azurite</h3>${declared}`;
}

function messagingPanel(ctx, d, node, activity) {
  const messages = d.messages ?? {};
  if (messages.error) return kit.notice(`The message bus could not be read: ${failed(messages)}`, 'bad');
  if (!messages.configured && messages.configured !== false) return kit.notice('This host did not report its message bus.', 'warn');
  if (!messages.configured) return kit.notice('No message bus is configured. Declare one under providers.messaging in /_setup/.', 'info');
  const bus = node('provider:messaging'), totals = activity.messages ?? {};
  const summary = kit.kv([
    ['Bus', `<code>${e(bus?.detail?.id ?? 'local')}</code> ${bus?.level ? kit.levelBadge(bus.level) : ''}`],
    ['Totals', e(activityCounts(totals))],
  ]);
  const endpoints = list(ctx, 'svc-endpoints', Object.entries(messages.endpoints ?? {}).map(([endpoint, target]) => ({ endpoint, target })), [
    { label: 'Service endpoint', render: item => `<code>${e(item.endpoint)}</code>` },
    { label: 'Target', render: item => `<code>${e(item.target)}</code>` },
  ], 'No service endpoint is mapped to the bus.', 'Mapped service endpoints');
  const entities = list(ctx, 'svc-entities', messages.entities ?? [], [
    { label: 'Entity', render: item => `<code>${e(item.entity)}</code>` },
    { label: 'Active', render: item => e(item.stats?.active ?? 0) },
    { label: 'Locked', render: item => e(item.stats?.locked ?? 0) },
    { label: 'Scheduled', render: item => e(item.stats?.scheduled ?? 0) },
    { label: 'Dead-lettered', render: item => e(item.stats?.deadLettered ?? 0) },
    { label: 'Actions', render: item => `<button type="button" class="ui-button ui-small" data-svc-peek="${e(item.entity)}" aria-label="Peek ${e(item.entity)}">Peek</button> `
      + `<button type="button" class="ui-button ui-small" data-svc-purge="${e(item.entity)}" aria-label="Purge ${e(item.entity)}">Purge</button>` },
  ], 'The bus has no entity yet.', 'Bus entities');
  const max = `<p><label for="svc-peek-max">Messages to peek</label> <input id="svc-peek-max" type="number" min="1" max="1000" value="${e(d.peekMax ?? 100)}" aria-describedby="svc-peek-max-help">`
    + `${kit.fieldHelp('svc-peek-max', 'Peek reads without locking, at most 1000 messages. Use <entity>/$deadletterqueue for dead letters.')}</p>`;
  const peek = d.peek
    ? `<h3>Messages in <code>${e(d.peek.entity)}</code></h3>${d.peek.error ? kit.notice(d.peek.error, 'bad') : list(ctx, 'svc-peek', d.peek.messages ?? [], [
      { label: 'Sequence', render: item => e(item.sequenceNumber ?? '') },
      { label: 'Message id', render: item => `<code>${e(item.messageId ?? '')}</code>` },
      { label: 'State', render: item => kit.badge(item.state ?? 'unknown', item.state === 'deadLettered' ? 'bad' : item.state === 'active' ? 'ok' : 'info') },
      { label: 'Enqueued', render: item => e(item.enqueuedTime ?? '') },
      { label: 'Deliveries', render: item => e(item.deliveryCount ?? 0) },
      { label: 'Body', render: item => `<code>${json(item.body)}</code>` },
    ], 'The entity has no message.', `Messages in ${d.peek.entity}`)}<p><button type="button" class="ui-button ui-small" data-svc-peek-close>Close messages</button></p>`
    : '';
  return `${summary}<h3>Endpoints</h3>${endpoints}<h3>Entities</h3>${max}${entities}${peek}`;
}

const CHANNELS = ['email', 'teams', 'outlook', 'portal-email'];
function outboxPanel(ctx, d) {
  const filter = d.outboxFilter ?? {}, outbox = d.outbox ?? {};
  const field = (id, name, label, help) => `<div><label for="${id}">${e(label)}</label><input id="${id}" name="${name}" type="text" value="${e(filter[name] ?? '')}" aria-describedby="${id}-help">${kit.fieldHelp(id, help)}</div>`;
  const form = `<form id="svc-outbox-form" class="ui-form" data-svc-outbox-form>${field('svc-outbox-correlation', 'correlationId', 'Correlation id', 'Exact correlation id of the captured entries.')}`
    + `<div><label for="svc-outbox-channel">Channel</label><select id="svc-outbox-channel" name="channel" aria-describedby="svc-outbox-channel-help"><option value="">Any channel</option>${CHANNELS.map(channel => `<option value="${channel}"${filter.channel === channel ? ' selected' : ''}>${channel}</option>`).join('')}</select>`
    + `${fieldHelp(ctx, 'svc-outbox-channel', 'services.outbox', 'channel')}</div>`
    + `${field('svc-outbox-since', 'since', 'Since', 'An ISO date and time; entries created at or after it are listed.')}`
    + '<p><button type="submit" class="ui-button ui-primary ui-small">Filter outbox</button> <button type="button" class="ui-button ui-small" data-svc-outbox-clear>Clear filter</button></p></form>';
  if (outbox.error) return `${form}${kit.notice(`The outbox could not be read: ${failed(outbox)}`, 'bad')}`;
  if (!outbox.configured && outbox.configured !== false) return `${form}${kit.notice('This host did not report its outbox.', 'warn')}`;
  if (!outbox.configured) return `${form}${kit.notice('No outbox is configured. Declare providers.outbox in /_setup/ (Providers & services) and restart.', 'info')}`;
  return form + list(ctx, 'svc-outbox', outbox.entries ?? [], [
    { label: 'Created', render: item => e(item.createdOn ?? '') },
    { label: 'Channel', render: item => e(item.channel ?? '') },
    { label: 'To', render: item => e((item.to ?? []).join(', ')) },
    { label: 'Subject', render: item => e(item.subject ?? '') },
    { label: 'State', render: item => kit.badge(item.state ?? 'queued', item.state === 'failed' ? 'bad' : item.state === 'delivered' ? 'ok' : 'info') },
    { label: 'Correlation id', render: item => `<code>${e(item.correlationId ?? '')}</code>` },
  ], 'No captured entry matches.', 'Outbox entries');
}

function connectorsPanel(ctx, d, node, byPrefix, activity) {
  const connectors = node('provider:connectors')?.detail?.providers ?? [];
  const providers = list(ctx, 'svc-connector-providers', connectors, [
    { label: 'Provider', render: item => `<code>${e(item.id)}</code>` },
    { label: 'Level', render: item => kit.levelBadge(item.level) },
    { label: 'Operations', render: item => e(item.operations ?? 0) },
  ], 'No connector provider is registered.', 'Connector providers');
  const connections = list(ctx, 'svc-connections', byPrefix('connection:'), [
    { label: 'Connection', render: item => `<code>${e(item.label)}</code>` },
    { label: 'Provider', render: item => e(item.detail?.provider ?? '—') },
    { label: 'Connector', render: item => e(item.detail?.connector ?? '—') },
    { label: 'Principal', render: item => e(item.detail?.principal ?? 'none') },
  ], 'No connection is declared. Declare connections in /_setup/ (Providers & services); settings use env: references.', 'Connections');
  const waits = d.waits ?? [];
  const approvals = !Array.isArray(waits) ? kit.notice(`Flow waits could not be read: ${failed(waits)}`, 'warn') : list(ctx, 'svc-approvals', waits.filter(wait => wait.kind === 'approval'), [
    { label: 'Approval', render: item => `<code>${e(item.id)}</code>` },
    { label: 'Run', render: item => `<a href="#flows?run=${encodeURIComponent(item.runId)}">${e(item.runId)}</a>` },
    { label: 'Assigned to', render: item => e(Array.isArray(item.assignedTo) ? item.assignedTo.join(', ') : item.assignedTo ?? '—') },
    { label: 'Timeout', render: item => e(item.timeoutAt ?? '—') },
    { label: 'Overdue', render: item => (item.overdue ? kit.badge('overdue', 'warn') : kit.badge('pending', 'info')) },
  ], 'No approval is waiting. Answer approvals in Flows & jobs.', 'Pending approvals');
  const totals = activity.messages ?? {};
  const queue = connectors.some(item => item.id === 'memory-queue')
    ? `<p class="ui-help">memory-queue sends through the local message bus: ${e(activityCounts(totals))}.</p>`
    : '<p class="ui-help">The memory-queue connector is not registered, so there is no queue depth.</p>';
  return `<h3>Providers</h3>${providers}${queue}<h3>Connections</h3>${connections}<h3>Pending approvals</h3>${approvals}`;
}

function secretsPanel(ctx, d, node) {
  const resolver = node('provider:secrets');
  const intro = '<p class="ui-help">Secret values are never shown here: only names, bound status and the resolver status.</p>';
  const head = resolver?.status === 'ready'
    ? kit.kv([['Resolver', kit.statusBadge('ready')], ['Secret names known to the resolver', e(resolver.detail?.keys ?? 0)]])
    : kit.notice('No secret resolver is configured. Declare secrets in /_setup/ (Providers & services); values come from environment variables or DPAPI-protected entries.', 'info');
  const environment = d.environment ?? {};
  const references = environment.error
    ? kit.notice(`Secret environment variables could not be read on this host: ${failed(environment)}`, 'warn')
    : list(ctx, 'svc-secrets', (environment.environmentVariables?.definitions ?? []).filter(item => item.secret), [
      { label: 'Environment variable', render: item => `<code>${e(item.schemaName ?? item.id)}</code>` },
      { label: 'Bound', render: item => yes(item.secretStatus?.bound, 'bound', 'unbound') },
      { label: 'Status', render: item => e(item.secretStatus?.status ?? 'unknown') },
    ], 'No Secret environment variable is defined in the Solution sources.', 'Secret environment variables');
  return `${intro}${head}${references}`;
}

function localServicesPanel(ctx, d, byPrefix) {
  const probes = d.probes ?? {};
  return list(ctx, 'svc-local-services', byPrefix('provider:local-service:'), [
    { label: 'Service', render: item => `<code>${e(item.label)}</code>` },
    { label: 'Kind', render: item => e(item.detail?.service ?? '—') },
    { label: 'Required', render: item => yes(item.detail?.required, 'required', 'optional') },
    { label: 'Status', render: item => kit.statusBadge(item.status) },
    { label: 'Last probe', render: item => { const probe = probes[item.label]; return probe ? `${kit.badge(probe.status, probe.status === 'satisfied' ? 'ok' : 'bad')} ${e(probe.message ?? '')}` : 'Not probed'; } },
    { label: 'Probe', render: item => `<button type="button" class="ui-button ui-small" data-svc-probe="${e(item.label)}" aria-label="Probe ${e(item.label)} now">Probe now</button>` },
  ], 'No local service is declared. Declare one under localServices in /_setup/ (Providers & services); Paqvilo probes it and never starts it.', 'Declared local services');
}

function fixturesPanel(ctx, byPrefix) {
  return list(ctx, 'svc-fixtures', byPrefix('provider:service-fixture:'), [
    { label: 'Service', render: item => `<code>${e(item.label)}</code>` },
    { label: 'Status', render: item => kit.statusBadge(item.status) },
    { label: 'Operations by level', render: item => e(Object.entries(item.detail?.operations ?? {}).map(([level, count]) => `${level}: ${count}`).join(', ') || '—') },
  ], 'No service fixture is registered: Power BI, AI Builder, Copilot and Dynamics apps answer ServiceDisabled.', 'Service fixtures');
}

function appsPanel(ctx, node, state) {
  const components = (state?.inventory ?? state?.status?.inventory)?.components ?? {};
  const canvas = node('app:canvas'), code = node('app:code');
  return kit.kv([
    ['Canvas apps', `${e(canvas?.detail?.apps ?? components.canvasapp?.count ?? 0)} ${canvas ? kit.statusBadge(canvas.status) : kit.statusBadge('unknown')}`],
    ['Code apps', `${e(code?.detail?.apps ?? 0)} ${code ? kit.statusBadge(code.status) : kit.statusBadge('unknown')}`],
    ['PCF controls (Solution inventory)', e(components.customcontrol?.count ?? 0)],
  ]) + '<p class="ui-help">Counts come from the Solution source inventory and the code app configuration; nothing here runs an app.</p>';
}

function sharepointPanel(ctx, node, byPrefix) {
  const route = node('provider:storage-route:sharepointDocuments');
  const connections = byPrefix('connection:').filter(item => /sharepoint/i.test(`${item.detail?.connector ?? ''} ${item.detail?.provider ?? ''}`));
  return kit.kv([
    ['Document route', route ? `<code>${e(route.detail?.provider ?? '—')}</code> ${kit.statusBadge(route.status)}` : kit.statusBadge('missing')],
    ['SharePoint connections', e(connections.map(item => item.label).join(', ') || 'none')],
  ]) + (connections.length ? '' : '<p class="ui-help">No SharePoint connection is declared, so the SharePoint and Graph REST contract is not mounted.</p>');
}

export const view = {
  id: ID,
  label: 'Providers & services',
  icon: '⛁',
  hosts: ['power-pages', 'standalone'],
  requires: ['/__sim/api/dashboard'],

  async load(ctx) {
    const d = (ctx.data[ID] ??= {});
    const filter = new URLSearchParams(Object.entries(d.outboxFilter ?? {}).filter(([, item]) => item));
    const [dashboard, messages, outbox, waits, environment] = await Promise.all([
      ctx.request('/dashboard'),
      ctx.request('/messages').catch(failure),
      ctx.request(`/outbox${filter.size ? `?${filter}` : ''}`).catch(failure),
      ctx.request('/flow-waits').catch(failure),
      ctx.request('/environment').catch(failure),
    ]);
    Object.assign(d, { dashboard, messages, outbox, waits, environment });
  },

  render(ctx) {
    const d = ctx.data[ID] ?? {}, nodes = d.dashboard?.nodes ?? [], activity = d.dashboard?.activity ?? {};
    const node = id => nodes.find(item => item.id === id);
    const byPrefix = prefix => nodes.filter(item => String(item.id).startsWith(prefix));
    const state = value(ctx.state);
    const storageNode = node('provider:storage');
    return heading(ctx)
      + panel(ctx, 'storage', 'Storage', storageNode ? `${storageNode.detail?.providers?.length ?? 0} providers · ${byPrefix('provider:storage-route:').length} routes` : 'not configured', storagePanel(ctx, d, node, byPrefix, activity), true)
      + panel(ctx, 'messaging', 'Messaging', configured(d.messages, `${d.messages?.entities?.length ?? 0} entities`), messagingPanel(ctx, d, node, activity))
      + panel(ctx, 'outbox', 'Outbox', configured(d.outbox, `${d.outbox?.entries?.length ?? 0} entries`), outboxPanel(ctx, d))
      + panel(ctx, 'connectors', 'Connectors & connections', `${byPrefix('connection:').length} connections`, connectorsPanel(ctx, d, node, byPrefix, activity))
      + panel(ctx, 'secrets', 'Secrets', node('provider:secrets')?.status ?? 'unknown', secretsPanel(ctx, d, node))
      + panel(ctx, 'local-services', 'Local services', `${byPrefix('provider:local-service:').length} declared`, localServicesPanel(ctx, d, byPrefix))
      + panel(ctx, 'service-fixtures', 'Service fixtures', `${byPrefix('provider:service-fixture:').length} services`, fixturesPanel(ctx, byPrefix))
      + panel(ctx, 'powerfx', 'Power Fx', node('provider:powerfx')?.level ?? 'not described',
        node('provider:powerfx') ? kit.kv([['Evaluator', e(node('provider:powerfx').detail?.name ?? '—')], ['Level', kit.levelBadge(node('provider:powerfx').level)]]) : kit.notice('This runtime describes no Power Fx evaluator.', 'info'))
      + panel(ctx, 'apps', 'Canvas, code apps and PCF', '', appsPanel(ctx, node, state))
      + panel(ctx, 'sharepoint', 'SharePoint route', '', sharepointPanel(ctx, node, byPrefix));
  },

  handle(ctx, event) {
    const d = (ctx.data[ID] ??= {});
    const target = selector => event.target?.closest?.(selector);
    if (event.type === 'submit' && target('[data-svc-outbox-form]')) {
      event.preventDefault();
      d.outboxFilter = Object.fromEntries([...new FormData(target('[data-svc-outbox-form]'))].map(([name, item]) => [name, String(item).trim()]));
      ctx.refresh();
      return true;
    }
    if (event.type !== 'click') return false;
    const peek = target('[data-svc-peek]'), purge = target('[data-svc-purge]'), probe = target('[data-svc-probe]'), storage = target('[data-svc-probe-storage]');
    if (target('[data-svc-outbox-clear]')) { d.outboxFilter = {}; ctx.refresh(); return true; }
    if (target('[data-svc-peek-close]')) { d.peek = null; ctx.refresh(); return true; }
    if (peek) {
      const entity = peek.dataset.svcPeek;
      const max = Math.min(1000, Math.max(1, Number(event.target.ownerDocument?.getElementById('svc-peek-max')?.value) || 100));
      d.peekMax = max;
      return pending(ctx, peek, async () => { d.peek = await ctx.request(`/messages?entity=${encodeURIComponent(entity)}&max=${max}`); await ctx.refresh(); });
    }
    if (purge) {
      const entity = purge.dataset.svcPurge;
      ctx.askConfirmation(`Purge ${entity}?`, `Removes every message of ${entity} from the local bus. Its dead-letter queue (${entity}/$deadletterqueue) is kept. This changes local state and cannot be undone.`, async () => {
        const result = await ctx.request(`/messages/${encodeURIComponent(entity)}`, { method: 'DELETE' });
        if (d.peek?.entity === entity) d.peek = null;
        ctx.notify(`Purged ${result.purged ?? 0} messages from ${entity}.`);
        await ctx.refresh();
      }, 'Purge');
      return true;
    }
    if (probe) {
      const id = probe.dataset.svcProbe;
      return pending(ctx, probe, async () => {
        const report = await ctx.request(`/preflight?requires=${encodeURIComponent(`local-service:${id}`)}`);
        (d.probes ??= {})[id] = report.requirements?.find(row => row.id === `local-service:${id}`) ?? { status: 'missing', message: 'The preflight report has no row for this service.' };
        await ctx.refresh();
      });
    }
    if (storage) {
      return pending(ctx, storage, async () => {
        const report = await ctx.request(`/preflight?requires=${encodeURIComponent('provider:storage/*')}`);
        d.storageProbe = (report.requirements ?? []).filter(row => String(row.id).startsWith('provider:storage/'));
        await ctx.refresh();
      });
    }
    return false;
  },
};
