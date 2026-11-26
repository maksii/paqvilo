// Knowledge article content access levels (Learn: power-pages/templates/dynamics-365-apps/
// manage-knowledge-articles-content-levels):
// - KnowledgeManagement/ContentAccessLevel/Enabled (default false) turns the filtering on; off, nothing changes.
// - Levels reach a visitor through their web roles (the Default level reaches anonymous and signed-in visitors through
//   the Anonymous Users and Authenticated Users roles), their contact, its parent contact and its account.
// - The table is the standard adx_contentaccesslevel. Its N:N relationships (intersect table and columns) are read from
//   the Solution metadata the store holds, never from a name.
// - Only active rows grant: an inactive level, contact or account, or an inactive web role, adds no level.
// Local model, not documented: an article is visible when it shares at least one level with the visitor, so an article
// with no level is hidden. The level links are read from local data. With live data (mode live) the same rule runs over
// the rows the live read path returns (the contact, its parent, the visitor's levels and the articles of those levels);
// when that read fails, every knowledge article is hidden and KNOWLEDGE_CONTENT_ACCESS_LIVE_HIDDEN is reported once (an
// article the visitor may not read is never shown).
import { siteSetting } from './redirects.mjs';
import { portalWebRoles } from './permissions.mjs';
import { collectFetchXmlPages } from './paging-validation.mjs';
import { xmlEscapeAttribute } from './fetchxml-engine.mjs';

const CONTENT_ACCESS_LEVEL_SETTING = 'KnowledgeManagement/ContentAccessLevel/Enabled';
const LEVEL_TABLE = 'adx_contentaccesslevel';
const ARTICLE_TABLE = 'knowledgearticle';
// The web role tables of the standard and enhanced data models (as sign-in-flow.mjs).
const WEB_ROLE_TABLES = new Set(['adx_webrole', 'mspp_webrole', 'powerpagecomponent']);

