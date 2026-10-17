/** Shared by the server and the browser. Indexed once per catalogue refresh;
 * filtering never joins memberships or rebuilds the rest of the admin page. */
export const PERSONA_TRANSLITERATIONS = Object.freeze({ 'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'đ': 'd', 'ð': 'd', 'ł': 'l', 'þ': 'th' });
const displayCollator = new Intl.Collator('en', { sensitivity: 'base' });
const transliterations = PERSONA_TRANSLITERATIONS;
export const foldPersonaText = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[øæœßđðłþ]/g, letter => transliterations[letter]);
const values = value => (Array.isArray(value) ? value : value ? [value] : []).map(foldPersonaText);
export const personaRowKey = persona => persona.key ?? `@contact:${persona.contactId}`;

export function personaFilters(parameters) {
  const params = parameters instanceof URLSearchParams ? parameters : new URLSearchParams(parameters);
  return { q: params.get('q') ?? '', roles: params.getAll('role'), accounts: params.getAll('account'), groups: params.getAll('group'), tags: params.getAll('tag'), hideNoRoles: params.get('rolesOnly') === '1' || ['1','true'].includes(params.get('hasRoles')), ...(params.has('subgroup')?{subgroups:params.getAll('subgroup')}:{}), ...(params.get('hasRoles')==='false'||params.get('hasRoles')==='0'?{withoutRoles:true}:{}) };
}

export function indexPersonaCatalog(report) {
  const groups = new Map((report.groups ?? []).map(group => [group.id, group]));
  const groupOrder = new Map([...groups.keys()].map((id, index) => [id, index]));
  const subgroupOrder = new Map([...groups].map(([id, group]) => [id, new Map((group.subgroups ?? []).map((sub, index) => [sub.id, index]))]));
  const displayOrder = (a, b) => (groupOrder.get(a.group) ?? groups.size) - (groupOrder.get(b.group) ?? groups.size) ||
    (a.subgroup ? subgroupOrder.get(a.group)?.get(a.subgroup) ?? 1000 : -1) - (b.subgroup ? subgroupOrder.get(b.group)?.get(b.subgroup) ?? 1000 : -1) ||
    (a.order ?? 1000) - (b.order ?? 1000) || displayCollator.compare(String(a.label ?? a.name ?? a.key), String(b.label ?? b.name ?? b.key)) || personaRowKey(a).localeCompare(personaRowKey(b));
  return [...(report.personas ?? []), ...(report.other ?? []).map(persona => ({ ...persona, group: '__other' }))].sort(displayOrder).map(persona => {
    const group = groups.get(persona.group), subgroup = group?.subgroups?.find(entry => entry.id === persona.subgroup);
    return { persona, key: personaRowKey(persona), text: foldPersonaText([
      persona.label, persona.name, persona.key, persona.email, persona.account?.name,
      ...(persona.roles ?? []), group?.label, subgroup?.label, ...(persona.tags ?? []), persona.description,
      persona.group === '__other' ? 'Other contacts' : '',
    ].filter(Boolean).join(' ')), roles: new Set((persona.roles ?? []).map(foldPersonaText)),
    accounts: new Set([persona.account?.id, persona.account?.name, !persona.account?.id && !persona.account?.name ? '__none' : null].filter(Boolean).map(foldPersonaText)),
    group: foldPersonaText(persona.group), subgroup:foldPersonaText(persona.subgroup), tags: new Set((persona.tags ?? []).map(foldPersonaText)) };
  });
}

export function filterPersonaIndex(index, filters = {}) {
  const terms = foldPersonaText(filters.q).trim().split(/\s+/).filter(Boolean);
  const roles = values(filters.roles), accounts = values(filters.accounts), groups = values(filters.groups), tags = values(filters.tags), subgroups=values(filters.subgroups);
  return index.filter(entry => terms.every(term => entry.text.includes(term)) &&
    (!roles.length || roles.some(role => entry.roles.has(role))) &&
    (!accounts.length || accounts.some(account => entry.accounts.has(account))) &&
    (!groups.length || groups.includes(entry.group)) &&
    (!tags.length || tags.some(tag => entry.tags.has(tag))) && (!subgroups.length||subgroups.some(group=>group===entry.subgroup||group===`${entry.group}:${entry.subgroup}`)) && (!filters.hideNoRoles || entry.roles.size > 0) && (!filters.withoutRoles||entry.roles.size===0));
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
