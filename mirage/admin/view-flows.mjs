// `#flows` view module: cloud flow runs, waits and approvals, and the organization's background work. DOM-free at
// module scope; reads GET /__sim/api/flow-runs[/<id>], /flow-waits[?state=] and /dashboard (activity.jobs, asyncOperations,
// webhooks) through ctx.request (API-relative paths) and answers a wait with POST /__sim/api/flow-waits/<id>.
import * as kit from './ui-kit.mjs';
import { HELP } from './help-content.mjs';
import { viewCommon } from './view-common.mjs';

const ID = 'flows';
const { e, list, failure, failed, json, fieldHelp, heading, panel, pending, deepLink } = viewCommon({
  id: ID,
  label: 'Flows & jobs',
  kit,
  help: HELP,
});
const STATUSES = ['Running', 'Waiting', 'Succeeded', 'Failed', 'Cancelled', 'TimedOut'];
/** The flow's name: the run's own, else the cloud flow of the same process in the operations, else its process id. */
const flowName = (ctx, run) => {
  const id = String(run?.processId ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
  const operation = (ctx.state?.()?.config?.operations ?? []).find(
    (item) =>
      item.kind === 'cloud-flow' &&
      String(item.processId ?? item.id ?? '')
        .replace(/[{}]/g, '')
        .toLowerCase() === id,
  );
  return run?.name ?? run?.flowName ?? operation?.name ?? run?.processId ?? 'Flow';
};
/** The run's flow-run step in Activity (#activity/<traceId>/<spanId>), or '' while the trace store has none. */
const activityHref = (run) =>
  run?.traceId ? `#activity/${[run.traceId, run.traceSpanId].filter(Boolean).map(encodeURIComponent).join('/')}` : '';
// In a table row the link names its run (aria-label); in the run details the heading already does.
const activityLink = (run, { row = false } = {}) =>
  activityHref(run)
    ? `<a class="ui-button ui-small" href="${e(activityHref(run))}"${row ? ` aria-label="Activity of run ${e(run.id)}"` : ''}>Activity →</a>`
    : '';
// The Monitor vocabulary (D-M-2): a run or action result is ok, error, running or cancelled, like an activity; the
// flow run status of the platform (Succeeded, TimedOut…) follows it in small text.
const RESULTS = {
  Succeeded: 'ok',
  Failed: 'error',
  TimedOut: 'error',
  Cancelled: 'cancelled',
  Running: 'running',
  Waiting: 'running',
  Skipped: 'cancelled',
};
const RESULT_TONES = { ok: 'ok', error: 'bad', running: 'info', cancelled: 'neutral' };
// The platform status follows the result only when it says more than the result does.
const DETAIL = { TimedOut: 'timed out', Waiting: 'waiting', Skipped: 'skipped' };
const result = (status) => {
  const value = RESULTS[status] ?? (status ? String(status).toLowerCase() : 'unknown');
  return `${kit.badge(value, RESULT_TONES[value] ?? 'neutral')}${DETAIL[status] ? ` <span class="ui-help">${e(DETAIL[status])}</span>` : ''}`;
};

function runDetail(ctx, d) {
  if (!d.runId) return '';
  const run = d.run ?? {};
  if (!run.error && run.id !== d.runId) return `<p role="status" class="ui-help">Loading run ${e(d.runId)}…</p>`;
  if (run.error) return kit.notice(`Flow run ${d.runId} could not be read: ${failed(run)}`, 'bad');
  const journal = Object.entries(run.journal ?? {}).map(([action, entry]) => ({ action, ...entry }));
  const facts = kit.kv([
    ['Flow', e(flowName(ctx, run))],
    ['Run', `<code>${e(run.id)}</code>`],
    ['Process', `<code>${e(run.processId ?? '—')}</code>`],
    ['Result', result(run.status)],
    ['Started', kit.time(run.starttime)],
    ['Ended', kit.time(run.endtime)],
    ['Trigger', e(run.triggertype ?? '—')],
    ['Correlation id', `<code>${e(run.correlationId ?? '—')}</code>`],
    ['Wait', e(run.wait ? `${run.wait.kind} ${run.wait.id}` : 'none')],
    ['Not resumable', e(run.notResumable ?? 'no')],
  ]);
  const table = run.journalPruned
    ? kit.notice('The journal of this run was pruned: only the newest finished runs keep their journals.', 'info')
    : list(
        ctx,
        'flow-journal',
        journal,
        [
          { label: 'Action', render: (item) => `<code>${e(item.action)}</code>` },
          { label: 'Result', render: (item) => result(item.status) },
          { label: 'Attempts', render: (item) => e(item.attempts?.length ?? 1) },
          {
            label: 'Outputs',
            render: (item) =>
              item.secure ? kit.badge('secure: not journalled', 'neutral') : `<code>${json(item.outputs)}</code>`,
          },
        ],
        'No action is journalled yet.',
        `Journal of run ${run.id}`,
      );
  const trace = run.traceId
    ? `<p>${activityLink(run)} <span class="ui-help">Every step of this run, with its log lines and findings.</span></p>`
    : '';
  return (
    `<h3>Run of ${e(flowName(ctx, run))} <code>${e(run.id ?? d.runId)}</code></h3>${facts}${trace}` +
    kit.section({
      key: `${ID}:journal`,
      title: 'Action journal',
      summary: `${journal.length} actions`,
      open: Boolean(ctx.open?.(`${ID}:journal`)),
      body: table,
    }) +
    '<p><button type="button" class="ui-button ui-small" data-flow-run-close>Close run</button></p>'
  );
}

const DRAWER = 'flows-filters';
/** A result filter choice as the drawer and its chip name it: "ok · succeeded", "error · timed out". */
const resultLabel = (status) => `${RESULTS[status] ?? status} · ${DETAIL[status] ?? String(status).toLowerCase()}`;
const FILTER_LABELS = { processId: 'Process', status: 'Result' };
/** The runs filter form, shown in the Filters drawer (D-M-7). */
function runsFilters(ctx, d) {
  const filter = d.filter ?? {};
  return (
    `<form id="flow-runs-form" class="ui-form" data-flow-runs-form><div><label for="flow-process">Process id</label>` +
    `<input id="flow-process" name="processId" type="text" value="${e(filter.processId ?? '')}" aria-describedby="flow-process-help">${kit.fieldHelp('flow-process', 'The workflow id of the cloud flow; leave empty for every flow.')}</div>` +
    `<div><label for="flow-status">Result</label><select id="flow-status" name="status" aria-describedby="flow-status-help"><option value="">Any result</option>${STATUSES.map((status) => `<option value="${status}"${filter.status === status ? ' selected' : ''}>${e(resultLabel(status))}</option>`).join('')}</select>` +
    `${fieldHelp(ctx, 'flow-status', 'flows.runs', 'status')}</div>` +
    '<p><button type="submit" class="ui-button ui-primary ui-small">Apply filters</button></p></form>'
  );
}
/** The chrome of the page: run count, the Filters toggle with its count and the active filters as chips. */
function chrome(ctx, d) {
  const active = Object.entries(d.filter ?? {}).filter(([, value]) => value);
  return (
    heading(ctx, {
      // The runs table's search box sits in this toolbar row (D-M-11); Filters filter the runs on the runtime.
      actions: kit.tableSearch('flow-runs', ctx.pager('flow-runs').search),
      filters: { count: active.length, drawerId: DRAWER },
      chips: {
        items: active.map(([name, value]) => ({
          label: `${FILTER_LABELS[name] ?? name}: ${name === 'status' ? resultLabel(value) : value}`,
          attrs: { 'data-flow-unfilter': name },
        })),
        clear: { 'data-flow-unfilter': '*' },
      },
    }) + kit.filterDrawer({ id: DRAWER, title: 'Filter runs', body: runsFilters(ctx, d) })
  );
}
function runsPanel(ctx, d) {
  if (!Array.isArray(d.runs))
    return kit.notice(
      d.runs?.error ? `Flow runs could not be read: ${failed(d.runs)}` : 'This host did not report flow runs.',
      'warn',
    );
  return (
    list(
      ctx,
      'flow-runs',
      d.runs,
      [
        {
          label: 'Flow',
          sortKey: 'flow',
          sortValue: (item) => flowName(ctx, item),
          render: (item) =>
            `<strong>${e(flowName(ctx, item))}</strong><div class="ui-help"><code>${e(item.id)}</code></div>`,
        },
        { label: 'Result', sortKey: 'status', render: (item) => result(item.status) },
        {
          label: 'Started',
          sortKey: 'starttime',
          info: kit.timeZoneNote(),
          render: (item) => kit.time(item.starttime),
        },
        { label: 'Ended', sortKey: 'endtime', render: (item) => kit.time(item.endtime) },
        { label: 'Trigger', render: (item) => e(item.triggertype ?? '—') },
        {
          label: 'Actions',
          className: 'ui-actions',
          render: (item) =>
            `<button type="button" class="ui-button ui-small" data-flow-run="${e(item.id)}" data-row-open aria-label="Details of run ${e(item.id)}">Details</button>${activityLink(item, { row: true })}`,
        },
      ],
      'No flow run matches. Runs appear when a cloud flow trigger fires.',
      'Flow runs',
      // The page's Filters drawer filters the runs (result, flow, time) and its toolbar row holds the search box.
      { filters: null, bar: false },
    ) + runDetail(ctx, d)
  );
}

function answerForm(ctx, d) {
  const wait = Array.isArray(d.waits) ? d.waits.find((item) => item.id === d.answer) : null;
  if (!wait) return '';
  const approval = wait.kind === 'approval';
  const body = approval
    ? `<div><label for="flow-responder">Responder</label><input id="flow-responder" name="responder" type="text" aria-describedby="flow-responder-help">${kit.fieldHelp('flow-responder', 'Who answers, for example reviewer@example.test.')}</div>` +
      `<div><label for="flow-comments">Comments</label><textarea id="flow-comments" name="comments" rows="3" aria-describedby="flow-comments-help"></textarea>${fieldHelp(ctx, 'flow-comments', 'flows.waits', 'comments')}</div>` +
      '<p><button type="submit" class="ui-button ui-primary ui-small" name="outcome" value="Approve">Approve</button> <button type="submit" class="ui-button ui-small" name="outcome" value="Reject">Reject</button></p>'
    : `<div><label for="flow-outputs">Outputs JSON</label><textarea id="flow-outputs" name="outputs" rows="4" aria-describedby="flow-outputs-help">{}</textarea>${kit.fieldHelp('flow-outputs', `The outputs the ${wait.kind} wait returns to the run, as a JSON object.`)}</div>` +
      '<p><button type="submit" class="ui-button ui-primary ui-small">Resume run</button></p>';
  return (
    `<form id="flow-wait-form" class="ui-form" data-flow-wait-form="${e(wait.id)}"><h3>Answer ${e(wait.kind)} <code>${e(wait.id)}</code></h3>` +
    `<p class="ui-help">Answering resumes run ${e(wait.runId)} by replaying its journal. This changes local state.</p>${body}` +
    '<p><button type="button" class="ui-button ui-small" data-flow-answer-cancel>Cancel</button></p></form>'
  );
}

function waitsPanel(ctx, d) {
  const filter = `<p><label for="flow-wait-state">Show</label> <select id="flow-wait-state" data-flow-wait-state aria-describedby="flow-wait-state-help">${[
    ['', 'All waits'],
    ['pending', 'Pending'],
    ['overdue', 'Overdue'],
  ]
    .map(
      ([option, label]) =>
        `<option value="${option}"${(d.waitState ?? '') === option ? ' selected' : ''}>${label}</option>`,
    )
    .join('')}</select> ${fieldHelp(ctx, 'flow-wait-state', 'flows.waits', 'state')}</p>`;
  if (!Array.isArray(d.waits))
    return `${filter}${kit.notice(d.waits?.error ? `Flow waits could not be read: ${failed(d.waits)}` : 'This host did not report flow waits.', 'warn')}`;
  return (
    filter +
    list(
      ctx,
      'flow-waits',
      d.waits,
      [
        { label: 'Wait', render: (item) => `<code>${e(item.id)}</code>` },
        { label: 'Kind', render: (item) => e(item.kind) },
        { label: 'Run', render: (item) => `<code>${e(item.runId)}</code>` },
        { label: 'Until / timeout', render: (item) => kit.time(item.until ?? item.timeoutAt) },
        {
          label: 'Assigned to',
          render: (item) => e(Array.isArray(item.assignedTo) ? item.assignedTo.join(', ') : (item.assignedTo ?? '—')),
        },
        {
          label: 'State',
          render: (item) => (item.overdue ? kit.badge('overdue', 'warn') : kit.badge('pending', 'info')),
        },
        {
          label: 'Answer',
          render: (item) =>
            `<button type="button" class="ui-button ui-small" data-flow-answer="${e(item.id)}" aria-label="Answer wait ${e(item.id)}">Answer</button>`,
        },
      ],
      'No run is waiting.',
      'Flow waits',
    ) +
    answerForm(ctx, d)
  );
}

function backgroundPanel(ctx, d) {
  const activity = d.dashboard?.activity ?? {},
    jobs = activity.jobs ?? {};
  const node = (d.dashboard?.nodes ?? []).find((item) => item.id === 'org:jobs');
  const scheduler = node?.detail?.scheduler;
  const tiles = kit.tiles([
    { label: 'Pending jobs', value: jobs.pending ?? 0 },
    { label: 'Scheduled', value: jobs.scheduled ?? 0 },
    { label: 'Running', value: jobs.running ?? 0 },
    { label: 'Job errors', value: jobs.failures ?? 0, tone: jobs.failures ? 'bad' : 'neutral' },
    { label: 'Poisoned async rows', value: jobs.poisoned ?? 0, tone: jobs.poisoned ? 'warn' : 'neutral' },
  ]);
  const schedulerFacts = scheduler
    ? kit.kv([
        ['Clock', e(scheduler.manual ? 'manual' : 'automatic')],
        ['Closed', e(scheduler.closed ? 'yes' : 'no')],
        ['Executed', e(scheduler.executed ?? 0)],
        ['Faults', e(scheduler.faults ?? 0)],
        ['Failures', e(scheduler.failures ?? 0)],
      ])
    : '<p class="ui-help">This runtime reports no scheduler status.</p>';
  const errors = list(
    ctx,
    'flow-job-errors',
    node?.detail?.recentErrors ?? [],
    [
      { label: 'Kind', render: (item) => e(item.kind ?? '') },
      { label: 'Code', render: (item) => `<code>${e(item.code ?? '')}</code>` },
    ],
    'No durable job error is recorded.',
    'Recent job errors',
  );
  const states = list(
    ctx,
    'flow-async',
    Object.entries(activity.asyncOperations?.byState ?? {}).map(([state, count]) => ({ state, count })),
    [
      { label: 'State', render: (item) => e(item.state) },
      { label: 'Async operations', render: (item) => e(item.count) },
    ],
    'No asyncoperation row exists.',
    'Async operations by state',
  );
  return `${tiles}<h3>Scheduler</h3>${schedulerFacts}<h3>Recent job errors</h3>${errors}<h3>Async operations</h3>${states}`;
}

function webhooksPanel(ctx, d) {
  const counters = d.dashboard?.activity?.webhooks ?? {};
  const endpoints = (d.dashboard?.nodes ?? []).find((item) => item.id === 'org:plugins')?.detail?.webhooks ?? [];
  return (
    kit.tiles([
      { label: 'Delivered', value: counters.delivered ?? 0, tone: 'ok' },
      { label: 'Failed', value: counters.failed ?? 0, tone: counters.failed ? 'bad' : 'neutral' },
      { label: 'Not contacted', value: counters.notContacted ?? 0, tone: counters.notContacted ? 'warn' : 'neutral' },
    ]) +
    kit.notice(
      'Loopback only: an endpoint is posted only when its host is localhost, 127.0.0.0/8, ::1 or a name that resolves only to loopback. Any other host is never contacted; the step records WEBHOOK_NOT_CONTACTED and continues.',
      'info',
    ) +
    list(
      ctx,
      'flow-webhooks',
      endpoints,
      [
        { label: 'Endpoint', render: (item) => e(item.name ?? '—') },
        { label: 'Host', render: (item) => `<code>${e(item.host ?? '—')}</code>` },
        {
          label: 'Delivery',
          render: (item) => (item.loopback ? kit.badge('loopback: posted', 'ok') : kit.badge('not contacted', 'warn')),
        },
      ],
      'No webhook (contract 8) service endpoint is registered.',
      'Webhook endpoints',
    )
  );
}

export const view = {
  id: ID,
  label: 'Flows & jobs',
  icon: '⟲',
  hosts: ['power-pages', 'standalone'],
  requires: ['/__sim/api/flow-runs'],

  async load(ctx) {
    const d = (ctx.data[ID] ??= {});
    const linked = deepLink('run');
    if (linked && linked !== d.linkedRun) d.linkedRun = d.runId = linked;
    const runQuery = new URLSearchParams(Object.entries(d.filter ?? {}).filter(([, item]) => item));
    const [runs, waits, dashboard, run] = await Promise.all([
      ctx.request(`/flow-runs${runQuery.size ? `?${runQuery}` : ''}`).catch(failure),
      ctx.request(`/flow-waits${d.waitState ? `?state=${encodeURIComponent(d.waitState)}` : ''}`).catch(failure),
      ctx.request('/dashboard').catch(failure),
      d.runId ? ctx.request(`/flow-runs/${encodeURIComponent(d.runId)}`).catch(failure) : null,
    ]);
    Object.assign(d, { runs, waits, dashboard, run });
  },

  render(ctx) {
    const d = ctx.data[ID] ?? {};
    const dashboardNote = d.dashboard?.error
      ? kit.notice(`The dashboard feed could not be read: ${failed(d.dashboard)}`, 'warn')
      : '';
    const waiting = Array.isArray(d.waits) ? d.waits.length : 0;
    // The runs table starts right under the toolbar (D-M-7); the other parts of the page are cards below it.
    return (
      chrome(ctx, d) +
      dashboardNote +
      `<section class="ui-card" data-ui-section="flows:runs" aria-label="Flow runs">${runsPanel(ctx, d)}</section>` +
      panel(
        ctx,
        'waits',
        'Waits & approvals',
        Array.isArray(d.waits) ? `${waiting} waiting` : 'unavailable',
        waitsPanel(ctx, d),
        Boolean(d.answer),
      ) +
      panel(
        ctx,
        'background',
        'Background work',
        `${d.dashboard?.activity?.jobs?.pending ?? 0} pending jobs`,
        backgroundPanel(ctx, d),
      ) +
      panel(
        ctx,
        'webhooks',
        'Webhooks',
        `${d.dashboard?.activity?.webhooks?.delivered ?? 0} delivered`,
        webhooksPanel(ctx, d),
      )
    );
  },

  handle(ctx, event) {
    const d = (ctx.data[ID] ??= {});
    const target = (selector) => event.target?.closest?.(selector);
    if (event.type === 'change' && target('[data-flow-wait-state]')) {
      d.waitState = target('[data-flow-wait-state]').value;
      ctx.refresh();
      return true;
    }
    if (event.type === 'submit' && target('[data-flow-runs-form]')) {
      event.preventDefault();
      d.filter = Object.fromEntries(
        [...new FormData(target('[data-flow-runs-form]'))].map(([name, item]) => [name, String(item).trim()]),
      );
      ctx.refresh();
      return true;
    }
    const form = event.type === 'submit' ? target('[data-flow-wait-form]') : null;
    if (form) {
      event.preventDefault();
      const id = form.dataset.flowWaitForm,
        wait = (Array.isArray(d.waits) ? d.waits : []).find((item) => item.id === id);
      const fields = new FormData(form),
        button = event.submitter ?? form.querySelector('[type=submit]');
      let body;
      if (wait?.kind === 'approval')
        body = {
          outcome: event.submitter?.value ?? 'Approve',
          responder: String(fields.get('responder') ?? '').trim() || undefined,
          comments: String(fields.get('comments') ?? '').trim() || undefined,
        };
      else {
        try {
          body = { outputs: JSON.parse(String(fields.get('outputs') || '{}')) };
        } catch {
          ctx.notify('Outputs must be valid JSON.', true);
          return true;
        }
        if (!body.outputs || typeof body.outputs !== 'object' || Array.isArray(body.outputs)) {
          ctx.notify('Outputs must be a JSON object.', true);
          return true;
        }
      }
      return pending(ctx, button, async () => {
        const result = await ctx.request(`/flow-waits/${encodeURIComponent(id)}`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        d.answer = null;
        ctx.notify(`Run ${result.runId} is scheduled to resume${result.outcome ? ` (${result.outcome})` : ''}.`);
        await ctx.refresh();
      });
    }
    if (event.type !== 'click') return false;
    const unfilter = target('[data-flow-unfilter]');
    if (unfilter) {
      const name = unfilter.dataset.flowUnfilter;
      d.filter = name === '*' ? {} : { ...d.filter, [name]: '' };
      ctx.forgetDraft?.('flow-runs-form');
      ctx.refresh();
      return true;
    }
    const run = target('[data-flow-run]'),
      answer = target('[data-flow-answer]');
    if (run) {
      d.runId = run.dataset.flowRun;
      ctx.refresh();
      return true;
    }
    if (target('[data-flow-run-close]')) {
      d.runId = null;
      d.run = null;
      ctx.refresh();
      return true;
    }
    if (answer) {
      d.answer = answer.dataset.flowAnswer;
      ctx.refresh();
      return true;
    }
    if (target('[data-flow-answer-cancel]')) {
      d.answer = null;
      ctx.refresh();
      return true;
    }
    return false;
  },
};
