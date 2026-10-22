// `#capabilities` view module (D3, D12): the capability report and Solution inventory from the `/state` payload, and a
// preflight runner over GET /__sim/api/preflight (`requires` repeatable, `strict`, `scenario`). DOM-free at module scope;
// requests go through ctx.request with API-relative paths. The report never includes configured values.
import * as kit from './ui-kit.mjs';
import { HELP } from './help-content.mjs';
import { viewCommon } from './view-common.mjs';

const ID = 'capabilities';
const { e, value, list, fieldHelp, heading, panel, pending, failure, failed } = viewCommon({ id: ID, label: 'Capabilities & preflight', kit, help: HELP });
const LEVELS = ['inventory', 'contract', 'behaviour', 'native-qualified'];
// Same order as PREFLIGHT_STATUSES in mirage/lib/capability-report.mjs.
const STATUSES = ['missing', 'unsupported', 'placeholder', 'disabled', 'secret', 'satisfied'];
const STATUS_TONE = { satisfied: 'ok', missing: 'bad', unsupported: 'warn', placeholder: 'warn', disabled: 'neutral', secret: 'info' };

const tokens = text => String(text ?? '').split(/[\s,]+/).map(item => item.trim()).filter(Boolean);

function runPreflight(ctx, button, { requires = [], strict = false, scenario = null }) {
  const d = (ctx.data[ID] ??= {});
  return pending(ctx, button, async () => {
    const query = new URLSearchParams();
    for (const item of requires) query.append('requires', item);
    if (strict) query.set('strict', 'true');
    if (scenario) query.set('scenario', scenario);
    d.result = await ctx.request(`/preflight${query.size ? `?${query}` : ''}`);
    d.ran = { requires, strict, scenario };
    await ctx.refresh();
  });
}

function results(ctx, d) {
  const report = d.result;
  if (!report) return '<p class="ui-help">No preflight has run in this session.</p>';
  const summary = report.summary ?? {}, rows = report.requirements ?? [];
  const scope = d.ran?.scenario
    ? kit.notice(`Scenario ${d.ran.scenario}: saved scenarios carry no requirement list, so the report covers ${d.ran.requires.length ? d.ran.requires.join(', ') : 'every requirement'} with strict blocking.`, 'info')
    : kit.notice(`Scope: ${d.ran?.requires?.length ? d.ran.requires.join(', ') : 'every requirement'}${d.ran?.strict ? ' · strict' : ''}.`, 'info');
  const tiles = kit.tiles([{ label: 'Requirements', value: summary.total ?? rows.length }, { label: 'Blocking', value: summary.blocking ?? 0, tone: summary.blocking ? 'bad' : 'ok' },
    ...STATUSES.map(status => ({ label: status, value: summary[status] ?? 0, tone: summary[status] ? STATUS_TONE[status] : 'neutral' }))]);
  const groups = STATUSES.map(status => {
    const items = rows.filter(row => row.status === status);
    if (!items.length) return '';
    const blocking = items.filter(row => row.blocking).length;
    return kit.section({ key: `${ID}:result:${status}`, title: `${status} (${items.length})`, summary: blocking ? `${blocking} blocking` : '', open: blocking > 0 || Boolean(ctx.open?.(`${ID}:result:${status}`)),
      body: list(ctx, `cap-result-${status}`, items, [
        { label: 'Requirement', render: item => `<code>${e(item.id)}</code>` },
        { label: 'Kind', render: item => e(item.kind ?? '') },
        { label: 'In scope', render: item => e(item.inScope ? 'yes' : 'no') },
        { label: 'Blocking', render: item => (item.blocking ? kit.badge('blocking', 'bad') : kit.badge('not blocking', 'neutral')) },
        { label: 'Message', render: item => e(item.message ?? item.reason ?? '') },
      ], 'Nothing in this group.', `Preflight requirements: ${status}`) });
  }).join('');
  return `<h3>Result</h3>${scope}${tiles}${groups || '<p class="ui-help">The report lists no requirement.</p>'}`;
}

