import path from 'node:path';
import {
  appCoverage,
  appDirectory,
  appEntryIndex,
  appJson,
  appObject,
  appPath,
  appPeer,
  appRoot,
  appRule,
} from './app-common.mjs';

const reference = 'https://learn.microsoft.com/power-apps/developer/code-apps/';
const cliReference =
  'https://github.com/microsoft/power-platform-skills/blob/3ffa5b8fca9016ae9635a4690eece1cd18ab295f/plugins/code-apps/shared/cli-binary.md';
const dependencyReference = 'https://docs.npmjs.com/cli/configuring-npm/package-lock-json';
export const codeAppRules = [
  appRule(
    'APP-CODE-001',
    'Invalid Code Apps configuration',
    'error',
    'reliability',
    'Code Apps configuration is not a JSON object or has an invalid declared field shape.',
    'Correct the configuration field types using the installed Power Apps CLI schema; preserve unknown extension fields and source values.',
    { references: [reference] },
  ),
  appRule(
    'APP-CODE-002',
    'Code Apps connector or data-source contract',
    'error',
    'reliability',
    'A declared connection or database reference has an invalid structural contract.',
    'Use object references, string identity fields and the documented data-source collection shapes; live connection authorization remains a separate check.',
    { references: [reference] },
  ),
  appRule(
    'APP-CODE-003',
    'Code App environment initialization',
    'hint',
    'compatibility',
    'Code Apps configuration does not contain a nonempty environment identity.',
    'Confirm whether this is an intentionally uninitialized scaffold and select the intended environment explicitly before any authorized CLI initialization or deployment.',
    { references: [reference], confidence: 'medium' },
  ),
  appRule(
    'APP-CODE-004',
    'Code Apps SDK dependency',
    'warning',
    'compatibility',
    'A recognized Code Apps project has no adjacent package manifest or does not declare the Power Apps runtime SDK.',
    'Review whether the exported folder is complete and verify the app SDK dependency in its own package; do not install dependencies during analysis.',
    { references: [reference] },
  ),
  appRule(
    'APP-CODE-005',
    'Code Apps build contract',
    'warning',
    'reliability',
    'A recognized Code Apps package has no nonempty build script.',
    'Define and verify the project build before an authorized deployment. Source inspection does not run or certify that build.',
    { references: [reference] },
  ),
  appRule(
    'APP-CODE-006',
    'Code Apps deployment CLI provenance',
    'hint',
    'maintainability',
    'A Code Apps package does not declare the separate Power Apps CLI dependency.',
    'For reproducible CLI workflows, declare @microsoft/power-apps-cli and resolve the actual project-local pa or power-apps executable. Analysis and local simulation do not require a deployment CLI.',
    { references: [cliReference], confidence: 'medium' },
  ),
  appRule(
    'APP-CODE-007',
    'Runtime SDK used as a CLI',
    'warning',
    'compatibility',
    'An npm script appears to invoke the Power Apps runtime SDK package as an executable CLI.',
    'Keep @microsoft/power-apps runtime services separate from @microsoft/power-apps-cli tooling; review command syntax and use the resolved local binary without implicit installation.',
    { references: [cliReference], confidence: 'medium' },
  ),
  appRule(
    'APP-CODE-008',
    'Explicitly disabled TypeScript strict mode',
    'hint',
    'maintainability',
    'The Code Apps TypeScript configuration explicitly disables strict checking.',
    'Review type-safety requirements and the effective extended TypeScript configuration before enabling stricter checking; no compiler or project code is executed.',
    { references: [reference], confidence: 'medium' },
  ),
  appRule(
    'APP-DEPS-001',
    'App dependency restore is not pinned',
    'warning',
    'maintainability',
    'A recognized Code Apps or PCF package has no supported dependency lockfile covering it in the supplied source inventory.',
    'Check export completeness and commit the appropriate package-manager lockfile for reproducible restores. No dependency installation or registry request is performed.',
    { references: [dependencyReference] },
  ),
  appRule(
    'APP-DEPS-002',
    'npm root dependency declarations drift',
    'warning',
    'reliability',
    'An npm lockfile root package does not match the supplied package dependency declarations.',
    'Regenerate the lockfile with the project package manager and review the resulting dependency changes; compare only records from this same source root.',
    { references: [dependencyReference] },
  ),
  appRule(
    'APP-DEPS-003',
    'Invalid app package JSON',
    'error',
    'reliability',
    'A recognized app package or npm lockfile is not a JSON object.',
    'Correct the supplied JSON source; parser messages and source values are deliberately withheld.',
    { references: [dependencyReference] },
  ),
  appRule(
    'APP-DEPS-004',
    'Invalid app package declarations',
    'error',
    'reliability',
    'A recognized app package declares dependency or script fields with invalid structural types.',
    'Use string-valued package dependency and script maps. Preserve intentional dependency ranges; this check does not install or resolve packages.',
    { references: [dependencyReference] },
  ),
];

