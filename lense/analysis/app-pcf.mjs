import { parseSolutionXml } from '../../mirage/lib/solution-xml.mjs';
import { appCoverage, appPath, appRule, atNode } from './app-common.mjs';

const manifest = 'https://learn.microsoft.com/power-apps/developer/component-framework/manifest-schema-reference/';
const property = `${manifest}property`;
const libraries =
  'https://learn.microsoft.com/power-apps/developer/component-framework/react-controls-platform-libraries';
const bestPractice =
  'https://learn.microsoft.com/power-apps/developer/component-framework/code-components-best-practices';
export const pcfRules = [
  appRule(
    'APP-PCF-001',
    'Invalid PCF manifest source',
    'error',
    'reliability',
    'A PCF manifest or project has invalid XML, or the manifest does not contain one complete control.',
    'Correct manifest XML before checking component contracts; diagnostic source values are withheld.',
    [manifest],
  ),
  appRule(
    'APP-PCF-002',
    'Missing PCF identity declaration',
    'error',
    'compatibility',
    'A control omits a required identity, version or display-name declaration, or declares an invalid control type.',
    'Supply namespace, constructor, version and display-name-key; control-type must be standard or virtual. Description-key is optional.',
    [`${manifest}control`],
  ),
  appRule(
    'APP-PCF-003',
    'Invalid PCF code resource cardinality',
    'error',
    'compatibility',
    'A control does not declare exactly one code resource with a nonempty path.',
    'Declare the component implementation resource once. Check packaging separately before deployment.',
    [`${manifest}code`],
  ),
  appRule(
    'APP-PCF-004',
    'Duplicate PCF declaration',
    'error',
    'reliability',
    'A property, dataset, type group or feature identity is repeated within its declaration scope.',
    'Keep declaration identities unique within the control or dataset; preserve existing bindings when correcting duplicates.',
    [manifest],
  ),
  appRule(
    'APP-PCF-005',
    'Inconsistent PCF property contract',
    'error',
    'compatibility',
    'A property has conflicting type declarations, an unresolved local type group, an invalid declared usage, or an Object type that is not output-only.',
    'Use one concrete type or declared type group, a supported usage when declared, and output-only Object properties.',
    [property],
  ),
  appRule(
    'APP-PCF-006',
    'PCF property host requirements need verification',
    'hint',
    'compatibility',
    'A property omits type or usage metadata whose requirements depend on the target host.',
    'Check the manifest schema for the intended model-driven or Canvas host; do not infer a host from the presence of arbitrary JavaScript.',
    [property],
    'medium',
  ),
  appRule(
    'APP-PCF-007',
    'Virtual control platform library declaration',
    'warning',
    'compatibility',
    'A virtual control does not declare the React platform library.',
    'Review the virtual-control template and platform-library declarations; a manifest edit alone does not convert a standard implementation.',
    [libraries],
  ),
  appRule(
    'APP-PCF-008',
    'PCF host and platform-library verification',
    'hint',
    'compatibility',
    'Virtual controls or platform libraries require target-host and deployed-library verification.',
    'Verify the intended host and current documented library versions. Canvas/model-driven support does not establish Power Pages support or runtime library identity.',
    [libraries],
    'medium',
  ),
  appRule(
    'APP-PCF-009',
    'PCF external-service declaration',
    'warning',
    'compatibility',
    'The manifest enables external-service usage, which can affect licensing and data boundaries.',
    'Review declared domains, premium-control licensing and actual outbound behavior for the intended host.',
    [`${manifest}external-service-usage`],
  ),
  appRule(
    'APP-PCF-010',
    'Explicit development component bundle',
    'warning',
    'performance',
    'The PCF project declares an unconditional development build mode without another source declaration.',
    'Verify the effective packaging configuration and produce a production bundle before deployment; command-line MSBuild overrides are not evaluated locally.',
    [bestPractice],
  ),
  appRule(
    'APP-PCF-011',
    'Documented unsupported PCF property type',
    'warning',
    'compatibility',
    'A property declares a type currently listed as unsupported in the Microsoft manifest reference.',
    'Review the current target-host schema and choose a documented supported type. Unknown future types are not automatically rejected by this rule.',
    [property],
  ),
  appRule(
    'APP-PCF-012',
    'Bound PCF default needs host review',
    'hint',
    'compatibility',
    'A bound property also declares a literal default-value.',
    'For model-driven hosts, literal defaults belong on input properties. Verify the intended host and pfx-default-value semantics before changing Canvas behavior.',
    [property],
    'medium',
  ),
];

