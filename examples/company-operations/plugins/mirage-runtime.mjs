import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  parsePluginDocument,
  importSolutionPlugins,
  pluginCatalogue,
  runPluginPhase,
  pluginStepMatchesEntity,
} from 'paqvilo/mirage/lib/exported-plugins.mjs';
import {
  prepareClrRuntime,
  validateClrDescriptor,
  canonicalClrDirectory,
  readClrDependency,
  closeClrHostPool,
} from 'paqvilo/mirage/lib/plugin-clr.mjs';
import { parseSolutionXml } from 'paqvilo/mirage/lib/solution-xml.mjs';
import { parseExactJson } from 'paqvilo/mirage/lib/exact-numeric.mjs';
import { parseODataExpression } from 'paqvilo/mirage/lib/odata-query.mjs';
import { createWebApiReplayClient } from '../portal-harness/mirage-webapi-replay.mjs';
import { createLiquidReplayClient } from '../portal-harness/mirage-liquid-replay.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const spanDto = (value) =>
  value?.type === 'String' &&
  value.truncated === false &&
  /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value.value ?? '')
    ? { ...value, value: '[generated span GUID]' }
    : value;
const generatedGuid = (value) =>
  typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value) ? '[generated GUID]' : value;
const generatedTime = (value) =>
  typeof value === 'string' && /^\/Date\(-?\d+\)\/$/.test(value) ? '[generated UTC DateTime]' : value;
const generatedCaptureTime = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(value) &&
  Number.isFinite(Date.parse(value))
    ? '[generated UTC capture string]'
    : value;
const normalizeWire = (value) =>
  Array.isArray(value)
    ? value.map(normalizeWire)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value).map(([key, item]) => {
            if (['@odata.context', '@odata.nextLink'].includes(key) && typeof item === 'string') {
              try {
                const url = new URL(item);
                return [key, '[owned origin]' + url.pathname + url.search + url.hash];
              } catch {
                /* Optional payload or browser capability is unavailable. */
              }
            }
            return [key, normalizeWire(item)];
          }),
        )
      : value;
const child = (node, name) => node.children?.find((item) => item.name.toLowerCase() === name.toLowerCase());
const value = (node, name) => child(node, name)?.text ?? node.attrs?.[name] ?? null;
async function regular(file) {
  const absolute = path.resolve(file),
    parent = path.dirname(absolute),
    canonicalParent = await canonicalClrDirectory(parent);
  // The shared reader validates the opened object and bounds reads even if a
  // source grows. Do not reopen a pathname after checking it.
  const { bytes } = await readClrDependency(canonicalParent, path.basename(absolute));
  if ((await canonicalClrDirectory(parent)) !== canonicalParent)
    throw new Error('Native runtime source directory changed during reading.');
  return bytes;
}
async function files(root) {
  const answer = [];
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isSymbolicLink()) throw new Error('Native runtime exports cannot contain symbolic links.');
    if (item.isDirectory()) answer.push(...(await files(file)));
    else if (item.isFile()) answer.push(file);
  }
  return answer;
}

export function nativeRegistrationFingerprint(registration) {
  const clean = (value) =>
    Array.isArray(value)
      ? value.map(clean)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => !key.startsWith('@'))
              .map(([key, item]) => [key, clean(item)]),
          )
        : value;
  const snapshot = { schemaVersion: registration.schemaVersion, applicationUserId: registration.applicationUserId };
  for (const [section, key] of [
    ['steps', 'sdkmessageprocessingstepid'],
    ['filters', 'sdkmessagefilterid'],
    ['messages', 'sdkmessageid'],
    ['images', 'sdkmessageprocessingstepimageid'],
  ]) {
    if (!Array.isArray(registration[section])) throw new Error('Native registration witness is incomplete.');
    snapshot[section] = registration[section]
      .map(clean)
      .sort((left, right) => String(left[key]).localeCompare(String(right[key])));
  }
  return hash(Buffer.from(JSON.stringify(canonical(snapshot))));
}

/** This explicit trusted project adapter uses original exported DLL bytes. It
 * never downloads SDK assemblies or contacts Dataverse. Private configuration
 * stays in the returned pack; summaries contain hashes and registration IDs. */
