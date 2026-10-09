export default {
  id: 'example',
  name: 'Example project',
  description: 'Invented contact data owned by the example project',
  matches: ({ portal }) => portal?.website?.name === 'Example portal',
  presets: () => ({
    'example-demo': {
      name: 'Example demo', description: 'One invented local contact',
      mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid' } },
      tables: { contact: [{ contactid: '11111111-1111-4111-8111-111111111111', fullname: 'Alex Example' }] },
      permissions: [{ entity: 'contact', scope: 'global', operations: ['read'], roles: ['Authenticated Users'] }],
    },
  }),
  generators: {}, personas: [], plugins: [],
};
