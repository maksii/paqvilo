// `#packs` view module: the registered data packs of this runtime from GET /__sim/api/packs, with matched
// status, exports, presets, persona catalogue counts, DATA ownership and PACK_EXPORT_* diagnostics, plus the data preset
// library with its Pack and Source columns. DOM-free at module scope; read-only (packs change in /_setup/).
import * as kit from './ui-kit.mjs';
import { HELP } from './help-content.mjs';
import { viewCommon } from './view-common.mjs';

const ID = 'packs';
const SETUP = '/_setup/#packs';
const { e, list, helpBlock, heading, panel } = viewCommon({ id: ID, label: 'Data packs', kit, help: HELP });
const count = exports => Object.values(exports ?? {}).reduce((total, item) => total + Number(item || 0), 0);
const matchedBadge = pack => (pack.matched === true ? kit.badge('matched', 'ok') : pack.matched === false ? kit.badge('not matched', 'warn') : kit.badge('not evaluated', 'neutral'));

function detail(ctx, pack) {
  const catalog = pack.personaCatalog ?? {};
  const facts = kit.kv([
    ['Module', `<code>${e(pack.module ?? 'supplied object')}</code>`, { mono: true }], ['Registration', e(pack.registration?.source ?? 'unknown')],
    ['Description', e(pack.description ?? '')], ['Matched', `${matchedBadge(pack)} ${e(pack.matchReason ?? '')}`],
    ['Personas', e(pack.personas ?? 0)], ['Configuration presets', e(pack.configurationPresets ?? 0)],
    ['Persona catalogue', e(`${catalog.groups ?? 0} groups · ${catalog.personas ?? 0} personas · ${catalog.contexts ?? 0} contexts · ${catalog.scenarios ?? 0} scenarios`)],
  ]);
  const key = `packs-${pack.id}`;
  const exports = list(ctx, `${key}-exports`, Object.entries(pack.exports ?? {}).map(([name, total]) => ({ name, total })), [
    { label: 'Export', render: item => `<code>${e(item.name)}</code>` }, { label: 'Count', render: item => e(item.total) },
  ], 'The pack exports no recognised handler or provider.', `Exports of ${pack.id}`);
  const presets = list(ctx, `${key}-presets`, pack.presets ?? [], [
    { label: 'Preset', render: item => `<code>${e(item.id)}</code>` }, { label: 'Name', render: item => e(item.name ?? '') },
  ], 'The pack contributes no data preset.', `Presets of ${pack.id}`);
  const files = list(ctx, `${key}-data`, pack.dataFiles ?? [], [
    { label: 'DATA file', render: item => `<code>${e(item.file)}</code>` },
    { label: 'Tables', render: item => e((item.tables ?? []).join(', ') || '—') },
    { label: 'Writable', render: item => (item.writable ? kit.badge('writable', 'ok') : kit.badge('read-only', 'neutral')) },
  ], 'The pack owns no DATA file.', `DATA files of ${pack.id}`);
  const diagnostics = list(ctx, `${key}-diagnostics`, pack.diagnostics ?? [], [
    { label: 'Code', render: item => `<code>${e(item.code ?? '')}</code>` },
    { label: 'Severity', render: item => kit.badge(item.severity ?? 'info', item.severity === 'error' ? 'bad' : item.severity === 'warning' ? 'warn' : 'info') },
    { label: 'Message', render: item => e(item.message ?? '') },
  ], 'No export diagnostic.', `Diagnostics of ${pack.id}`);
  return kit.section({ key: `${ID}:detail:${pack.id}`, title: `Pack ${pack.name ?? pack.id}`, summary: pack.id, open: true, help: helpBlock(ctx, `${ID}.diagnostics`),
    body: `${facts}<h3>Exports</h3>${exports}<h3>Presets</h3>${presets}<h3>DATA ownership</h3>${files}<h3>Diagnostics</h3>${diagnostics}`
      + '<p><button type="button" class="ui-button ui-small" data-pack-details-close>Close details</button></p>' });
}

