import { DataError } from './data-error.mjs';
import { handoffPluginResponse } from './plugin-response.mjs';
const fail = (message, code = 'LocalSdkRelationshipUnsupported', status = 501) => {
  throw new DataError(message, status, code);
};
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const scalar = (value) => (value && typeof value === 'object' && value.id ? value.id : value);
/** SDK schema names are not navigation properties. Select one source-defined
 * direction, retaining explicit EntityRole for self-referential relationships. */
export function associationBinding(store, entity, relationship, related, identity) {
  if (
    relationship?.$type !== 'Relationship' ||
    typeof relationship.schemaName !== 'string' ||
    !relationship.schemaName.trim() ||
    related?.$type !== 'EntityReferenceCollection' ||
    !Array.isArray(related.values) ||
    !related.values.length ||
    related.values.length > 1000
  )
    fail('SDK relationship and 1-1000 typed related references are required.');
  if (
    related.values.some(
      (ref) =>
        ref?.$type !== 'EntityReference' || !uuid.test(ref.id) || ref.logicalName !== related.values[0].logicalName,
    ) ||
    new Set(related.values.map((ref) => ref.id.toLowerCase())).size !== related.values.length
  )
    fail(
      'Related SDK references must have unique valid IDs and one exact target table.',
      'LocalSdkRelationshipInput',
      400,
    );
  const mapping = store.resolveMapping(entity),
    role = relationship.primaryEntityRole;
  if (role !== null && role !== undefined && !['Referencing', 'Referenced'].includes(role))
    fail('SDK EntityRole is not supported.');
  const candidates = Object.entries(store.relationshipsFor(mapping, identity)).filter(
    ([, rel]) =>
      rel.schemaName?.toLowerCase() === relationship.schemaName.toLowerCase() &&
      rel.entity === related.values[0].logicalName &&
      (!role ||
        (!rel.intersect && role === (rel.many === false ? 'Referencing' : 'Referenced')) ||
        (rel.intersect && rel.sdkEntityRole === role)),
  );
  if (candidates.length !== 1)
    fail(
      'SDK relationship schema/direction must resolve to one exact source mapping; self-reference needs source EntityRole metadata.',
    );
  const [navigation, rel] = candidates[0];
  if (rel.many === false && related.values.length !== 1)
    fail('A referencing lookup accepts one related SDK reference.', 'LocalSdkRelationshipInput', 400);
  return { mapping, navigation, rel };
}
/** The SDK Associate/Disassociate: explicit grants, plug-in stages 10/20/40 and the store association write. executeAssociation
 * runs them synchronously (a synchronous service endpoint step posts through the synchronous I/O bridge: the SDK inside a
 * plug-in); executeAssociationAsync awaits each stage's post and the related row's update steps (a flow Relate/Unrelate rows
 * action, which is not nested inside a plug-in), so Mirage keeps serving while a receiver answers. */
