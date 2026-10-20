import { defaultManagementApp, powerPagesTables } from './power-pages.mjs';

/** Optional source provider. A solution-only runtime never constructs this provider. */
export function powerPagesProvider(portal, metadata) {
  if (!portal) return null;
  const app = defaultManagementApp(portal);
  return { id: 'power-pages', apps: [app], defaultApp: app.id, tables: powerPagesTables(portal, metadata) };
}