function preflightPanel(ctx, d, state) {
  const ran = d.ran ?? {};
  const form = `<form id="cap-preflight-form" class="ui-form" data-cap-preflight-form><div><label for="cap-requires">Requirements</label>`
    + `<input id="cap-requires" name="requires" type="text" value="${e((ran.requires ?? []).join(', '))}" aria-describedby="cap-requires-help">`
    + `${kit.fieldHelp('cap-requires', 'Requirement ids or globs separated by commas or spaces, for example cloud-flow:*, table:x_item. Empty checks every requirement.')}</div>`
    + `<div class="ui-check"><input id="cap-strict" name="strict" type="checkbox"${ran.strict ? ' checked' : ''} aria-describedby="cap-strict-help"><label for="cap-strict">Strict</label></div>`
    + `${kit.fieldHelp('cap-strict', 'Strict makes every unsatisfied requirement in scope blocking.')}`
    + '<p><button type="submit" class="ui-button ui-primary ui-small">Run preflight</button></p></form>';
  const powerPages = value(ctx.capabilities)?.powerPages !== false;
  const scenarios = powerPages ? (state?.status?.scenarios ?? state?.scenarios ?? []) : [];
  const buttons = scenarios.length
    ? `<h3>Saved scenarios</h3><p class="ui-help">Runs preflight labelled with the scenario id, strict, with the requirements above.</p>${list(ctx, 'cap-scenarios', scenarios, [
      { label: 'Scenario', render: item => `<code>${e(item.id)}</code>` },
      { label: 'Name', render: item => e(item.name ?? item.id) },
      { label: 'Preflight', render: item => `<button type="button" class="ui-button ui-small" data-cap-scenario="${e(item.id)}" aria-label="Preflight this scenario: ${e(item.name ?? item.id)}">Preflight this scenario</button>` },
    ], 'No saved scenario.', 'Saved scenarios')}`
    : '';
  return form + buttons + results(ctx, d);
}

