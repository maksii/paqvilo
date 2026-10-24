import { personaRowKey } from './persona-search.mjs';

export const personaHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
const html = personaHtml;

export function personaCard(
  persona,
  { mode = 'select', selectedKey, selectedContactId, contexts = new Map(), shortcut = false } = {},
) {
  const key = personaRowKey(persona),
    selected = selectedKey ? selectedKey === key : selectedContactId === persona.contactId;
  const context = contexts.get(persona.context);
  const action =
    mode === 'signin'
      ? `<button type="submit" class="persona-button persona-primary" name="${persona.key ? 'personaKey' : 'contactId'}" value="${html(persona.key ?? persona.contactId)}">${persona.context ? 'Open context' : 'Sign in'}</button>`
      : `<button type="button" class="persona-button${selected ? ' persona-primary' : ''}" data-persona-choose="${html(key)}" aria-pressed="${selected}">${selected ? 'Selected' : 'Choose'}</button>`;
  return `<li class="persona-card${shortcut ? ' persona-shortcut' : ''} paqvilo-mirage-persona" data-persona-row="${html(key)}" data-contact-id="${html(persona.contactId)}" data-selected="${selected}"><div class="persona-card-main"><div class="persona-title"><strong>${html(persona.label ?? persona.name ?? persona.contactId)}</strong>${persona.default ? '<span class="persona-badge">Default</span>' : ''}${persona.key ? `<code>${html(persona.key)}</code>` : ''}</div><p class="persona-account">${html(persona.account?.name || persona.account?.id || 'No account')}<span aria-hidden="true"> · </span>${html((persona.roles ?? []).join(', ') || 'No web roles')}</p>${persona.summary ? `<p class="persona-summary" title="${html(persona.description)}">${html(persona.summary)}</p>` : ''}${(persona.tags ?? []).length ? `<ul class="persona-tags" aria-label="Tags">${persona.tags.map((tag) => `<li>${html(tag)}</li>`).join('')}</ul>` : ''}${persona.context ? `<p class="persona-context-label">Context: ${html(context?.label ?? persona.context)}</p>` : ''}</div><div class="persona-card-actions">${action}<button type="button" class="persona-button persona-pin" data-persona-pin="${html(key)}" aria-pressed="false" aria-label="Pin ${html(persona.label ?? persona.name)}" hidden>☆</button><button type="button" class="persona-button persona-details" data-persona-details="${html(key)}" hidden>Details</button></div></li>`;
}

/** Pure, escaped HTML shared by native sign-in and the admin picker. Search is
 * optional enhancement; the complete grouped sign-in list is usable without JS. */
