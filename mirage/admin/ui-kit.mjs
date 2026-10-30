// Shared UI kit for `/_sim/` and `/_setup/`: pure string builders, no DOM access and no imports, so
// both hosts can serve this file under their own prefix. Every interpolated value is escaped here;
// parameters named `*Html` (and column `render` results, section bodies) are trusted markup from the caller.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
const e = escapeHtml;

const TONES = new Set(['ok', 'warn', 'bad', 'info', 'neutral']);
const tone = (value) => (TONES.has(value) ? value : 'neutral');
export const STATUS_TONES = Object.freeze({
  listening: 'ok',
  ready: 'ok',
  declared: 'info',
  disabled: 'neutral',
  placeholder: 'warn',
  missing: 'bad',
  error: 'bad',
  planned: 'info',
  unknown: 'neutral',
});
export const LEVEL_TONES = Object.freeze({
  inventory: 'neutral',
  contract: 'info',
  behaviour: 'ok',
  'native-qualified': 'ok',
});
export const PAGE_SIZES = Object.freeze([10, 20, 50]);

export const badge = (text, toneName = 'neutral') =>
  `<span class="ui-badge ui-tone-${tone(toneName)}">${e(text)}</span>`;
export const statusBadge = (status) => {
  const known = Object.hasOwn(STATUS_TONES, status) ? status : 'unknown';
  return badge(status == null || status === '' ? 'unknown' : status, STATUS_TONES[known]);
};
export const levelBadge = (level) =>
  badge(level || 'unknown', Object.hasOwn(LEVEL_TONES, level) ? LEVEL_TONES[level] : 'neutral');

/** Client-side paging. `state` is caller-owned `{ page, size, search }`; the page is clamped to `[1, pages]`. */
export function pageItems(items, state = {}, { searchable = true, text = (item) => JSON.stringify(item) } = {}) {
  const list = Array.isArray(items) ? items : [];
  const search = searchable ? String(state?.search ?? '').trim() : '';
  const needle = search.toLowerCase();
  const matches = needle
    ? list.filter((item) =>
        String(text(item) ?? '')
          .toLowerCase()
          .includes(needle),
      )
    : list;
  const requested = Number(state?.size);
  const size = Number.isInteger(requested) && requested > 0 ? requested : PAGE_SIZES[0];
  const pages = Math.max(1, Math.ceil(matches.length / size));
  const page = Math.min(pages, Math.max(1, Math.trunc(Number(state?.page)) || 1));
  return { items: matches.slice((page - 1) * size, page * size), total: matches.length, pages, page, size, search };
}

export function tableTools(key, result, { searchable = true, sizes = PAGE_SIZES } = {}) {
  const k = e(key),
    { total = 0, pages = 1, page = 1, size = sizes[0], search = '' } = result ?? {};
  const options = [...new Set([...sizes, size])]
    .map((value) => `<option value="${e(value)}"${value === size ? ' selected' : ''}>${e(value)}</option>`)
    .join('');
  return (
    `<div class="ui-table-tools">${searchable ? `<input type="search" data-table-search="${k}" aria-label="Search ${k}" placeholder="Filter ${k}…" value="${e(search)}">` : ''}` +
    `<span class="ui-table-count">${e(total)} results · Page ${e(page)} of ${e(pages)}</span>` +
    `<label class="ui-table-size">Rows <select data-table-size="${k}" aria-label="Rows per page for ${k}">${options}</select></label>` +
    `<div class="ui-pager"><button type="button" class="ui-button ui-small" data-table-page="${k}" data-delta="-1"${page <= 1 ? ' disabled' : ''}>Previous</button>` +
    `<button type="button" class="ui-button ui-small" data-table-page="${k}" data-delta="1"${page >= pages ? ' disabled' : ''}>Next</button></div></div>`
  );
}