export const view = {
  id: ID,
  label: 'Capabilities & preflight',
  icon: '✓',
  hosts: ['power-pages', 'standalone'],
  requires: ['/__sim/api/dashboard'], // cheap probe; preflight itself runs only on demand

  // The report and inventory come from ctx.state(); preflight runs only on request.
  async load(ctx) { ctx.data[ID] ??= {}; },

  render(ctx) {
    const d = ctx.data[ID] ?? {}, state = value(ctx.state) ?? {};
    const report = state.capabilityReport ?? state.status?.capabilityReport;
    const inventory = state.inventory ?? state.status?.inventory;
    const modules = (report?.modules ?? []).filter(item => !d.level || item.level === d.level);
    const levelFilter = `<p><label for="cap-level">Level</label> <select id="cap-level" data-cap-level aria-describedby="cap-level-help"><option value="">Every level</option>${LEVELS.map(level => `<option value="${level}"${d.level === level ? ' selected' : ''}>${level}</option>`).join('')}</select> ${fieldHelp(ctx, 'cap-level', 'capabilities.report', 'level')}</p>`;
    const reportBody = report ? levelFilter + list(ctx, 'cap-modules', modules, [
      { label: 'Capability', render: item => `<code>${e(item.name)}</code>` },
      { label: 'Kind', render: item => e(item.kind ?? '') },
      { label: 'Level', render: item => kit.levelBadge(item.level) },
      { label: 'Source', render: item => e(item.source ?? item.stateOwner ?? item.lifecycle ?? '—') },
      { label: 'Operations', render: item => e(item.operations?.length ?? 0) },
    ], 'No capability record matches.', 'Capability records') : kit.notice('This host sent no capability report in its state.', 'warn');
    const missing = list(ctx, 'cap-missing', report?.missing ?? [], [
      { label: 'Capability', render: item => `<code>${e(item.module)}</code>` }, { label: 'Requires', render: item => `<code>${e(item.requires)}</code>` },
    ], 'Every plain prerequisite is provided by a registered record.', 'Missing prerequisites');
    const unsupported = list(ctx, 'cap-unsupported', report?.unsupported ?? [], [
      { label: 'Capability', render: item => `<code>${e(item.id)}</code>` }, { label: 'Level', render: item => kit.levelBadge(item.level) }, { label: 'Reason', render: item => e(item.reason ?? '') },
    ], 'No capability is below behaviour.', 'Unsupported capabilities');
    const components = Object.entries(inventory?.components ?? {}).map(([component, entry]) => ({ component, ...entry }));
    const inventoryBody = inventory ? `<p class="ui-help">${e(inventory.total ?? 0)} Solution components in the source inventory.</p>` + list(ctx, 'cap-inventory', components, [
      { label: 'Component', render: item => `<code>${e(item.component)}</code>` }, { label: 'Count', render: item => e(item.count ?? 0) },
      { label: 'Levels', render: item => e(Object.entries(item.levels ?? {}).map(([level, count]) => `${level}: ${count}`).join(', ')) },
    ], 'The Solution sources contribute no component.', 'Source inventory') : kit.notice('This host sent no source inventory in its state.', 'info');
    // GET /__sim/api/model-driven/offline on request: each staff session's mobile offline summary (counts only).
    const offlineButton = `<p><button type="button" class="ui-button ui-small" data-cap-offline>${d.offline ? 'Reload sessions' : 'Show sessions'}</button></p>`;
    const offlineBody = offlineButton + (!d.offline ? '<p class="ui-help">Sessions load on request.</p>' : !Array.isArray(d.offline) ? kit.notice(failed(d.offline), 'warn') : list(ctx, 'cap-offline', d.offline, [
      { label: 'Staff user', render: item => `<code>${e(item.kind === 'local-admin' ? 'local administrator' : item.principalId)}</code>` },
      { label: 'App', render: item => `<code>${e(item.app)}</code>` }, { label: 'Profile', render: item => e(item.profile ?? '—') },
      { label: 'Mode', render: item => kit.badge(item.mode, item.mode === 'offline' ? 'warn' : 'ok') }, { label: 'Last sync', render: item => e(item.lastSync ?? 'never') },
      { label: 'Tables', render: item => e(item.tables) }, { label: 'Pending', render: item => e(item.queue) },
      { label: 'Conflicts', render: item => (item.conflicts ? kit.badge(String(item.conflicts), 'bad') : '0') }, { label: 'Errors', render: item => (item.errors ? kit.badge(String(item.errors), 'bad') : '0') },
    ], 'No staff session has used mobile offline.', 'Mobile offline sessions'));
    return heading(ctx)
      + panel(ctx, 'report', 'Capability report', `${report?.modules?.length ?? 0} records`, reportBody, true)
      + panel(ctx, 'missing', 'Missing prerequisites', `${report?.missing?.length ?? 0}`, missing)
      + panel(ctx, 'unsupported', 'Unsupported', `${report?.unsupported?.length ?? 0}`, unsupported)
      + panel(ctx, 'offline', 'Mobile offline sessions', Array.isArray(d.offline) ? `${d.offline.filter(item => item.mode === 'offline').length} offline` : d.offline ? 'unavailable' : 'not loaded', offlineBody, Boolean(d.offline))
      + panel(ctx, 'inventory', 'Source inventory', `${inventory?.total ?? 0} components`, inventoryBody, false, `${ID}.report`)
      + panel(ctx, 'preflight', 'Preflight', d.result ? `${d.result.summary?.blocking ?? 0} blocking` : 'not run', preflightPanel(ctx, d, state), Boolean(d.result));
  },

  handle(ctx, event) {
    const d = (ctx.data[ID] ??= {});
    const target = selector => event.target?.closest?.(selector);
    if (event.type === 'change' && target('[data-cap-level]')) { d.level = target('[data-cap-level]').value; ctx.refresh(); return true; }
    const form = event.type === 'submit' ? target('[data-cap-preflight-form]') : null;
    if (form) {
      event.preventDefault();
      const fields = new FormData(form);
      return runPreflight(ctx, event.submitter ?? form.querySelector('[type=submit]'), { requires: tokens(fields.get('requires')), strict: fields.get('strict') === 'on' });
    }
    const sessions = event.type === 'click' ? target('[data-cap-offline]') : null;
    if (sessions) return pending(ctx, sessions, async () => {
      try { d.offline = (await ctx.request('/model-driven/offline')).items ?? []; } catch (error) { d.offline = failure(error); }
      await ctx.refresh();
    });
    const scenario = event.type === 'click' ? target('[data-cap-scenario]') : null;
    if (scenario) {
      const input = event.target.ownerDocument?.getElementById('cap-requires');
      return runPreflight(ctx, scenario, { requires: tokens(input?.value ?? (d.ran?.requires ?? []).join(',')), strict: true, scenario: scenario.dataset.capScenario });
    }
    return false;
  },
};
