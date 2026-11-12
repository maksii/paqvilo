import {
  dataverseEntry,
  recognizedWithoutRules,
  webResourceMetadata,
  readDataverseDocument,
  knownMetadataKind,
  localName,
  nodeValue,
  directNode,
  sourceAt,
  lower,
  metadataFields,
  rootKey,
  objectRows,
} from './dataverse-document.mjs';
import { analyzeDataverseSchema, collectDataverseSchema } from './dataverse-schema.mjs';
import { dataverseQueryRules, analyzeDataverseQueries } from './dataverse-query.mjs';

const alm = 'https://learn.microsoft.com/power-platform/alm/solution-concepts-alm';
const environment = 'https://learn.microsoft.com/power-apps/maker/data-platform/environmentvariables';
const plugin = 'https://learn.microsoft.com/power-apps/developer/data-platform/register-plug-in';
const model = 'https://learn.microsoft.com/power-apps/developer/model-driven-apps/clientapi/events-forms-grids';
const schema = 'https://learn.microsoft.com/power-apps/developer/data-platform/entity-attribute-metadata';
function ruleDomain(id) {
  if (id.startsWith('DV-MODEL-')) return 'model-driven';
  if (['DV-SOLUTION-', 'DV-ENV-', 'DV-CONNECTION-'].some((prefix) => id.startsWith(prefix))) return 'alm';
  return 'dataverse';
}
const rule = (id, title, severity, category, message, remediation, references) => ({
  id,
  domain: ruleDomain(id),
  title,
  severity,
  category,
  confidence: 'high',
  message,
  remediation,
  references: [references],
});

