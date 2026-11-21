/** Record kinds of the portal source as a developer names them; any other kind is listed by its own name. */
const NAMES = {
  website: 'the website record',
  websitelanguage: 'website languages',
  webpage: 'web pages',
  webtemplate: 'web templates',
  pagetemplate: 'page templates',
  webfile: 'web files',
  webrole: 'web roles',
  tablepermission: 'table permissions',
  sitesetting: 'site settings',
  sitemarker: 'site markers',
  contentsnippet: 'content snippets',
  publishingstate: 'publishing states',
  basicform: 'basic forms',
  basicformmetadata: 'basic form metadata',
  list: 'lists',
  serverlogic: 'server logic',
  cloudflowconsumer: 'cloud flow consumers',
};

const byKind = (portal) => {
  const counts = new Map();
  for (const record of portal?.records ?? []) counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1);
  return counts;
};

/**
 * What a source reload lost as a whole: every kind of portal record the previous revision had and the new one has none
 * of (every web template, every table permission, the website record). The portal source is whatever is on disk, so
 * such a reload is accepted; but a whole kind disappearing is what a folder deleted or moved by mistake looks like,
 * and nothing else would tell the developer why pages changed. Returns one warning diagnostic, or null.
 */
export function portalSourceLoss(previous, next) {
  if (!previous || !next) return null;
  const now = byKind(next);
  const removed = [...byKind(previous)]
    .filter(([kind]) => kind && !now.has(kind))
    .map(([kind, count]) => ({ kind, name: NAMES[kind] ?? kind, count }));
  if (!removed.length) return null;
  const list = removed.map(({ kind, name, count }) => (kind === 'website' ? name : `${name} (${count})`)).join(', ');
  return {
    code: 'PORTAL_SOURCE_REMOVED',
    severity: 'warning',
    removed,
    message: `This reload found none of these portal sources, which the previous revision had: ${list}. The portal is now served without them. If they were deleted or moved by mistake, put them back: the next reload reads them again.`,
  };
}