const children = (node, name) => node.children.filter((candidate) => candidate.name === name);
function duplicate(nodes, emit, entry) {
  const names = new Set();
  for (const node of nodes) {
    const name = node.attrs.name;
    if (name && names.has(name)) emit('APP-PCF-004', entry, undefined, atNode(node));
    names.add(name);
  }
}
function inspectProperty(node, groups, entry, emit) {
  const attrs = node.attrs;
  const types = attrs['of-type-group'] ? groups.get(attrs['of-type-group']) : [attrs['of-type']];
  const conflicting = attrs['of-type'] && attrs['of-type-group'];
  const missingGroup = attrs['of-type-group'] && !groups.has(attrs['of-type-group']);
  const invalidUsage = attrs.usage && !['bound', 'input', 'output'].includes(attrs.usage);
  const invalidObject = types?.includes('Object') && attrs.usage !== 'output';
  const unsupported = new Set([
    'Lookup.Customer',
    'Lookup.Owner',
    'Lookup.PartyList',
    'Lookup.Regarding',
    'Status Reason',
    'Status',
    'Whole.Duration',
    'Whole.Language',
    'Whole.TimeZone',
    'File',
  ]);
  if (types?.some((type) => unsupported.has(type))) emit('APP-PCF-011', entry, undefined, atNode(node));
  if (attrs.usage === 'bound' && Object.hasOwn(attrs, 'default-value'))
    emit('APP-PCF-012', entry, undefined, atNode(node));
  if (!attrs.name?.trim() || conflicting || missingGroup || invalidUsage || invalidObject)
    emit('APP-PCF-005', entry, undefined, atNode(node));
  else if ((!attrs['of-type'] && !attrs['of-type-group']) || !attrs.usage)
    emit('APP-PCF-006', entry, undefined, atNode(node));
}
function inspectControl(control, entry, emit) {
  const attrs = control.attrs;
  if (
    ['namespace', 'constructor', 'version', 'display-name-key'].some(
      (name) => typeof attrs[name] !== 'string' || !attrs[name].trim(),
    ) ||
    (attrs['control-type'] && !['standard', 'virtual'].includes(attrs['control-type']))
  )
    emit('APP-PCF-002', entry, undefined, atNode(control));
  const resources = children(control, 'resources').flatMap((node) => node.children);
  const code = resources.filter((node) => node.name === 'code');
  if (children(control, 'resources').length !== 1 || code.length !== 1 || !code[0]?.attrs.path?.trim())
    emit('APP-PCF-003', entry, undefined, atNode(control));
  const platform = resources.filter((node) => node.name === 'platform-library');
  if (attrs['control-type'] === 'virtual' && !platform.some((node) => node.attrs.name === 'React'))
    emit('APP-PCF-007', entry, undefined, atNode(control));
  if (attrs['control-type'] === 'virtual' || platform.length) emit('APP-PCF-008', entry, undefined, atNode(control));
  const external = children(control, 'external-service-usage').find((node) => node.attrs.enabled === 'true');
  if (external) emit('APP-PCF-009', entry, undefined, atNode(external));
  inspectContracts(control, entry, emit);
}
function inspectContracts(control, entry, emit) {
  const groupNodes = children(control, 'type-group');
  const groups = new Map(
    groupNodes.map((node) => [node.attrs.name, children(node, 'type').map((type) => type.text.trim())]),
  );
  const properties = children(control, 'property');
  const datasets = children(control, 'data-set');
  for (const list of [groupNodes, properties, datasets]) duplicate(list, emit, entry);
  const features = children(control, 'feature-usage').flatMap((node) => children(node, 'uses-feature'));
  duplicate(features, emit, entry);
  for (const dataset of datasets) {
    const sets = children(dataset, 'property-set');
    duplicate(sets, emit, entry);
    for (const node of sets) inspectProperty(node, groups, entry, emit);
  }
  for (const node of properties) inspectProperty(node, groups, entry, emit);
}
function inspectManifest(entry, emit) {
  let root;
  try {
    root = parseSolutionXml(entry.text, { locations: true });
  } catch {
    emit('APP-PCF-001', entry);
    return;
  }
  const controls = children(root, 'control');
  if (root.name !== 'manifest' || controls.length !== 1) emit('APP-PCF-001', entry);
  else inspectControl(controls[0], entry, emit);
}
function inspectProject(entry, emit) {
  let root;
  try {
    root = parseSolutionXml(entry.text, { locations: true });
  } catch {
    emit('APP-PCF-001', entry);
    return;
  }
  const declarations = [];
  const stack = [{ node: root, conditional: false }];
  while (stack.length) {
    const { node, conditional } = stack.pop();
    const guarded = conditional || Object.keys(node.attrs).some((key) => key.toLowerCase() === 'condition');
    if (node.name === 'PcfBuildMode') declarations.push({ node, conditional: guarded });
    for (const child of node.children) stack.push({ node: child, conditional: guarded });
  }
  if (
    declarations.length === 1 &&
    !declarations[0].conditional &&
    declarations[0].node.text.trim().toLowerCase() === 'development'
  )
    emit('APP-PCF-010', entry, 'PcfBuildMode', atNode(declarations[0].node));
}
export function analyzePcf(entries, emit) {
  let files = 0;
  for (const entry of entries) {
    if (/(?:^|\/)ControlManifest(?:\.Input)?\.xml$/i.test(appPath(entry))) {
      files++;
      inspectManifest(entry, emit);
    } else if (/\.pcfproj$/i.test(appPath(entry))) {
      files++;
      inspectProject(entry, emit);
    }
  }
  return appCoverage(files, [
    'native-pcf-build',
    'effective-msbuild-properties',
    'target-host-and-library-runtime',
    'component-javascript-dataflow',
  ]);
}