export const dataverseRules = [
  ...dataverseQueryRules,
  rule(
    'DV-SOURCE-001',
    'Incomplete Dataverse source analysis',
    'warning',
    'reliability',
    'Selected Dataverse metadata could not be fully parsed within the supported structure budget.',
    'Check the indicated source syntax, export format and size/depth limits; no source values are included in diagnostics.',
    alm,
  ),
  rule(
    'DV-SOLUTION-001',
    'Invalid explicit solution version',
    'error',
    'reliability',
    'A solution version is not four nonnegative 32-bit integer components.',
    'Use major.minor.build.revision with each component between zero and 2147483647.',
    alm,
  ),
  rule(
    'DV-SOLUTION-002',
    'Export-declared missing dependency',
    'warning',
    'reliability',
    'The solution export declares a missing dependency whose target availability is not established locally.',
    'Review the dependency in the source and verify target prerequisites before import; an installed target dependency may satisfy it.',
    alm,
  ),
  rule(
    'DV-SOLUTION-003',
    'Duplicate root component declaration',
    'warning',
    'reliability',
    'The same component is declared more than once in one solution manifest.',
    'Review duplicate component identities while preserving deliberate solution layering; do not infer membership from names alone.',
    alm,
  ),
  rule(
    'DV-ENV-001',
    'Literal secret-like environment value',
    'warning',
    'security',
    'An environment variable contains a literal secret-like default or current value.',
    'Use an appropriate secret store and project-owned target settings; inspect history and rotate a real exposed secret without copying its value into reports.',
    environment,
  ),
  rule(
    'DV-ENV-002',
    'Required environment binding not established',
    'hint',
    'reliability',
    'A required environment variable has no usable default or selected current value.',
    'Supply target-owned deployment settings or verify the existing target value; omission from an export does not prove a deployed failure.',
    environment,
  ),
  rule(
    'DV-ENV-003',
    'Invalid literal JSON environment value',
    'error',
    'reliability',
    'A selected literal value for an explicitly JSON-typed environment variable is not valid JSON.',
    'Correct the JSON value in its owning source or deployment settings and validate target-specific resolution separately.',
    environment,
  ),
  rule(
    'DV-ENV-004',
    'Ambiguous environment current values',
    'warning',
    'reliability',
    'More than one distinct current value is selected for one environment variable in one source root.',
    'Resolve the target binding explicitly; dependent value conclusions are skipped rather than choosing an arbitrary value.',
    environment,
  ),
  rule(
    'DV-CONNECTION-001',
    'Connection binding belongs to an environment',
    'hint',
    'portability',
    'A connection reference includes an environment-specific connection binding.',
    'Keep target-owned bindings in deployment settings and verify connector, connection ownership and permissions before use.',
    'https://learn.microsoft.com/power-platform/alm/conn-ref-env-variables-build-tools',
  ),
  rule(
    'DV-PLUGIN-001',
    'Update step has no filtering attributes',
    'warning',
    'performance',
    'An enabled Update plug-in step has no filtering attributes and can execute for every update payload.',
    'Declare the columns that should trigger the step, or document why every update is intentional; filtering tests payload inclusion, not whether values changed.',
    'https://learn.microsoft.com/power-apps/developer/data-platform/best-practices/business-logic/include-filtering-attributes-plugin-registration',
  ),
  rule(
    'DV-PLUGIN-002',
    'Plug-in image projects all columns',
    'warning',
    'performance',
    'A plug-in image explicitly requests all columns or omits its attribute projection.',
    'Select only the image columns required by the implementation and verify the step message and image availability.',
    plugin,
  ),
  rule(
    'DV-PLUGIN-003',
    'Asynchronous step before PostOperation',
    'error',
    'reliability',
    'An explicitly asynchronous plug-in step is registered before PostOperation.',
    'Register asynchronous execution in PostOperation or use synchronous execution for a supported earlier stage.',
    plugin,
  ),
  rule(
    'DV-PLUGIN-004',
    'Plug-in image cannot exist at this stage',
    'error',
    'reliability',
    'A declared plug-in image is incompatible with its explicit message or execution stage.',
    'Create has no pre-image, Delete has no post-image, and post-images require PostOperation; correct the registration without changing business logic.',
    plugin,
  ),
  rule(
    'DV-MODEL-001',
    'Form web resource is outside selected metadata',
    'hint',
    'reliability',
    'An enabled form handler refers to a web resource not declared in the selected source root.',
    'Verify the exact library identity and solution membership; partial exports and platform-provided libraries require separate evidence.',
    model,
  ),
  rule(
    'DV-MODEL-002',
    'Duplicate event handler registration',
    'warning',
    'reliability',
    'One event contains duplicate enabled handler registrations with identical library, function and parameters.',
    'Review whether duplicate execution is intentional and remove only a confirmed redundant registration.',
    model,
  ),
  rule(
    'DV-MODEL-003',
    'Form column is outside selected table metadata',
    'hint',
    'reliability',
    'A form control binds to a column not declared by the selected table metadata.',
    'Verify the exact column against complete target metadata; built-in columns and partial table exports are not established as missing.',
    model,
  ),
  rule(
    'DV-MODEL-004',
    'View column is outside selected metadata',
    'hint',
    'reliability',
    'A declared view or saved query selects a column not declared in the selected table metadata.',
    'Verify the exact logical column against complete metadata; linked tables, built-in columns and partial exports require their own evidence.',
    model,
  ),
  rule(
    'DV-API-001',
    'Bound Custom API has no target table',
    'error',
    'reliability',
    'A Custom API explicitly declares an entity binding without its bound entity logical name.',
    'Declare the exact bound table logical name or select an appropriate global binding; do not substitute an entity-set or display name.',
    'https://learn.microsoft.com/power-apps/developer/data-platform/custom-api-tables',
  ),
  rule(
    'DV-API-002',
    'Custom API implementation needs verification',
    'hint',
    'reliability',
    'A Custom API definition does not declare a main plug-in implementation.',
    'Verify a target implementation or permitted processing-step handler before callers depend on this API; a scaffold is not functional verification.',
    'https://learn.microsoft.com/power-apps/developer/data-platform/custom-api',
  ),
  rule(
    'DV-SCHEMA-001',
    'Reversed explicit column bounds',
    'error',
    'reliability',
    'A column explicitly declares a minimum greater than its maximum.',
    'Correct the bounds while preserving the column type, precision and established data contract.',
    schema,
  ),
  rule(
    'DV-SCHEMA-002',
    'Duplicate explicit choice value',
    'error',
    'reliability',
    'One choice definition contains duplicate explicit integer option values.',
    'Resolve the duplicate identity without renumbering deployed choices or confusing translated labels with distinct options.',
    schema,
  ),
  rule(
    'DV-SCHEMA-003',
    'Relationship table is outside selected metadata',
    'hint',
    'reliability',
    'A relationship refers to a table not declared in the selected source root.',
    'Verify the relationship against complete target metadata or required solutions; do not invent table or entity-set names from plurals.',
    schema,
  ),
  rule(
    'DV-QUERY-001',
    'Saved query projects all attributes',
    'warning',
    'performance',
    'An exported saved FetchXML query explicitly projects all attributes.',
    'Select the required logical column names after checking view consumers; source projection is not measured query latency.',
    'https://learn.microsoft.com/power-apps/developer/data-platform/fetchxml/select-columns',
  ),
];

