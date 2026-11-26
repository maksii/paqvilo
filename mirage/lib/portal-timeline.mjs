// Power Pages notes rich text and the activity timeline (Learn: configure-notes, "Enable rich text editor";
// view-all-activities-in-portal-timeline). The service shapes and selection rules not stated by Learn follow the
// open-sourced portal code (xRM Portals Community Edition: ActivityDataAdapter, ViewDataAdapter,
// FormXmlCellMetadata, EntityActivityController) and are local models; mirage/docs/forms-lists-parity.md lists them.
import sanitizeHtml from 'sanitize-html';
import { siteSetting } from './redirects.mjs';
import { standardTableDef } from './dataverse-standard.mjs';
import { objectTypeCode } from './dataverse-metadata.mjs';

const TIMELINE_RTE_SETTING = 'Timeline/RTEEnabled';
const TIMELINE_ALL_ACTIVITIES_SETTING = 'CustomerSupport/DisplayAllUserActivitiesOnTimeline';
// The Portal Timeline View savedquery on activitypointer (ActivityDataAdapter.PortalTimelineSavedQueryId).
export const PORTAL_TIMELINE_VIEW_ID = '620cdb5e-d7c9-e511-80d1-00155d20b011';
const PORTAL_TIMELINE_VIEW_NAME = 'Portal Timeline View';
// The portal comment activity the timeline shows when not every activity is displayed (ViewDataAdapter).
export const PORTAL_COMMENT_TABLE = 'adx_portalcomment';
// EntityActivityController page sizes: 10 when the request names none, at most 25 (ActivityDataAdapter).
export const TIMELINE_DEFAULT_PAGE_SIZE = 10;
export const TIMELINE_MAX_PAGE_SIZE = 25;

const lower = (value) => String(value ?? '').toLowerCase();
// The platform parses these settings with bool.TryParse: true in any casing, surrounding white space ignored.
const settingTrue = (portal, name) => lower(siteSetting(portal, name)).trim() === 'true';

/** Timeline/RTEEnabled: notes are added and edited with the rich text editor and keep their HTML. */
export const notesRichTextEnabled = (portal) => settingTrue(portal ?? {}, TIMELINE_RTE_SETTING);
/** CustomerSupport/DisplayAllUserActivitiesOnTimeline: the timeline shows every activity of its view. */
export const displayAllActivitiesOnTimeline = (portal) => settingTrue(portal ?? {}, TIMELINE_ALL_ACTIVITIES_SETTING);

const LINK_SCHEMES = ['http', 'https', 'mailto', 'tel'];
const BASE_OPTIONS = {
  allowedSchemes: LINK_SCHEMES,
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }) },
};
const NOTE_OPTIONS = {
  ...BASE_OPTIONS,
  allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img'],
  allowedAttributes: {
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan'],
  },
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
};
// Learn: the website timeline doesn't show inline images (for example images embedded within emails).
const ACTIVITY_OPTIONS = {
  ...BASE_OPTIONS,
  allowedTags: sanitizeHtml.defaults.allowedTags.filter((tag) => tag !== 'img'),
  allowedAttributes: { a: ['href', 'name', 'target', 'rel'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] },
};

/** Rich note HTML with scripts, event handlers, styles and unsafe URLs removed. */
export const sanitizeNoteHtml = (html) => sanitizeHtml(String(html ?? ''), NOTE_OPTIONS);
/** Activity description HTML for the timeline: sanitized, without inline images. */
export const sanitizeActivityHtml = (html) => sanitizeHtml(String(html ?? ''), ACTIVITY_OPTIONS);
/** Rich HTML without visible text or an image, for the required-note check. */
export const richTextIsEmpty = (html) =>
  !/<img\b/i.test(sanitizeNoteHtml(html)) &&
  !sanitizeHtml(String(html ?? ''), { allowedTags: [], allowedAttributes: {} })
    .replaceAll('&nbsp;', ' ')
    .trim();

/** The Portal Timeline View among the Solution views: its fixed id, else its name on activitypointer. */
export function portalTimelineView(metadata) {
  const views = (metadata?.views ?? []).filter((view) => lower(view.entity) === 'activitypointer');
  return (
    views.find((view) => lower(view.id).replace(/[{}]/g, '') === PORTAL_TIMELINE_VIEW_ID) ??
    views.find((view) => lower(view.name) === lower(PORTAL_TIMELINE_VIEW_NAME)) ??
    null
  );
}

/** Activity tables of the store: activityid keyed, or standard activity tables. */
export function activityTables(store) {
  // A stored mapping is keyed by its table and may not name it; the resolved mapping does.
  const resolve = (key, mapping) => {
    const resolved = typeof store?.resolveMapping === 'function' ? store.resolveMapping(key) : mapping;
    return { ...mapping, ...resolved, logicalName: resolved?.logicalName ?? mapping.logicalName ?? key };
  };
  return Object.entries(store?.state?.mappings ?? {})
    .map(([key, mapping]) => resolve(key, mapping))
    .filter(
      (mapping) =>
        lower(mapping.logicalName) !== 'activitypointer' &&
        (mapping.idColumn === 'activityid' || standardTableDef(mapping.logicalName)?.isActivity === true),
    );
}

const descendants = (node, name) =>
  (node?.children ?? []).flatMap((child) => [...(child.name === name ? [child] : []), ...descendants(child, name)]);

// An activitytypecode value is a type code or a table logical name.
const typeMatches = (value, logical, metadata) => {
  const text = lower(value).trim();
  if (text === lower(logical)) return true;
  const declared = metadata?.entities?.[lower(logical)]?.objectTypeCode;
  return Number(text) === Number(declared ?? objectTypeCode(logical));
};

/**
 * The view's selection over the activity tables: tables admitted by its activitytypecode conditions (every table when
 * it has none), its first order, and the conditions on other columns, which the local timeline does not apply.
 */
export function timelineViewSelection(tree, tables, metadata) {
  const entity = descendants(tree, 'entity')[0];
  const conditions = descendants(entity, 'condition').filter((condition) => !condition.attrs.entityname);
  const typeConditions = conditions.filter((condition) => lower(condition.attrs.attribute) === 'activitytypecode');
  let admitted = tables;
  for (const condition of typeConditions) {
    const operator = lower(condition.attrs.operator);
    const values = [
      ...(condition.attrs.value == null ? [] : [condition.attrs.value]),
      ...descendants(condition, 'value').map((value) => value.text),
    ];
    const matches = (table) => values.some((value) => typeMatches(value, table.logicalName, metadata));
    if (operator === 'in' || operator === 'eq') admitted = admitted.filter(matches);
    else if (operator === 'not-in' || operator === 'ne' || operator === 'neq')
      admitted = admitted.filter((table) => !matches(table));
  }
  const order = descendants(entity, 'order')[0];
  return {
    tables: admitted,
    order: order?.attrs.attribute
      ? { attribute: lower(order.attrs.attribute), descending: lower(order.attrs.descending) === 'true' }
      : null,
    unapplied: conditions
      .filter((condition) => lower(condition.attrs.attribute) !== 'activitytypecode')
      .map((condition) => condition.attrs.attribute),
    linked: descendants(entity, 'link-entity').length > 0,
  };
}

/** A custom table: a publisher-prefixed logical name that is not a standard table (only the diagnostic uses it). */
export const customTable = (logical) => lower(logical).includes('_') && !standardTableDef(logical);
