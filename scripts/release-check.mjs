// Audit the distributable file list without creating an archive or contacting a registry.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const DOCUMENTATION_ASSETS = new Set([
  'docs/assets/overview.svg',
  'docs/assets/lense-icon.png',
  'docs/assets/mirage-icon.png',
  'docs/assets/lense-visual.png',
  'docs/assets/mirage-visual.png',
]);

const SAMPLE_COMPONENT_LICENSE =
  'examples/project/code-solution/Controls/exa_ExamplePages.ExampleLinearInput/bundle.js.LICENSE.txt';
const MODEL_DRIVEN_FILES = new Set(
  [
    'app.mjs',
    'client-runtime.mjs',
    'pcf-runtime.mjs',
    'catalogue.mjs',
    'offline.mjs',
    'control-descriptors.mjs',
    'controls.mjs',
    'controls.css',
    'choice-control.mjs',
    'date-control.mjs',
    'date-control.css',
    'duration-control.mjs',
    'duration-control.css',
    'lookup-control.mjs',
    'lookup-dialog.mjs',
    'data.mjs',
    'http.mjs',
    'icons.mjs',
    'index.html',
    'power-pages.mjs',
    'providers.mjs',
    'solution.mjs',
    'view-prerequisites.mjs',
    'style.css',
  ].map((name) => `mirage/lib/model-driven/${name}`),
);
// Reusable campaign sources only. Native recordings, configuration snapshots,
// bridge credentials and local invocation manifests stay outside the package.
const COMPANY_QUALIFICATION_SOURCES = new Set(
  [
    'forms/delta.mjs',
    'portal-harness/batch-capture.mjs',
    'portal-harness/native-batch-prototype.mjs',
    'portal-harness/native-browser.mjs',
    'portal-harness/native-capture.mjs',
    'portal-harness/native-prototype.mjs',
    'portal-harness/native-profile.mjs',
    'portal-harness/native-paging.mjs',
    'portal-harness/native-archive.mjs',
    'portal-harness/native-profile-comparison.mjs',
    'test/native-profile-comparison.test.mjs',
    'portal-harness/native-history.mjs',
    'test/native-history.test.mjs',
    'portal-harness/native-campaign.mjs',
    'test/native-campaign.test.mjs',
    'portal-harness/native-mask-window.mjs',
    'test/native-mask-window.test.mjs',
    'portal-harness/native-auth-cohort.mjs',
    'test/native-auth-cohort.test.mjs',
    'portal-harness/native-visibility-lease.mjs',
    'test/native-visibility-lease.test.mjs',
    'portal-harness/private-journal.mjs',
    'test/private-journal.test.mjs',
    'portal-harness/mirage-webapi-replay.mjs',
    'test/mirage-webapi-replay.test.mjs',
    'portal-harness/mirage-liquid-replay.mjs',
    'test/mirage-liquid-replay.test.mjs',
    'portal-harness/mirage-campaign-replay.mjs',
    'test/mirage-campaign-replay.test.mjs',
    'portal-harness/mirage-replay-shards.mjs',
    'test/mirage-replay-shards.test.mjs',
    'portal-harness/mirage-role-replay.mjs',
    'test/mirage-role-replay.test.mjs',
    'portal-harness/metadata-envelope.mjs',
    'test/metadata-envelope.test.mjs',
    'portal-harness/native-registry.mjs',
    'portal-harness/native-role-lease.mjs',
    'portal-security/qualification-domain.mjs',
    'portal-security/qualification-plan.mjs',
    'portal-security/permission-order.mjs',
    'portal-security/permission-order-plan.mjs',
    'portal-security/permission-order-disambiguator.mjs',
    'portal-security/qualification-lease.mjs',
    'portal-security/qualification-priority.mjs',
    'portal-security/qualification-campaign.mjs',
    'test/qualification-campaign.test.mjs',
    'portal-security/qualification-native-adapters.mjs',
    'test/qualification-native-adapters.test.mjs',
    'portal-security/qualification-actor-lease.mjs',
    'test/qualification-actor-lease.test.mjs',
    'portal-security/qualification-endpoints.mjs',
    'test/qualification-endpoints.test.mjs',
    'portal-security/odata-admission-cohorts.mjs',
    'test/odata-admission-cohorts.test.mjs',
    'portal-security/qualification-fixtures.mjs',
    'portal-security/count-limit-fixtures.mjs',
    'test/count-limit-fixtures.test.mjs',
    'portal-security/odata-permission-model.mjs',
    'portal-security/odata-permission-diagnostic.mjs',
    'portal-harness/odata-probes.mjs',
    'portal-harness/query-drop-probes.mjs',
    'test/query-drop-probes.test.mjs',
    'portal-harness/query-budget-probes.mjs',
    'test/query-budget-probes.test.mjs',
    'portal-harness/query-drop-flags.mjs',
    'test/query-drop-flags.test.mjs',
    'plugins/mirage-runtime.mjs',
    'plugins/test/mirage-runtime.test.mjs',
    'plugins/test/collector-worker-lifecycle.test.mjs',
    'plugins/currency-observer-plan.mjs',
    'plugins/test/currency-observer-plan.test.mjs',
    'plugins/sdk-projection-probes.mjs',
    'plugins/test/sdk-projection-probes.test.mjs',
    'plugins/SdkProjectionDriver.cs',
    'plugins/SdkProbes/SdkProbes.csproj',
    'plugins/SdkProbes/packages.lock.json',
    'test/native-capture.test.mjs',
    'test/qualification-domain.test.mjs',
    'test/replay-role-combinations.test.mjs',
    'test/native-batch.test.mjs',
    'test/native-archive.test.mjs',
    'test/native-paging.test.mjs',
    'test/native-profile.test.mjs',
    'test/native-role-lease.test.mjs',
    'test/permission-order.test.mjs',
    'test/permission-order-disambiguator.test.mjs',
    'test/qualification-lease.test.mjs',
    'test/currency-reference.test.mjs',
    'test/odata-permission-model.test.mjs',
    'test/odata-probes.test.mjs',
  ].map((name) => `examples/company-operations/${name}`),
);