export async function prepareNativeReplayPlugins({
  exportRoot,
  nativeSteps = [],
  nativeRegistration,
  sdkMessages = {},
  context,
  serviceProfiles,
  sdkAssembly,
  proxyAssembly,
  cacheRoot,
  expectedAssemblyHashes,
  selectedStepIds,
  secureConfigurationByStep = {},
  persistentHost = false,
  expectedRegistrationHash,
}) {
  if (!Array.isArray(serviceProfiles) || !serviceProfiles.length)
    throw new Error('Explicit backend caller profiles are required.');
  const registrationSha256 = nativeRegistration ? nativeRegistrationFingerprint(nativeRegistration) : null;
  if (expectedRegistrationHash && registrationSha256 !== expectedRegistrationHash)
    throw new Error('Native registration snapshot does not match the required campaign witness.');
  const root = await fs.realpath(exportRoot),
    documents = [],
    configuration = new Map(),
    exportedFiles = await files(root);
  for (const file of exportedFiles.filter((file) => file.endsWith('.xml'))) {
    if (
      !file.includes(`${path.sep}PluginAssemblies${path.sep}`) &&
      !file.includes(`${path.sep}SdkMessageProcessingSteps${path.sep}`)
    )
      continue;
    const bytes = await regular(file),
      xml = bytes.toString('utf8'),
      facts = parsePluginDocument(xml);
    documents.push({ file, hash: hash(bytes), facts: { plugins: facts } });
    const document = parseSolutionXml(xml);
    if (document.name === 'SdkMessageProcessingStep') {
      const id = (document.attrs.SdkMessageProcessingStepId ?? '').replace(/[{}]/g, '').toLowerCase();
      configuration.set(id, value(document, 'Configuration'));
    }
  }
  if (nativeRegistration) {
    const filters = new Map(nativeRegistration.filters.map((filter) => [filter.sdkmessagefilterid, filter]));
    for (const message of nativeRegistration.messages)
      sdkMessages[message.sdkmessageid] = {
        name: message.name,
        evidence: 'Fresh native SDK message registration snapshot',
      };
    nativeSteps = nativeRegistration.steps.map((step) => ({
      id: step.sdkmessageprocessingstepid,
      name: step.name,
      configuration: step.configuration,
      typeId: step._eventhandler_value,
      message: sdkMessages[step._sdkmessageid_value]?.name,
      entity: filters.get(step._sdkmessagefilterid_value)?.primaryobjecttypecode ?? null,
      messageFilterId: step._sdkmessagefilterid_value ?? null,
      unfiltered: Object.hasOwn(step, '_sdkmessagefilterid_value') && step._sdkmessagefilterid_value === null,
      stage: step.stage,
      rank: step.rank,
      mode: step.mode,
      enabled: step.statecode === 0,
      impersonatingUserId: step._impersonatinguserid_value,
      filteringAttributes: String(step.filteringattributes ?? '')
        .split(',')
        .filter(Boolean),
      images: nativeRegistration.images
        .filter((image) => image._sdkmessageprocessingstepid_value === step.sdkmessageprocessingstepid)
        .map((image) => ({
          name: image.name,
          alias: image.entityalias,
          type: image.imagetype,
          attributes: String(image.attributes ?? '')
            .split(',')
            .filter(Boolean),
        })),
    }));
  }
  const nativeById = new Map(nativeSteps.map((step) => [step.id ?? step.sdkmessageprocessingstepid, step]));
  const inventory = importSolutionPlugins([{ documents }], { sdkMessages });
  inventory.steps = inventory.steps.map((step) => {
    const native = nativeById.get(step.id);
    if (!native) return step;
    if (native.typeId !== undefined && native.typeId !== step.typeId)
      throw new Error('Native step handler differs from its exact exported original type.');
    if (native.configuration !== undefined) configuration.set(step.id, native.configuration);
    return {
      ...step,
      ...Object.fromEntries(
        [
          'name',
          'message',
          'entity',
          'messageFilterId',
          'unfiltered',
          'stage',
          'rank',
          'mode',
          'enabled',
          'filteringAttributes',
          'images',
          'impersonatingUserId',
        ]
          .filter((key) => native[key] !== undefined)
          .map((key) => [key, native[key]]),
      ),
    };
  });
  const selected = selectedStepIds ? new Set(selectedStepIds) : null;
  if (selected)
    for (const id of selected) {
      const step = inventory.steps.find((step) => step.id === id);
      if (!step || !step.enabled || (nativeRegistration && !nativeById.has(id)))
        throw new Error('A selected native runtime step is absent or disabled.');
    }
  const assemblyFiles = new Map(),
    receipts = [];
  for (const assembly of inventory.assemblies) {
    const relative = String(assembly.binaryPath ?? '').replace(/^[/\\]/, '');
    const file = path.resolve(root, relative),
      bound = path.relative(root, file);
    if (bound.startsWith('..') || path.isAbsolute(bound)) throw new Error('Assembly export escaped its declared root.');
    const bytes = await regular(file),
      sha256 = hash(bytes),
      expected = expectedAssemblyHashes?.[assembly.name];
    if (!expected || expected !== sha256)
      throw new Error('Original assembly bytes do not match the required native receipt.');
    assemblyFiles.set(assembly.id, { file, sha256, bytes });
    receipts.push({ assembly: assembly.name, sha256 });
  }
  if (!path.isAbsolute(cacheRoot)) throw new Error('An explicit absolute owned native runtime cache is required.');
  await fs.mkdir(cacheRoot, { recursive: true });
  await canonicalClrDirectory(cacheRoot);
  const workRoot = path.resolve(cacheRoot, 'trusted-originals');
  await fs.mkdir(workRoot, { recursive: true });
  await canonicalClrDirectory(workRoot);
  const proxyBytes = proxyAssembly ? await regular(proxyAssembly) : null;
  if (proxyBytes) await fs.writeFile(path.join(workRoot, path.basename(proxyAssembly)), proxyBytes);
  const prepared = new Map(),
    runtimes = new Map(),
    pluginRuntimes = {},
    overrides = {};
  for (const step of inventory.steps) {
    if (!step.enabled || (selected && !selected.has(step.id))) continue;
    if (!step.typeName || !step.message)
      throw new Error('A selected native registration has no resolved type or SDK message.');
    const assembly = assemblyFiles.get(step.assemblyId);
    if (!assembly) throw new Error('A selected native registration has no verified original assembly.');
    const assemblyName = path.basename(assembly.file);
    await fs.writeFile(path.join(workRoot, assemblyName), assembly.bytes);
    const profile = serviceProfiles.find(
      (profile) => profile.userId.toLowerCase() === (context.userId ?? context.initiatingUserId).toLowerCase(),
    );
    if (!profile) throw new Error('The observed runtime caller has no explicit backend grant profile.');
    const descriptor = validateClrDescriptor({
      trust: 'execute-local-assembly',
      root: workRoot,
      assembly: assemblyName,
      typeName: step.typeName,
      sdkRoot: path.dirname(sdkAssembly),
      sdkAssembly: path.basename(sdkAssembly),
      dependencies: proxyBytes ? [path.basename(proxyAssembly)] : [],
      cacheRoot: path.resolve(cacheRoot, 'hosts'),
      serviceProfile: profile,
      sdkCallerProfiles: serviceProfiles.filter((item) => item !== profile),
      context: { ...context, ...(step.impersonatingUserId ? { executionUserId: step.impersonatingUserId } : {}) },
      unsecureConfiguration: configuration.get(step.id) ?? null,
      secureConfiguration: secureConfigurationByStep[step.id] ?? null,
      timeoutMs: 10000,
      persistentHost,
    });
    const key = `${assembly.sha256}/${step.typeName}`;
    if (!prepared.has(key)) prepared.set(key, await prepareClrRuntime(descriptor));
    const runtime = { ...prepared.get(key), descriptor };
    runtimes.set(step.id, runtime);
    pluginRuntimes[step.id] = descriptor;
    overrides[`plugin-step:${step.id}`] = { mode: 'clr' };
  }
  const pack = { id: 'company-operations-native-plugins', pluginRuntimes };
  const items = pluginCatalogue({ plugins: inventory, runtimes, overrides });
  return {
    pack,
    inventory,
    runtimes,
    items,
    receipt: {
      scope: 'Trusted original exported assemblies; local SDK backend',
      assemblies: receipts,
      selectedSteps: runtimes.size,
      registrationSha256,
      sourceDocuments: documents.map((document) => ({
        file: path.relative(root, document.file).replaceAll('\\', '/'),
        sha256: document.hash,
      })),
      sdkSha256: hash(await regular(sdkAssembly)),
      proxySha256: proxyBytes ? hash(proxyBytes) : null,
      secureConfiguration:
        'Only explicitly supplied installation-safe fixtures; native secure values are never read or copied',
    },
    setReadContext(snapshot) {
      const observed = contextFromNativeCapture(snapshot),
        profile = serviceProfiles.find((profile) => profile.userId.toLowerCase() === observed.userId.toLowerCase());
      if (!profile) throw new Error('The observed read caller has no explicit backend grant profile.');
      for (const runtime of runtimes.values()) {
        const executionUserId = runtime.descriptor.context.executionUserId;
        runtime.descriptor = validateClrDescriptor({
          ...runtime.descriptor,
          serviceProfile: profile,
          sdkCallerProfiles: serviceProfiles.filter((item) => item !== profile),
          context: { ...observed, ...(executionUserId ? { executionUserId } : {}) },
        });
      }
    },
    close(diagnostic = () => {}) {
      for (const runtime of runtimes.values()) closeClrHostPool({ runtime, diagnostic });
    },
    bind(store, diagnostic = () => {}) {
      store.setPluginPipeline(
        (event) => runPluginPhase({ ...event, store, items, runtimes, diagnostic }),
        (event) =>
          items.some(
            (item) =>
              item.enabled &&
              pluginStepMatchesEntity(item, event.entity) &&
              String(item.message).toLowerCase() === event.operation &&
              runtimes.has(item.id),
          ),
      );
    },
  };
}

export function contextFromNativeCapture(snapshot) {
  const extension = snapshot.extensions;
  if (snapshot.interfaceVersion !== 7 || !extension?.context6?.observed || !extension?.context7?.observed)
    throw new Error('Complete observed Context7 identity metadata is required.');
  const millis = /^\/Date\((-?\d+)\)\/$/.exec(snapshot.OperationCreatedOn ?? ''),
    clock = millis && Number.isSafeInteger(Number(millis[1])) ? new Date(Number(millis[1])).toISOString() : null;
  return {
    userId: snapshot.UserId,
    initiatingUserId: snapshot.InitiatingUserId,
    organizationId: snapshot.OrganizationId,
    businessUnitId: snapshot.BusinessUnitId,
    ...(clock
      ? {
          operationCreatedOn: clock,
          operationCreatedOnEvidence:
            'Actual original CLR recorded framework Context.OperationCreatedOn request-envelope metadata; not result-derived',
        }
      : {}),
    organizationName: snapshot.organizationName?.value ?? '',
    secondaryEntityName: snapshot.SecondaryEntityName ?? '',
    interfaceVersion: 7,
    environmentId: extension.context6.values.environmentId.value,
    tenantId: extension.context6.values.tenantId.value,
    isApplicationUser: extension.context7.values.IsApplicationUser,
    initiatingUserAgentPresent: extension.context5.values.initiatingUserAgentPresent,
    portalInputParameters: Object.fromEntries(
      Object.entries(snapshot.input ?? {})
        .filter(([name]) => ['AppModuleId', 'IsAppModuleContext', 'IncludeAnnotations'].includes(name))
        .map(([name, value]) => [name, value.type === 'Guid' ? { $type: 'Guid', value: value.value } : value.value]),
    ),
  };
}

