// Local native-source declarations only. No Expo config, Gradle, native compiler or bridge is executed.
import { appRule, appJson, appObject, appPath, appEntryIndex, appPeer } from './app-common.mjs';
import path from 'node:path';

const extensionReference =
  'https://github.com/microsoft/power-platform-skills/blob/3ffa5b8fca9016ae9635a4690eece1cd18ab295f/plugins/power-apps-mobile-extension/shared/ppmplugin-format.md';
const mobileReference =
  'https://github.com/microsoft/power-platform-skills/blob/3ffa5b8fca9016ae9635a4690eece1cd18ab295f/plugins/mobile-apps/template/package.json';
const rule = (id, title, severity, category, message, remediation, reference) =>
  appRule(id, title, severity, category, message, remediation, { references: [reference] });
export const nativeRules = [
  rule(
    'NATIVE-EXT-004',
    'Packaged native manifest missing',
    'error',
    'reliability',
    'An inspected native extension package has no root manifest.json declaration.',
    'Supply the exact documented root manifest and separately verify each declared native binary and ABI. No package content was extracted or executed.',
    extensionReference,
  ),
  rule(
    'NATIVE-EXT-001',
    'Native extension manifest structure',
    'error',
    'reliability',
    'The declared native extension manifest has an invalid required identity, ABI, entrypoint or receiver shape.',
    'Validate the documented manifest schema and retain only explicitly declared target platforms. Values are omitted from this diagnostic.',
    extensionReference,
  ),
  rule(
    'NATIVE-EXT-002',
    'Ambiguous native receiver',
    'warning',
    'reliability',
    'The native extension declares duplicate receiver identities or methods.',
    'Review dispatch identities and method allowlists against the actual native implementation; do not guess class names.',
    extensionReference,
  ),
  rule(
    'NATIVE-EXT-003',
    'Native package evidence',
    'hint',
    'compatibility',
    'A native extension manifest requires separate binary, dispatcher and device verification.',
    'Check the actual DEX/framework, ABI and bridge contract for each shipped target. A source manifest does not prove that an artifact loads.',
    extensionReference,
  ),
  rule(
    'MOBILE-APP-001',
    'Native host dependency evidence',
    'warning',
    'compatibility',
    'A Power Apps native host is declared without local React Native dependency evidence.',
    'Inspect the actual workspace dependency graph and supported native template; do not apply Code Apps or extension version pins to this app.',
    mobileReference,
  ),
  rule(
    'MOBILE-APP-002',
    'Native app reproducibility',
    'hint',
    'maintainability',
    'The recognized native application has no local dependency lock evidence.',
    'Keep a supported lockfile with the application or explicitly review the enclosing workspace lock. No dependency installation was performed.',
    mobileReference,
  ),
  rule(
    'MOBILE-APP-003',
    'Native runtime configuration shape',
    'warning',
    'compatibility',
    'The explicit Power Apps native configuration has an unsupported schema or runtime version shape.',
    'Review the current native template and selected platform versions. Dynamic app configuration is not evaluated.',
    mobileReference,
  ),
  rule(
    'MOBILE-APP-004',
    'Unreadable native app configuration',
    'error',
    'reliability',
    'A recognized native application JSON configuration could not be parsed as an object.',
    'Correct the local JSON configuration; source text and parser messages are not included. Dynamic app configuration was not executed.',
    mobileReference,
  ),
];

const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
function validReceiver(receiver) {
  return (
    appObject(receiver) &&
    nonempty(receiver.name) &&
    nonempty(receiver.nativeModule) &&
    Array.isArray(receiver.methods) &&
    receiver.methods.length > 0 &&
    receiver.methods.every(nonempty)
  );
}
function validEntrypoints(value) {
  if (!appObject(value)) return false;
  const android = Object.hasOwn(value, 'android'),
    ios = Object.hasOwn(value, 'ios');
  if (!android && !ios) return false;
  if (android && (!appObject(value.android) || !nonempty(value.android.dex) || !nonempty(value.android.packageClass)))
    return false;
  if (ios && (!appObject(value.ios) || !nonempty(value.ios.framework) || !nonempty(value.ios.moduleClass)))
    return false;
  return true;
}
function inspectExtension(entry, manifest, emit) {
  if (
    !manifest ||
    !nonempty(manifest.name) ||
    !nonempty(manifest.version) ||
    !nonempty(manifest.abi?.compatibleShells) ||
    !nonempty(manifest.abi?.builtAgainst) ||
    !validEntrypoints(manifest.entrypoints) ||
    !Array.isArray(manifest.receivers) ||
    !manifest.receivers.length ||
    !manifest.receivers.every(validReceiver)
  ) {
    emit('NATIVE-EXT-001', entry);
    return false;
  }
  const names = manifest.receivers.map((receiver) => receiver.name);
  if (
    new Set(names).size !== names.length ||
    manifest.receivers.some((receiver) => new Set(receiver.methods).size !== receiver.methods.length)
  )
    emit('NATIVE-EXT-002', entry, 'receivers');
  emit('NATIVE-EXT-003', entry);
  return true;
}
const nativeDependencies = (manifest) => ({
  ...manifest.peerDependencies,
  ...manifest.optionalDependencies,
  ...manifest.dependencies,
  ...manifest.devDependencies,
});
function inspectMobilePackage(entry, manifest, context) {
  const { index, emit } = context;
  const dependencies = nativeDependencies(manifest);
  if (!dependencies['react-native']) emit('MOBILE-APP-001', entry, 'dependencies');
  if (
    !['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'].some((name) =>
      appPeer(index, entry, name),
    )
  )
    emit('MOBILE-APP-002', entry);
  const configEntry = appPeer(index, entry, 'app.json');
  if (!configEntry) return true;
  context.mobile.add(configEntry.file);
  return inspectNativeConfiguration(configEntry, context);
}

