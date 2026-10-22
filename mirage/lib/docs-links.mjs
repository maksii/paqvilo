// Documentation links shared by the setup workspace and `/_sim/`: repository paths plus a GitHub
// link pinned to the installed release tag (`v<version>`) when the version is a plain release;
// prerelease builds link to `main` because no tag of their own exists for the installed copy.
const DOCS = Object.freeze({
  setup: 'docs/getting-started.md',
  gettingStarted: 'docs/getting-started.md',
  setupWorkspace: 'docs/setup.md',
  configuration: 'docs/configuration.md',
  sources: 'docs/project-extensions.md',
  projectExtensions: 'docs/project-extensions.md',
  projectScaffold: 'docs/project-scaffold.md',
  lense: 'docs/lense.md',
  architecture: 'docs/architecture.md',
  publicApi: 'docs/public-api.md',
  mirage: 'mirage/README.md',
  packs: 'mirage/docs/data-packs.md',
  simulation: 'mirage/docs/simulation-levels.md',
  identity: 'mirage/docs/dataverse-api.md',
  dataverseApi: 'mirage/docs/dataverse-api.md',
  simAdministration: 'mirage/docs/sim-administration.md',
  personaCatalog: 'mirage/docs/persona-catalog.md',
  standaloneOrganization: 'mirage/docs/standalone-organization.md',
  platformStack: 'mirage/docs/platform-stack.md',
  capabilities: 'mirage/docs/capabilities-and-preflight.md',
  storageProviders: 'mirage/docs/storage-providers.md',
  messaging: 'mirage/docs/messaging-and-outbox.md',
  serviceFixtures: 'mirage/docs/service-fixtures.md',
  operations: 'mirage/docs/operations.md',
  deploymentProfiles: 'mirage/docs/deployment-profiles.md',
  configurationExperiments: 'mirage/docs/configuration-experiments.md',
  runtimeEvidence: 'mirage/docs/runtime-evidence.md',
  modelDrivenApps: 'mirage/docs/model-driven-apps.md',
  canvasApps: 'mirage/docs/canvas-apps.md',
  codeApps: 'mirage/docs/code-apps.md',
  sharepoint: 'mirage/docs/sharepoint.md',
  dataversePlugins: 'mirage/docs/dataverse-plugins.md',
  dataverseContractModules: 'mirage/docs/dataverse-contract-modules.md',
  stateStorage: 'mirage/docs/state-storage.md',
  bootstrap: 'mirage/docs/bootstrap-and-sources.md',
  runtimePerformance: 'mirage/docs/runtime-performance.md',
});

const label = path => path.split('/').pop().replace(/\.md$/, '').split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
const plainRelease = version => /^\d+\.\d+\.\d+$/.test(version ?? '');

/** @returns {Record<string, { href: string, path: string, label: string }>} */
export function docsLinks(version, repositoryUrl) {
  const repository = String(repositoryUrl ?? '').replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/$/, '');
  const base = repository ? `${repository}/blob/${plainRelease(version) ? `v${version}` : 'main'}/` : '';
  return Object.fromEntries(Object.entries(DOCS).map(([key, path]) => [key, { href: base ? base + path : null, path, label: label(path) }]));
}

export const DOC_PATHS = DOCS;