export const view = {
  id: ID,
  label: 'Data packs',
  icon: '▣',
  hosts: ['power-pages', 'standalone'],
  requires: ['/__sim/api/packs'],

  async load(ctx) {
    const d = (ctx.data[ID] ??= {});
    d.payload = await ctx.request('/packs');
  },

  render(ctx) {
    const d = ctx.data[ID] ?? {}, payload = d.payload ?? {}, packs = payload.packs ?? [];
    const head = heading(ctx);
    const registered = list(ctx, 'packs-registered', packs, [
      { label: 'Pack', render: item => `<code>${e(item.id)}</code>` },
      { label: 'Name', render: item => e(item.name ?? '') },
      { label: 'Matched', info: "matched: the pack's matches() said it applies to this portal, so it is in use. not matched: it is registered but contributes nothing here.", render: item => `${matchedBadge(item)}<div class="ui-help">${e(item.matchReason ?? '')}</div>` },
      { label: 'Exports', info: 'How many handlers and providers the pack supplies (server logic, flows, plug-in models, storage and others). Details lists them.', render: item => e(count(item.exports)) },
      { label: 'Presets', info: 'Data presets the pack adds; apply them under Plugins & presets.', render: item => e(item.presets?.length ?? 0) },
      { label: 'DATA files', info: 'JSON files of business records the pack owns; record changes go to them when the simulation level writes DATA files.', render: item => e(item.dataFiles?.length ?? 0) },
      { label: 'Diagnostics', info: "Problems found in the pack's exports, such as an unknown export name.", render: item => e(item.diagnostics?.length ?? 0) },
      { label: 'Details', render: item => `<button type="button" class="ui-button ui-small" data-pack-details="${e(item.id)}" aria-label="Details of pack ${e(item.id)}">Details</button>` },
    ], `No data pack is registered. Write pack/<id>.mjs, register it under dataPacks in ${SETUP}, then restart.`, 'Registered packs');
    const failed = (payload.failed ?? []).length ? `<h3>Modules that failed to load</h3>${list(ctx, 'packs-failed', payload.failed, [
      { label: 'Module', render: item => `<code>${e(item.module ?? '')}</code>` }, { label: 'Error', render: item => e(item.error ?? '') },
    ], 'Every registered module loaded.', 'Pack modules that failed to load')}` : '';
    const selected = packs.find(item => item.id === d.selected);
    const library = list(ctx, 'packs-library', payload.library ?? [], [
      { label: 'Preset', render: item => `<code>${e(item.id)}</code>` },
      { label: 'Name', render: item => e(item.name ?? '') },
      { label: 'Pack', render: item => (item.pack ? `<code>${e(item.pack)}</code>` : '—') },
      { label: 'Source', info: 'builtin: shipped with Paqvilo or a pack. stored: saved in this runtime.', render: item => kit.badge(item.source ?? 'unknown', item.source === 'stored' ? 'info' : 'neutral') },
    ], 'No data preset is available.', 'Data presets');
    return head
      + panel(ctx, 'registered', 'Registered packs', `${packs.length} packs · ${packs.filter(item => item.matched === true).length} matched`, registered + failed + (selected ? detail(ctx, selected) : ''), true)
      + panel(ctx, 'presets', 'Data presets', `${payload.library?.length ?? 0} presets`, library)
      + panel(ctx, 'lifecycle', 'Add or change a pack', 'write · register · restart · verify', `<p><a class="ui-button ui-small" href="${e(SETUP)}">Project setup: Data packs →</a></p>`);
  },

  handle(ctx, event) {
    if (event.type !== 'click') return false;
    const d = (ctx.data[ID] ??= {});
    const details = event.target?.closest?.('[data-pack-details]');
    if (details) { d.selected = details.dataset.packDetails; ctx.reveal?.(`[data-ui-section="${ID}:detail:${d.selected.replace(/["\\]/g, '\\$&')}"]`); ctx.refresh(); return true; }
    if (event.target?.closest?.('[data-pack-details-close]')) { d.selected = null; ctx.refresh(); return true; }
    return false;
  },
};
