import { createHash } from 'node:crypto';
import { DataStore } from 'paqvilo/mirage/lib/data.mjs';
import { buildPermissionModel } from 'paqvilo/mirage/lib/permissions.mjs';
import { canonicalRows } from './core.mjs';
import { queryFingerprint, capturedQueries, principalFootprint } from './parity.mjs';
import { parseXmlDocument } from 'paqvilo/mirage/lib/fetchxml-engine.mjs';

/** Reconstruct a project fixture state using explicitly supplied native source
 * records. This never contacts Dataverse or changes the portal configuration. */
export function replayStore({
  schema,
  catalogue,
  overlay,
  nativeComponents,
  roles,
  contactId,
  nativeRelationships = {},
  inactivePermissionIds = [],
  observed = {},
}) {
  const records = [...catalogue.records, ...(overlay?.records ?? [])],
    byKey = new Map(records.map((record) => [record.key, record]));
  const mappings = {},
    tables = {},
    relationships = {};
  for (const table of schema.tables) {
    const fields = Object.fromEntries(
      [...(table.primaryName ? [table.primaryName] : []), ...table.columns].map((column) => {
        const options = column.choice
          ? schema.choices?.find((choice) => choice.name === column.choice)?.options
          : undefined;
        return [
          column.name,
          { ...column, type: column.type ?? 'string', ...(options ? { options: structuredClone(options) } : {}) },
        ];
      }),
    );
    mappings[table.name] = {
      logicalName: table.name,
      entitySet: table.entitySetName,
      idColumn: `${table.name}id`,
      primaryNameColumn:
        table.primaryName?.name ??
        (table.name === 'account' ? 'name' : table.name === 'contact' ? 'fullname' : undefined),
      fields,
      relationships: {},
    };
    tables[table.name] = [];
  }
  const allRelationships = [
    ...schema.relationships,
    {
      name: 'account_parent_account',
      kind: 'oneToMany',
      parent: 'account',
      child: 'account',
      lookup: { name: 'parentaccountid' },
    },
    {
      name: 'contact_customer_accounts',
      kind: 'oneToMany',
      parent: 'account',
      child: 'contact',
      lookup: { name: 'parentcustomerid' },
    },
  ];
  for (const relation of allRelationships) {
    if (relation.kind === 'oneToMany') {
      const rel = {
        schemaName: relation.name,
        type: 'one-to-many',
        referencingEntity: relation.child,
        referencedEntity: relation.parent,
        referencingAttribute: relation.lookup.name,
        referencedAttribute: `${relation.parent}id`,
      };
      relationships[relation.name] = rel;
      mappings[relation.child].fields[relation.lookup.name] = { type: 'lookup', targets: [relation.parent] };
      mappings[relation.child].relationships[relation.name] = {
        entity: relation.parent,
        from: relation.lookup.name,
        to: `${relation.parent}id`,
      };
      // Schema relationship identities remain in their own index. A lookup's
      // wire navigation name comes only from explicit source/native metadata.
      const candidates = (nativeRelationships[relation.child] ?? []).filter(
          (row) =>
            row.SchemaName === relation.name &&
            row.ReferencingEntity === relation.child &&
            row.ReferencedEntity === relation.parent &&
            row.ReferencingAttribute === relation.lookup.name &&
            row.ReferencedAttribute === `${relation.parent}id`,
        ),
        declared = relation.referencingNavigationProperty ?? relation.ReferencingEntityNavigationPropertyName;
      if (candidates.length > 1) throw new Error('Native single-valued navigation metadata is ambiguous.');
      const navigation = candidates[0]?.ReferencingEntityNavigationPropertyName ?? declared;
      if (declared && candidates.length && declared !== navigation)
        throw new Error('Declared navigation differs from actual native metadata.');
      if (navigation) {
        if (
          !/^[a-z][a-z\d_]*$/i.test(navigation) ||
          (Object.hasOwn(mappings[relation.child].relationships, navigation) && navigation !== relation.name)
        )
          throw new Error('Native navigation name is invalid or conflicts with another relationship.');
        mappings[relation.child].relationships[navigation] = {
          entity: relation.parent,
          from: relation.lookup.name,
          to: `${relation.parent}id`,
          many: false,
          schemaName: relation.name,
        };
      }
    } else {
      const [attribute1, attribute2] = relation.intersectColumns;
      relationships[relation.name] = {
        schemaName: relation.name,
        type: 'many-to-many',
        entity1: relation.parent,
        entity2: relation.child,
        intersectEntity: relation.intersectName,
        attribute1,
        attribute2,
      };
      mappings[relation.parent].relationships[relation.name] = {
        entity: relation.child,
        from: `${relation.parent}id`,
        to: `${relation.child}id`,
        many: true,
        intersect: { entity: relation.intersectName, from: attribute1, to: attribute2 },
      };
      mappings[relation.child].relationships[relation.name] = {
        entity: relation.parent,
        from: `${relation.child}id`,
        to: `${relation.parent}id`,
        many: true,
        intersect: { entity: relation.intersectName, from: attribute2, to: attribute1 },
      };
      mappings[relation.intersectName] = {
        logicalName: relation.intersectName,
        entitySet: relation.intersectName,
        idColumn: `${relation.intersectName}id`,
        fields: { [attribute1]: { type: 'guid' }, [attribute2]: { type: 'guid' } },
        relationships: {},
      };
      tables[relation.intersectName] = [];
    }
  }
  for (const record of byKey.values()) {
    const values = { ...record.fields, [`${record.table}id`]: record.id };
    for (const [field, target] of Object.entries(record.refs ?? {})) {
      if (target === null) values[field] = null;
      else {
        const reference = byKey.get(target);
        if (!reference) throw new Error('Fixture replay has an unresolved reference.');
        values[field] = { id: reference.id, logical_name: reference.table };
      }
    }
    tables[record.table].push(values);
  }
  let edge = 0;
  const seen = new Set();
  for (const association of [...catalogue.associations, ...(overlay?.associations ?? [])]) {
    const rel = relationships[association.relationship];
    if (!rel?.intersectEntity) throw new Error('Fixture replay has an unresolved association.');
    for (const target of association.to) {
      const from = byKey.get(association.from),
        to = byKey.get(target);
      if (!from || !to) throw new Error('Fixture replay has an unresolved association endpoint.');
      const key = `${association.relationship}:${from.id}:${to.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tables[rel.intersectEntity].push({
        [`${rel.intersectEntity}id`]: `replay-edge-${++edge}`,
        [rel.attribute1]: from.id,
        [rel.attribute2]: to.id,
      });
    }
  }
  const inactive = new Set(inactivePermissionIds);
  const portal = {
    observed,
    records: nativeComponents
      .filter((record) => [11, 18].includes(record.powerpagecomponenttype))
      .map((record) => ({
        ...JSON.parse(record.content),
        id: record.powerpagecomponentid,
        kind: record.powerpagecomponenttype === 11 ? 'webrole' : 'tablepermission',
        name: record.name,
        statecode: inactive.has(record.powerpagecomponentid) ? 1 : record.statecode,
      })),
  };
  const state = {
    mappings,
    tables,
    relationships,
    permissions: [],
    plugins: [],
    simulator: { permissionSource: 'exported' },
    settings: { permissionMode: 'enforce', fetchColumnValidation: 'lenient' },
  };
  const model = buildPermissionModel(portal, state, { relationships, source: 'exported' });
  state.permissions = model.permissions;
  const roleIds = portal.records
    .filter((record) => record.kind === 'webrole' && roles.includes(record.name))
    .map((record) => record.id);
  const actor = tables.contact.find((record) => record.contactid === contactId);
  if (!actor) throw new Error('Fixture replay is missing the bound native actor.');
  const identity = {
    id: contactId,
    contactId,
    roles,
    roleIds,
    roleSource: 'memberships',
    accountId: actor.parentcustomerid?.id,
  };
  const store = new DataStore({ state });
  store.setObserved(observed);
  return { store, identity, diagnostics: model.diagnostics };
}

/** Execute the authored physical pages against Mirage, retaining incomplete
 * errors and the actual query delivered to a stage observer. The host supplies
 * its compiler; fabricated native plugin events are never generated here. */
export function replayLane(native, plan, { store, identity, compile }) {
  const rows = [],
    pages = [],
    differences = [];
  for (const page of native.pages ?? []) {
    let xml = page.authoredFetchXml;
    if (!xml && native.engine === 'liquid' && page.body) {
      const find = (node) => (node.name === 'authored-fetchxml' ? node : node.children.map(find).find(Boolean));
      try {
        xml = find(parseXmlDocument(page.body, { root: 'co-test-response' }))?.text;
      } catch {
        /* Optional payload or browser capability is unavailable. */
      }
    }
    if (!xml && page.authoredRequest) {
      try {
        xml = new URL(
          typeof page.authoredRequest === 'string' ? page.authoredRequest : page.authoredRequest.url,
          'http://127.0.0.1',
        ).searchParams.get('fetchXml');
      } catch {
        /* Optional payload or browser capability is unavailable. */
      }
    }
    if (!xml) {
      differences.push({ kind: 'missing-authored-query', verdict: 'unqualified' });
      continue;
    }
    let expansion, result, error;
    try {
      expansion = compile?.(xml, {
        permissions: store.state.permissions,
        identity,
        mappings: store.state.mappings,
        operation: 'read',
        rules: store.rules.bind(store),
      });
      result = store.fetchXml(xml, identity, {
        profile: native.engine === 'webapi' ? 'webapi' : 'portal',
        portalRequest: true,
      });
      rows.push(...canonicalRows(result.entities, plan));
    } catch (caught) {
      error = {
        code: caught.code,
        platformCode: caught.details?.innerCode ?? null,
        status: caught.status,
        message: caught.message,
      };
    }
    const captured = capturedQueries(page.backendEvents, { operationId: page.operationId });
    const actual = expansion?.xml ? queryFingerprint(expansion.xml) : null;
    const incoming = captured.queries.find((query) => query.stage === 10);
    differences.push({
      kind: 'query-shape',
      page: page.page,
      fragment: page.fragment ?? 1,
      verdict:
        !incoming || !actual || captured.errors.length
          ? 'unqualified'
          : incoming.fingerprint.structuralHash === actual.structuralHash
            ? 'equal'
            : 'different',
      exactBackendXml:
        !incoming || !actual || captured.errors.length ? null : incoming.fingerprint.exactHash === actual.exactHash,
      nativeHash: incoming?.fingerprint.structuralHash,
      mirageHash: actual?.structuralHash,
      nativeLinks: incoming?.fingerprint.linkCount,
      mirageLinks: actual?.linkCount,
      nativePrincipals: incoming?.principalFootprint ?? [],
      miragePrincipals: expansion?.xml ? principalFootprint(expansion.xml) : [],
      roleFootprintStatus:
        !incoming || !actual
          ? 'unqualified'
          : JSON.stringify(incoming.principalFootprint) === JSON.stringify(principalFootprint(expansion.xml))
            ? 'matching'
            : 'requires-cache-controlled-native-capture',
      captureErrors: captured.errors,
      diagnostics: expansion?.diagnostics ?? [],
    });
    pages.push({
      page: page.page,
      fragment: page.fragment ?? 1,
      operationId: page.operationId,
      authoredFetchXml: xml,
      effectiveFetchXml: expansion?.xml,
      httpStatus: error?.status ?? 200,
      count: result?.entities?.length ?? 0,
      error,
      more: result?.more_records,
      backendEvents: [],
    });
  }
  const complete = pages.length === (native.pages?.length ?? 0) && pages.every((page) => !page.error);
  const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const ids = rows.map((row) => row[plan.primaryId]).filter(Boolean);
  return {
    caseId: native.caseId,
    engine: native.engine,
    outcome: complete ? 'success' : 'failed',
    complete,
    rows,
    ids,
    returnedCount: rows.length,
    canonicalHash: digest(rows),
    pages,
    queryComparisons: differences,
    limitation:
      'Authored-page replay with reconstructed fixtures; stage inputs compared separately. HTTP middleware, CLR plugin context and native configuration/data snapshots require independent qualification.',
  };
}