/** Context has generated clocks and IDs. Compare explicit stable fields and
 * classify volatile fields independently; never label full snapshots equal. */
export function compareRecordedContexts(native, local) {
  const fields = [
    'schemaVersion',
    'MessageName',
    'PrimaryEntityName',
    'PrimaryEntityId',
    'SecondaryEntityName',
    'Stage',
    'Mode',
    'executionOrder',
    'Depth',
    'IsInTransaction',
    'UserId',
    'InitiatingUserId',
    'BusinessUnitId',
    'OrganizationId',
    'organizationName',
    'IsolationMode',
    'IsExecutingOffline',
    'IsOfflinePlayback',
    'interfaceVersion',
    'extensions',
    'owningExtension',
    'input',
    'output',
    'preImages',
    'postImages',
    'sharedVariables',
    'parents',
    'parentTruncated',
    'CorrelationId',
    'RequestId',
    'OperationId',
    'OperationCreatedOn',
  ];
  const stable = (value, field) =>
    ['CorrelationId', 'RequestId', 'OperationId'].includes(field)
      ? generatedGuid(value)
      : field === 'OperationCreatedOn'
        ? generatedTime(value)
        : field === 'sharedVariables' && value
          ? {
              ...value,
              ...(Object.hasOwn(value, 'pqvd.lab.span') ? { 'pqvd.lab.span': spanDto(value['pqvd.lab.span']) } : {}),
            }
          : field === 'parents' && Array.isArray(value)
            ? value.map((parent) =>
                Object.fromEntries(Object.entries(parent).map(([key, item]) => [key, stable(item, key)])),
              )
            : value;
  const differences = fields
    .filter(
      (field) =>
        JSON.stringify(canonical(stable(native[field], field))) !==
        JSON.stringify(canonical(stable(local[field], field))),
    )
    .map((field) => ({ field, native: native[field], local: local[field] }));
  return {
    stableEqual: differences.length === 0,
    differences,
    generatedFields: [
      'CorrelationId',
      'RequestId',
      'OperationId',
      'OperationCreatedOn',
      'sharedVariables.pqvd.lab.span',
    ],
    fullSnapshotEqual: false,
  };
}

export function compareRecordedPluginArtifacts(native, local) {
  const fields = [
    'schemaVersion',
    'assemblyIdentity',
    'operationId',
    'artifact',
    'content',
    'durability',
    'captureTime',
    'spanId',
    'parentSpanId',
  ];
  const normalize = (value, key) =>
    key === 'captureTime'
      ? generatedCaptureTime(value)
      : ['spanId', 'parentSpanId'].includes(key)
        ? generatedGuid(value)
        : value;
  const differences = fields
    .filter(
      (field) =>
        JSON.stringify(canonical(normalize(native[field], field))) !==
        JSON.stringify(canonical(normalize(local[field], field))),
    )
    .map((field) => ({ field, native: native[field], local: local[field] }));
  return {
    stableEqual: differences.length === 0,
    differences,
    generatedFields: ['captureTime', 'spanId', 'parentSpanId'],
    fullSnapshotEqual: false,
  };
}

/** Load frozen native records, including platform defaults absent from seed
 * manifests. Metadata resolves lookup targets; no identity or grant is inferred
 * from the source rows. This is an explicit local snapshot replacement. */
export function applyNativeDataSnapshot(store, snapshot, { rowVersions = snapshot?.rowVersions ?? {} } = {}) {
  if (!snapshot?.tables || !snapshot.projections)
    throw new Error('A complete native data/projection snapshot is required.');
  const tables = structuredClone(store.state.tables),
    mappings = structuredClone(store.state.mappings);
  const sourceTables = structuredClone(snapshot.tables),
    actor = structuredClone(snapshot.actorBinding?.actor),
    customer = snapshot.actorBinding?.customer;
  if (actor && customer) {
    const definition = store.fieldDefinition('contact', 'parentcustomerid');
    mappings.contact.fields ??= {};
    mappings.contact.fields.parentcustomerid = {
      ...definition,
      type: 'lookup',
      targets: [...new Set([...(definition?.targets ?? []), customer.type])],
    };
    actor['_parentcustomerid_value@Microsoft.Dynamics.CRM.lookuplogicalname'] = customer.type;
  }
  if (actor) {
    if (actor.contactid !== snapshot.contactId) throw new Error('Native actor binding identifies a different Contact.');
    sourceTables.contact ??= [];
    const existing = sourceTables.contact.find((row) => row.contactid === actor.contactid);
    if (
      existing &&
      Object.entries(actor).some(
        ([field, value]) => Object.hasOwn(existing, field) && JSON.stringify(existing[field]) !== JSON.stringify(value),
      )
    )
      throw new Error('Native actor binding conflicts with frozen fixture fields.');
    if (existing) Object.assign(existing, actor);
    else sourceTables.contact.push(actor);
  }
  if (customer) {
    if (
      !['account', 'contact'].includes(customer.type) ||
      customer.row?.[customer.type + 'id'] !== customer.id ||
      actor?._parentcustomerid_value !== customer.id
    )
      throw new Error('Native typed customer binding conflicts with its actor lookup.');
    sourceTables[customer.type] ??= [];
    const primary = customer.type + 'id',
      existing = sourceTables[customer.type].find((row) => row[primary] === customer.id);
    if (
      existing &&
      Object.entries(customer.row).some(
        ([field, value]) => Object.hasOwn(existing, field) && JSON.stringify(existing[field]) !== JSON.stringify(value),
      )
    )
      throw new Error('Native customer binding conflicts with frozen fixture fields.');
    if (existing) Object.assign(existing, customer.row);
    else sourceTables[customer.type].push(customer.row);
  }
  for (const [entity, rows] of Object.entries(sourceTables)) {
    if (!Array.isArray(rows) || rows.length > 10000) throw new Error('Native snapshot table exceeds local bounds.');
    const mapping = store.resolveMapping(entity);
    if (rowVersions[entity] || (entity === 'contact' && rowVersions.actor?.contact != null)) {
      mappings[mapping.logicalName].sdkRowVersionColumn = 'versionnumber';
      mappings[mapping.logicalName].fields ??= {};
      mappings[mapping.logicalName].fields.versionnumber = { type: 'bigint' };
    }
    tables[mapping.logicalName] = rows.map((source) => {
      const row = {};
      for (const [key, value] of Object.entries(source)) {
        if (key.startsWith('@') || key.includes('@')) continue;
        const lookup = /^_(.+)_value$/.exec(key),
          field = lookup?.[1],
          targets =
            field && (mappings[mapping.logicalName].fields?.[field] ?? store.fieldDefinition(entity, field))?.targets,
          annotation = lookup && source[`${key}@Microsoft.Dynamics.CRM.lookuplogicalname`];
        if (annotation && (!/^[a-z][a-z\d_]*$/i.test(annotation) || (targets?.length && !targets.includes(annotation))))
          throw new Error('Native lookup annotation conflicts with declared target metadata.');
        const target = annotation ?? (targets?.length === 1 ? targets[0] : null);
        if (lookup && value !== null && target) row[field] = { id: value, logical_name: target };
        else row[field ?? key] = value;
      }
      const version =
        entity === 'contact' && row.contactid === snapshot.contactId && rowVersions.actor?.contact != null
          ? rowVersions.actor.contact
          : rowVersions[entity]?.[row[mapping.idColumn]];
      if (version !== undefined) row.versionnumber = version;
      return row;
    });
  }
  for (const [schemaName, rows] of Object.entries(snapshot.projections)) {
    const relationship = store.state.relationships?.[schemaName];
    if (!relationship?.intersectEntity) throw new Error('Native projection has no exact imported relationship.');
    if (!Array.isArray(rows) || rows.length > 10000) throw new Error('Native projection exceeds local bounds.');
    tables[relationship.intersectEntity] = structuredClone(rows);
  }
  store.state.tables = tables;
  store.state.mappings = mappings;
  Object.defineProperty(store, 'nativeReadSnapshot', {
    value: Object.fromEntries(
      [
        'permissionSnapshotHash',
        'membershipSnapshotHash',
        'dataSnapshotHash',
        'rowVersionSnapshotHash',
        'contactId',
        'complete',
      ].map((field) => [field, snapshot[field]]),
    ),
    writable: true,
    configurable: true,
  });
  return {
    dataSnapshotHash: snapshot.dataSnapshotHash,
    tableCount: Object.keys(snapshot.tables).length,
    projectionCount: Object.keys(snapshot.projections).length,
  };
}