export const PROJECT_TEMPLATE_FILES = [
  'gitignore.template',
  'gitattributes.template',
  'editorconfig.template',
  'README.md',
  'AGENTS.md',
  'pack.mjs.template',
  'pack.test.mjs.template',
  'pack-README.md',
  'support-mirage.mjs.template',
  'no-pack.test.mjs.template',
  'test-browser.mjs.template',
  'smoke.test.mjs.template',
  'bootstrap.mjs.template',
  'support-site.mjs.template',
  'browser-reporter.mjs.template',
  'acceptance.md.template',
  'configuration.md',
  'configuration.example.yml',
  'data-lifecycle.md',
  'workflows.md',
].map((name) => `templates/project/${name}`);

export const REQUIRED_RELEASE_FILES = [
  'lense/model-driven.mjs',
  'lense/commands/model-driven.mjs',
  'lense/model-driven-panel.mjs',
  'lense/model-driven-native-comparison.mjs',
  'lense/model-driven-targets.mjs',
  'lense/owned-page-binding.mjs',
  'lense/model-driven-inspection.mjs',
  'lense/model-driven-inspector.mjs',
  'lense/model-driven-inspector-ui.mjs',
  'lense/model-driven-actions.mjs',
  'lense/model-driven-action-runner.mjs',
  'lense/model-driven-actions-ui.mjs',
  'lense/model-driven-identity.mjs',
  'lense/model-driven-commands.mjs',
  'docs/model-driven-actions.md',
  ...MODEL_DRIVEN_FILES,
  'mirage/docs/model-driven-apps.md',
  'lense/standalone-mirage.mjs',
  'lense/stop-command.mjs',
  'mirage/lib/standalone-runtime.mjs',
  'mirage/lib/dataverse-organization.mjs',
  'mirage/lib/runtime-config.mjs',
  'mirage/lib/simulation-settings.mjs',
  'mirage/lib/simulation-persistence.mjs',
  'mirage/lib/transactional-files.mjs',
  'mirage/lib/pack-data-files.mjs',
  'mirage/docs/standalone-organization.md',
  'mirage/docs/simulation-levels.md',
  'lense/commands/setup.mjs',
  'lense/setup/store.mjs',
  'lense/setup/server.mjs',
  'lense/setup/app.mjs',
  'lense/setup/index.html',
  'lense/setup/style.css',
  'lense/setup/quick.mjs',
  'lense/setup/preview.mjs',
  'lense/setup/preview-runner.mjs',
  'docs/setup.md',
  'lense/commands/init.mjs',
  'lense/project-scaffold.mjs',
  'lense/project-check.mjs',
  'lense/project-workflows.mjs',
  'lense/project-editor.mjs',
  'lense/scaffold.mjs',
  'lense/dev-messages.mjs',
  'docs/project-scaffold.md',
  ...PROJECT_TEMPLATE_FILES,
  'lense/dataverse/index.mjs',
  'lense/dataverse/cli.mjs',
  'lense/dataverse/connection.mjs',
  'lense/dataverse/client.mjs',
  'lense/dataverse/manifest.mjs',
  'lense/dataverse/provision.mjs',
  'lense/dataverse/data.mjs',
  'docs/dataverse-provisioning.md',
  'docs/design/company-operations-demo.md',
  'docs/design/power-pages-permission-test-harness.md',
  'docs/design/dataverse-plugin-observation.md',
  'docs/design/dataverse-api.md',
  'examples/company-operations/README.md',
  'examples/company-operations/package.json',
  'examples/company-operations/prepare-schema.mjs',
  'examples/company-operations/dataverse/manifest.json',
  'examples/company-operations/prepare-data.mjs',
  'examples/company-operations/data/catalogue.json',
  'examples/company-operations/prepare-stress-data.mjs',
  'examples/company-operations/data/stress-catalogue.json',
  'examples/company-operations/forms/catalogue.mjs',
  'examples/company-operations/forms/deploy.mjs',
  'examples/company-operations/forms/import-quickfind.mjs',
  'examples/company-operations/forms/update-quickfind.ps1',
  'examples/company-operations/portal-security/blueprint.mjs',
  'examples/company-operations/portal-security/deploy.mjs',
  'examples/company-operations/portal-security/reference-projections.mjs',
  'examples/company-operations/portal-security/package.mjs',
  'examples/company-operations/portal-harness/compile.mjs',
  'examples/company-operations/portal-harness/runtime.mjs',
  'examples/company-operations/portal-harness/deploy.mjs',
  'examples/company-operations/plugins/registration.mjs',
  'examples/company-operations/plugins/deploy.mjs',
  'examples/company-operations/plugins/Shared/Lab.cs',
  'examples/company-operations/plugins/Shared/Recording.cs',
  'examples/company-operations/plugins/QueryObservation/IncomingQueryObserver.cs',
  'examples/company-operations/plugins/PipelineTests/Pipeline.cs',
  'examples/company-operations/plugins/PipelineTests/Guards.cs',
  'package.json',
  'README.md',
  'CONTRIBUTING.md',
  'AGENTS.md',
  '.env.example',
  'paqvilo.config.yml',
  'npm-shrinkwrap.json',
  'bin/paqvilo.mjs',
  'lense/cli.mjs',
  'lense/commands/demo.mjs',
  'scripts/ensure-dependencies.mjs',
  'LICENSE',
  'NOTICE',
  'licenses/bootstrap.txt',
  'licenses/jquery.txt',
  'licenses/sql4cds.txt',
  'licenses/xrm-portals-community-edition.txt',
  'mirage/cli.mjs',
  'mirage/server.mjs',
  'mirage/lib/importer.mjs',
  'mirage/lib/project-config.mjs',
  'mirage/admin/index.html',
  'lense/source-inspection.mjs',
  'mirage/lib/code-components.mjs',
  'mirage/lib/code-components-client.js',
  'mirage/lib/exported-operations.mjs',
  'mirage/lib/exported-operation-worker.mjs',
  'mirage/lib/operation-catalogue.mjs',
  'mirage/lib/exported-plugins.mjs',
  'mirage/lib/liquid-source.mjs',
  'mirage/lib/plugin-clr.mjs',
  'mirage/lib/plugin-clr-worker.mjs',
  'mirage/lib/sync-io-bridge.mjs',
  'mirage/lib/sync-io-worker.mjs',
  'mirage/lib/plugin-clr-host.cs',
  'mirage/lib/plugin-async.mjs',
  'mirage/lib/plugin-query.mjs',
  'mirage/lib/plugin-sdk-query.mjs',
  'mirage/lib/plugin-response.mjs',
  'mirage/lib/flow-runtime.mjs',
  'mirage/lib/flow-triggers.mjs',
  'mirage/lib/committed-work.mjs',
  'mirage/lib/local-organization-service.mjs',
  'mirage/lib/bootstrap-plugins-compat.js',
  'mirage/lib/datetimepicker-compat.js',
  'mirage/lib/jqueryui-dialog-compat.js',
  'mirage/lib/date-format-compat.js',
  'mirage/lib/footer-spacing-compat.js',
  'mirage/lib/bootstrap-fonts/glyphicons-halflings-regular.woff2',
  'mirage/admin/app.mjs',
  'mirage/admin/style.css',
  'mirage/admin/persona-manager.mjs',
  'mirage/admin/persona-picker.mjs',
  'mirage/admin/persona-picker.css',
  'mirage/admin/ui-kit.mjs',
  'mirage/admin/ui-kit.css',
  'mirage/admin/shell.css',
  'mirage/admin/help-content.mjs',
  'mirage/admin/view-common.mjs',
  'mirage/admin/view-services.mjs',
  'mirage/admin/view-flows.mjs',
  'mirage/admin/view-capabilities.mjs',
  'mirage/admin/view-packs.mjs',
  'mirage/admin/dashboard-map.mjs',
  'mirage/admin/dashboard-icons.mjs',
  'mirage/admin/dashboard.css',
  'mirage/lib/persona-catalog.mjs',
  'mirage/lib/persona-search.mjs',
  'mirage/lib/persona-picker-view.mjs',
  'mirage/lib/persona-contexts.mjs',
  'mirage/lib/persona-context-settings.mjs',
  'mirage/testing/personas.mjs',
  'mirage/docs/persona-catalog.md',
  'mirage/package.json',
  'mirage/package-lock.json',
  'mirage/README.md',
  'mirage/docs/runtime-evidence.md',
  'mirage/docs/bootstrap-and-sources.md',
  'mirage/docs/dataverse-parity.md',
  'mirage/docs/sim-administration.md',
  'mirage/docs/toolkit-integration.md',
  'mirage/docs/data-packs.md',
  'mirage/docs/parity-evidence.md',
  'mirage/docs/README.md',
  'mirage/docs/forms-lists-parity.md',
  'mirage/docs/code-components.md',
  'mirage/docs/operations.md',
  'mirage/docs/dataverse-plugins.md',
  'mirage/testing/session.mjs',
  'docs/project-extensions.md',
  'docs/architecture.md',
  'docs/index.md',
  'docs/getting-started.md',
  'docs/demo.md',
  'docs/coverage.md',
  'docs/faq.md',
  ...DOCUMENTATION_ASSETS,
  'examples/project/pack/pack.mjs',
  'examples/project/AGENTS.md',
  'examples/project/test/portal.test.mjs',
  'examples/project/gitignore.template',
  'examples/project/gitattributes.template',
  'examples/project/editor-workspace.mjs',
  'mirage/api.mjs',
  'mirage/acceptance-api.mjs',
  'mirage/testing.mjs',
  'lense/api.mjs',
  'docs/public-api.md',
  'docs/release-notes.md',
  'docs/branch-packages.md',
  'examples/project/paqvilo.config.yml',
  'examples/project/portal/sitesetting.yml',
  'examples/project/portal/webrole.yml',
  'examples/project/paqvilo-demo.code-workspace',
  'examples/project/.vscode/tasks.json',
  'examples/project/.vscode/launch.json',
  'examples/project/portal/web-files/demo.css',
  'examples/project/portal/web-files/demo-workspace.js',
  'examples/project/portal/web-files/demo.css.webfile.yml',
  'examples/project/portal/web-files/demo-workspace.js.webfile.yml',
  'examples/project/pack/fixtures.json',
  'examples/project/solution/Entities/Account/Entity.xml',
  'examples/project/metadata/Other/Relationships.xml',
];
export function validateReleaseFiles(files) {
  const templates = new Set(PROJECT_TEMPLATE_FILES);
  const provisioningSources =
    /^examples\/company-operations\/(?:README\.md|package(?:-lock)?\.json|prepare-(?:schema|data|stress-data)\.mjs|dataverse\/manifest\.json|data\/(?:catalogue|stress-catalogue)\.json|data\/reconcile-seed-headers\.mjs|test\/(?:schema|data|stress|forms|portal-security|plugins)\.test\.mjs|forms\/(?:catalogue|deploy|import-quickfind)\.mjs|forms\/update-quickfind\.ps1|portal-security\/(?:README\.md|blueprint\.json|(?:blueprint|deploy|model-audit|role-variant|deep-variant|reference-projections|package|bind-tester|tester-overlay)\.mjs)|portal-harness\/(?:README\.md|(?:browser|parity)\.test\.mjs|(?:compile|core|deploy|runtime|test|browser-test|live-test|readiness|parity|compare-parity|replay|replay-parity)\.mjs)|plugins\/(?:README\.md|LabPublicSigning\.snk|(?:registrations|secure-provisioning)\.json|test\/(?:collector|registration)\.test\.mjs|(?:deploy|registration|inspect-metadata|inspect-trace|verify-live|upload-assemblies|prepare-registration|provision-owner-team|inspect-operation-errors|update-guard-config|audit-evidence|audit-installation)\.mjs|(?:PipelineTests|QueryObservation|Tests)\/(?:[A-Za-z]+\.(?:cs|csproj)|packages\.lock\.json)|Shared\/(?:Lab|Recording)\.cs|collector\/(?:[a-z-]+\.mjs|(?:deployment|flow-secret-contract)\.json)))$/;
  const designDocuments = new Set([
    'docs/design/company-operations-demo.md',
    'docs/design/power-pages-permission-test-harness.md',
    'docs/design/dataverse-plugin-observation.md',
    'docs/design/dataverse-api.md',
    'docs/design/hotfix-0.9.6.1-demo-review.md',
    'docs/design/hotfix-0.9.6.1-integration-review.md',
    'docs/design/hotfix-0.9.6.1-lifecycle-review.md',
    'docs/design/hotfix-0.9.6.1-runtime-review.md',
    'docs/design/hotfix-0.9.6.1.md',
  ]);
  const demoSources =
    /^examples\/project\/(?:portal|solution|code-solution|metadata|components|deployment)\/[a-zA-Z0-9/_.{}, +()-]+\.(?:yml|html|css|js|mjs|ts|xml|json|resx|md|sl|pcfproj|cdsproj)$/;
  const demoArtifacts = new Set([
    'examples/project/deployment/PaqviloDemoSample.zip',
    'examples/project/deployment/PaqviloDemoCodeComponents.zip',
    'examples/project/deployment/demo-data.zip',
  ]);
  const demoEditorFiles = new Set([
    'examples/project/AGENTS.md',
    'examples/project/paqvilo-demo.code-workspace',
    'examples/project/.vscode/tasks.json',
    'examples/project/.vscode/launch.json',
    'examples/project/gitattributes.template',
    'examples/project/.gitattributes',
    'examples/project/editor-workspace.mjs',
  ]);
  const demoPluginSources =
    /^examples\/project\/components\/DataversePlugins\/[A-Za-z0-9._-]+\.(?:cs|csproj|json|md|snk)$/;
  const demoPluginAssembly =
    /^examples\/project\/solution\/PluginAssemblies\/[A-Za-z0-9_.{} /-]*PaqviloDemoPlugins\.dll$/;
  const allowed =
    /^(?:package\.json|npm-shrinkwrap\.json|README\.md|CONTRIBUTING\.md|AGENTS\.md|LICENSE|NOTICE|licenses\/[a-z0-9-]+\.txt|\.env\.example|paqvilo\.config\.yml|bin\/paqvilo\.mjs|scripts\/ensure-dependencies\.mjs|lense\/[a-z0-9/-]+\.mjs|lense\/setup\/[a-z0-9-]+\.(?:html|css)|docs\/[a-z0-9-]+\.md|docs\/baseline\/[a-z0-9-]+\.md|examples\/project\/(?:README\.md|package\.json|paqvilo\.config\.yml|gitignore\.template|(?:pack|test)\/[a-z0-9.-]+\.mjs|portal\/[a-zA-Z0-9./_-]+\.(?:yml|html|css|js)|baseline\/(?:[a-z0-9-]+\.(?:mjs|json)|dataverse\/[a-zA-Z0-9/_.-]+\.(?:json|xml)|data\/catalogue\.json|site\/[a-zA-Z0-9./_ ,-]+\.(?:yml|html|css|js|png)|solution\/[a-zA-Z0-9/_.{}, +()*-]+\.(?:xml|json|yaml|xaml|dll|snk|js|css|html|resx)))|mirage\/(?:[a-z0-9-]+\.mjs|package(?:-lock)?\.json|README\.md|lib\/[a-z0-9-]+\.(?:mjs|js|css|json)|lib\/bootstrap-fonts\/(?:glyphicons-halflings-regular\.(?:eot|svg|ttf|woff2?)|LICENSE-bootstrap\.txt)|admin\/[a-z0-9-]+\.(?:html|mjs|css)|testing\/[a-z0-9-]+\.mjs|docs\/(?:README|[a-z0-9-]+)\.md|docs\/baseline\/[a-z0-9-]+\.md|docs\/baseline\/catalog\/[a-z0-9-]+\.json))$/;
  const paths = new Set(files.map((file) => file.path));
  // Allow only named product illustrations, never arbitrary screenshots or evidence.
  // npm masks GUIDs as *** in pack's JSON output; the archive retains the real filenames.
  for (const name of paths)
    if (
      !allowed.test(name) &&
      !MODEL_DRIVEN_FILES.has(name) &&
      !templates.has(name) &&
      !provisioningSources.test(name) &&
      !COMPANY_QUALIFICATION_SOURCES.has(name) &&
      !designDocuments.has(name) &&
      name !== 'mirage/lib/plugin-clr-host.cs' &&
      !demoSources.test(name.replaceAll('***', 'redacted-id')) &&
      !demoPluginSources.test(name) &&
      !demoPluginAssembly.test(name.replaceAll('***', 'redacted-id')) &&
      !demoArtifacts.has(name) &&
      !demoEditorFiles.has(name) &&
      name !== 'examples/project/pack/fixtures.json' &&
      name !== SAMPLE_COMPONENT_LICENSE &&
      !DOCUMENTATION_ASSETS.has(name)
    )
      throw new Error(`Unexpected release file: ${name}`);
  for (const name of REQUIRED_RELEASE_FILES)
    if (!paths.has(name)) throw new Error(`Required release file is missing: ${name}`);
  // npm redacts GUIDs in JSON, so distinct archive entries can share a path here.
  return files.length;
}

