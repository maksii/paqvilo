import { DataStore } from '../../lib/data.mjs';

export const user = '10000000-0000-0000-0000-000000000001';
export const existing = '20000000-0000-0000-0000-000000000001';

export function storeFixture() {
  return new DataStore({
    state: {
      version: 1,
      mappings: {
        widget: { entitySet: 'widgets', idColumn: 'widgetid' },
        child: { entitySet: 'children', idColumn: 'childid' },
      },
      tables: { widget: [{ widgetid: existing, title: 'Existing' }], child: [] },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'permissive' },
    },
  });
}