export function recordedPluginPayloads(rows) {
  const groups = new Map();
  for (const row of rows ?? []) {
    const key = row.pqvd_eventkey;
    if (!key) throw new Error('Native plugin event key is missing.');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const answer = [];
  for (const parts of groups.values()) {
    parts.sort((a, b) => a.pqvd_partnumber - b.pqvd_partnumber);
    const count = parts[0].pqvd_partcount;
    if (
      count !== parts.length ||
      parts.some(
        (part, index) =>
          part.pqvd_partnumber !== index + 1 ||
          part.pqvd_partcount !== count ||
          part.pqvd_payloadhash !== parts[0].pqvd_payloadhash,
      )
    )
      throw new Error('Native plugin event parts are incomplete or inconsistent.');
    const text = parts.map((part) => part.pqvd_payloadtext).join('');
    if (hash(Buffer.from(text)) !== parts[0].pqvd_payloadhash)
      throw new Error('Native plugin payload checksum does not match.');
    answer.push(parseExactJson(text));
  }
  return answer;
}

/** Artifact equality is not proof that graph, memberships, data or registration
 * stayed frozen during native capture. Every campaign must supply both reads. */
export function validateNativeReadWitness(witness, receipt, loaded) {
  const fields = ['permissionSnapshotHash', 'membershipSnapshotHash', 'dataSnapshotHash', 'rowVersionSnapshotHash'],
    reasons = [];
  if (witness?.before?.complete !== true || witness?.after?.complete !== true || loaded?.complete !== true)
    reasons.push('sourceCompleteness');
  for (const field of fields) {
    const before = witness?.before?.[field],
      after = witness?.after?.[field];
    if (!/^[a-f\d]{64}$/.test(before ?? '') || before !== after || before !== loaded?.[field]) reasons.push(field);
  }
  if (
    !/^[a-f\d]{64}$/.test(witness?.registrationSha256 ?? '') ||
    witness.registrationSha256 !== receipt?.registrationSha256
  )
    reasons.push('registrationSha256');
  return { verified: reasons.length === 0, reasons };
}

const finalObserverWitnesses = new WeakSet();
/** Derive the narrower final-query/wire scope from actual paired calibration.
 * A caller-supplied verified Boolean cannot activate this observation profile. */
export function validateFinalQueryObserverWitness(calibration) {
  const { full, final } = calibration ?? {};
  if (
    !full?.capture ||
    !final?.capture ||
    !Array.isArray(full.registration?.steps) ||
    !Array.isArray(final.registration?.steps)
  )
    throw new Error('Actual paired full/final observer calibration is required.');
  const snapshots = [full.before, full.after, final.before, final.after];
  for (const field of [
    'permissionSnapshotHash',
    'membershipSnapshotHash',
    'dataSnapshotHash',
    'rowVersionSnapshotHash',
    'contactId',
  ])
    if (
      snapshots.some(
        (row) =>
          row?.complete !== true ||
          row[field] !== snapshots[0]?.[field] ||
          !(field === 'contactId' ? /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/ : /^[a-f\d]{64}$/).test(
            row[field] ?? '',
          ),
      )
    )
      throw new Error('Observer calibration graph, actor, membership, data or versions changed.');
  const siteHashes = [full.siteBefore, full.siteAfter, final.siteBefore, final.siteAfter].map((rows) => {
    const result = validateNativeWireWitness({ before: rows, after: rows });
    if (!result.verified) throw new Error('Observer calibration requires complete source freezes.');
    return result.beforeHash;
  });
  if (new Set(siteHashes).size !== 1) throw new Error('Observer calibration consumed site source changed.');
  const typeId = calibration.observerTypeId;
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(typeId ?? ''))
    throw new Error('Observer calibration requires its exact exported observer type.');
  const enabled = final.registration.steps.filter((row) => row._eventhandler_value === typeId && row.statecode === 0);
  if (!enabled.length || enabled.some((row) => row.stage !== 20 || row.rank !== 9900 || row.mode !== 0))
    throw new Error('Final observation requires only synchronous final20 observer declarations.');
  const finalStepIds = enabled.map((row) => row.sdkmessageprocessingstepid),
    fullSteps = new Map(full.registration.steps.map((row) => [row.sdkmessageprocessingstepid, row]));
  if (fullSteps.size !== full.registration.steps.length || final.registration.steps.length !== fullSteps.size)
    throw new Error('Observer registration identities changed.');
  const registrationView = (registration, allowState) => ({
    ...registration,
    steps: registration.steps.map((row) => {
      const copy = { ...row };
      if (allowState && copy._eventhandler_value === typeId) {
        delete copy.statecode;
        delete copy.statuscode;
      }
      return copy;
    }),
  });
  if (
    nativeRegistrationFingerprint(registrationView(full.registration, true)) !==
    nativeRegistrationFingerprint(registrationView(final.registration, true))
  )
    throw new Error('Observer calibration changed configuration, handlers or unrelated registrations.');
  for (const step of enabled) {
    const original = fullSteps.get(step.sdkmessageprocessingstepid);
    if (original?.statecode !== 0) throw new Error('Final observer was not active in its full calibration.');
  }
  const artifacts = {
      full: recordedPluginPayloads(full.capture.backendEvents),
      final: recordedPluginPayloads(final.capture.backendEvents),
    },
    key = (request) => JSON.stringify([request.caseId, request.variant, request.lane, request.page ?? 1]),
    byKey = new Map(full.capture.requests.map((request) => [key(request), request]));
  for (const [side, events] of Object.entries(artifacts))
    for (const event of events) {
      const declared = calibration[side].registration.steps.find(
        (row) => row.sdkmessageprocessingstepid === event.context?.owningExtension?.id,
      );
      if (
        !declared ||
        declared.statecode !== 0 ||
        declared.stage !== event.context.Stage ||
        declared._eventhandler_value !== typeId ||
        !calibration[side].capture.requests.some((request) => request.operationId === event.operationId)
      )
        throw new Error('Observer calibration artifacts do not bind active declared source steps and requests.');
    }
  if (
    byKey.size !== full.capture.requests.length ||
    final.capture.requests.length !== byKey.size ||
    new Set(final.capture.requests.map(key)).size !== byKey.size
  )
    throw new Error('Observer calibration must cover the same complete physical request inventory.');
  const marker = (request) => {
    const text = request.authoredFetchXml ?? new URL(request.url, 'http://127.0.0.1').searchParams.get('$filter') ?? '',
      values = [...text.matchAll(/CO-UTC:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g)].map((match) => match[0]);
    if (new Set(values).size !== 1)
      throw new Error('Observer calibration authored UTC binding is missing or ambiguous.');
    return values[0];
  };
  const authored = (text, request) =>
    typeof text === 'string'
      ? text
          .replaceAll('CO-OP:' + request.operationId, 'CO-OP:[operation]')
          .replaceAll(marker(request), 'CO-UTC:[time]')
      : text;
  const source = (request) =>
    request.authoredFetchXml
      ? authored(request.authoredFetchXml, request)
      : (() => {
          const url = new URL(request.url, 'http://127.0.0.1');
          return (
            url.pathname +
            '?' +
            [...url.searchParams]
              .map(([name, value]) => [name, authored(value, request)])
              .sort(([a], [b]) => a.localeCompare(b))
              .map((row) => JSON.stringify(row))
              .join('&')
          );
        })();
  let observed = 0,
    backendless = 0;
  for (const request of final.capture.requests) {
    const original = byKey.get(key(request));
    if (!original || source(original) !== source(request))
      throw new Error('Observer calibration changed caller-authored query inputs.');
    const a = artifacts.full.filter(
        (row) => row.operationId === original.operationId && finalStepIds.includes(row.context?.owningExtension?.id),
      ),
      b = artifacts.final.filter((row) => row.operationId === request.operationId);
    if (
      a.length !== b.length ||
      b.some((row) => row.context?.Stage !== 20 || !finalStepIds.includes(row.context?.owningExtension?.id))
    )
      throw new Error('Final observer artifact inventory differs from its calibrated full profile.');
    for (const event of b) {
      const match = a.find((row) => row.context.owningExtension.id === event.context.owningExtension.id);
      if (
        !match ||
        typeof event.content?.query?.xml !== 'string' ||
        authored(match.content?.query?.xml, original) !== authored(event.content.query.xml, request) ||
        stableAssembly(match.assemblyIdentity) !== stableAssembly(event.assemblyIdentity)
      )
        throw new Error('Final native query or original assembly differs between full/final profiles.');
    }
    if (b.length) observed++;
    else backendless++;
    const fullEvents = artifacts.full.filter((row) => row.operationId === original.operationId),
      positive =
        request.lane === 'webapi'
          ? full.capture.results.find((row) => row.operationId === original.operationId)?.status === 200
          : full.capture.liquidPages?.find((row) => row.operationId === original.operationId)?.outcome === 'success';
    if (
      a.length &&
      positive &&
      !fullEvents.some(
        (row) =>
          row.context?.Stage === 40 &&
          row.context.output?.BusinessEntityCollection?.type === 'EntityCollection' &&
          row.context.output.BusinessEntityCollection.truncated === false,
      )
    )
      throw new Error('Full positive calibration lacks its complete actual Stage40 SDK observation.');
    if (request.lane === 'webapi') {
      const left = full.capture.results.find((row) => row.operationId === original.operationId),
        right = final.capture.results.find((row) => row.operationId === request.operationId);
      if (
        !left ||
        !right ||
        left.status !== right.status ||
        JSON.stringify(canonical(normalizeWire(parseExactJson(left.body)))) !==
          JSON.stringify(canonical(normalizeWire(parseExactJson(right.body))))
      )
        throw new Error('Full/final actual HTTP wire differs or is missing.');
    } else {
      const left = full.capture.liquidPages?.find((row) => row.operationId === original.operationId),
        right = final.capture.liquidPages?.find((row) => row.operationId === request.operationId),
        page = (row, source) =>
          row
            ? {
                ...row,
                operationId: '[operation]',
                authoredFetchXml: authored(row.authoredFetchXml, source),
                effectiveFetchXml: authored(row.effectiveFetchXml, source),
              }
            : null;
      if (
        !left ||
        !right ||
        JSON.stringify(canonical(page(left, original))) !== JSON.stringify(canonical(page(right, request)))
      )
        throw new Error('Full/final actual Liquid wire differs or is missing.');
    }
  }
  if (!observed) throw new Error('Observer calibration has no actual final-query callback evidence.');
  const witness = Object.freeze({
    verified: true,
    scope: 'Final plugin query, recorded final context and complete portal wire; SDK collection unobserved',
    finalStepIds: Object.freeze(finalStepIds),
    registrationSha256: nativeRegistrationFingerprint(final.registration),
    permissionSnapshotHash: final.before.permissionSnapshotHash,
    dataSnapshotHash: final.before.dataSnapshotHash,
    rowVersionSnapshotHash: final.before.rowVersionSnapshotHash,
    siteSourceHash: siteHashes[0],
    physicalReads: byKey.size,
    observed,
    backendless,
  });
  finalObserverWitnesses.add(witness);
  return witness;
}

