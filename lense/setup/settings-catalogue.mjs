// Guided setting reference for /_setup/: every catalogue, site and project key with its scope, help, kind,
// an invented YAML example and the setup stage (1..10, docs/setup.md journey) that configures it.
// Mirage keys take doc/contract/redact from mirage/lib/config-keys.mjs, the one registration point.
import { MIRAGE_SETTINGS, pendingSettingParsers } from '../../mirage/lib/config-keys.mjs';
import '../../mirage/lib/provider-modules.mjs';

// Choices mirror the choice([...]) parsers and enum checks; test/setup-settings-catalogue.test.mjs proves each
// one is accepted and a foreign value rejected, so a parser change fails the test instead of drifting.
const MIRAGE = {
  project: { kind: 'string', stage: 1, example: 'project: ./mirage.project.yml\n' },
  solutionRoots: { kind: 'list', stage: 3, example: 'solutionRoots:\n  - ./solutions/x_core\n' },
  solutionOrder: { kind: 'choice', choices: ['derived', 'explicit'], stage: 3, example: 'solutionOrder: derived\n' },
  dataPacks: { kind: 'list', stage: 5, example: 'dataPacks:\n  - id: invented-pack\n    module: ./pack/pack.mjs\n' },
  connectorScripts: { kind: 'list', stage: 8, example: 'connectorScripts:\n  - connector: x_5finventedapi\n    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"\n' },
  port: { kind: 'number', stage: 10, example: 'port: 0\n' },
  preset: { kind: 'string', stage: 6, example: 'preset: invented-starter\n' },
  presetMode: { kind: 'choice', choices: ['bootstrap', 'always'], stage: 6, example: 'presetMode: bootstrap\n' },
  presetConfiguration: { kind: 'choice', choices: ['data-only', 'apply'], stage: 6, example: 'presetConfiguration: data-only\n' },
  confinePortalPages: { kind: 'boolean', stage: 2, example: 'confinePortalPages: true\n' },
  externalAssets: { kind: 'boolean', stage: 2, example: 'externalAssets: false\n' },
  externalFrameOrigins: { kind: 'list', stage: 2, example: 'externalFrameOrigins:\n  - https://media.example.test\n' },
  observed: { kind: 'object', stage: 3, example: 'observed:\n  loginPath: /SignIn\n  evidence: Invented capture note, 2026-01-01\n' },
  dataModel: { kind: 'choice', choices: ['standard', 'enhanced'], stage: 3, example: 'dataModel: enhanced\n' },
  compat: { kind: 'object', stage: 2, example: 'compat:\n  footerSpacing: false\n' },
  head: { kind: 'object', stage: 2, example: 'head:\n  stylesheets:\n    - ./local/invented-theme.css\n' },
  render: { kind: 'object', stage: 7, example: 'render:\n  timeLimitMs: 60000\n' },
  personaContexts: { kind: 'object', stage: 6, example: 'personaContexts:\n  maxInstances: 4\n' },
  identityProvider: { kind: 'object', stage: 9, choices: ['page', 'dialog'], example: 'identityProvider:\n  presentation: dialog\n  title: Invented local sign-in\n' },
  deploymentProfiles: { kind: 'object', stage: 8, example: 'deploymentProfiles:\n  default: test\n  profiles:\n    test:\n      environmentVariables: ./profiles/test-environment-variables.json\n' },
  platform: { kind: 'object', stage: 7, example: 'platform:\n  QueryLinkEntityLimit: 15\n  evidence: Invented support note\n' },
  dataverse: { kind: 'object', stage: 9, example: 'dataverse:\n  enabled: true\n  port: 0\n  users:\n    - domainname: invented.user@example.test\n      fullname: Invented User\n' },
  runtime: { kind: 'object', stage: 2, choices: ['power-pages', 'model-driven', 'dataverse-api'], example: 'runtime:\n  kind: model-driven\n' },
  simulation: { kind: 'object', stage: 7, choices: ['dry-run', 'simulation', 'deep'], example: 'simulation:\n  level: dry-run\n' },
  modelDriven: { kind: 'object', stage: 2, example: 'modelDriven:\n  trustedExtensions: false\n  clientSources:\n    - ./client/x_invented\n' },
  environmentVariables: { kind: 'object', stage: 8, example: 'environmentVariables:\n  x_InventedFeatureFlag: "true"\n' },
  connections: { kind: 'object', stage: 8, example: 'connections:\n  invented-fixture:\n    provider: fixture\n    evidence: Invented local fixture\n' },
  secrets: { kind: 'object', stage: 8, example: 'secrets:\n  invented-vault/api-key:\n    source: environment\n    variable: INVENTED_API_KEY\n' },
  localServices: { kind: 'object', stage: 8, example: 'localServices:\n  invented-api:\n    kind: http\n    baseUrl: http://127.0.0.1:7071\n    probe: /health\n' },
  providers: { kind: 'object', stage: 8, example: 'providers:\n  storage:\n    invented-disk:\n      kind: local-disk\n  routes:\n    dataverseFiles: invented-disk\n    annotations: invented-disk\n  messaging:\n    invented-bus:\n      kind: local-queue\n    endpoints:\n      x-invented-endpoint: invented-bus/x_invented_queue\n  outbox:\n    kind: local\n' },
  canvas: { kind: 'object', stage: 2, example: 'canvas:\n  enabled: true\n  sources:\n    - ./canvas/x_invented\n' },
  codeApps: { kind: 'list', stage: 2, example: 'codeApps:\n  - name: invented-app\n    dir: ./code-apps/invented\n' },
};
// A secret-bearing member of a non-redacted key: the application secret is an environment variable name.
// What a reference looks like for each references-only key (secret-resolver.mjs, connector-runtime.mjs, dataverse-api.md).
const REDACT_HELP = {
  secrets: 'References only: each <vault>/<secret> entry names an environment variable (variable: NAME) or carries source: protected with a protectedValue written by the secrets CLI. Validation refuses value and secret fields.',
  connections: 'References only: a connection names its provider (and connector or principal); settings accept only rewrites of URL prefixes to local URL prefixes, without credentials. Secret values never belong here.',
  'dataverse.applications': 'References only: secretEnvironmentVariable names the environment variable holding the client secret; never paste the secret.',
};
const DATAVERSE_APPLICATIONS = { key: 'dataverse.applications', kind: 'list', stage: 9, redact: true, redactHelp: REDACT_HELP['dataverse.applications'],
  doc: 'App registrations of the simulated Dataverse API; the client secret comes from secretEnvironmentVariable, never from configuration.',
  contract: 'mirage/docs/dataverse-api.md',
  example: 'dataverse:\n  applications:\n    - appId: 00000000-0000-4000-8000-000000000001\n      displayName: Invented client\n      secretEnvironmentVariable: INVENTED_CLIENT_SECRET\n' };