function checkEditorTasks(root) {
  const tasks = JSON.parse(fs.readFileSync(path.join(root, '.vscode/tasks.json'), 'utf8'));
  const launch = JSON.parse(fs.readFileSync(path.join(root, '.vscode/launch.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const labels = new Set(tasks.tasks.map((task) => task.label));
  if (labels.size !== tasks.tasks.length) throw new Error('Duplicate editor task labels');
  for (const task of tasks.tasks) {
    for (const dependency of [task.dependsOn ?? []].flat())
      if (!labels.has(dependency)) throw new Error(`Missing editor task: ${dependency}`);
    if (task.type === 'npm' && !pkg.scripts[task.script])
      throw new Error(`Missing npm script in editor task: ${task.script}`);
    if (
      task.command === 'node' &&
      task.args[0] !== '${workspaceFolder}/node_modules/paqvilo/bin/paqvilo.mjs' &&
      !fs.existsSync(path.resolve(root, task.args[0].replace('${workspaceFolder}', root)))
    )
      throw new Error(`Missing editor task program: ${task.args[0]}`);
  }
  for (const config of launch.configurations) {
    if (config.preLaunchTask && !labels.has(config.preLaunchTask))
      throw new Error(`Missing debugger task: ${config.preLaunchTask}`);
    if (config.program && !fs.existsSync(config.program.replace('${workspaceFolder}', root)))
      throw new Error(`Missing debugger program: ${config.program}`);
  }
}

export function checkDocumentation(root) {
  const names = ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md', 'mirage/README.md'];
  const visit = (directory) => {
    if (!fs.existsSync(path.join(root, directory))) return;
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ['node_modules', 'bin', 'obj', 'out', 'coverage'].includes(entry.name))
        continue;
      const name = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile() && name.endsWith('.md')) names.push(name);
    }
  };
  for (const directory of ['docs', 'mirage/docs', 'examples/project', 'examples/company-operations']) visit(directory);
  // Template-relative links are checked after generation by installed-package smoke.
  for (const name of names) {
    const text = fs.readFileSync(path.join(root, name), 'utf8');
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const localPath = decodeURIComponent(target.replace(/^<|>$/g, ''));
      if (!fs.existsSync(path.resolve(root, path.dirname(name), localPath)))
        throw new Error(`Broken documentation link in ${name}: ${target}`);
    }
  }
  for (const name of ['.env', 'paqvilo.config.local.yml']) {
    if (!fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes(name))
      throw new Error(`Personal state is not ignored: ${name}`);
  }
}