function stableAssembly(identity) {
  if (
    !identity?.name ||
    !identity.version ||
    !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(identity.moduleVersionId ?? '')
  )
    throw new Error('Observer calibration original assembly identity is incomplete.');
  return JSON.stringify(canonical(identity));
}

/** Compare only actual emitted artifacts. A failed admitted query has no
 * fabricated Stage40 collection; its observable wire fault is a separate input
 * to qualification, and hidden native fault codes remain explicitly unknown. */
export function compareNativeReadArtifacts(
  native,
  local,
  {
    wireQualified = false,
    wireFailure = false,
    localPhases = [],
    localBackendExecutions = 0,
    finalObserverWitness,
  } = {},
) {
  const key = (event) => event.artifact + '/' + event.context?.owningExtension?.id;
  const expectedRows = native.find((event) => event.context.Stage === 40)?.context.output?.BusinessEntityCollection;
  const actualRows = local.find((event) => event.context.Stage === 40)?.context.output?.BusinessEntityCollection;
  const contexts = native.map((event) => {
    const counterpart = local.find((item) => key(item) === key(event));
    return {
      artifact: event.artifact,
      stepId: event.context?.owningExtension?.id,
      ...(counterpart
        ? compareRecordedContexts(event.context, counterpart.context)
        : { stableEqual: false, missing: true }),
      artifactMetadata: counterpart
        ? compareRecordedPluginArtifacts(event, counterpart)
        : { stableEqual: false, missing: true },
    };
  });
  const sameQueries = (left, right) =>
    left?.content?.query &&
    right?.content?.query &&
    (typeof left.content.query.xml === 'string' && typeof right.content.query.xml === 'string'
      ? left.content.query.xml === right.content.query.xml
      : JSON.stringify(canonical(left.content.query)) === JSON.stringify(canonical(right.content.query)));
  const queryExact =
    native.length > 0 &&
    local.length === native.length &&
    native.every((event) =>
      /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(event.context?.owningExtension?.id ?? ''),
    ) &&
    new Set(native.map(key)).size === native.length &&
    new Set(local.map(key)).size === local.length &&
    local.every((event) => {
      const expected = native.find((item) => key(item) === key(event));
      return expected && sameQueries(event, expected);
    });
  const collectionComplete =
    expectedRows?.type === 'EntityCollection' &&
    expectedRows.truncated !== true &&
    actualRows?.type === 'EntityCollection' &&
    actualRows.truncated !== true;
  const rowExact =
    collectionComplete && JSON.stringify(canonical(expectedRows)) === JSON.stringify(canonical(actualRows));
  const contextsExact = contexts.every((context) => context.stableEqual && context.artifactMetadata.stableEqual);
  const backendAbsenceExact =
    native.length === 0 && local.length === 0 && localBackendExecutions === 0 && localPhases.length === 0;
  const nativePhases = [...new Set(native.map((event) => event.context.Stage))].sort((a, b) => a - b);
  const phaseExact = JSON.stringify(localPhases.map((phase) => phase.stage)) === JSON.stringify(nativePhases);
  const backendArtifactsExact = queryExact && rowExact && contextsExact && phaseExact && localBackendExecutions === 1;
  const admittedFaultExact =
    queryExact &&
    contextsExact &&
    wireQualified &&
    wireFailure &&
    expectedRows === undefined &&
    actualRows === undefined &&
    native.every((event) => event.context.Stage !== 40) &&
    local.every((event) => event.context.Stage !== 40) &&
    phaseExact &&
    localPhases.length > 0 &&
    localBackendExecutions <= 1;
  const finalProfile = finalObserverWitnesses.has(finalObserverWitness),
    finalObserverInventory =
      finalProfile &&
      native.every(
        (event) =>
          event.context.Stage === 20 && finalObserverWitness.finalStepIds.includes(event.context.owningExtension.id),
      );
  const finalFrameworkExact =
    JSON.stringify(localPhases.map((phase) => phase.stage)) === JSON.stringify(wireFailure ? [10, 20] : [10, 20, 40]);
  const finalQueryWireExact =
    finalProfile &&
    finalObserverInventory &&
    queryExact &&
    contextsExact &&
    expectedRows === undefined &&
    actualRows === undefined &&
    wireQualified &&
    finalFrameworkExact &&
    (wireFailure ? localBackendExecutions <= 1 : localBackendExecutions === 1);
  return {
    contexts,
    queryExact,
    collectionComplete,
    rowExact,
    contextsExact,
    backendArtifactsExact,
    backendAbsenceExact,
    admittedFaultExact,
    finalQueryWireExact,
    collectionObservation: finalProfile ? 'not-recorded' : 'full-pipeline',
    backendFaultCodeObserved: admittedFaultExact || (finalQueryWireExact && wireFailure) ? false : null,
    qualified:
      wireQualified && (backendArtifactsExact || backendAbsenceExact || admittedFaultExact || finalQueryWireExact),
  };
}

