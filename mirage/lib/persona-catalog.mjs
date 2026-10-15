import { validatePortalOverrides } from './portal-overrides.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const identifier = /^[a-z0-9][a-z0-9._-]*$/;
const guid = /^\{?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}?$/i;
export const personaContactId = value => String(value ?? '').replace(/[{}]/g, '').toLowerCase();
const ordered = (a, b) => (a.order ?? 1000) - (b.order ?? 1000) || String(a.label ?? a.key ?? a.id).localeCompare(String(b.label ?? b.key ?? b.id), 'en', { sensitivity: 'base' }) || String(a.key ?? a.id).localeCompare(String(b.key ?? b.id));
export const personaCatalogError = message => Object.assign(new Error(message), { code: 'InvalidPersonaCatalog', status: 400 });

export function personaStartPath(value, source = 'Persona startPath') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) throw personaCatalogError(`${source} must be a relative path starting with "/"`);
  let decoded;
  try { decoded = decodeURIComponent(value.split(/[?#]/, 1)[0]); } catch { throw personaCatalogError(`${source} has invalid path encoding`); }
  if (decoded.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(decoded)) throw personaCatalogError(`${source} must be a relative path starting with "/"`);
  return value;
}

/** Versioned, declarative metadata. Identity/role/account grants are never
 * authored here. Contexts reference configured profiles rather than file paths. */
export function validatePersonaCatalog(value, source = 'State') {
  const fail = message => { throw personaCatalogError(`${source}: personaCatalog.${message}`); };
  const keys = (entry, allowed, at) => {
    if (!object(entry)) fail(`${at} must be an object`);
    for (const key of Object.keys(entry)) if (!allowed.includes(key)) fail(`${at}${at ? '.' : ''}${key} is an unknown field`);
  };
  const text = (entry, key, at, max, required = false) => {
    if (entry[key] === undefined && !required) return;
    if (typeof entry[key] !== 'string' || key !== 'description' && !entry[key].trim() || entry[key].length > max) fail(`${at}.${key} must contain ${key === 'description' ? '0' : '1'}-${max} characters`);
  };
  const id = (entry, key, at) => { if (typeof entry[key] !== 'string' || !identifier.test(entry[key])) fail(`${at}.${key} must match ^[a-z0-9][a-z0-9._-]*$`); };
  const order = (entry, at) => { if (entry.order !== undefined && !Number.isSafeInteger(entry.order)) fail(`${at}.order must be an integer`); };
  const list = (input, at) => {
    if (!Array.isArray(input)) fail(`${at} must be an array`);
    for (let index = 0; index < input.length; index++) if (!Object.hasOwn(input, index)) fail(`${at}[${index}] must be an object`);
    return input;
  };
  const unique = (entries, field, at) => {
    const seen = new Map();
    entries.forEach((entry, index) => { if (seen.has(entry[field])) fail(`${at}[${index}].${field} "${entry[field]}" repeats ${at}[${seen.get(entry[field])}]`); seen.set(entry[field], index); });
  };
  keys(value, ['version', 'groups', 'personas', 'contexts', 'scenarios'], '');
  if (value.version !== 1) fail('version must be 1');
  const groups = list(value.groups, 'groups');
  groups.forEach((group, index) => {
    const at = `groups[${index}]`;
    keys(group, ['id', 'label', 'order', 'subgroups'], at); id(group, 'id', at); text(group, 'label', at, 60, true); order(group, at);
    const subgroups = group.subgroups === undefined ? [] : list(group.subgroups, `${at}.subgroups`);
    subgroups.forEach((subgroup, sub) => { const path = `${at}.subgroups[${sub}]`; keys(subgroup, ['id', 'label', 'order'], path); id(subgroup, 'id', path); text(subgroup, 'label', path, 60, true); order(subgroup, path); });
    unique(subgroups, 'id', `${at}.subgroups`);
  });
  unique(groups, 'id', 'groups');
  const groupMap = new Map(groups.map(group => [group.id, group]));
  const contexts = value.contexts === undefined ? [] : list(value.contexts, 'contexts');
  contexts.forEach((context, index) => {
    const at = `contexts[${index}]`;
    keys(context, ['id', 'label', 'description', 'order', 'deploymentProfile', 'environmentVariables', 'portalOverrides', 'preset', 'startPath', 'browser', 'extensions'], at);
    id(context, 'id', at); text(context, 'label', at, 80, true); text(context, 'description', at, 500); order(context, at);
    if (context.preset !== undefined && (typeof context.preset !== 'string' || !context.preset.trim())) fail(`${at}.preset must name a preset`);
    if (context.startPath !== undefined) personaStartPath(context.startPath, `${source}: personaCatalog.${at}.startPath`);
    if (context.deploymentProfile !== undefined) {
      keys(context.deploymentProfile, ['profile', 'enabled'], `${at}.deploymentProfile`);
      if (context.deploymentProfile.profile !== null && (typeof context.deploymentProfile.profile !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(context.deploymentProfile.profile) || ['__proto__', 'constructor', 'prototype'].includes(context.deploymentProfile.profile.toLowerCase()))) fail(`${at}.deploymentProfile.profile must name a configured profile or be null`);
      if (context.deploymentProfile.enabled !== undefined) {
        keys(context.deploymentProfile.enabled, ['pages', 'environmentVariables', 'connectionReferences'], `${at}.deploymentProfile.enabled`);
        if (Object.values(context.deploymentProfile.enabled).some(flag => typeof flag !== 'boolean')) fail(`${at}.deploymentProfile.enabled values must be boolean`);
      }
    }
    if (context.environmentVariables !== undefined) {
      if (!object(context.environmentVariables)) fail(`${at}.environmentVariables must map variable names to JSON values`);
      for (const [key, item] of Object.entries(context.environmentVariables)) {
        if (!key.trim() || ['__proto__', 'constructor', 'prototype'].includes(key)) fail(`${at}.environmentVariables has an invalid variable name`);
        assertJson(item, `${at}.environmentVariables.${key}`, fail);
      }
    }
    if (context.portalOverrides !== undefined) {
      keys(context.portalOverrides, ['settings', 'snippets'], `${at}.portalOverrides`);
      try { validatePortalOverrides(context.portalOverrides); } catch (cause) { fail(`${at}.portalOverrides: ${cause.message}`); }
    }
    if (context.browser !== undefined) {
      keys(context.browser, ['locale', 'timezoneId', 'viewport', 'colorScheme'], `${at}.browser`);
      text(context.browser, 'locale', `${at}.browser`, 80); text(context.browser, 'timezoneId', `${at}.browser`, 120);
      try { if (context.browser.locale) Intl.getCanonicalLocales(context.browser.locale); } catch { fail(`${at}.browser.locale is not a valid language tag`); }
      try { if (context.browser.timezoneId) new Intl.DateTimeFormat('en', { timeZone: context.browser.timezoneId }); } catch { fail(`${at}.browser.timezoneId is not a valid time zone`); }
      if (context.browser.colorScheme !== undefined && !['light', 'dark', 'no-preference'].includes(context.browser.colorScheme)) fail(`${at}.browser.colorScheme is invalid`);
      if (context.browser.viewport !== undefined) {
        keys(context.browser.viewport, ['width', 'height'], `${at}.browser.viewport`);
        if (['width', 'height'].some(key => !Number.isInteger(context.browser.viewport[key]) || context.browser.viewport[key] < 1 || context.browser.viewport[key] > 16384)) fail(`${at}.browser.viewport requires width and height from 1 to 16384`);
      }
    }
    if (context.extensions !== undefined) extensions(context.extensions, `${at}.extensions`, fail);
  });
  unique(contexts, 'id', 'contexts');
  const contextIds = new Set(contexts.map(context => context.id));
  const groupReference = (entry, at) => {
    if (!groupMap.has(entry.group)) fail(`${at}.group "${entry.group}" is not a declared group`);
    if (entry.subgroup !== undefined && !(groupMap.get(entry.group).subgroups ?? []).some(subgroup => subgroup.id === entry.subgroup)) fail(`${at}.subgroup "${entry.subgroup}" is not declared under group "${entry.group}"`);
  };
  const contextReference = (entry, at) => { if (entry.context !== undefined && !contextIds.has(entry.context)) fail(`${at}.context "${entry.context}" is not a declared context`); };
  const personas = list(value.personas, 'personas');
  personas.forEach((persona, index) => {
    const at = `personas[${index}]`;
    keys(persona, ['key', 'contactId', 'label', 'group', 'subgroup', 'tags', 'description', 'order', 'startPath', 'context', 'extensions'], at);
    id(persona, 'key', at);
    if (typeof persona.contactId !== 'string' || !guid.test(persona.contactId) || persona.contactId.startsWith('{') !== persona.contactId.endsWith('}')) fail(`${at}.contactId must be a GUID with optional braces`);
    text(persona, 'label', at, 80); text(persona, 'description', at, 500); order(persona, at); groupReference(persona, at); contextReference(persona, at);
    if (persona.tags !== undefined && (!Array.isArray(persona.tags) || persona.tags.length > 20 || Array.from(persona.tags).some(tag => typeof tag !== 'string' || tag.length > 40 || !/^[a-z0-9][a-z0-9-]*$/.test(tag)))) fail(`${at}.tags must contain at most 20 lowercase tags, each at most 40 characters`);
    if (persona.startPath !== undefined) personaStartPath(persona.startPath, `${source}: personaCatalog.${at}.startPath`);
    if (persona.extensions !== undefined) extensions(persona.extensions, `${at}.extensions`, fail);
  });
  unique(personas, 'key', 'personas');
  const personaKeys = new Set(personas.map(persona => persona.key));
  const scenarios = value.scenarios === undefined ? [] : list(value.scenarios, 'scenarios');
  scenarios.forEach((scenario, index) => {
    const at = `scenarios[${index}]`;
    keys(scenario, ['id', 'label', 'description', 'order', 'group', 'subgroup', 'persona', 'startPath', 'preset', 'context'], at);
    id(scenario, 'id', at); text(scenario, 'label', at, 80, true); text(scenario, 'description', at, 500); order(scenario, at); groupReference(scenario, at); contextReference(scenario, at);
    if (!personaKeys.has(scenario.persona)) fail(`${at}.persona "${scenario.persona}" is not a declared persona`);
    if (scenario.startPath !== undefined) personaStartPath(scenario.startPath, `${source}: personaCatalog.${at}.startPath`);
    if (scenario.preset !== undefined && (typeof scenario.preset !== 'string' || !scenario.preset.trim())) fail(`${at}.preset must name a preset`);
  });
  unique(scenarios, 'id', 'scenarios');
  return structuredClone(value);
}

function assertJson(value, at, fail, seen = new Set(), depth = 0) {
  if (value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return;
  if ((!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) && !Array.isArray(value) || depth > 32 || seen.has(value)) fail(`${at} must contain finite, acyclic JSON data`);
  seen.add(value);
  for (const [key, item] of Array.isArray(value) ? value.entries() : Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail(`${at}.${key} is not allowed`);
    assertJson(item, `${at}.${key}`, fail, seen, depth + 1);
  }
  seen.delete(value);
}
function extensions(value, at, fail) {
  if (!object(value)) fail(`${at} must map namespaced keys to JSON data`);
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/.test(key)) fail(`${at}.${key} must be namespaced as pack:feature`);
    assertJson(item, `${at}.${key}`, fail);
  }
}

/** Primary entries win as a whole; groups additionally merge their subgroups.
 * Used by additive datasets and by effective pack/state catalogue resolution. */
export function mergePersonaCatalogs(primary, fallback) {
  if (!primary) return fallback ? structuredClone(fallback) : undefined;
  if (!fallback) return structuredClone(primary);
  const merge = (a = [], b = [], field = 'id') => {
    const entries = new Map(b.map(entry => [entry[field], structuredClone(entry)]));
    for (const entry of a) entries.set(entry[field], structuredClone(entry));
    return [...entries.values()];
  };
  const groups = merge(primary.groups, fallback.groups);
  const originals = new Map(fallback.groups.map(group => [group.id, group]));
  for (const group of groups) if (originals.has(group.id)) group.subgroups = merge(group.subgroups, originals.get(group.id).subgroups);
  return {
    version: 1, groups,
    personas: merge(primary.personas, fallback.personas, 'key'),
    ...((primary.contexts || fallback.contexts) ? { contexts: merge(primary.contexts, fallback.contexts) } : {}),
    ...((primary.scenarios || fallback.scenarios) ? { scenarios: merge(primary.scenarios, fallback.scenarios) } : {}),
  };
}

/** Join catalogue descriptions to authoritative active contact identities. */
export function resolvePersonaCatalog({ contacts = [], catalogs = [], defaultContactId, defaultKey } = {}) {
  const sources = catalogs.map(entry => entry.source), diagnostics = [];
  const definitions = new Map(), groups = new Map(), contexts = new Map(), scenarios = new Map();
  for (const { source, catalog, state = false } of catalogs) {
    if (!catalog) continue;
    for (const group of catalog.groups) {
      const previous = groups.get(group.id);
      if (!previous || state) {
        const subgroups = new Map((previous?.subgroups ?? []).map(subgroup => [subgroup.id, subgroup]));
        for (const subgroup of group.subgroups ?? []) subgroups.set(subgroup.id, subgroup);
        groups.set(group.id, { ...group, subgroups: [...subgroups.values()] });
      } else {
        const ids = new Set((previous.subgroups ?? []).map(subgroup => subgroup.id));
        previous.subgroups = [...(previous.subgroups ?? []), ...(group.subgroups ?? []).filter(subgroup => !ids.has(subgroup.id))];
      }
    }
    for (const entry of catalog.personas) {
      const previous = definitions.get(entry.key);
      if (previous && !state && personaContactId(previous.entry.contactId) !== personaContactId(entry.contactId)) diagnostics.push({ code: 'PERSONA_CATALOG_KEY_CONFLICT', key: entry.key, source, selectedSource: previous.source });
      if (!previous || state) definitions.set(entry.key, { entry, source, state });
    }
    for (const context of catalog.contexts ?? []) if (!contexts.has(context.id) || state) contexts.set(context.id, { ...context, source });
    for (const scenario of catalog.scenarios ?? []) if (!scenarios.has(scenario.id) || state) scenarios.set(scenario.id, { ...scenario, source });
  }
  const active = new Map(contacts.filter(contact => contact.active !== false).map(contact => [personaContactId(contact.contactId), contact]));
  const represented = new Set(), personas = []; let skipped = 0;
  for (const { entry, source, state } of definitions.values()) {
    const contactId = personaContactId(entry.contactId), contact = active.get(contactId);
    if (!contact) {
      if (state) diagnostics.push({ code: 'PERSONA_CATALOG_CONTACT_MISSING', source, key: entry.key, contactId });
      else skipped++;
      continue;
    }
    represented.add(contactId);
    personas.push({ ...structuredClone(entry), contactId, label: entry.label || contact.name || contactId, name: contact.name || contactId,
      email: contact.email ?? '', account: { id: contact.accountId ?? null, name: contact.accountName ?? null }, accountId: contact.accountId ?? null,
      roles: [...(contact.roles ?? [])], roleIds: [...(contact.roleIds ?? [])], active: true, tags: [...new Set(entry.tags ?? [])],
      summary: (entry.description ?? '').split(/\r?\n/, 1)[0], description: entry.description ?? '', source, default: false });
  }
  personas.sort(ordered);
  const preferred = personas.find(persona => persona.key === defaultKey) ?? personas.find(persona => persona.contactId === personaContactId(defaultContactId));
  if (preferred) preferred.default = true;
  const other = [...active.values()].filter(contact => !represented.has(personaContactId(contact.contactId))).map(contact => ({
    contactId: personaContactId(contact.contactId), label: contact.name ?? contact.contactId, name: contact.name ?? contact.contactId, email: contact.email ?? '',
    account: { id: contact.accountId ?? null, name: contact.accountName ?? null }, accountId: contact.accountId ?? null,
    roles: [...(contact.roles ?? [])], roleIds: [...(contact.roleIds ?? [])], active: true,
    default: !preferred && personaContactId(contact.contactId) === personaContactId(defaultContactId), tags: [], summary: '', description: '', source: 'contact',
  })).sort(ordered);
  const counts = new Map(), subcounts = new Map();
  for (const persona of personas) { counts.set(persona.group, (counts.get(persona.group) ?? 0) + 1); if (persona.subgroup) { const key = `${persona.group}:${persona.subgroup}`; subcounts.set(key, (subcounts.get(key) ?? 0) + 1); } }
  return { version: 1, enabled: catalogs.length > 0, sources, total: personas.length + other.length,
    groups: [...groups.values()].sort(ordered).map(group => ({ ...group, count: counts.get(group.id) ?? 0, subgroups: (group.subgroups ?? []).sort(ordered).map(subgroup => ({ ...subgroup, count: subcounts.get(`${group.id}:${subgroup.id}`) ?? 0 })) })),
    personas, other, skipped, diagnostics, contexts: [...contexts.values()].sort(ordered), scenarios: [...scenarios.values()].sort(ordered) };
}
