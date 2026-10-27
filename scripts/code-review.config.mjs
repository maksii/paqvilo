// Explicit executable/browser URL entries; package wildcard deep imports are not public roots.
export const runtimeEntries = [
  'bin/paqvilo.mjs',
  'mirage/cli.mjs',
  'mirage/mcp-stdio.mjs',
  'lense/api.mjs',
  'lense/dataverse/index.mjs',
  'mirage/api.mjs',
  'mirage/acceptance-api.mjs',
  'mirage/testing.mjs',
  'mirage/packs.mjs',
  'mirage/fixtures.mjs',
  'lense/setup/app.mjs',
  'lense/setup/quick.mjs',
  'mirage/admin/view-services.mjs',
  'mirage/admin/view-packs.mjs',
  'mirage/admin/view-flows.mjs',
  'mirage/admin/view-common.mjs',
  'mirage/admin/view-capabilities.mjs',
  'mirage/admin/ui-kit.mjs',
  'mirage/admin/persona-picker.mjs',
  'mirage/admin/persona-manager.mjs',
  'mirage/admin/help-content.mjs',
  'mirage/admin/dashboard-map.mjs',
  'mirage/admin/dashboard-icons.mjs',
  'mirage/admin/app.mjs',
  'mirage/lib/xrm-webform-compat.js',
  'mirage/lib/webforms-compat.js',
  'mirage/lib/stackranking-compat.js',
  'mirage/lib/radcaptcha-compat.js',
  'mirage/lib/platform-app-compat.js',
  'mirage/lib/pages-client-api.js',
  'mirage/lib/multiselect-compat.js',
  'mirage/lib/jqueryui-widgets-compat.js',
  'mirage/lib/jqueryui-dialog-compat.js',
  'mirage/lib/jquery-timeago-compat.js',
  'mirage/lib/jquery-class-selection-compat.js',
  'mirage/lib/jquery-blockui-compat.js',
  'mirage/lib/footer-spacing-compat.js',
  'mirage/lib/fileuploadcontrol-compat.js',
  'mirage/lib/entitylist-map-compat.js',
  'mirage/lib/entitylist-calendar-compat.js',
  'mirage/lib/entity-grid-compat.js',
  'mirage/lib/datetimepicker-compat.js',
  'mirage/lib/date-format-compat.js',
  'mirage/lib/crmentityformview-datetime-compat.js',
  'mirage/lib/crmentityformview-compat.js',
  'mirage/lib/code-components-client.js',
  'mirage/lib/code-apps-client.js',
  'mirage/lib/code-apps-vite.mjs',
  'mirage/lib/code-apps-workbench.js',
  'lense/code-app-dev-wrapper.mjs',
  'mirage/lib/bootstrap-plugins-compat.js',
  'mirage/lib/model-driven/app.mjs',
  'mirage/lib/model-driven/client-runtime.mjs',
  'mirage/lib/model-driven/pcf-runtime.mjs',
  'mirage/lib/model-driven/controls.mjs',
  'mirage/lib/model-driven/date-control.mjs',
  'mirage/lib/model-driven/duration-control.mjs',
  'mirage/lib/model-driven/choice-control.mjs',
  'mirage/lib/model-driven/lookup-dialog.mjs',
  'mirage/lib/model-driven/lookup-control.mjs',
  'mirage/lib/model-driven/control-descriptors.mjs',
  'mirage/lib/model-driven/icons.mjs',
  'lense/cli.mjs',
  'lense/dataverse/cli.mjs',
  'lense/commands/demo.mjs',
  'mirage/bootstrap-report.mjs',
  'mirage/render-sweep.mjs',
  'mirage/liquid-inventory.mjs',
  'mirage/webapi-inventory.mjs',
  'mirage/portal-matrix.mjs',
  'mirage/parity-suite.mjs',
  'mirage/baseline-suite.mjs',
  'mirage/liquid-conformance.mjs',
  'mirage/acceptance.mjs',
  'mirage/enrich-reference.mjs',
  'mirage/reference-parity.mjs',
  'mirage/query-inventory.mjs',
  'mirage/verify.mjs',
  'mirage/verify-storage.mjs',
  'mirage/capture-shell.mjs',
  'mirage/lib/persona-chooser-client.mjs',
  'mirage/dataverse-parity.mjs',
  'mirage/lib/sharepoint-contract.mjs',
];

export const runtimeProject = [
  'bin/**/*.mjs',
  'lense/**/*.{mjs,js}',
  'mirage/*.mjs',
  'mirage/lib/**/*.{mjs,js}',
  'mirage/admin/**/*.mjs',
  'mirage/testing/**/*.mjs',
];
export const testEntries = [
  'test/*.test.mjs',
  'test-browser/*.test.mjs',
  'mirage/test/*.test.mjs',
  'mirage/test-browser/*.test.mjs',
  'mirage/test-sdk/**/*.test.mjs',
  'mirage/test-volume/*.test.mjs',
  // Independently spawned synthetic workers/volume commands use filesystem URLs.
  'mirage/test-sdk/cert-auth/msal-child.mjs',
  'mirage/test-volume/state-storage.mjs',
];
export const ignored = [
  '**/fixtures/**',
  '**/generated/**',
  '**/node_modules/**',
  '**/obj/**',
  '**/bin/Release/**',
  '**/out/**',
  '**/.paqvilo/**',
  '**/.claude/**',
];

export function browserSources(source, filename) {
  const f = filename.replaceAll('\\', '/');
  if (f.endsWith('/lense/setup/app.mjs'))
    source = source.replace(
      /(['"])\.\/(ui-kit|dashboard-map|dashboard-icons|help-content)\.mjs\1/g,
      '$1../../mirage/admin/$2.mjs$1',
    );
  if (/\/mirage\/admin\//.test(f))
    source = source.replace(/(['"])\.\/(persona-search|persona-picker-view)\.mjs\1/g, '$1../lib/$2.mjs$1');
  if (/\/mirage\/test-browser\//.test(f))
    source = source.replace(/(['"])\/(?:_apps\/)?assets\/controls\.mjs\1/g, '$1../lib/model-driven/controls.mjs$1');
  if (f.endsWith('/examples/company-operations/portal-harness/browser.test.mjs'))
    source = source.replace(/(['"])\/(runtime|core)\.mjs\1/g, '$1./$2.mjs$1');
  return source;
}

export function knipConfig(scope = 'full') {
  return {
    entry: scope === 'runtime' ? runtimeEntries.map((file) => `${file}!`) : [...runtimeEntries, ...testEntries],
    project:
      scope === 'runtime'
        ? runtimeProject.map((file) => `${file}!`)
        : [...runtimeProject, 'test/**/*.mjs', 'test-browser/**/*.mjs', 'mirage/test*/**/*.{mjs,js}'],
    ignore: ignored,
    paths: {
      'paqvilo/lense': ['./lense/api.mjs'],
      'paqvilo/mirage': ['./mirage/api.mjs'],
      'paqvilo/mirage/acceptance': ['./mirage/acceptance-api.mjs'],
      'paqvilo/mirage/testing': ['./mirage/testing.mjs'],
      'paqvilo/mirage/packs': ['./mirage/packs.mjs'],
      'paqvilo/mirage/fixtures': ['./mirage/fixtures.mjs'],
      'paqvilo/lense/*': ['./lense/*'],
      'paqvilo/mirage/*': ['./mirage/*'],
    },
    includeEntryExports: true,
    compilers: { mjs: browserSources },
  };
}

export default knipConfig(process.env.PAQVILO_REVIEW_SCOPE ?? 'full');