/** Recover only caller-authored markers and the source root. OData is executed
 * by the real handler; its backend FetchXML is never an input to this helper. */
export function nativeReadRequestInput(store, request, liquidPage) {
  const xml = request.authoredFetchXml ?? liquidPage?.authoredFetchXml;
  let table,
    marker,
    page = 1;
  if (xml) {
    const tree = parseSolutionXml(xml),
      root = tree.children.find((node) => node.name === 'entity');
    table = root?.attrs.name;
    page = Number(tree.attrs.page ?? 1);
    const markers = [];
    const visit = (node) => {
      if (node.name === 'condition' && node.attrs.operator === 'ne' && node.attrs.value?.startsWith('CO-UTC:'))
        markers.push(node.attrs.value);
      for (const child of node.children ?? []) visit(child);
    };
    visit(root ?? {});
    const distinct = [...new Set(markers)];
    if (distinct.length === 1) marker = distinct[0];
  } else if (request.lane === 'webapi') {
    const url = new URL(request.url, 'http://127.0.0.1'),
      entitySet = /^\/_api\/([a-z][a-z\d_]*)$/i.exec(url.pathname)?.[1];
    if (!entitySet) throw new Error('Authored OData read requires a source collection route.');
    const mapping = store.resolveMapping(entitySet);
    table = mapping.logicalName;
    const aliases = Object.fromEntries([...url.searchParams].filter(([name]) => name.startsWith('@'))),
      tree = parseODataExpression(url.searchParams.get('$filter') ?? '', { aliases }),
      values = [];
    const visit = (node) => {
      if (!node || node.type === 'lambda') return;
      if (
        node.type === 'compare' &&
        node.op === 'ne' &&
        node.left?.type === 'path' &&
        node.left.segments.length === 1 &&
        node.left.segments[0] === (mapping.primaryNameColumn ?? mapping.nameColumn) &&
        node.right?.type === 'literal' &&
        typeof node.right.value === 'string'
      )
        values.push(node.right.value);
      for (const child of Object.values(node))
        if (child && typeof child === 'object') {
          if (Array.isArray(child)) child.forEach(visit);
          else visit(child);
        }
    };
    visit(tree);
    const operations = [...new Set(values.filter((value) => value.startsWith('CO-OP:')))],
      times = [...new Set(values.filter((value) => value.startsWith('CO-UTC:')))];
    if (operations.length !== 1 || operations[0] !== 'CO-OP:' + request.operationId || times.length !== 1)
      throw new Error('Authored OData operation/time markers are absent, ambiguous or mismatched.');
    marker = times[0];
  }
  if (
    !table ||
    !marker ||
    !/^CO-UTC:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(marker) ||
    !Number.isInteger(page) ||
    page < 1
  )
    throw new Error('Authored read root, operation UTC marker or page input is unavailable.');
  return { source: xml ?? null, table, marker, page };
}

/** Bind the actually consumed template/settings inputs to complete native site
 * component readbacks. Query-template replay excludes dispatcher/authentication
 * execution; this receipt never labels an unrendered page or script as executed. */
export function validateNativeWireWitness(witness, { webApiPortal, liquidReplay } = {}) {
  const reasons = [],
    clean = (value) =>
      Array.isArray(value)
        ? value.map(clean)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .filter(([key]) => !key.startsWith('@'))
                .map(([key, item]) => [key, clean(item)]),
            )
          : value;
  const components = (rows) =>
    Array.isArray(rows)
      ? rows.map(clean).sort((a, b) => String(a.powerpagecomponentid).localeCompare(String(b.powerpagecomponentid)))
      : null;
  const before = components(witness?.before),
    after = components(witness?.after),
    consumed = [];
  if (!before || !after || !before.length || before.some((row) => !row.powerpagecomponentid))
    return { verified: false, reasons: ['siteComponents'], consumed };
  const beforeHash = hash(Buffer.from(JSON.stringify(canonical(before)))),
    afterHash = hash(Buffer.from(JSON.stringify(canonical(after))));
  if (beforeHash !== afterHash) reasons.push('siteSourceChanged');
  const source = (type, name) => {
    const rows = before.filter(
      (row) => row.powerpagecomponenttype === type && row.statecode === 0 && row.name === name,
    );
    if (rows.length !== 1) {
      reasons.push('sourceMissingOrAmbiguous');
      return null;
    }
    const row = rows[0];
    let content;
    try {
      content = JSON.parse(row.content);
    } catch {
      reasons.push('sourceContent');
      return null;
    }
    consumed.push({ id: row.powerpagecomponentid, sha256: hash(Buffer.from(row.content)) });
    return content;
  };
  if (webApiPortal)
    for (const [name, value] of Object.entries(webApiPortal.settings ?? {})) {
      if (source(9, name)?.value !== value) reasons.push('webApiSetting');
    }
  if (liquidReplay) {
    for (const template of liquidReplay.templates ?? [])
      if (source(8, template.name)?.source !== template.source) reasons.push('queryTemplateSource');
    for (const [name, value] of Object.entries(liquidReplay.portal?.settings ?? {}))
      if (source(9, name)?.value !== value) reasons.push('liquidSetting');
    const dispatcher = source(8, 'CO Permission Lab Liquid Dispatcher')?.source;
    if (/assign dataset_version = '([^']+)'/.exec(dispatcher ?? '')?.[1] !== liquidReplay.datasetVersion)
      reasons.push('datasetVersionInput');
  }
  return {
    verified: reasons.length === 0,
    reasons: [...new Set(reasons)],
    beforeHash,
    afterHash,
    consumed: [...new Map(consumed.map((row) => [row.id, row])).values()],
    scope:
      'Complete site source freeze and actually consumed query-template/settings inputs; dispatcher, page and authentication execution excluded',
  };
}

