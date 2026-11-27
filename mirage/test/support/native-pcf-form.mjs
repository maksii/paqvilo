// The invented basic form of the native-field PCF unit tests: create form `create` of table `synthetic`, one
// field-component metadata row per field definition, an empty store and the test's code component renderer.
import { renderComponent } from '../../lib/platform.mjs';

/** Renders the form with `fields` (the schema fields) and the metadata rows of `definitions`. */
export function renderSyntheticCreateForm(definitions, fields, codeComponent) {
  return renderComponent(
    'entityform',
    'create',
    {},
    {
      portal: {
        forms: [{ id: 'create', name: 'Create synthetic row', mode: 100000000 }],
        records: definitions.map((field) => ({
          kind: 'basicformmetadata',
          adx_entityform: 'create',
          adx_attributelogicalname: field.name,
          adx_type: 100000000,
          adx_controlstyle: 756150001,
        })),
        pages: [],
        website: { id: 'site' },
      },
      schemas: { create: { entity: 'synthetic', fields } },
      store: {
        resolveMapping: () => ({ entitySet: 'synthetics', idColumn: 'syntheticid' }),
        query: () => ({ value: [] }),
      },
      codeComponent,
    },
  );
}