const ROOT = [
  ['sourceRoot', 'string', 3, 'Folder that site sources resolve from, relative to the catalogue.', 'sourceRoot: ../invented-checkout\n'],
  ['defaultSite', 'string', 3, 'Site used when a command names none.', 'defaultSite: invented-portal\n'],
  ['portals', 'choice', 4, 'selected starts the default site; all starts every site.', 'portals: selected\n', ['selected', 'all']],
  ['includeCaution', 'boolean', 4, 'Include real-data (caution) environments in all-target commands.', 'includeCaution: false\n'],
  ['browser.channel', 'string', 10, 'Browser channel for Lense, such as msedge or chrome.', 'browser:\n  channel: msedge\n'],
  ['browser.headless', 'boolean', 10, 'Run the Lense browser without a window.', 'browser:\n  headless: false\n'],
  ['browser.profileDir', 'string', 10, 'Folder for Lense-owned browser profiles.', 'browser:\n  profileDir: .paqvilo/profiles\n'],
  ['browser.profile', 'string', 10, 'Named Lense-owned profile.', 'browser:\n  profile: invented-work\n'],
  ['browser.userDataDir', 'string', 10, 'Existing browser user data folder to reuse.', 'browser:\n  userDataDir: ./invented-user-data\n'],
  ['browser.profileDirectory', 'string', 10, 'Profile folder name inside userDataDir.', 'browser:\n  profileDirectory: Default\n'],
  ['browser.cdpUrl', 'string', 10, 'Attach to a running browser through its DevTools endpoint.', 'browser:\n  cdpUrl: http://127.0.0.1:9222\n'],
  ['browser.debugPort', 'number', 10, 'Remote debugging port of the owned browser (0 = off).', 'browser:\n  debugPort: 0\n'],
  ['browser.bypassCSP', 'boolean', 10, 'Let Lense bypass the page content security policy.', 'browser:\n  bypassCSP: false\n'],
  ['agent.enabled', 'boolean', 10, 'Expose the bounded Lense agent API.', 'agent:\n  enabled: false\n'],
  ['liveReload', 'boolean', 10, 'Reload the page after a local source edit.', 'liveReload: true\n'],
  ['panel', 'boolean', 10, 'Show the Lense panel on the page.', 'panel: true\n'],
  ['editor', 'string', 10, 'Editor command used by "open in editor".', 'editor: code\n'],
  ['sourceMaps', 'boolean', 10, 'Map overlaid resources back to source files.', 'sourceMaps: true\n'],
  ['defaults', 'object', 2, 'Settings every site inherits; a site value wins.', 'defaults:\n  mirage:\n    simulation:\n      level: dry-run\n'],
  ['sites', 'object', 3, 'Targets by id.', 'sites:\n  invented-portal:\n    source: ./portal-export\n'],
];
const SITE = [
  ['source', 'string', 3, 'Portal export folder, relative to sourceRoot.', 'source: ./portal-export\n'],
  ['defaultEnv', 'string', 4, 'Environment used when a command names none.', 'defaultEnv: dev\n'],
  ['environments', 'object', 4, 'Live origins by name; caution marks real data.', 'environments:\n  dev:\n    url: https://invented-portal.example.test\n    caution: false\n'],
  ['startPath', 'string', 4, 'First page Lense opens.', 'startPath: /\n'],
  ['webFiles', 'object', 3, 'Web file overlay switches.', 'webFiles:\n  enabled: true\n'],
  ['inline', 'object', 3, 'Inline block overlay switches.', 'inline:\n  enabled: true\n'],
  ['markup', 'object', 3, 'Markup overlay switches.', 'markup:\n  enabled: true\n'],
  ['scope', 'choice', 4, 'all overlays every resource; changed only the edited ones.', 'scope: changed\n', ['all', 'changed']],
  ['routes', 'list', 3, 'Route rules mapping URL paths to local files or folders.', 'routes:\n  - url: /assets/**\n    dir: web-files\n'],
];
const PROJECT = [
  ['version', 'number', 1, 'Project file version (2 accepts every current key).', 'version: 2\n'],
  ['defaultPortal', 'string', 3, 'Portal used when a command names none.', 'defaultPortal: invented-portal\n'],
  ['portals', 'list', 3, 'Portal exports with optional origin, solutions and per-portal settings.', 'portals:\n  - id: invented-portal\n    path: ./portal-export\n    origin: https://invented-portal.example.test\n'],
  ['solutions', 'list', 3, 'Solution export folders by id.', 'solutions:\n  - id: x-core\n    path: ./solutions/x_core\n'],
  ['references', 'list', 4, 'Live reference origins for read-only comparison.', 'references:\n  - id: dev\n    origin: https://invented-portal.example.test\n'],
  ['presets', 'list', 5, 'Legacy name of dataPacks.', 'presets:\n  - ./pack/pack.mjs\n'],
  ['lcid', 'number', 7, 'Locale id of the simulated organization.', 'lcid: 1033\n'],
  ['watch', 'boolean', 10, 'Reload when sources change.', 'watch: true\n'],
  ['stateDirectory', 'string', 7, 'Folder for local runtime state.', 'stateDirectory: .paqvilo/state\n'],
];

