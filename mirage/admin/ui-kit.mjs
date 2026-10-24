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

export function table({
  key,
  columns = [],
  items,
  result,
  emptyText = 'Nothing to show.',
  caption,
  rowAttrs,
  searchable = true,
}) {
  const rows = items ?? result?.items ?? [];
  const tools = result ? tableTools(key, result, { searchable }) : '';
  const empty = result ? result.total === 0 : rows.length === 0;
  if (empty)
    return `${tools}<p class="ui-empty" data-table-empty="${e(key)}">${e(result?.search ? `No results match “${result.search}”.` : emptyText)}</p>`;
  const cls = (column) => (column.className ? ` class="${e(column.className)}"` : '');
  return (
    `${tools}<div class="ui-table-wrap"><table class="ui-table" data-table="${e(key)}">${caption ? `<caption class="ui-sr-only">${e(caption)}</caption>` : ''}` +
    `<thead><tr>${columns.map((column) => `<th scope="col"${cls(column)}>${e(column.label)}${column.info ? info({ label: `About ${column.label}`, text: column.info }) : ''}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map((item) => `<tr${attributes(rowAttrs?.(item))}>${columns.map((column) => `<td${cls(column)}>${column.render(item) ?? ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
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
export const fieldHelp = (id, text) => `<small class="ui-field-help" id="${e(id)}-help">${e(text)}</small>`;

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