// Attribute names a caller may add to rows: plain data-*/aria-*/id/class names, never event handlers.
const SAFE_ATTRIBUTE = /^(?:data-[a-z0-9-]+|aria-[a-z]+|id|class|tabindex)$/;
const attributes = (values) =>
  Object.entries(values ?? {})
    .filter(([name, value]) => SAFE_ATTRIBUTE.test(name) && value !== undefined && value !== null && value !== false)
    .map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${e(value)}"`))
    .join('');

// A column's `head` is header markup the caller built and escaped (a sort button); `sort` becomes its aria-sort.
export function table({
  key,
  columns = [],
  items,
  result,
  emptyText = 'Nothing to show.',
  caption,
  rowAttrs,
  searchable = true,
  afterRow,
}) {
  const rows = items ?? result?.items ?? [];
  const tools = result ? tableTools(key, result, { searchable }) : '';
  const empty = result ? result.total === 0 : rows.length === 0;
  if (empty)
    return `${tools}<p class="ui-empty" data-table-empty="${e(key)}">${e(result?.search ? `No results match “${result.search}”.` : emptyText)}</p>`;
  const cls = (column) => (column.className ? ` class="${e(column.className)}"` : '');
  return (
    `${tools}<div class="ui-table-wrap"><table class="ui-table" data-table="${e(key)}">${caption ? `<caption class="ui-sr-only">${e(caption)}</caption>` : ''}` +
    `<thead><tr>${columns.map((column) => `<th scope="col"${cls(column)}${column.sort ? ` aria-sort="${e(column.sort)}"` : ''}>${column.head ?? e(column.label)}${column.info ? info({ label: `About ${column.label}`, text: column.info }) : ''}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map((item) => `<tr${attributes(rowAttrs?.(item))}>${columns.map((column) => `<td${cls(column)}>${column.render(item) ?? ''}</td>`).join('')}</tr>${afterRow?.(item) ?? ''}`).join('')}</tbody></table></div>`
  );
}

export function section({ key, title, summary = '', open = false, body = '', help: helpValue }) {
  const helpHtml = helpValue && typeof helpValue === 'object' ? help(helpValue) : (helpValue ?? '');
  const content = typeof body === 'function' ? body() : body;
  return (
    `<details class="ui-section" data-ui-section="${e(key)}"${open ? ' open' : ''}><summary><span class="ui-section-title">${e(title)}</span>` +
    `${summary ? `<span class="ui-section-summary">${e(summary)}</span>` : ''}</summary><div class="ui-section-body">${helpHtml}${content ?? ''}</div></details>`
  );
}

const docMarkup = (doc) =>
  doc?.path
    ? doc.href
      ? `<a class="ui-doc" href="${e(doc.href)}" target="_blank" rel="noreferrer">${e(doc.label)}</a> <code>${e(doc.path)}</code>`
      : `<code>${e(doc.path)}</code>`
    : '';

export function help({ id, text, doc } = {}) {
  const link = docMarkup(doc);
  return `<p class="ui-help"${id ? ` id="${e(id)}"` : ''}>${e(text)}${link ? ` ${link}` : ''}</p>`;
}

/**
 * Guidance behind an (i) button: the tooltip shows on hover or focus and holds the text, optional numbered steps, an
 * example and doc links. Pass `id` and point a control's `aria-describedby` at it to keep the text as its description.
 */
export function info({ id, label = 'More information', text, steps = [], example, docs = [] } = {}) {
  const links = docs.map(docMarkup).filter(Boolean);
  if (!text && !steps.length && !example && !links.length) return '';
  return (
    `<span class="ui-info"><button type="button" class="ui-info-button" aria-label="${e(label)}"${id ? ` aria-describedby="${e(id)}"` : ''}>i</button>` +
    `<span class="ui-info-pop" role="tooltip"${id ? ` id="${e(id)}"` : ''}>${text ? `<span class="ui-info-text">${e(text)}</span>` : ''}` +
    `${steps.map((step, index) => `<span class="ui-info-step">${index + 1}. ${e(step)}</span>`).join('')}` +
    `${example ? `<code class="ui-info-example">${e(example)}</code>` : ''}${links.length ? `<span class="ui-info-docs">${links.join(' · ')}</span>` : ''}</span></span>`
  );
}

/** `[first sentence, the rest]` of a help text: plain words first, details after. */
export const splitLead = (text) => {
  const [lead = '', ...rest] = String(text ?? '').split(/(?<=[.!?])\s+(?=[A-Z0-9“"(/])/);
  return [lead, rest.join(' ')];
};

/**
 * Compact help: the first sentence stays visible; the rest of the text, steps, example and doc link sit behind an (i)
 * tooltip labelled `About <label>`. The tooltip carries `<id>-more` so a control can point at it.
 */
export function leadHelp({ id, label = 'this section', text, steps = [], example, doc } = {}) {
  const [lead, rest] = splitLead(text);
  const more = info({
    id: id ? `${id}-more` : undefined,
    label: `About ${label}`,
    text: rest,
    steps,
    example,
    docs: doc?.path ? [doc] : [],
  });
  return lead || more ? `<p class="ui-help"${id ? ` id="${e(id)}"` : ''}>${e(lead)}${more}</p>` : '';
}

/** Visible field help; give the control `aria-describedby="<id>-help"`. */
/**
 * Field help (D-M-6): an (i) next to the control; its popover keeps the id `<id>-help`, so the control's
 * `aria-describedby="<id>-help"` still reads the text. No visible line under the control.
 */
export const fieldHelp = (id, text) =>
  text
    ? `<span class="ui-info ui-field-info"><button type="button" class="ui-info-button" aria-label="About this field" aria-describedby="${e(id)}-help">i</button><span class="ui-info-pop ui-field-help" role="tooltip" id="${e(id)}-help">${e(text)}</span></span>`
    : '';

/** A view guide: `intro` stays visible; `details` (more text), steps, example and doc links sit under How this works. */
export function guide({ key, title, intro, details, steps = [], example, docs = [] }) {
  const links = docs.map(docMarkup).filter(Boolean);
  const more =
    details || steps.length || example || links.length
      ? `<details class="ui-guide-more" data-ui-section="guide:${e(key)}"><summary>How this works</summary>` +
        `${details ? `<p class="ui-guide-details">${e(details)}</p>` : ''}${steps.length ? `<ol>${steps.map((step) => `<li>${e(step)}</li>`).join('')}</ol>` : ''}` +
        `${example ? `<pre class="ui-example">${e(example)}</pre>` : ''}${links.length ? `<p class="ui-guide-docs">${links.join(' · ')}</p>` : ''}</details>`
      : '';
  return `<section class="ui-guide" data-ui-guide="${e(key)}">${title ? `<p class="ui-guide-title">${e(title)}</p>` : ''}<p class="ui-guide-intro">${e(intro)}</p>${more}</section>`;
}

/** rows: `[[label, valueHtml, { mono }]]`; values are trusted markup (escape plain text with `escapeHtml`). */
export const kv = (rows) =>
  `<dl class="ui-kv">${(rows ?? []).map(([label, valueHtml, options]) => `<div class="ui-kv-row"><dt>${e(label)}</dt><dd${options?.mono ? ' class="ui-mono"' : ''}>${valueHtml ?? ''}</dd></div>`).join('')}</dl>`;

export const tiles = (items) =>
  `<div class="ui-tiles">${(items ?? [])
    .map(
      (item) =>
        `<div class="ui-tile ui-tone-${tone(item.tone)}"><span class="ui-tile-label">${e(item.label)}</span>` +
        `<strong class="ui-tile-value">${e(item.value)}</strong>${item.detail ? `<span class="ui-tile-detail">${e(item.detail)}</span>` : ''}</div>`,
    )
    .join('')}</div>`;

export const notice = (text, toneName = 'info') => `<p class="ui-notice ui-tone-${tone(toneName)}">${e(text)}</p>`;

const titleCase = (path) =>
  path
    .split('/')
    .pop()
    .replace(/\.md$/, '')
    .split('-')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');

/** Resolve `path[#anchor]` against the docs map (`{ key: { href, path, label } }`); unknown paths get `href: null`. */
export function docLink(path, docs) {
  const text = String(path ?? '');
  const [file, anchor] = text.split('#');
  const entry = Object.values(docs ?? {}).find((item) => item?.path === file);
  return {
    href: entry?.href ? `${entry.href}${anchor ? `#${anchor}` : ''}` : null,
    label: entry?.label ?? titleCase(file),
    path: text,
  };
}

/**
 * Tabs: a tablist of buttons (`data-tab="<key>" data-tab-id="<id>"`, roving tabindex) over one panel holding
 * `panelHtml` (trusted markup) for the selected tab. The caller switches tabs on click and arrow keys.
 */
export function tabs({ key, label, items = [], selected, panelHtml = '' }) {
  const k = e(key),
    current = items.some((item) => item.id === selected) ? selected : items[0]?.id;
  return (
    `<div class="ui-tabs"><div class="ui-tablist" role="tablist" aria-label="${e(label)}">${items
      .map(
        (item) =>
          `<button type="button" role="tab" class="ui-tab" id="${k}-tab-${e(item.id)}" aria-selected="${item.id === current}" aria-controls="${k}-panel" tabindex="${item.id === current ? 0 : -1}" data-tab="${k}" data-tab-id="${e(item.id)}">${e(item.label)}</button>`,
      )
      .join('')}</div>` +
    `<div class="ui-tabpanel" role="tabpanel" id="${k}-panel" aria-labelledby="${k}-tab-${e(current)}">${panelHtml}</div></div>`
  );
}

const unit = (value) => Math.min(1, Math.max(0, Number(value) || 0));
/**
 * A horizontal bar on a track: `offset` and `width` are fractions (0..1) of the track and become SVG geometry
 * (1000 units wide), never inline styles; `marks` are fractions drawn as ticks; `className` colours the fill.
 */
export function bar({ offset = 0, width = 0, className = '', marks = [], label = '' }) {
  const w = Math.max(3, Math.round(unit(width) * 1000)),
    x = Math.min(Math.round(unit(offset) * 1000), 1000 - w);
  return (
    `<svg class="ui-bar" viewBox="0 0 1000 12" preserveAspectRatio="none" role="img" aria-label="${e(label)}" focusable="false">` +
    `<rect class="ui-bar-track" width="1000" height="12"></rect><rect class="ui-bar-fill${className ? ` ${e(className)}` : ''}" x="${x}" y="1" width="${w}" height="10"></rect>` +
    `${marks.map((mark) => `<rect class="ui-bar-mark" x="${Math.min(998, Math.round(unit(mark) * 1000))}" y="0" width="2" height="12"></rect>`).join('')}</svg>`
  );
}

// One time format for every `/_sim/` table: local `HH:MM:SS.mmm`, the date and UTC on hover, the zone named once.
const pad = (value, width = 2) => String(value).padStart(width, '0');
const dateOf = (value) => {
  const at = new Date(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : (value ?? NaN));
  return value === '' || value === null || value === undefined || Number.isNaN(at.getTime()) ? null : at;
};
/** Local wall clock `HH:MM:SS.mmm` of an ISO time or epoch milliseconds; '' for anything unreadable. */
export const clock = (value) => {
  const at = dateOf(value);
  return at
    ? `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`
    : '';
};
/** The local UTC offset at `at`, as `UTC+02:00`. */
export const utcOffset = (at = new Date()) => {
  const minutes = -at.getTimezoneOffset();
  return `UTC${minutes < 0 ? '−' : '+'}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
};
/** A `<time>` showing `clock(value)`; its tooltip holds the local date and time and the UTC instant. */
export const time = (value) => {
  const at = dateOf(value);
  if (!at) return '—';
  const local = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock(at)}`;
  return `<time class="ui-mono" datetime="${e(at.toISOString())}" title="${e(`${local} ${utcOffset(at)} · ${at.toISOString()}`)}">${e(clock(at))}</time>`;
};
/** The one line that names the zone of every time on a page. */
export const timeZoneNote = () => `Times are local (${utcOffset()}); hover a time for its date and UTC.`;

// ---- Page chrome (D-M-7; contract in monitor-review/N2b-chrome.md)
/** Active filter chips: `{ items: [{ label, attrs }], clear }` (remove buttons and Clear all), or trusted markup. */
export function chips(value) {
  if (typeof value === 'string') return value;
  const items = value?.items ?? [];
  if (!items.length) return '';
  return `<div class="ui-chips" role="group" aria-label="Active filters">${items
    .map(
      (item) =>
        `<button type="button" class="ui-chip" aria-label="Remove filter ${e(item.label)}"${attributes(item.attrs)}>${e(item.label)} <span aria-hidden="true">×</span></button>`,
    )
    .join(
      '',
    )}${value.clear ? `<button type="button" class="ui-link-button"${attributes(value.clear)}>Clear all</button>` : ''}</div>`;
}
/**
 * The one page chrome of a view: the visually hidden H1 (focus target), the view's (i) (the shell moves it next to the
 * breadcrumb), one toolbar row (summary left; actions and the Filters toggle right) and the active filter chips.
 */
export function pageChrome({ breadcrumb = {}, help: about, actions = '', filters, summary = '', chips: active } = {}) {
  const page = breadcrumb.page ?? '';
  const helpHtml =
    about && (about.text || about.steps?.length)
      ? info({
          label: `About ${page}`,
          text: about.text,
          steps: about.steps ?? [],
          example: about.example,
          docs: about.docs ?? [],
        }).replace('<span class="ui-info">', '<span class="ui-info ui-chrome-help" data-chrome-help>')
      : '';
  const toggle = filters?.drawerId
    ? `<button type="button" class="ui-button ui-small ui-filter-toggle" data-filter-toggle="${e(filters.drawerId)}" aria-controls="${e(filters.drawerId)}" aria-expanded="false">${e(filters.label ?? 'Filters')}${Number(filters.count) > 0 ? `<span class="ui-filter-count"> · ${e(filters.count)}</span>` : ''}</button>`
    : '';
  const bar =
    summary || actions || toggle
      ? `<div class="ui-page-toolbar" role="toolbar" aria-label="${e(page)} actions"><span class="ui-page-summary">${e(summary)}</span><span class="ui-page-actions">${actions}${toggle}</span></div>`
      : '';
  return `<div class="ui-page-chrome"><h1 id="view-title" class="ui-sr-only" tabindex="-1">${e(page)}</h1>${helpHtml}${bar}${chips(active)}</div>`;
}
/** The right-hand filter drawer a `pageChrome` Filters toggle opens; `body`/`footer` are trusted markup. */
export function filterDrawer({ id, title = 'Filters', body = '', footer = '' }) {
  const k = e(id);
  return (
    `<aside class="ui-filter-drawer" id="${k}" aria-labelledby="${k}-title" hidden><div class="ui-filter-drawer-head"><h2 id="${k}-title">${e(title)}</h2>` +
    `<button type="button" class="ui-button ui-small" data-filter-drawer-close="${k}">Close</button></div><div class="ui-filter-drawer-body">${body}</div>` +
    `${footer ? `<div class="ui-filter-drawer-foot">${footer}</div>` : ''}</aside>`
  );
}

// ---- dataTable (D-M-8; contract in monitor-review/N2b-chrome.md): one table look and behaviour everywhere.
/** The bottom controls of a table: footer actions, the count, rows per page and Previous/Next. */
export function tableFoot(key, result, { actions = '', sizes = PAGE_SIZES } = {}) {
  const k = e(key),
    { total = 0, pages = 1, page = 1, size = sizes[0] } = result ?? {};
  const options = [...new Set([...sizes, size])]
    .map((value) => `<option value="${e(value)}"${value === size ? ' selected' : ''}>${e(value)}</option>`)
    .join('');
  return (
    `<div class="ui-table-foot">${actions ? `<div class="ui-table-foot-actions">${actions}</div>` : ''}` +
    `<span class="ui-table-count">${e(total)} ${total === 1 ? 'result' : 'results'}${pages > 1 ? ` · Page ${e(page)} of ${e(pages)}` : ''}</span>` +
    `<label class="ui-table-size">Rows <select data-table-size="${k}" aria-label="Rows per page for ${k}">${options}</select></label>` +
    `<div class="ui-pager"><button type="button" class="ui-button ui-small" data-table-page="${k}" data-delta="-1"${page <= 1 ? ' disabled' : ''}>Previous</button>` +
    `<button type="button" class="ui-button ui-small" data-table-page="${k}" data-delta="1"${page >= pages ? ' disabled' : ''}>Next</button></div>` +
    '</div>'
  );
}
/** A column header that sorts the table (aria-sort follows `sort`). */
const sortHead = (key, column, sort) => {
  const active = sort?.key === column.sortKey ? sort.order : null;
  return {
    ...column,
    sort: active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none',
    head: `<button type="button" class="ui-sort" data-table-sort="${e(key)}" data-sort-key="${e(column.sortKey)}">${e(column.label)}<span class="ui-sort-mark" aria-hidden="true">${active === 'asc' ? '▲' : active === 'desc' ? '▼' : '↕'}</span></button>`,
  };
};
/**
 * The shared table (the Activities look): an optional bar above (search and the table's own actions), the table with a
 * sticky sortable header, row dividers and row actions pinned right, and the bottom controls bar.
 */
export function dataTable({
  id,
  caption,
  columns = [],
  items,
  result,
  rowAttrs,
  emptyText = 'Nothing to show.',
  emptyHtml = '',
  search = false,
  toolbar = '',
  footActions = '',
  sort,
  afterRow,
  filters,
  bar: inBar = true,
}) {
  const k = e(id);
  const heads = columns.map((column) => (column.sortKey ? sortHead(id, column, sort) : column));
  const rows = items ?? result?.items ?? [];
  const filter = filters ? columnFilters(id, caption, heads, filters) : null;
  // `bar: false`: the page's main list, whose search box and Filters sit in the page toolbar row (tableSearch,
  // filtersToggle); its chips and drawer stay here.
  const bar =
    inBar && (search || toolbar || filter)
      ? `<div class="ui-table-bar">${search ? tableSearch(id, result?.search) : ''}${filter?.toggle ?? ''}${toolbar ? `<span class="ui-table-bar-actions">${toolbar}</span>` : ''}</div>${filter?.chips ?? ''}`
      : (filter?.chips ?? '');
  const body =
    !rows.length && emptyHtml && !result?.search
      ? `<div class="ui-empty-guide" data-table-empty="${k}">${emptyHtml}</div>`
      : table({
          key: id,
          columns: heads,
          items: rows,
          emptyText: result?.search ? `No results match “${result.search}”.` : emptyText,
          caption,
          rowAttrs,
          afterRow,
        });
  const total = result?.total ?? rows.length;
  // The bottom controls bar is on every table, also with one page or no row (D-M-11).
  const foot = tableFoot(id, result ?? { total, pages: 1, page: 1 }, { actions: footActions });
  return `<div class="ui-data-table" data-data-table="${k}">${bar}${body}${foot}${filter?.drawer ?? ''}</div>`;
}
/** The drawer id of a table's column filters (a table key may hold spaces). */
export const filtersId = (id) => `${String(id).replace(/[^a-z0-9_-]+/gi, '-')}-filters`;
/** A table's search box (in its bar, or in the page toolbar row for the page's main list). */
export const tableSearch = (id, value = '') =>
  `<input type="search" data-table-search="${e(id)}" aria-label="Search ${e(id)}" placeholder="Search…" value="${e(value ?? '')}">`;
/** The Filters toggle of a table's column filters, with the number in force. */
export const filtersToggle = (id, count = 0) =>
  `<button type="button" class="ui-button ui-small ui-table-filters" data-filter-toggle="${e(filtersId(id))}" aria-expanded="false" aria-controls="${e(filtersId(id))}">Filters${count ? ` · ${count}` : ''}</button>`;
/**
 * Column filters of a table with more than one sortable data column (D-M-11): "Filters · n" in the bar, one text box
 * per column in a drawer (the shell moves it beside the page and applies the form), chips for the active ones.
 * `filters`: { <sortKey>: text } in force.
 */
function columnFilters(id, caption, heads, filters) {
  const fields = heads.filter((column) => column.sortKey);
  if (fields.length < 2) return null;
  const k = e(id),
    drawerId = filtersId(id),
    active = fields.filter((column) => String(filters[column.sortKey] ?? '').trim());
  const toggle = filtersToggle(id, active.length);
  const body =
    `<form class="ui-form" data-table-filters="${k}"><p class="ui-help" id="${e(drawerId)}-help">Rows whose column contains the text; empty boxes do not filter.</p>` +
    fields
      .map(
        (column, index) =>
          `<label for="${e(drawerId)}-${index}">${e(column.label)}</label><input id="${e(drawerId)}-${index}" type="search" name="${e(column.sortKey)}" value="${e(filters[column.sortKey] ?? '')}" aria-describedby="${e(drawerId)}-help">`,
      )
      .join('') +
    '<button type="submit" class="ui-button ui-primary">Apply filters</button></form>';
  return {
    toggle,
    chips: chips({
      items: active.map((column) => ({
        label: `${column.label}: ${filters[column.sortKey]}`,
        attrs: { 'data-table-unfilter': id, 'data-filter-key': column.sortKey },
      })),
      clear: active.length > 1 ? { 'data-table-unfilter': id } : null,
    }),
    drawer: filterDrawer({ id: drawerId, title: `Filter ${caption ?? id}`, body }),
  };
}
/** Keeps the items whose value in each filtered column (its sort value, else its shown text) contains the filter text. */
export function filterItems(items, columns, filters) {
  const tests = Object.entries(filters ?? {})
    .filter(([, text]) => String(text ?? '').trim())
    .map(([key, text]) => {
      const column = columns.find((item) => item.sortKey === key);
      const read = column?.sortValue ?? ((item) => item?.[key]);
      const needle = String(text).trim().toLowerCase();
      return (item) =>
        String(read(item) ?? '')
          .toLowerCase()
          .includes(needle);
    });
  return tests.length ? items.filter((item) => tests.every((test) => test(item))) : items;
}
/** Sorts `items` by `sort` ({ key, order }) with the columns' `sortValue` (client-side tables). */
export function sortItems(items, columns, sort) {
  const column = sort && columns.find((item) => item.sortKey === sort.key);
  if (!column) return items;
  const value = column.sortValue ?? ((item) => item?.[column.sortKey]);
  const dir = sort.order === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    const x = value(a),
      y = value(b);
    if (x === y) return 0;
    if (x === null || x === undefined || x === '') return 1;
    if (y === null || y === undefined || y === '') return -1;
    return (
      (typeof x === 'number' && typeof y === 'number'
        ? x - y
        : String(x).localeCompare(String(y), undefined, { numeric: true })) * dir
    );
  });
}
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
/** The visible text of a cell's markup (sorting by what the row shows). */
const cellText = (html) =>
  String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ENTITIES[name])
    .replace(/\s+/g, ' ')
    .trim();
/**
 * Makes every data column of a client-side table sortable: a column without a `sortKey` sorts by the text it shows.
 * Row-action columns (`className` with "actions" or the label "Actions") and `sortKey: false` stay plain.
 */
export function sortable(columns = []) {
  return columns.map((column, index) => {
    if (column.sortKey || column.sortKey === false || !column.label || column.label === 'Actions') return column;
    if (/actions/.test(column.className ?? '') || typeof column.render !== 'function') return column;
    return { ...column, sortKey: `col-${index}`, sortValue: (item) => cellText(column.render(item)) };
  });
}
