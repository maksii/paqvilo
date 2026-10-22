// Example setups for the /_setup/ create flow. Every name is invented and every origin is an example.test
// placeholder, so the expected findings (placeholder-origin, missing-source, missing-solution) are the next steps
// the user completes after creating the file: select real folders and replace the placeholder origin.
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const DEFAULTS = { id: 'invented-portal', root: '' };

function values(input = {}) {
  const id = input.id ?? DEFAULTS.id, root = input.root ?? DEFAULTS.root;
  if (typeof id !== 'string' || !ID.test(id)) throw Object.assign(new Error('Target name must be 1-63 letters, numbers or hyphens.'), { status: 400 });
  if (typeof root !== 'string' || root.length > 1024 || /[\x00-\x1f\x7f]/.test(root)) throw Object.assign(new Error('Source folder must be a path without control characters.'), { status: 400 });
  return { id, root: root.trim() };
}

const portalOrigin = id => `https://${id.toLowerCase()}.example.test`;
const storageAndServices = () => ({
  providers: {
    storage: { 'invented-disk': { kind: 'local-disk' } },
    routes: { dataverseFiles: 'invented-disk', annotations: 'invented-disk' },
    messaging: { 'invented-bus': { kind: 'local-queue' }, endpoints: { 'x-invented-endpoint': 'invented-bus/x_invented_queue' } },
    outbox: { kind: 'local' },
  },
  connections: { 'invented-fixture': { provider: 'fixture', evidence: 'Invented local fixture; replace with your connection id.' } },
  secrets: { 'invented-vault/api-key': { source: 'environment', variable: 'INVENTED_API_KEY' } },
  localServices: { 'invented-api': { kind: 'http', baseUrl: 'http://127.0.0.1:7071', probe: '/health', description: 'Invented loopback service; probed, never started.' } },
  deploymentProfiles: { default: 'test', profiles: { test: { environmentVariables: './profiles/test-environment-variables.json' } } },
  dataverse: { enabled: true, port: 0 },
  simulation: { level: 'dry-run' },
});

const TEMPLATES = [
  { id: 'power-pages', title: 'Power Pages portal', surfaces: ['power-pages'],
    description: 'One portal export served locally, with a placeholder live environment for Lense.',
    nextSteps: ['Select the portal export folder.', 'Replace the example.test origin with the environment you may use, or a loopback origin.', 'Register a data pack when the portal needs data.'],
    catalogue: ({ id, root }) => ({ sourceRoot: '.', defaultSite: id, portals: 'selected',
      sites: { [id]: { source: root || './portal-export', defaultEnv: 'dev', environments: { dev: portalOrigin(id) }, mirage: { port: 0, simulation: { level: 'simulation' } } } } }),
    project: ({ id, root }) => ({ version: 2, defaultPortal: id, portals: [{ id, path: root || './portal-export', origin: portalOrigin(id) }], solutions: [], simulation: { level: 'simulation' } }),
    expected: ['missing-source', 'placeholder-origin'] },
  { id: 'model-driven', title: 'Model-driven app project', surfaces: ['model-driven'],
    description: 'Model-driven apps from Solution exports; no portal export is needed.',
    nextSteps: ['Select the Solution export folder.', 'Choose the default app after the first start.', 'Trust model-driven extensions only for code you own.'],
    catalogue: ({ id, root }) => ({ sourceRoot: '.', defaultSite: id,
      sites: { [id]: { mirage: { port: 0, runtime: { kind: 'model-driven' }, simulation: { level: 'dry-run' }, solutionRoots: [root || './solutions/x_core'], modelDriven: { trustedExtensions: false } } } } }),
    project: ({ root }) => ({ version: 2, runtime: { kind: 'model-driven' }, simulation: { level: 'dry-run' }, solutions: [{ id: 'x-core', path: root || './solutions/x_core' }], modelDriven: { trustedExtensions: false } }),
    expected: ['missing-solution'] },
  { id: 'dataverse-api', title: 'Dataverse API only', surfaces: ['dataverse-api'],
    description: 'The simulated Dataverse Web API for clients and tests, built from Solution exports.',
    nextSteps: ['Select the Solution export folder.', 'Register an application in Administration, then point your client at the local API.'],
    catalogue: ({ id, root }) => ({ sourceRoot: '.', defaultSite: id,
      sites: { [id]: { mirage: { port: 0, runtime: { kind: 'dataverse-api' }, simulation: { level: 'dry-run' }, solutionRoots: [root || './solutions/x_core'], dataverse: { enabled: true, port: 0 } } } } }),
    project: ({ root }) => ({ version: 2, runtime: { kind: 'dataverse-api' }, simulation: { level: 'dry-run' }, solutions: [{ id: 'x-core', path: root || './solutions/x_core' }], dataverse: { enabled: true, port: 0 } }),
    expected: ['missing-solution'] },
  { id: 'full-stack', title: 'Full stack sample', surfaces: ['power-pages', 'dataverse-api'],
    description: 'A portal with the Dataverse API, storage routes, a local message queue, the outbox, a fixture connection, secret references by environment variable, a declared loopback service and a deployment profile.',
    nextSteps: ['Select the portal export folder.', 'Replace the example.test origin.', 'Set INVENTED_API_KEY in your shell before starting; configuration only names the variable.', 'Start the declared loopback service yourself; Paqvilo probes it and never starts it.', 'Create the deployment profile file or remove the profile.'],
    catalogue: ({ id, root }) => ({ sourceRoot: '.', defaultSite: id, portals: 'selected',
      sites: { [id]: { source: root || './portal-export', defaultEnv: 'dev', environments: { dev: portalOrigin(id) },
        mirage: { port: 0, ...storageAndServices(), personaContexts: { maxInstances: 4 } } } } }),
    // personaContexts is a catalogue-only setting; a project file keeps every other piece.
    project: ({ id, root }) => ({ version: 2, defaultPortal: id, portals: [{ id, path: root || './portal-export', origin: portalOrigin(id) }], solutions: [], ...storageAndServices() }),
    expected: ['missing-source', 'placeholder-origin'] },
];

/** The document of template `id` for a `kind` file, rendered with the target name and source folder. */
export function renderTemplate(kind, id, input) {
  const template = TEMPLATES.find(item => item.id === id);
  if (!template) throw Object.assign(new Error(`Unknown setup template '${String(id).slice(0, 64)}'.`), { status: 400 });
  return template[kind === 'project' ? 'project' : 'catalogue'](values(input));
}

/** Templates for a `catalogue` or `project` setup session, rendered with the default invented values. */
export function setupTemplates(kind = 'catalogue') {
  return TEMPLATES.map(({ id, title, description, surfaces, nextSteps, expected }) => ({
    id, title, description, surfaces, document: renderTemplate(kind, id), expectedFindings: [...expected], nextSteps: [...nextSteps],
  }));
}