/** Recorder reads are source inputs, not reconstructed expected query outputs.
 * Older captures lack these readbacks and retain their narrower proof scope. */
export function nativeRecordingInputs(store, capture, identity) {
  if (capture.recordingInputs === undefined)
    return {
      verified: false,
      reason: 'Actual recorder Run/operation readbacks were not captured',
      operations: null,
      run: null,
    };
  const inputs = capture.recordingInputs,
    actor = identity.contactId ?? identity.id;
  if (!inputs?.run || !Array.isArray(inputs.operations) || inputs.operations.length !== capture.requests.length)
    throw new Error('Native recorder inputs are incomplete.');
  const platformTargets = {
    createdby: ['systemuser'],
    modifiedby: ['systemuser'],
    createdonbehalfby: ['systemuser'],
    modifiedonbehalfby: ['systemuser'],
    organizationid: ['organization'],
    owninguser: ['systemuser'],
    owningteam: ['team'],
    owningbusinessunit: ['businessunit'],
  };
  const convert = (entity, source) => {
    const mapping = store.resolveMapping(entity),
      row = {};
    if (!source || typeof source !== 'object' || Array.isArray(source))
      throw new Error('Native recorder readback is not a record.');
    for (const [key, value] of Object.entries(source)) {
      if (key.startsWith('@') || key.includes('@')) continue;
      const lookup = /^_(.+)_value$/.exec(key),
        field = lookup?.[1] ?? key,
        annotation = source[key + '@Microsoft.Dynamics.CRM.lookuplogicalname'],
        targets = lookup && (store.fieldDefinition(entity, field)?.targets ?? platformTargets[field]),
        target = annotation ?? (targets?.length === 1 ? targets[0] : null);
      if (annotation && targets?.length && !targets.includes(annotation))
        throw new Error('Native recorder lookup conflicts with source metadata.');
      if (lookup && value != null && !target) throw new Error('Native recorder lookup requires typed source metadata.');
      row[field] = lookup && value != null ? { id: value, logical_name: target } : value;
    }
    const etag = /^W\/"(\d+)"$/.exec(source['@odata.etag'] ?? '');
    if (!etag || !row[mapping.idColumn] || !row.createdby?.id)
      throw new Error('Native recorder readback lacks identity, creator or RowVersion.');
    row.versionnumber = etag[1];
    return row;
  };
  const run = convert('pqvd_testrun', inputs.run);
  if (run.pqvd_testrunid !== capture.runId || run.pqvd_runnercontactid?.id !== actor)
    throw new Error('Native recorder Run does not belong to the actual actor.');
  const operations = inputs.operations.map((source) => convert('pqvd_testoperation', source)),
    byId = new Map(operations.map((row) => [row.pqvd_testoperationid, row]));
  if (byId.size !== operations.length) throw new Error('Native recorder operation readbacks are ambiguous.');
  for (const request of capture.requests) {
    const operation = byId.get(request.operationId),
      authored = nativeReadRequestInput(
        store,
        request,
        (capture.liquidPages ?? []).find((row) => row.operationId === request.operationId),
      );
    if (
      !operation ||
      operation.pqvd_runid?.id !== capture.runId ||
      operation.pqvd_runnercontactid?.id !== actor ||
      operation.pqvd_markeroperation !== 'CO-OP:' + request.operationId ||
      operation.pqvd_markerutc !== authored.marker ||
      operation.pqvd_roottable !== authored.table ||
      operation.pqvd_expectedmessage !== 'RetrieveMultiple' ||
      operation.pqvd_lane !== (request.lane === 'liquid' ? 183270000 : 183270001) ||
      operation.pqvd_caseid !== request.caseId ||
      operation.pqvd_variant !== request.variant
    )
      throw new Error('Native recorder operation does not bind its authored physical request.');
  }
  return {
    verified: true,
    run,
    operations,
    scope: 'Actual immutable pre-query Run/operation readbacks, including creator and RowVersion',
  };
}

/** Execute every authored physical read independently through the original DLL
 * binding. The caller supplies the already frozen graph/data/session; this hook
 * never changes native roles, permissions or data, and never feeds a captured
 * expanded query into the local execution path. */
