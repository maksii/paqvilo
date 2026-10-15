/** Shared by the server and the browser. Indexed once per catalogue refresh;
 * filtering never joins memberships or rebuilds the rest of the admin page. */
export const foldPersonaText = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const values = value => (Array.isArray(value) ? value : value ? [value] : []).map(foldPersonaText);
export const personaRowKey = persona => persona.key ?? `@contact:${persona.contactId}`;

export function personaFilters(parameters) {
  const params = parameters instanceof URLSearchParams ? parameters : new URLSearchParams(parameters);
  return { q: params.get('q') ?? '', roles: params.getAll('role'), accounts: params.getAll('account'), groups: params.getAll('group'), tags: params.getAll('tag'), hideNoRoles: params.get('rolesOnly') === '1' };
}

export function indexPersonaCatalog(report) {
  const groups = new Map((report.groups ?? []).map(group => [group.id, group]));
  return [...(report.personas ?? []), ...(report.other ?? []).map(persona => ({ ...persona, group: '__other' }))].map(persona => {
    const group = groups.get(persona.group), subgroup = group?.subgroups?.find(entry => entry.id === persona.subgroup);
    return { persona, key: personaRowKey(persona), text: foldPersonaText([
      persona.label, persona.name, persona.key, persona.email, persona.account?.name,
      ...(persona.roles ?? []), group?.label, subgroup?.label, ...(persona.tags ?? []), persona.description,
      persona.group === '__other' ? 'Other contacts' : '',
    ].filter(Boolean).join(' ')), roles: new Set((persona.roles ?? []).map(foldPersonaText)),
    accounts: new Set([persona.account?.id, persona.account?.name, !persona.account?.id && !persona.account?.name ? '__none' : null].filter(Boolean).map(foldPersonaText)),
    group: foldPersonaText(persona.group), tags: new Set((persona.tags ?? []).map(foldPersonaText)) };
  });
}

export function filterPersonaIndex(index, filters = {}) {
  const terms = foldPersonaText(filters.q).trim().split(/\s+/).filter(Boolean);
  const roles = values(filters.roles), accounts = values(filters.accounts), groups = values(filters.groups), tags = values(filters.tags);
  return index.filter(entry => terms.every(term => entry.text.includes(term)) &&
    (!roles.length || roles.some(role => entry.roles.has(role))) &&
    (!accounts.length || accounts.some(account => entry.accounts.has(account))) &&
    (!groups.length || groups.includes(entry.group)) &&
    (!tags.length || tags.some(tag => entry.tags.has(tag))) && (!filters.hideNoRoles || entry.roles.size > 0));
}

export function closestPersonaKeys(key, personas, count = 5) {
  const query = foldPersonaText(key).slice(0, 128);
  const distance = value => {
    const target = foldPersonaText(value).slice(0, 128);
    let previous = Array.from({ length: target.length + 1 }, (_, index) => index);
    for (let row = 1; row <= query.length; row++) {
      const next = [row];
      for (let column = 1; column <= target.length; column++) next[column] = Math.min(next[column - 1] + 1, previous[column] + 1, previous[column - 1] + (query[row - 1] === target[column - 1] ? 0 : 1));
      previous = next;
    }
    return previous[target.length];
  };
  return personas.filter(persona => persona.key).map(persona => ({ key: persona.key, score: distance(persona.key) }))
    .sort((a, b) => a.score - b.score || a.key.localeCompare(b.key)).slice(0, count).map(entry => entry.key);
}