export function renderPersonaPicker(
  report,
  {
    id = 'persona-picker',
    mode = 'select',
    selectedKey,
    selectedContactId,
    enhanced = false,
    collapsed = false,
    q = '',
  } = {},
) {
  const contexts = new Map((report.contexts ?? []).map((context) => [context.id, context]));
  const options = { mode, selectedKey, selectedContactId, contexts };
  const cards = (entries) =>
    `<ul class="persona-list">${entries.map((persona) => personaCard(persona, options)).join('')}</ul>`;
  const buckets = new Map();
  for (const persona of report.personas ?? []) {
    const key = `${persona.group}\0${persona.subgroup ?? ''}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(persona);
  }
  const defaultPersona = [...(report.personas ?? []), ...(report.other ?? [])].find((persona) => persona.default);
  const groups = (report.groups ?? [])
    .map(
      (group) =>
        `<details class="persona-group" data-persona-group="${html(group.id)}"${collapsed ? '' : ' open'}${group.count ? '' : ' hidden'}><summary><span>${html(group.label)}</span><span class="persona-group-count" data-persona-group-count="${html(group.id)}">${group.count}</span></summary><div class="persona-group-body">${cards(buckets.get(`${group.id}\0`) ?? [])}${(group.subgroups ?? []).map((subgroup) => `<details class="persona-subgroup" data-persona-subgroup="${html(group.id)}:${html(subgroup.id)}"${collapsed ? '' : ' open'}${subgroup.count ? '' : ' hidden'}><summary><span>${html(subgroup.label)}</span><span class="persona-group-count" data-persona-subgroup-count="${html(group.id)}:${html(subgroup.id)}">${subgroup.count}</span></summary>${cards(buckets.get(`${group.id}\0${subgroup.id}`) ?? [])}</details>`).join('')}</div></details>`,
    )
    .join('');
  return `<div class="persona-picker" id="${html(id)}" data-persona-picker data-persona-mode="${html(mode)}"><div class="persona-tools" data-persona-tools${enhanced ? '' : ' hidden'}><label class="persona-search-label" for="${html(id)}-search">Find a persona</label><div class="persona-search-row"><input type="search" id="${html(id)}-search" data-persona-query value="${html(q)}" placeholder="Name, role, account, tag or description" autocomplete="off"><button type="button" class="persona-button" data-persona-clear>Clear filters</button></div><div class="persona-filters">${[
    ['roles', 'Web role'],
    ['accounts', 'Account'],
    ['groups', 'Group'],
    ['tags', 'Tag'],
  ]
    .map(
      ([name, label]) =>
        `<details class="persona-facet" data-persona-facet="${name}"><summary>${label}<span data-persona-facet-count="${name}"></span></summary><div class="persona-facet-options" data-persona-options="${name}"></div></details>`,
    )
    .join(
      '',
    )}<label class="persona-role-toggle"><input type="checkbox" data-persona-roles-only> Has web roles</label></div><p class="persona-filter-help">Search terms all match. Choose any values within a filter; filters combine to narrow results.</p></div><div class="persona-results-bar"><p role="status" aria-live="polite" data-persona-result-count>${report.total} of ${report.total}</p><span data-persona-selection></span></div><section class="persona-spotlight" data-persona-shortcuts="pinned" hidden><h3>Pinned</h3><div data-persona-shortcut-list></div></section><section class="persona-spotlight" data-persona-shortcuts="recent" hidden><h3>Recent</h3><div data-persona-shortcut-list></div></section>${defaultPersona ? `<section class="persona-spotlight" data-persona-default><h3>Default</h3>${cards([defaultPersona])}</section>` : ''}<div class="persona-groups">${groups}${(report.other ?? []).length ? `<details class="persona-group persona-other" data-persona-group="__other"${collapsed ? '' : ' open'}><summary><span>Other contacts</span><span class="persona-group-count" data-persona-group-count="__other">${report.other.length}</span></summary><div class="persona-group-body">${cards(report.other)}</div></details>` : ''}</div><p class="persona-empty" data-persona-empty${report.total ? ' hidden' : ''}>${report.total ? 'No personas match these filters. Clear a filter or try fewer search terms.' : 'No active contacts are available for this catalogue. Review the dataset or manage the catalogue.'}</p></div>`;
}

export function personaDetailsView(persona, context) {
  const rows = [
    ['Key', persona.key ?? 'Other contact'],
    ['Contact', persona.name ?? persona.label],
    ['Contact ID', persona.contactId],
    ['Email', persona.email || 'Not provided'],
    ['Account', persona.account?.name || persona.account?.id || 'None'],
    ['Web roles', (persona.roles ?? []).join(', ') || 'None'],
    ['Tags', (persona.tags ?? []).join(', ') || 'None'],
    ['Source', persona.source ?? 'contact'],
    ['Start page', persona.startPath ?? context?.startPath ?? '/'],
  ];
  return `<h2>${html(persona.label ?? persona.name)}</h2><p class="persona-full-description">${html(persona.description ?? '')}</p><dl class="persona-detail-list">${rows.map(([label, value]) => `<dt>${html(label)}</dt><dd>${html(value)}</dd>`).join('')}</dl>${context ? `<section class="persona-context-detail"><h3>${html(context.label)}</h3><p>${html(context.description ?? '')}</p><p>This setup opens in an isolated local runtime. Other visitors keep their current setup.</p><dl class="persona-detail-list"><dt>Deployment profile</dt><dd>${html(context.deploymentProfile === undefined ? 'Runtime default' : (context.deploymentProfile.profile ?? 'No profile'))}</dd><dt>Environment variables</dt><dd>${html(Object.keys(context.environmentVariables ?? {}).join(', ') || 'No overrides')}</dd><dt>Content snippets</dt><dd>${html(Object.keys(context.portalOverrides?.snippets ?? {}).join(', ') || 'No overrides')}</dd><dt>Site settings</dt><dd>${html(Object.keys(context.portalOverrides?.settings ?? {}).join(', ') || 'No overrides')}</dd></dl></section>` : ''}`;
}