const canonical = (value) =>
  String(value?.id ?? value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const active = (row) => {
  const state = row?.statecode?.value ?? row?.statecode;
  return state == null || state === '' || Number(state) === 0;
};
// Stores that already reported the live-data notice.
const liveNoticeReported = new WeakSet();

/** The ids of the active rows of `table`. */
function activeIds(store, table) {
  const idColumn = store.state?.mappings?.[table]?.idColumn ?? `${table}id`;
  return new Set(
    store
      .tableRows(table)
      .filter(active)
      .map((row) => canonical(row[idColumn]))
      .filter(Boolean),
  );
}

/** Whether the site filters knowledge articles by content access level. */
function contentAccessLevelsEnabled(portal) {
  return /^(?:true|1)$/i.test(String(siteSetting(portal ?? {}, CONTENT_ACCESS_LEVEL_SETTING) ?? '').trim());
}

/** The level table's N:N relationships from the Solution metadata: { table, intersect, levelColumn, otherColumn }. */
function levelRelationships(store) {
  let mapping;
  try {
    mapping = store.resolveMapping(LEVEL_TABLE);
  } catch {
    return [];
  }
  const found = new Map();
  for (const rel of Object.values(mapping.relationships ?? {})) {
    const intersect = rel?.intersect;
    if (!rel?.entity || !intersect?.entity || !intersect.from || !intersect.to) continue;
    found.set(`${intersect.entity}:${rel.entity}`, {
      table: String(rel.entity).toLowerCase(),
      intersect: intersect.entity,
      levelColumn: intersect.from,
      otherColumn: intersect.to,
    });
  }
  return [...found.values()];
}

function levelsOf(store, relationships, matches, ids) {
  const levels = new Set();
  if (!ids.size) return levels;
  for (const rel of relationships) {
    if (!matches(rel.table)) continue;
    for (const row of store.tableRows(rel.intersect))
      if (ids.has(canonical(row[rel.otherColumn]))) levels.add(canonical(row[rel.levelColumn]));
  }
  levels.delete('');
  return levels;
}

/** The contact's parent customer: { id, type } with type null when the row does not name it. */
function parentCustomer(contact) {
  const value = contact?.parentcustomerid ?? contact?._parentcustomerid_value;
  const id = canonical(value);
  if (!id) return null;
  const type =
    value?.logical_name ??
    value?.logicalName ??
    contact?.['_parentcustomerid_value@Microsoft.Dynamics.CRM.lookuplogicalname'] ??
    contact?.parentcustomeridtype ??
    null;
  return { id, type: type ? String(type).toLowerCase() : null };
}

/**
 * The visitor's web role ids, as the store's table-permission rules see them (data.mjs rules): the resolved membership
 * roles, else the named roles plus the export's Anonymous Users or Authenticated Users role. No identity is anonymous.
 * Only the export's active web roles count.
 */
function visitorRoleIds(portal, identity, signedIn) {
  const roleIds = new Set((identity?.roleIds ?? []).map(canonical).filter(Boolean));
  const roles = portalWebRoles(portal),
    names = new Set(identity?.roles ?? []);
  const activeRoles = new Set(roles.map((role) => canonical(role.id)));
  if (identity?.roleSource !== 'memberships')
    for (const role of roles)
      if (names.has(role.name) || (signedIn ? role.authenticated : role.anonymous)) roleIds.add(canonical(role.id));
  return new Set([...roleIds].filter((roleId) => activeRoles.has(roleId)));
}

/** Web role, contact, parent contact and account levels of `identity`. */
function visitorLevels(portal, store, relationships, identity) {
  const contactId = canonical(identity?.contactId ?? identity?.id);
  const roleIds = visitorRoleIds(portal, identity, Boolean(contactId));
  const contacts = new Set(contactId ? [contactId] : []);
  const accounts = new Set(identity?.accountId ? [canonical(identity.accountId)] : []);
  if (contactId) {
    const idColumn = store.state?.mappings?.contact?.idColumn ?? 'contactid';
    const contact = store.tableRows('contact').find((row) => canonical(row[idColumn]) === contactId);
    const parent = parentCustomer(contact);
    if (parent && parent.type !== 'account') contacts.add(parent.id);
    if (parent && parent.type !== 'contact') accounts.add(parent.id);
  }
  const activeContacts = activeIds(store, 'contact'),
    activeAccounts = activeIds(store, 'account'),
    activeLevels = activeIds(store, LEVEL_TABLE);
  const only = (ids, allowed) => new Set([...ids].filter((id) => allowed.has(id)));
  const levels = [
    ...levelsOf(store, relationships, (table) => WEB_ROLE_TABLES.has(table), roleIds),
    ...levelsOf(store, relationships, (table) => table === 'contact', only(contacts, activeContacts)),
    ...levelsOf(store, relationships, (table) => table === 'account', only(accounts, activeAccounts)),
  ];
  return only(levels, activeLevels);
}

const HIDE_ALL = Object.freeze({ levels: [], visible: () => false });

function liveHidden(store, diagnostic, reason) {
  if (!liveNoticeReported.has(store)) {
    liveNoticeReported.add(store);
    diagnostic({
      code: 'KNOWLEDGE_CONTENT_ACCESS_LIVE_HIDDEN',
      severity: 'warning',
      component: 'knowledge',
      message: `${CONTENT_ACCESS_LEVEL_SETTING} is true, but the live content access levels could not be read (${reason}): every knowledge article is hidden rather than shown unfiltered.`,
    });
  }
  return HIDE_ALL;
}

const idColumnOf = (store, table) => {
  try {
    return store.resolveMapping(table).idColumn ?? `${table}id`;
  } catch {
    return `${table}id`;
  }
};
const inValues = (ids) => [...ids].map((id) => `<value>${xmlEscapeAttribute(id)}</value>`).join('');

/** Every row id of a distinct live query, through the read provider's paged FetchXML. */
async function liveRows(readProvider, identity, entity, idColumn, body) {
  const { records } = await collectFetchXmlPages({
    idColumn,
    readPage: async ({ page, cookie, pageSize }) => {
      const continuation = cookie ? ` paging-cookie="${xmlEscapeAttribute(cookie)}"` : '';
      const result = await readProvider.fetchXml(
        `<fetch distinct="true" count="${pageSize}" page="${page}"${continuation}><entity name="${entity}"><attribute name="${idColumn}"/>${body}</entity></fetch>`,
        identity,
      );
      return { ...result, entities: result.entities ?? result.value ?? [] };
    },
  });
  return records.map((row) => canonical(row[idColumn])).filter(Boolean);
}

/** The active levels linked through `rels` to any of `ids`, read live. */
async function liveLevels(readProvider, identity, levelId, rels, ids) {
  const levels = new Set();
  if (!ids.size) return levels;
  for (const rel of rels) {
    const body = `<filter><condition attribute="statecode" operator="eq" value="0"/></filter><link-entity name="${rel.intersect}" from="${rel.levelColumn}" to="${levelId}" link-type="inner" intersect="true"><filter><condition attribute="${rel.otherColumn}" operator="in">${inValues(ids)}</condition></filter></link-entity>`;
    for (const level of await liveRows(readProvider, identity, LEVEL_TABLE, levelId, body)) levels.add(level);
  }
  return levels;
}

/** An active row read live, or null when it does not exist or is inactive. */
async function liveActiveRow(readProvider, identity, table, id) {
  if (!id) return null;
  let row;
  try {
    row = await readProvider.get(table, id, identity);
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
  return row && active(row) ? row : null;
}

/** The visitor's active contacts (its own and its parent contact) and accounts, read live. */
async function liveVisitorRecords(readProvider, identity, contactId) {
  const contacts = new Set(),
    accounts = new Set();
  const contact = await liveActiveRow(readProvider, identity, 'contact', contactId);
  if (contact) contacts.add(contactId);
  const parent = parentCustomer(contact);
  const candidates = [];
  if (identity?.accountId) candidates.push(['account', canonical(identity.accountId)]);
  if (parent && parent.type !== 'account') candidates.push(['contact', parent.id]);
  if (parent && parent.type !== 'contact') candidates.push(['account', parent.id]);
  for (const [table, id] of candidates)
    if (await liveActiveRow(readProvider, identity, table, id)) (table === 'contact' ? contacts : accounts).add(id);
  return { contacts, accounts };
}

/** The same content access level rule as local data, over rows the live read path returns. */
async function liveKnowledgeArticleAccess({ portal, store, identity, readProvider, diagnostic }) {
  try {
    const relationships = levelRelationships(store);
    const articleRelationships = relationships.filter((rel) => rel.table === ARTICLE_TABLE);
    if (!articleRelationships.length) return liveHidden(store, diagnostic, 'no level-to-article relationship');
    const levelId = idColumnOf(store, LEVEL_TABLE);
    const contactId = canonical(identity?.contactId ?? identity?.id);
    const roleIds = visitorRoleIds(portal, identity, Boolean(contactId));
    const { contacts, accounts } = await liveVisitorRecords(readProvider, identity, contactId);
    const of = (matches) => relationships.filter((rel) => matches(rel.table));
    const levels = new Set([
      ...(await liveLevels(
        readProvider,
        identity,
        levelId,
        of((table) => WEB_ROLE_TABLES.has(table)),
        roleIds,
      )),
      ...(await liveLevels(
        readProvider,
        identity,
        levelId,
        of((table) => table === 'contact'),
        contacts,
      )),
      ...(await liveLevels(
        readProvider,
        identity,
        levelId,
        of((table) => table === 'account'),
        accounts,
      )),
    ]);
    const articles = new Set();
    const articleId = idColumnOf(store, ARTICLE_TABLE);
    if (levels.size)
      for (const rel of articleRelationships) {
        const body = `<link-entity name="${rel.intersect}" from="${rel.otherColumn}" to="${articleId}" link-type="inner" intersect="true"><filter><condition attribute="${rel.levelColumn}" operator="in">${inValues(levels)}</condition></filter></link-entity>`;
        for (const article of await liveRows(readProvider, identity, ARTICLE_TABLE, articleId, body))
          articles.add(article);
      }
    return { levels: [...levels].sort(), visible: (id) => articles.has(canonical(id)) };
  } catch (error) {
    return liveHidden(store, diagnostic, error?.message ?? String(error));
  }
}

/**
 * The content access level filter for `identity`, or null when the site does not filter (the setting is off).
 * `visible(articleId)` is true when the article shares a level with the visitor. With live data (`config.mode` live) it
 * is a promise of the same filter over the rows `readProvider` reads; without a read provider, or when the read fails,
 * the filter admits no article.
 */
export function knowledgeArticleAccess({
  portal,
  store,
  identity,
  config = null,
  readProvider = null,
  diagnostic = () => {},
}) {
  if (!contentAccessLevelsEnabled(portal)) return null;
  if (config?.mode === 'live') {
    if (typeof readProvider?.fetchXml !== 'function' || typeof readProvider?.get !== 'function')
      return liveHidden(store, diagnostic, 'no live read path');
    return liveKnowledgeArticleAccess({ portal, store, identity, readProvider, diagnostic });
  }
  const relationships = levelRelationships(store);
  const articleRelationships = relationships.filter((rel) => rel.table === ARTICLE_TABLE);
  if (!articleRelationships.length)
    diagnostic({
      code: 'KNOWLEDGE_CONTENT_ACCESS_UNRESOLVED',
      severity: 'warning',
      component: 'knowledge',
      message: `${CONTENT_ACCESS_LEVEL_SETTING} is true but the Solution metadata has no N:N relationship between ${LEVEL_TABLE} and ${ARTICLE_TABLE}: every knowledge article is hidden.`,
    });
  const levels = visitorLevels(portal, store, relationships, identity);
  const articleLevels = new Map();
  for (const rel of articleRelationships)
    for (const row of store.tableRows(rel.intersect)) {
      const article = canonical(row[rel.otherColumn]),
        level = canonical(row[rel.levelColumn]);
      if (!article || !level) continue;
      if (!articleLevels.has(article)) articleLevels.set(article, new Set());
      articleLevels.get(article).add(level);
    }
  return {
    levels: [...levels].sort(),
    visible: (articleId) => [...(articleLevels.get(canonical(articleId)) ?? [])].some((level) => levels.has(level)),
  };
}