const row = ([key, kind, stage, doc, example, choices], scope) => ({ key, scope, doc, contract: null, pending: false, redact: false, kind, ...(choices ? { choices } : {}), example, stage });
function mirageEntry(key, scope) {
  const setting = MIRAGE_SETTINGS[key], meta = MIRAGE[key];
  return { key, scope, doc: setting.doc, contract: setting.contract ?? null, pending: pendingSettingParsers().includes(key),
    redact: Boolean(setting.redact) || key === 'connections', ...(REDACT_HELP[key] ? { redactHelp: REDACT_HELP[key] } : {}), kind: meta.kind, ...(meta.choices ? { choices: meta.choices } : {}), example: meta.example, stage: meta.stage };
}

/**
 * Keys a setup session of `kind` can edit. scope: catalogue (root), site (sites.<id> or sites.<id>.mirage),
 * project (project file; for a catalogue the linked sites.<id>.mirage.project file) or portal (project portals[]).
 */
export function settingsCatalogue(kind = 'catalogue') {
  const keys = Object.keys(MIRAGE_SETTINGS);
  if (kind === 'project') return [
    ...PROJECT.map(item => row(item, 'project')),
    ...keys.filter(key => MIRAGE_SETTINGS[key].scopes.includes('project')).map(key => mirageEntry(key, 'project')),
    ...keys.filter(key => !MIRAGE_SETTINGS[key].scopes.includes('project') && MIRAGE_SETTINGS[key].scopes.includes('portal')).map(key => mirageEntry(key, 'portal')),
    { ...DATAVERSE_APPLICATIONS, scope: 'project', pending: false },
  ];
  return [
    ...ROOT.map(item => row(item, 'catalogue')),
    ...SITE.map(item => row(item, 'site')),
    ...keys.filter(key => MIRAGE_SETTINGS[key].scopes.includes('catalogue')).map(key => mirageEntry(key, 'site')),
    // Project-only keys of a catalogue site live in its linked project file (layer project:<site>).
    ...keys.filter(key => !MIRAGE_SETTINGS[key].scopes.includes('catalogue')).map(key => mirageEntry(key, 'project')),
    { ...DATAVERSE_APPLICATIONS, scope: 'site', pending: false },
  ];
}