export function executeAssociation(options) {
  const steps = associationSteps(options, false);
  let next = steps.next();
  while (!next.done) next = steps.next(next.value);
  return next.value;
}
export async function executeAssociationAsync(options) {
  const steps = associationSteps(options, true);
  let next = steps.next();
  while (!next.done) {
    let answer,
      failed = false;
    try {
      answer = await next.value;
    } catch (error) {
      answer = error;
      failed = true;
    }
    next = failed ? steps.throw(answer) : steps.next(answer);
  }
  return next.value;
}
function* associationSteps(
  { store, entity, id, relationship, related, identity, authorize, associate, responseToken },
  awaitIo,
) {
  if (!uuid.test(id)) fail('SDK association requires a valid source ID.', 'LocalSdkRelationshipInput', 400);
  const { mapping, navigation, rel } = associationBinding(store, entity, relationship, related, identity),
    operation = associate ? 'associate' : 'disassociate';
  const get = (table, key) => {
    const row = store.get(table, key, identity, { skipPluginRead: true });
    if (!row) fail('SDK association row not found.', 'NotFound', 404);
    return row;
  };
  let source, records;
  const checkPermissions = () => {
    source = get(entity, id);
    records = related.values.map((ref) => get(ref.logicalName, ref.id));
    authorize(entity, operation, source);
    for (const row of records) authorize(rel.entity, operation, row);
    if (rel.intersect) {
      for (const row of records) {
        const values = { [rel.intersect.from]: scalar(source[rel.from]), [rel.intersect.to]: scalar(row[rel.to]) };
        const edges = store.snapshot().tables[rel.intersect.entity] ?? [],
          existing = edges.filter((edge) => Object.keys(values).every((key) => scalar(edge[key]) === values[key]));
        for (const edge of existing.length ? existing : [values])
          authorize(rel.intersect.entity, associate ? 'create' : 'delete', edge);
      }
    } else {
      const affected = rel.many === false ? [source] : records;
      for (const row of affected) {
        const table = rel.many === false ? entity : rel.entity,
          column = rel.many === false ? rel.from : rel.to,
          value = scalar(rel.many === false ? records[0][rel.to] : source[rel.from]);
        authorize(table, 'update', row);
        if (associate || scalar(row[column]) === value)
          authorize(table, 'update', { ...row, [column]: associate ? value : null });
      }
    }
  };
  checkPermissions();
  const parameters = {
      Target: { $type: 'EntityReference', logicalName: mapping.logicalName, id, name: null },
      Relationship: {
        $type: 'Relationship',
        schemaName: relationship.schemaName,
        primaryEntityRole: relationship.primaryEntityRole ?? null,
      },
      RelatedEntities: {
        $type: 'EntityReferenceCollection',
        values: related.values.map((ref) => ({
          $type: 'EntityReference',
          logicalName: ref.logicalName,
          id: ref.id,
          name: ref.name ?? null,
        })),
      },
    },
    original = JSON.stringify(parameters),
    holder = structuredClone(source),
    inherited = store.pluginInTransaction;
  const phase = function* (stage) {
    if (stage !== 10) store.pluginInTransaction = true;
    if (store.pluginPipeline && store.pluginPipelineActive({ entity: mapping.logicalName, operation })) {
      const frame = yield store.pluginPipeline({
        entity: mapping.logicalName,
        operation,
        stage,
        associationParameters: parameters,
        record: holder,
        identity,
        changedAttributes: [],
        ...(awaitIo ? { awaitIo: true } : {}),
      });
      if (stage === 40) handoffPluginResponse(store, operation, mapping.logicalName, frame, responseToken);
    }
    if (JSON.stringify(parameters) !== original)
      fail('Association parameter replacement requires a source-qualified validation adapter.');
  };
  const change = (...args) =>
    awaitIo ? store.changeAssociationRecordAsync(...args) : store.changeAssociationRecord(...args);
  try {
    yield* phase(10);
    yield* phase(20);
    checkPermissions();
    if (rel.many !== false) {
      for (const ref of related.values) yield change(entity, id, navigation, ref.id, identity, associate);
    } else {
      const targetMapping = store.resolveMapping(rel.entity),
        reverse = Object.entries(store.relationshipsFor(targetMapping, identity)).filter(
          ([nav, candidate]) =>
            nav === rel.partner &&
            candidate.schemaName === rel.schemaName &&
            candidate.entity === mapping.logicalName &&
            candidate.many !== false &&
            !candidate.intersect,
        );
      if (reverse.length !== 1)
        fail('Referencing SDK relationship requires its exact source-defined collection partner.');
      yield change(rel.entity, related.values[0].id, reverse[0][0], id, identity, associate);
    }
    if (rel.intersect && associate) {
      for (const row of records) {
        const values = { [rel.intersect.from]: scalar(source[rel.from]), [rel.intersect.to]: scalar(row[rel.to]) };
        for (const edge of store.snapshot().tables[rel.intersect.entity] ?? [])
          if (Object.keys(values).every((key) => scalar(edge[key]) === values[key]))
            authorize(rel.intersect.entity, 'create', edge);
      }
    }
    if (!rel.intersect) {
      const table = rel.many === false ? entity : rel.entity,
        keys = rel.many === false ? [id] : related.values.map((ref) => ref.id);
      for (const key of keys) authorize(table, 'update', get(table, key));
    }
    yield* phase(40);
    return null;
  } finally {
    store.pluginInTransaction = inherited;
  }
}