const hasValue = (value) => value !== undefined && value !== null && String(value).trim() !== '';
const actualBoolean = (value) => value === true || value === 1 || value === '1' || lower(value) === 'true';
const externalValue = (value) =>
  typeof value === 'string' && /\$\{|{{|@parameters\(|@environmentvariables\(/i.test(value);
const fieldsForNode = (node) =>
  metadataFields({
    ...node.attrs,
    ...Object.fromEntries(
      node.children.filter((child) => !child.children.length).map((child) => [child.name, child.text.trim()]),
    ),
  });

function validVersion(value) {
  if (typeof value !== 'string') return false;
  const components = value.split('.');
  return components.length === 4 && components.every((part) => /^\d{1,10}$/.test(part) && Number(part) <= 2147483647);
}

function inspectManifestComponent(document, node, seen, emit) {
  const identity = nodeValue(node, 'id') ?? nodeValue(node, 'schemaname');
  const key = JSON.stringify([nodeValue(node, 'type'), lower(identity)]);
  if (hasValue(identity) && seen.has(key)) emit('DV-SOLUTION-003', sourceAt(document, node));
  seen.add(key);
}

function inspectManifestNode(document, node, emit) {
  const version = nodeValue(node, 'version');
  if (hasValue(version) && !validVersion(version)) emit('DV-SOLUTION-001', sourceAt(document, node), 'version');
  const seen = new Set(),
    pending = [...node.children];
  while (pending.length) {
    const item = pending.pop(),
      kind = localName(item);
    if (kind === 'missingdependency') emit('DV-SOLUTION-002', sourceAt(document, item));
    if (kind === 'rootcomponent') inspectManifestComponent(document, item, seen, emit);
    for (const child of item.children) pending.push(child);
  }
}

function inspectManifest(document, emit) {
  for (const { node } of document.rows)
    if (localName(node) === 'solutionmanifest') inspectManifestNode(document, node, emit);
}

function collectXmlBindings(document, state) {
  for (const { node } of document.rows) {
    const kind = localName(node);
    if (!['environmentvariabledefinition', 'environmentvariablevalue', 'connectionreference'].includes(kind)) continue;
    const fields = fieldsForNode(node),
      source = sourceAt(document, node);
    if (kind === 'connectionreference') {
      if (hasValue(fields.connectionid)) state.connections.push(source);
      continue;
    }
    const rows = kind === 'environmentvariabledefinition' ? state.definitions : state.values;
    rows.push({ fields, source });
  }
}

function addObjectEnvironment(document, state) {
  const value = document.value,
    fields = metadataFields(value);
  if (fields.environmentvariabledefinition)
    for (const row of objectRows(fields.environmentvariabledefinition))
      state.definitions.push({ fields: metadataFields(row), source: document.entry });
  if (fields.schemaname && fields.type !== undefined) state.definitions.push({ fields, source: document.entry });
  for (const row of objectRows(
    fields.environmentvariablevalues?.environmentvariablevalue ??
      fields.environmentvariablevalues ??
      fields.environmentvariablevalue,
  ))
    state.values.push({ fields: metadataFields(row), source: document.entry });
  for (const row of objectRows(value?.EnvironmentVariables))
    state.values.push({ fields: metadataFields(row), source: document.entry });
  for (const row of objectRows(value?.environmentVariables))
    state.definitions.push({ fields: metadataFields(row), source: document.entry });
  if (environmentValueFolder(document.entry) && fields.value !== undefined)
    state.values.push({ fields, source: document.entry });
}

function environmentValueFolder(source) {
  const relative = source.relativeFile ?? source.file;
  return /(?:^|\/)environmentvariabledefinitions\//i.test(String(relative).replaceAll('\\', '/'));
}

function addObjectBindings(document, state) {
  const value = document.value,
    fields = metadataFields(value);
  if (Array.isArray(value)) {
    for (const row of value) state.values.push({ fields: metadataFields(row), source: document.entry });
    return;
  }
  addObjectEnvironment(document, state);
  const connections = objectRows(fields.connectionreferences ?? fields.connectionreference);
  if (fields.connectionreferencelogicalname) connections.push(value);
  for (const row of connections) if (hasValue(metadataFields(row).connectionid)) state.connections.push(document.entry);
}

function bindingName(fields, source) {
  const name = fields.schemaname ?? fields.schemaName;
  if (hasValue(name)) return lower(name);
  const parts = String(source.relativeFile ?? source.file)
    .replaceAll('\\', '/')
    .split('/');
  const index = parts.findIndex((part) => lower(part) === 'environmentvariabledefinitions');
  return index >= 0 ? lower(parts[index + 1]) : '';
}

function secretReference(value, parsed) {
  if (typeof value !== 'string') return false;
  const parts = value.split('/').map((part) => lower(part));
  if (
    parts[1] === 'subscriptions' &&
    parts[5] === 'providers' &&
    parts[6] === 'microsoft.keyvault' &&
    parts[7] === 'vaults' &&
    parts[9] === 'secrets' &&
    Boolean(parts[10])
  )
    return true;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const fields = metadataFields(parsed);
  return hasValue(fields.vaultname) && hasValue(fields.secretname);
}

function currentValues(state) {
  const selected = new Map();
  for (const row of state.values) {
    const key = JSON.stringify([rootKey(row.source), bindingName(row.fields, row.source)]);
    const values = selected.get(key) ?? [];
    values.push(row);
    selected.set(key, values);
  }
  return selected;
}

function literalFacts(value, cache) {
  const cached = cache.get(value);
  if (cached) return cached;
  let parsed,
    jsonValid = false;
  try {
    parsed = JSON.parse(String(value));
    jsonValid = true;
  } catch {
    /* A fixed diagnostic is emitted by the typed-value rule. */
  }
  const result = { jsonValid, secretReference: secretReference(value, parsed) };
  cache.set(value, result);
  return result;
}

function inspectEnvironmentValue(definition, selected, emit, cache) {
  const { fields, source } = definition,
    name = bindingName(fields, source);
  const value = selected.length ? selected[0].fields.value : fields.defaultvalue;
  const field = selected.length ? 'value' : 'defaultvalue';
  if (!hasValue(value)) {
    if (actualBoolean(fields.isrequired)) emit('DV-ENV-002', source);
    return;
  }
  if (externalValue(value)) return;
  const facts = literalFacts(value, cache);
  const type = lower(fields.type),
    secret =
      ['secret', '100000005'].includes(type) ||
      /(?:secret|password|apikey|api_key|access_token|connectionstring)/i.test(name);
  if (secret && !facts.secretReference) emit('DV-ENV-001', source, field);
  if (['json', '100000003'].includes(type) && !facts.jsonValid)
    emit('DV-ENV-003', selected[0]?.source ?? source, field);
}

function inspectEnvironment(state, emit) {
  const values = currentValues(state);
  const cache = new Map();
  for (const definition of state.definitions) {
    const { fields, source } = definition,
      name = bindingName(fields, source);
    const selected = values.get(JSON.stringify([rootKey(source), name])) ?? [];
    const distinct = new Set(selected.map((row) => row.fields.value));
    if (distinct.size > 1) {
      emit('DV-ENV-004', source);
      continue;
    }
    inspectEnvironmentValue(definition, selected, emit, cache);
  }
  for (const source of state.connections) emit('DV-CONNECTION-001', source, 'connectionid');
}

function inspectPluginImage(document, image, { message, stage }, emit) {
  const fields = fieldsForNode(image),
    type = Number(fields.imagetype),
    source = sourceAt(document, image);
  if (!hasValue(fields.attributes) || String(fields.attributes).trim() === '*')
    emit('DV-PLUGIN-002', source, 'attributes');
  if (
    (message === 'create' && [0, 2].includes(type)) ||
    (message === 'delete' && [1, 2].includes(type)) ||
    ([1, 2].includes(type) && [10, 20].includes(stage))
  )
    emit('DV-PLUGIN-004', source, 'imagetype');
}

function inspectPlugin(document, node, emit) {
  const fields = fieldsForNode(node),
    source = sourceAt(document, node);
  if (fields.statecode !== undefined && !['0', 'active'].includes(lower(fields.statecode))) return;
  const stage = Number(fields.stage),
    mode = Number(fields.mode);
  const message = lower(
    fields.sdkmessagename ?? fields.messagename ?? nodeValue(directNode(node, 'sdkmessageid'), 'name'),
  );
  if (message === 'update' && !hasValue(fields.filteringattributes))
    emit('DV-PLUGIN-001', source, 'filteringattributes');
  if (mode === 1 && [10, 20].includes(stage)) emit('DV-PLUGIN-003', source, 'stage');
  const pending = [...node.children];
  while (pending.length) {
    const image = pending.pop();
    if (localName(image) === 'sdkmessageprocessingstepimage')
      inspectPluginImage(document, image, { message, stage }, emit);
    for (const child of image.children) pending.push(child);
  }
}

function inspectCustomApi(document, node, emit) {
  const fields = fieldsForNode(node),
    source = sourceAt(document, node);
  if (['1', '2'].includes(lower(fields.bindingtype)) && !hasValue(fields.boundentitylogicalname))
    emit('DV-API-001', source, 'boundentitylogicalname');
  const implementation = hasValue(fields.plugintypeid)
    ? fields.plugintypeid
    : nodeValue(directNode(node, 'plugintypeid'), 'id');
  if (!hasValue(implementation)) emit('DV-API-002', source, 'plugintypeid');
}

function inspectObjectManifest(document, emit) {
  const fields = metadataFields(document.value),
    manifest = metadataFields(fields.solutionmanifest ?? fields.solution ?? fields);
  if (hasValue(manifest.version) && !validVersion(manifest.version)) emit('DV-SOLUTION-001', document.entry, 'version');
}

function collectDocuments(entries, state, emit) {
  const documents = [],
    skipped = [],
    metadataFiles = new Set(),
    unreviewed = new Set();
  for (const entry of entries) {
    if (!dataverseEntry(entry)) continue;
    metadataFiles.add(entry.file);
    const label = recognizedWithoutRules(entry.relativeFile ?? entry.file);
    // A WebResource metadata XML keeps its parsed path; other files in WebResources are content.
    if (label && !(label === 'web resource content' && webResourceMetadata(entry))) {
      unreviewed.add(label);
      continue;
    }
    try {
      const document = readDataverseDocument(entry);
      if (!knownMetadataKind(document)) {
        skipped.push({ file: entry.file, reason: 'unsupported-dataverse-metadata' });
        continue;
      }
      documents.push(document);
      if (document.format === 'object') {
        addObjectBindings(document, state);
        inspectObjectManifest(document, emit);
      } else {
        inspectManifest(document, emit);
        collectXmlBindings(document, state);
      }
    } catch {
      skipped.push({ file: entry.file, reason: 'unparsed-dataverse-metadata' });
      emit('DV-SOURCE-001', entry);
    }
  }
  return { documents, skipped, metadataFiles, unreviewed };
}

function inspectDocument(document, schemaFacts, emit, skipped) {
  for (const { node } of document.rows ?? []) {
    if (localName(node) === 'sdkmessageprocessingstep') inspectPlugin(document, node, emit);
    else if (localName(node) === 'customapi') inspectCustomApi(document, node, emit);
  }
  if (!analyzeDataverseSchema(document, schemaFacts, emit))
    skipped.push({ file: document.entry.file, reason: 'unparsed-embedded-fetchxml' });
}

/** Pure checks over the caller's bounded local inventory; no project modules or commands are executed. */
export function analyzeDataverse(entries, emit) {
  const state = { definitions: [], values: [], connections: [] };
  const { documents, skipped, metadataFiles, unreviewed } = collectDocuments(entries, state, emit);
  inspectEnvironment(state, emit);
  const querySummary = analyzeDataverseQueries(entries, emit);
  const schemaFacts = collectDataverseSchema(documents);
  for (const document of documents) inspectDocument(document, schemaFacts, emit, skipped);
  skipped.push(...querySummary.skipped);
  const summary = {
    domain: 'dataverse',
    files: new Set([...metadataFiles, ...querySummary.fileNames]).size,
    recognized: documents.length + querySummary.queries,
    complete: skipped.length === 0,
    skipped,
    literalQueryFiles: querySummary.files,
    literalQueries: querySummary.queries,
    evaluatedRules: dataverseRules.map((item) => item.id),
    limitations: [
      'partial-solution-dependencies-remain-unknown',
      'published-vs-saved-form-state-not-observed',
      'effective-security-roles-not-observed',
      'plugin-implementation-not-executed',
      'target-connection-and-secret-resolution-not-performed',
      'javascript-dataflow-and-dynamic-query-construction-not-analyzed',
      'complete-solution-XSD-and-SDK-app-spec-validation-not-performed',
      ...(unreviewed.size
        ? [
            `Recognized without rules: ${[...unreviewed].sort((left, right) => left.localeCompare(right, 'en')).join(', ')}.`,
          ]
        : []),
    ],
  };
  const domainFiles = (names) =>
    documents.filter(
      (document) => document.format === 'xml' && document.rows.some(({ node }) => names.includes(localName(node))),
    ).length;
  const models =
    domainFiles(['form', 'systemform', 'appmodule', 'sitemap', 'webresource']) +
    documents.filter(
      (document) =>
        document.format === 'object' &&
        ['forms', 'views', 'webResources'].some((key) => Array.isArray(document.value?.[key])),
    ).length;
  const almFiles =
    domainFiles([
      'solutionmanifest',
      'environmentvariabledefinition',
      'environmentvariablevalue',
      'connectionreference',
    ]) + documents.filter((document) => document.format === 'object').length;
  return {
    ...summary,
    domains: [
      summary,
      {
        domain: 'model-driven',
        files: models,
        recognized: models,
        complete: summary.complete,
        skipped,
        limitations: [
          'published-form-state-and-effective-app-membership-not-observed',
          'partial-column-and-library-references-remain-unknown',
        ],
      },
      {
        domain: 'alm',
        files: almFiles,
        recognized: almFiles,
        complete: summary.complete,
        skipped,
        limitations: [
          'target-import-dependencies-and-binding-usability-not-observed',
          'no-pack-import-publish-or-checker-upload',
        ],
      },
    ],
  };
}