function inspectNativeConfiguration(configEntry, context) {
  const { emit, reviewedConfigurations } = context;
  if (reviewedConfigurations.has(configEntry)) return reviewedConfigurations.get(configEntry);
  const config = appJson(configEntry);
  if (!config) {
    emit('MOBILE-APP-004', configEntry);
    reviewedConfigurations.set(configEntry, false);
    return false;
  }
  const native = config?.expo?.extra?.powerappsNative;
  if (
    native !== undefined &&
    (!appObject(native) ||
      !Number.isInteger(native.schemaVersion) ||
      native.schemaVersion < 1 ||
      !appObject(native.nativeRuntimeVersions) ||
      Object.values(native.nativeRuntimeVersions).some((version) => !Number.isInteger(version) || version < 1))
  )
    emit('MOBILE-APP-003', configEntry, 'powerappsNative');
  reviewedConfigurations.set(configEntry, true);
  return true;
}

function inspectNativeEntry(entry, context) {
  const file = appPath(entry),
    name = path.posix.basename(file).toLowerCase();
  if (entry.archive && file.toLowerCase().endsWith('.ppmplugin')) {
    context.extensions.add(entry.file);
    if (!entry.archiveInspected || !entry.nativeManifestPresent) {
      context.extensionComplete = false;
      if (entry.archiveInspected) context.emit('NATIVE-EXT-004', entry);
    }
    return;
  }
  if (name === 'package.json') return inspectNativePackage(entry, context);
  if (name === 'app.json') return inspectNativeApp(entry, context);
  if (name !== 'manifest.json') return;
  const manifest = appJson(entry);
  const declared =
    entry.file.toLowerCase().includes('.ppmplugin!/') ||
    (manifest && ['abi', 'entrypoints', 'receivers'].filter((key) => Object.hasOwn(manifest, key)).length >= 2);
  if (!declared) return;
  context.extensions.add(entry.file);
  context.extensionComplete = inspectExtension(entry, manifest, context.emit) && context.extensionComplete;
}
function inspectNativePackage(entry, context) {
  const manifest = appJson(entry);
  if (!manifest || !nativeDependencies(manifest)['@microsoft/power-apps-native-host']) return;
  context.mobile.add(entry.file);
  context.mobileComplete = inspectMobilePackage(entry, manifest, context) && context.mobileComplete;
}
function inspectNativeApp(entry, context) {
  const config = appJson(entry);
  if (!appObject(config?.expo?.extra) || !Object.hasOwn(config.expo.extra, 'powerappsNative')) return;
  context.mobile.add(entry.file);
  context.mobileComplete = inspectNativeConfiguration(entry, context) && context.mobileComplete;
}

export function analyzeNative(entries, emit) {
  const context = {
    index: appEntryIndex(entries),
    emit,
    reviewedConfigurations: new Map(),
    mobile: new Set(),
    extensions: new Set(),
    mobileComplete: true,
    extensionComplete: true,
  };
  for (const entry of entries) inspectNativeEntry(entry, context);
  const { mobileComplete, extensionComplete } = context;
  return {
    complete: extensionComplete && mobileComplete,
    domains: [
      {
        domain: 'mobile-apps',
        files: context.mobile.size,
        recognized: context.mobile.size,
        complete: mobileComplete,
        limitations: [
          'App configuration functions are not executed; native build, offline synchronization, mutation idempotency and device behavior require separate evidence.',
        ],
      },
      {
        domain: 'mobile-extension',
        files: context.extensions.size,
        recognized: context.extensions.size,
        complete: extensionComplete,
        limitations: [
          'No DEX/Mach-O ABI, source-to-receiver binary match, upload allowlist enforcement or dispatcher/device execution is verified.',
        ],
      },
    ],
  };
}