// npm provenance rejects a publish whose repository.url does not name the source repository.
export function checkPackageMetadata(pkg) {
  if (!/^git\+https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(pkg.repository?.url ?? ''))
    throw new Error('package.json repository.url must be git+https://github.com/<owner>/<repo>.git for npm provenance');
}

function checkLockConsistency(root) {
  const packageLock = fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8');
  const shrinkwrap = fs.readFileSync(path.join(root, 'npm-shrinkwrap.json'), 'utf8');
  if (packageLock !== shrinkwrap) throw new Error('npm-shrinkwrap.json must match package-lock.json');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    checkDocumentation(root);
    checkLockConsistency(root);
    checkPackageMetadata(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')));
    checkEditorTasks(root);
    checkEditorTasks(path.join(root, 'examples/project'));
    const npmCli = process.env.npm_execpath;
    if (!npmCli || !fs.existsSync(npmCli))
      throw new Error('Run npm run release:check so the configured npm CLI is used');
    const packed = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });
    if (packed.status !== 0) throw new Error(packed.error?.message ?? packed.stderr.trim());
    const report = JSON.parse(packed.stdout)[0];
    const count = validateReleaseFiles(report.files);
    console.log(
      `Release check passed: ${count} allowlisted files, ${report.unpackedSize} bytes; documentation links and editor tasks valid.`,
    );
  } catch (error) {
    console.error(`Release check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
