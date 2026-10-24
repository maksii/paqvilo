import { personaHtml as h } from './persona-picker-view.mjs';
import {
  indexPersonaCatalog,
  filterPersonaIndex,
  personaFilters,
  personaRowKey,
  foldPersonaText,
} from './persona-search.mjs';
import { personaContactId } from './persona-catalog.mjs';
import { createHash } from 'node:crypto';

const indexes = new WeakMap(),
  reports = new WeakMap();
const orderedCatalogues = new Map();
const bounded = (value) => Math.max(0, Math.min(1000000, Number.isSafeInteger(Number(value)) ? Number(value) : 0));
export const CHOOSER_PARAMETERS = [
  'q',
  'group',
  'subgroup',
  'role',
  'tag',
  'account',
  'hasRoles',
  'rolesOnly',
  'offset',
  'view',
  'pin',
  'recent',
  'presentation',
];
export function chooserReport(report, users) {
  const signature = JSON.stringify(users);
  const cached = report && reports.get(report);
  if (cached?.signature === signature) return cached.value;
  const remember = (value) => {
    if (report) reports.set(report, { signature, value });
    return value;
  };
  const byContact = new Map(users.map((user) => [personaContactId(user.contactId), user]));
  const join = (entries) =>
    entries
      .filter((p) => p.active !== false && byContact.has(personaContactId(p.contactId)))
      .map((p) => ({ ...p, subject: byContact.get(personaContactId(p.contactId)).subject }));
  if (!report?.enabled) {
    const contacts = new Map((report?.other ?? []).map((persona) => [personaContactId(persona.contactId), persona]));
    return remember({
      groups: [],
      personas: [],
      other: users.map((user) => ({
        ...contacts.get(personaContactId(user.contactId)),
        ...user,
        label: user.name,
        roles: user.roles ?? [],
        group: '__other',
      })),
      scope: report?.scope ?? 'local',
      contexts: [],
    });
  }
  return remember({ ...report, personas: join(report.personas ?? []), other: join(report.other ?? []) });
}
export function chooserSelection(report, parameters = new URLSearchParams(), { limit = 50 } = {}) {
  let index = indexes.get(report);
  if (!index) {
    // Runtime revisions can rebuild a report after an unrelated row write. Keep
    // ordering tied to the catalogue/contact contents rather than object identity.
    const digest = createHash('sha256')
      .update(JSON.stringify([report.groups, report.personas, report.other]))
      .digest('hex');
    index = orderedCatalogues.get(digest);
    if (!index) {
      index = indexPersonaCatalog(report);
      orderedCatalogues.set(digest, index);
      if (orderedCatalogues.size > 4) orderedCatalogues.delete(orderedCatalogues.keys().next().value);
    }
    indexes.set(report, index);
  }
  const filters = personaFilters(parameters),
    matching = filterPersonaIndex(index, filters);
  limit = Math.max(1, Math.min(200, limit));
  const offset = Math.min(bounded(parameters.get('offset')), Math.max(0, matching.length - 1));
  return { index, matching, rows: matching.slice(offset, offset + limit), filters, offset, limit, total: index.length };
}
function chooserCard(persona, contexts = new Map()) {
  const key = personaRowKey(persona),
    label = persona.label ?? persona.name ?? persona.contactId,
    context = contexts.get(persona.context);
  return `<li class="paqvilo-mirage-idp-user chooser-card" data-subject="${h(persona.subject)}" data-contact-id="${h(persona.contactId)}" data-chooser-key="${h(key)}"><div><strong>${h(label)}</strong>${persona.default ? '<span class="chooser-badge">Default</span>' : ''}<p class="chooser-contact">${h(persona.name ?? persona.contactId)}${persona.account?.name ? ` · ${h(persona.account.name)}` : ''}</p>${persona.description ? `<p>${h(persona.description.split(/\r?\n/, 1)[0])}</p>` : ''}<p class="chooser-meta">${h((persona.roles ?? []).join(', ') || 'No web roles')}</p>${persona.tags?.length ? `<p class="chooser-tags">${persona.tags.map((tag) => `<span>${h(tag)}</span>`).join('')}</p>` : ''}<details><summary>Details and effects</summary><p>${h(persona.description ?? '')}</p><dl><dt>Contact</dt><dd>${h(persona.contactId)}</dd><dt>Source</dt><dd>${h(persona.source ?? 'contact')}</dd><dt>Session effect</dt><dd>Sign in this browser as this contact. Runtime configuration stays unchanged.</dd>${context ? `<dt>Available setup</dt><dd>${h(context.label)} · Open the runtime’s full persona picker to launch its isolated configuration.</dd>` : ''}</dl></details></div><div class="chooser-actions"><button type="submit" form="idp-choose" formnovalidate name="subject" value="${h(persona.subject)}">Continue as ${h(label)}</button><button type="button" data-chooser-pin="${h(key)}" aria-label="Pin ${h(label)}" aria-pressed="false" hidden>☆</button></div></li>`;
}
export function chooserResults(report, params, action) {
  const selection = chooserSelection(report, params),
    { rows, matching, offset, limit, total } = selection,
    contexts = new Map((report.contexts ?? []).map((c) => [c.id, c]));
  const cards = (items) =>
    `<ul class="chooser-list">${items.map((row) => chooserCard(row.persona, contexts)).join('')}</ul>`;
  const counts = new Map();
  for (const row of matching)
    counts.set(row.persona.group ?? '__other', (counts.get(row.persona.group ?? '__other') ?? 0) + 1);
  const matchingByKey = new Map(matching.map((row) => [row.key, row]));
  const chosen = new Set(),
    shortcuts = ['pin', 'recent']
      .map((kind) => {
        const found = [...new Set(params.getAll(kind))]
          .slice(0, 100)
          .map((key) => matchingByKey.get(key))
          .filter(Boolean)
          .slice(0, kind === 'recent' ? 5 : 25);
        found.forEach((row) => chosen.add(row.key));
        return `<section data-chooser-shortcut="${kind}"${found.length ? '' : ' hidden'}><h2>${kind === 'pin' ? 'Pinned' : 'Recent'}</h2>${cards(found)}</section>`;
      })
      .join('');
  const preferred = offset === 0 ? matching.find((row) => row.persona.default) : null;
  if (preferred) chosen.add(preferred.key);
  const groups = [...(report.groups ?? []), { id: '__other', label: 'Other contacts' }];
  const active = Boolean(
    selection.filters.q ||
    ['roles', 'tags', 'accounts', 'groups', 'subgroups'].some((key) => selection.filters[key]?.length) ||
    selection.filters.hideNoRoles ||
    selection.filters.withoutRoles,
  );
  const sections = groups
    .filter((group) => counts.get(group.id))
    .map((group) => {
      const pageRows = rows.filter((row) => (row.persona.group ?? '__other') === group.id && !chosen.has(row.key));
      const subgroupRows = (group.subgroups ?? [])
        .map((sub) => {
          const entries = pageRows.filter((row) => row.persona.subgroup === sub.id);
          return entries.length
            ? `<section class="chooser-subgroup"><h3>${h(sub.label)} <small>${matching.filter((row) => row.persona.group === group.id && row.persona.subgroup === sub.id).length}</small></h3>${cards(entries)}</section>`
            : '';
        })
        .join('');
      const groupParams = new URLSearchParams(params);
      for (const key of ['group', 'offset', 'view', 'pin', 'recent']) groupParams.delete(key);
      groupParams.set('group', group.id);
      return `<details class="chooser-group" data-chooser-group="${h(group.id)}"${(counts.get(group.id) <= 25 || active) && pageRows.length ? ' open' : ''}><summary>${h(group.label)} <span>${counts.get(group.id)}</span>${!pageRows.length ? ` · <a data-chooser-group-link href="${h(action + '?' + groupParams)}">View ${h(group.label)} matches</a>` : ''}</summary>${cards(pageRows.filter((row) => !row.persona.subgroup))}${subgroupRows}</details>`;
    })
    .join('');
  const link = (start, label) => {
    const next = new URLSearchParams(params);
    for (const key of ['pin', 'recent', 'view']) next.delete(key);
    next.set('offset', String(start));
    return `<a data-chooser-more href="${h(action + '?' + next)}">${label}</a>`;
  };
  return `<div class="chooser-results" aria-label="Preset users" aria-live="polite"><p class="chooser-count" role="status">${matching.length ? offset + 1 : 0}–${Math.min(offset + limit, matching.length)} of ${matching.length} matching personas · ${total} available</p>${preferred ? `<section><h2>Default</h2>${cards([preferred])}</section>` : ''}${shortcuts}${sections}${matching.length ? '' : '<p>No personas match. Clear a filter or try fewer search terms.</p>'}<nav aria-label="Persona pages">${offset ? link(Math.max(0, offset - limit), 'Previous') : ''}${offset + limit < matching.length ? link(offset + limit, 'Show more') : ''}</nav></div>`;
}
export function chooserSearch(report, params, action, hidden) {
  const { index } = chooserSelection(report),
    selected = personaFilters(params);
  const groups = [
    ...(report.groups ?? []).filter((group) => index.some((row) => row.persona.group === group.id)),
    ...(index.some((row) => row.persona.group === '__other') ? [{ id: '__other', label: 'Other contacts' }] : []),
  ];
  const activeFilters =
    [selected.roles, selected.tags, selected.groups, selected.subgroups ?? [], selected.accounts].reduce(
      (total, values) => total + values.length,
      0,
    ) + (selected.hideNoRoles || selected.withoutRoles ? 1 : 0);
  const facets = [
    ['role', 'Web role', [...new Set(index.flatMap((row) => row.persona.roles ?? []))], selected.roles],
    ['tag', 'Tag', [...new Set(index.flatMap((row) => row.persona.tags ?? []))], selected.tags],
    ['group', 'Group', groups.map((g) => ({ id: g.id, label: g.label })), selected.groups],
    [
      'subgroup',
      'Subgroup',
      (report.groups ?? []).flatMap((g) =>
        (g.subgroups ?? []).map((sub) => ({ id: `${g.id}:${sub.id}`, label: `${g.label} / ${sub.label}` })),
      ),
      selected.subgroups ?? [],
    ],
    [
      'account',
      'Account',
      [...new Map(index.map((row) => [row.persona.account?.id, row.persona.account?.name])).entries()]
        .filter(([id]) => id)
        .map(([id, label]) => ({ id, label: label ?? id })),
      selected.accounts,
    ],
  ];
  const selectedOption = (key, values, item) =>
    values.some(
      (value) =>
        foldPersonaText(value) === foldPersonaText(item.id) ||
        (key === 'account' && foldPersonaText(value) === foldPersonaText(item.label)),
    );
  return `<form method="get" action="${h(action)}" class="chooser-search">${hidden}<label for="chooser-q">Find a persona</label><div class="chooser-search-row"><input id="chooser-q" name="q" type="search" value="${h(selected.q)}" placeholder="Name, role, account, tag or description" autocomplete="off"><button>Search</button><a href="${h(action + '?' + new URLSearchParams([...params].filter(([key]) => !CHOOSER_PARAMETERS.includes(key))))}" data-chooser-clear>Clear</a></div><details class="chooser-filter-disclosure"${activeFilters ? ' open' : ''}><summary>Filters${activeFilters ? ` · ${activeFilters} active` : ''}</summary><div class="chooser-filters">${facets
    .filter(([, , options]) => options.length)
    .map(
      ([key, label, options, values]) =>
        `<label>${label}<select name="${key}" multiple size="3" aria-label="${label}">${options
          .map((item) => (typeof item === 'string' ? { id: item, label: item } : item))
          .filter((item, index) => index < 100 || selectedOption(key, values, item))
          .map(
            (item) =>
              `<option value="${h(item.id)}"${selectedOption(key, values, item) ? ' selected' : ''}>${h(item.label)}</option>`,
          )
          .join('')}</select></label>`,
    )
    .join(
      '',
    )}<label>Web roles<select name="hasRoles"><option value="">Any</option><option value="true"${selected.hideNoRoles ? ' selected' : ''}>Has roles</option><option value="false"${selected.withoutRoles ? ' selected' : ''}>No roles</option></select></label></div><p class="chooser-meta">All search terms match. Choose any values within a filter; different filters narrow the results. Ctrl/Cmd selects multiple values.${facets.some(([, , options]) => options.length > 100) ? ' Filter menus show the first 100 values; use search for other names, roles, accounts or tags.' : ''}</p></details></form>`;
}