const dependencies = (pkg) => ({
  ...(appObject(pkg?.dependencies) ? pkg.dependencies : {}),
  ...(appObject(pkg?.devDependencies) ? pkg.devDependencies : {}),
});
function invalidConnection(reference) {
  if (!appObject(reference)) return true;
  if (
    ['id', 'apiName', 'displayName'].some((field) => reference[field] != null && typeof reference[field] !== 'string')
  )
    return true;
  return (
    reference.dataSources != null &&
    (!Array.isArray(reference.dataSources) || reference.dataSources.some((item) => typeof item !== 'string'))
  );
}
function invalidReference(raw) {
  if (
    raw.connectionReferences != null &&
    (!appObject(raw.connectionReferences) || Object.values(raw.connectionReferences).some(invalidConnection))
  )
    return true;
  if (raw.databaseReferences == null) return false;
  if (!appObject(raw.databaseReferences)) return true;
  return Object.values(raw.databaseReferences).some(invalidDatabase);
}
function invalidDatabase(database) {
  if (!appObject(database)) return true;
  if (database.dataSources == null) return false;
  if (!appObject(database.dataSources)) return true;
  return Object.values(database.dataSources).some(
    (table) =>
      !appObject(table) ||
      ['entitySetName', 'logicalName'].some((field) => table[field] != null && typeof table[field] !== 'string') ||
      (table.isHidden != null && typeof table.isHidden !== 'boolean'),
  );
}
function inspectConfig(entry, emit) {
  const raw = appJson(entry);
  if (!raw) {
    emit('APP-CODE-001', entry);
    return;
  }
  const invalid = ['appId', 'environmentId', 'localAppUrl'].some(
    (field) => raw[field] != null && typeof raw[field] !== 'string',
  );
  if (invalid || (raw.appSettings != null && !appObject(raw.appSettings))) emit('APP-CODE-001', entry);
  if (invalidReference(raw)) emit('APP-CODE-002', entry);
  if (raw.environmentId == null || (typeof raw.environmentId === 'string' && !raw.environmentId.trim()))
    emit('APP-CODE-003', entry, 'environmentId');
}
function supportedLock(index, entry, parsedLocks) {
  for (const name of [
    'npm-shrinkwrap.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
  ]) {
    const lock = appPeer(index, entry, name);
    if (lock) return { entry: lock, packagePath: '' };
  }
  let directory = appDirectory(entry);
  while (directory !== '.') {
    directory = path.posix.dirname(directory);
    const parent = { ...entry, relativeFile: path.posix.join(directory, 'package.json') };
    const lock = appPeer(index, parent, 'package-lock.json') ?? appPeer(index, parent, 'npm-shrinkwrap.json');
    if (!lock) continue;
    if (!parsedLocks.has(lock)) parsedLocks.set(lock, appJson(lock));
    const parsed = parsedLocks.get(lock);
    const packagePath = path.posix.relative(directory, appDirectory(entry));
    if (appObject(parsed?.packages?.[packagePath])) return { entry: lock, packagePath, parsed };
  }
  return null;
}
function inspectLock(pkg, entry, lock, emit) {
  if (!/(?:^|\/)(?:package-lock|npm-shrinkwrap)\.json$/i.test(appPath(lock.entry))) return;
  const parsed = lock.parsed ?? appJson(lock.entry);
  if (!parsed) {
    emit('APP-DEPS-003', lock.entry);
    return;
  }
  const root = parsed.packages?.[lock.packagePath];
  if (!appObject(root)) return;
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const declared = appObject(pkg[key]) ? pkg[key] : {};
    const recorded = appObject(root[key]) ? root[key] : {};
    if (
      Object.keys(declared).length !== Object.keys(recorded).length ||
      Object.entries(declared).some(([name, value]) => recorded[name] !== value)
    ) {
      emit('APP-DEPS-002', entry, key);
      return;
    }
  }
}
function inspectPackage(entry, index, parsedLocks, codeApp, emit) {
  const pkg = appJson(entry);
  if (!pkg) {
    emit('APP-DEPS-003', entry);
    return;
  }
  const declared = dependencies(pkg);
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'scripts']) {
    if (
      pkg[field] != null &&
      (!appObject(pkg[field]) || Object.values(pkg[field]).some((value) => typeof value !== 'string'))
    ) {
      emit('APP-DEPS-004', entry, field);
    }
  }
  const lock = supportedLock(index, entry, parsedLocks);
  if (!lock) emit('APP-DEPS-001', entry);
  else inspectLock(pkg, entry, lock, emit);
  if (!codeApp) return;
  if (!Object.hasOwn(declared, '@microsoft/power-apps')) emit('APP-CODE-004', entry);
  if (typeof pkg.scripts?.build !== 'string' || !pkg.scripts.build.trim()) emit('APP-CODE-005', entry, 'scripts');
  if (!Object.hasOwn(declared, '@microsoft/power-apps-cli')) emit('APP-CODE-006', entry);
  if (appObject(pkg.scripts) && Object.values(pkg.scripts).some(sdkCliInvocation))
    emit('APP-CODE-007', entry, 'scripts');
  inspectTypeScript(entry, index, emit);
}
function sdkCliInvocation(command) {
  return (
    typeof command === 'string' &&
    /(?:^|[;&|]\s*|\s)npx\s+(?:--no-install\s+)?@microsoft\/power-apps(?:\s|$)/.test(command)
  );
}
function inspectTypeScript(entry, index, emit) {
  const config = appPeer(index, entry, 'tsconfig.json');
  if (!config) return;
  // TypeScript accepts JSONC. A strict JSON parser cannot reject a valid JSONC configuration.
  const json = appJson(config);
  if (json?.compilerOptions?.strict === false) emit('APP-CODE-008', config, 'compilerOptions');
}
function packageIdentity(entry) {
  return `${appRoot(entry)}\0${appDirectory(entry)}`;
}
function selectPackage(entry, index, packages) {
  const deps = dependencies(appJson(entry));
  const native = ['@microsoft/power-apps-native-host', 'react-native', 'expo'].some((name) =>
    Object.hasOwn(deps, name),
  );
  const codeApp =
    Boolean(appPeer(index, entry, 'power.config.json')) || (Object.hasOwn(deps, '@microsoft/power-apps') && !native);
  if (!codeApp && !native && !Object.hasOwn(deps, 'pcf-scripts')) return 0;
  const key = packageIdentity(entry);
  packages.set(key, { entry, codeApp: codeApp || packages.get(key)?.codeApp === true });
  return codeApp ? 1 : 0;
}
function selectConfiguredPackage(entry, index, packages, emit) {
  inspectConfig(entry, emit);
  const pkg = appPeer(index, entry, 'package.json');
  if (pkg) packages.set(packageIdentity(pkg), { entry: pkg, codeApp: true });
  else emit('APP-CODE-004', entry);
}
export function analyzeCodeApps(entries, emit) {
  const index = appEntryIndex(entries);
  const packages = new Map();
  const parsedLocks = new Map();
  let files = 0;
  for (const entry of entries) {
    const file = appPath(entry);
    if (/(?:^|\/)power\.config\.json$/i.test(file)) {
      files++;
      selectConfiguredPackage(entry, index, packages, emit);
    } else if (/(?:^|\/)package\.json$/i.test(file)) {
      files += selectPackage(entry, index, packages);
    }
  }
  for (const project of packages.values()) inspectPackage(project.entry, index, parsedLocks, project.codeApp, emit);
  return appCoverage(files, [
    'native-app-build',
    'live-connector-identity-and-permissions',
    'effective-jsonc-typescript-config',
    'generated-service-dataflow',
    'package-install-and-vulnerability-audit',
    'uninspected-native-lockfile-formats',
  ]);
}