export async function replayNativeReadBatch({
  binding,
  store,
  identity,
  capture,
  sourceWitness,
  webApiPortal,
  liquidReplay,
  metadata,
  finalObserverWitness,
  progress = () => {},
}) {
  if (finalObserverWitness !== undefined) {
    if (
      !finalObserverWitnesses.has(finalObserverWitness) ||
      binding.receipt.registrationSha256 !== finalObserverWitness.registrationSha256 ||
      ['permissionSnapshotHash', 'dataSnapshotHash', 'rowVersionSnapshotHash'].some(
        (field) => store.nativeReadSnapshot?.[field] !== finalObserverWitness[field],
      ) ||
      finalObserverWitness.finalStepIds.some((id) => !binding.runtimes.has(id))
    )
      throw new Error('Final observer profile does not bind this exact source/registration/runtime.');
  }
  const native = recordedPluginPayloads(capture.backendEvents),
    byOperation = new Map();
  if (!Array.isArray(capture.requests) || !capture.requests.length)
    throw new Error('Native read qualification requires a nonempty physical request set.');
  const requestIds = new Set();
  for (const request of capture.requests) {
    if (
      !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(request.operationId ?? '') ||
      requestIds.has(request.operationId) ||
      !['liquid', 'webapi'].includes(request.lane)
    )
      throw new Error('Native read requests require unique operation identities and supported lanes.');
    requestIds.add(request.operationId);
  }
  if (native.some((event) => !requestIds.has(event.operationId)))
    throw new Error('Native backend artifacts include an unrequested operation.');
  for (const event of native) {
    if (!byOperation.has(event.operationId)) byOperation.set(event.operationId, []);
    byOperation.get(event.operationId).push(event);
  }
  const results = new Map(
    capture.results.filter((result) => result.operationId).map((result) => [result.operationId, result]),
  );
  const liquid = new Map((capture.liquidPages ?? []).map((page) => [page.operationId, page]));
  const originalOperations = structuredClone(store.state.tables.pqvd_testoperation),
    originalRuns = structuredClone(store.state.tables.pqvd_testrun),
    originalEvents = structuredClone(store.state.tables.pqvd_pluginevent),
    started = Date.now(),
    pages = [];
  const recorderInputs = nativeRecordingInputs(store, capture, identity);
  const liquidClient = liquidReplay ? createLiquidReplayClient({ store, identity, ...liquidReplay }) : null;
  const webApi = webApiPortal
    ? await createWebApiReplayClient({ store, identity, portal: webApiPortal, metadata })
    : null;
  let localPhases = [],
    localBackendExecutions = 0;
  const originalPipeline = store.pluginPipeline,
    originalFetchCore = store.fetchXmlCore;
  if (originalPipeline)
    store.pluginPipeline = function (event) {
      if (event.portalRequest === true && event.operation === 'retrievemultiple')
        localPhases.push({ entity: event.entity, stage: event.stage });
      return originalPipeline?.call(this, event);
    };
  store.fetchXmlCore = function (xml, who, options = {}) {
    if (options.portalRequest === true && options.noBackendAdmission !== true) localBackendExecutions++;
    return originalFetchCore.call(this, xml, who, options);
  };
  try {
    if (recorderInputs.verified)
      store.state.tables.pqvd_testrun = [
        ...(originalRuns ?? []).filter((row) => row.pqvd_testrunid !== capture.runId),
        recorderInputs.run,
      ];
    for (const request of capture.requests) {
      store.state.tables.pqvd_testoperation = structuredClone(originalOperations);
      store.state.tables.pqvd_pluginevent = structuredClone(originalEvents);
      localPhases = [];
      localBackendExecutions = 0;
      const expected = byOperation.get(request.operationId) ?? [],
        http = results.get(request.operationId),
        liquidPage = liquid.get(request.operationId);
      let result,
        error,
        captures = [],
        localHttp,
        localLiquid;
      try {
        if (expected.length) {
          binding.setReadContext((expected.find((event) => event.context.Stage === 40) ?? expected[0]).context);
        }
        const { source, table, marker, page } = nativeReadRequestInput(store, request, liquidPage);
        const controller = identity.contactId ?? identity.id;
        store.state.tables.pqvd_testoperation = store.state.tables.pqvd_testoperation.filter(
          (row) => row.pqvd_testoperationid !== request.operationId,
        );
        store.state.tables.pqvd_testoperation.push(
          recorderInputs.verified
            ? structuredClone(recorderInputs.operations.find((row) => row.pqvd_testoperationid === request.operationId))
            : {
                pqvd_testoperationid: request.operationId,
                pqvd_name: 'Native campaign replay intent',
                pqvd_runid: { id: capture.runId, logical_name: 'pqvd_testrun' },
                pqvd_runnercontactid: { id: controller, logical_name: 'contact' },
                pqvd_markerutc: marker,
                pqvd_markeroperation: 'CO-OP:' + request.operationId,
                pqvd_roottable: table,
                pqvd_expectedmessage: 'RetrieveMultiple',
                pqvd_lane: request.lane === 'liquid' ? 183270000 : 183270001,
                pqvd_actorprovenance: 'PortalRelationshipClaim',
              },
        );
        if (request.lane === 'webapi' && webApi) {
          const url = new URL(request.url, 'http://127.0.0.1');
          localHttp = await webApi.request(url.pathname + url.search);
          const body = parseExactJson(localHttp.body);
          result = { entities: body.value ?? [] };
          if (localHttp.status >= 400)
            error = {
              code: body.error?.code,
              platformCode: body.error?.cdscode ?? body.error?.innererror?.code ?? null,
              message: body.error?.message,
              status: localHttp.status,
            };
        } else if (request.lane === 'liquid' && liquidClient) {
          localLiquid = await liquidClient.request({
            caseId: request.caseId,
            variant: request.variant,
            templateName: request.templateName,
            operation: {
              ...store.state.tables.pqvd_testoperation.at(-1),
              id: request.operationId,
              pqvd_pagenumber: page,
            },
          });
          result = {
            entities: localLiquid.page.rows,
            more_records: localLiquid.page.more,
            xml: localLiquid.page.effectiveFetchXml,
          };
        } else
          result = await store.readOperation(() =>
            store.fetchXml(source, identity, {
              portalRequest: true,
              profile: request.lane === 'webapi' ? 'webapi' : 'portal',
            }),
          );
      } catch (cause) {
        error = {
          code: cause.code ?? 'NativeReplayUnsupported',
          platformCode: cause.details?.innerCode ?? null,
          message: cause.message,
          status: cause.status,
        };
      }
      captures = recordedPluginPayloads(store.state.tables.pqvd_pluginevent.slice(originalEvents.length));
      let httpExact = null;
      try {
        if (localHttp && http)
          httpExact =
            localHttp.status === http.status &&
            JSON.stringify(canonical(normalizeWire(parseExactJson(localHttp.body)))) ===
              JSON.stringify(canonical(normalizeWire(parseExactJson(http.body))));
      } catch {
        httpExact = false;
      }
      const source = request.authoredFetchXml ?? liquidPage?.authoredFetchXml;
      const liquidExact =
        request.lane === 'liquid' && liquidPage && !error
          ? localLiquid
            ? JSON.stringify(canonical(localLiquid.page)) === JSON.stringify(canonical(liquidPage)) &&
              localLiquid.page.authoredFetchXml === source
            : liquidPage.outcome === 'success' &&
              JSON.stringify(canonical(result?.entities)) === JSON.stringify(canonical(liquidPage.rows)) &&
              Boolean(result?.more_records) === liquidPage.more &&
              result?.xml === liquidPage.effectiveFetchXml
          : null;
      const wireQualified =
        request.lane === 'liquid'
          ? Boolean(liquidClient) && liquidExact === true
          : Boolean(webApi) && httpExact === true;
      const wireFailure =
        wireQualified &&
        (localHttp?.status >= 400 || String(localLiquid?.page.outcome ?? '').startsWith('Liquid error:'));
      const artifacts = compareNativeReadArtifacts(expected, captures, {
        wireQualified,
        wireFailure,
        localPhases,
        localBackendExecutions,
        finalObserverWitness,
      });
      const entry = {
        caseId: request.caseId,
        variant: request.variant,
        lane: request.lane,
        operationId: request.operationId,
        localCount: result?.entities.length,
        error,
        ...artifacts,
        httpExact,
        liquidExact,
        wireQualified,
        capturedEvents: captures.length,
        nativeEvents: expected.length,
        localBackendExecutions,
        localPhases: [...localPhases],
        nativeHttpStatus: http?.status,
        nativeLiquidOutcome: liquidPage?.outcome,
        captures,
        localHttp,
        localLiquid,
      };
      pages.push(entry);
      await progress({ ...entry, captures: undefined });
    }
  } finally {
    store.pluginPipeline = originalPipeline;
    store.fetchXmlCore = originalFetchCore;
    store.state.tables.pqvd_testoperation = originalOperations;
    store.state.tables.pqvd_testrun = originalRuns;
    store.state.tables.pqvd_pluginevent = originalEvents;
    await webApi?.close();
  }
  const witness = validateNativeReadWitness(sourceWitness, binding.receipt, store.nativeReadSnapshot);
  const wireWitness =
    webApiPortal || liquidReplay
      ? validateNativeWireWitness(sourceWitness?.siteComponents, { webApiPortal, liquidReplay })
      : null;
  if (finalObserverWitness && wireWitness?.beforeHash !== finalObserverWitness.siteSourceHash)
    throw new Error('Final observer source does not match its calibrated site source.');
  return {
    durationMs: Date.now() - started,
    pages,
    physicalReads: pages.length,
    qualifiedReads: pages.filter((page) => page.qualified).length,
    qualificationScope:
      finalObserverWitness?.scope ??
      'Observable original CLR query/recorded context and actual wire contracts; hidden backend fault codes remain separately unobserved',
    observerWitness: finalObserverWitness ?? null,
    fullSdkCollectionQualified:
      !finalObserverWitness &&
      pages.every((page) => page.backendAbsenceExact || (page.collectionComplete && page.backendArtifactsExact)),
    recordingInputWitness: { verified: recorderInputs.verified, scope: recorderInputs.scope ?? recorderInputs.reason },
    sourceWitness: witness,
    wireSourceWitness: wireWitness,
    allRuntimeFaultCodesQualified: pages.every((page) => page.backendFaultCodeObserved !== false),
    allQualified: witness.verified && (!wireWitness || wireWitness.verified) && pages.every((page) => page.qualified),
  };
}
