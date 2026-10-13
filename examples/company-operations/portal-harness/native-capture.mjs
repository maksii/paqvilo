import { createHash } from 'node:crypto';
import { stable, escapeXml } from './core.mjs';

export const snapshotHash = value => createHash('sha256').update(stable(value)).digest('hex');
const omitVolatile = row => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('@') && !key.includes('@OData.')).sort(([a], [b]) => a.localeCompare(b)));
const sortedRows = rows => rows.map(omitVolatile).sort((a, b) => stable(a).localeCompare(stable(b)));
const identity = value => String(value ?? '').replace(/[{}]/g, '').toLowerCase();
const credentialColumn = key => /(?:password|token|securitystamp|secret|salt)/i.test(key);
async function fixtureRows(client, query) {
  if (!client.request) return client.list(query);
  const rows = [], visited = new Set();
  let next = query;
  while (next) {
    if (visited.has(next) || visited.size >= 1000) throw new Error('Invalid native fixture continuation.');
    visited.add(next);
    const page = (await client.request(next, {prefer: 'odata.include-annotations="Microsoft.Dynamics.CRM.lookuplogicalname"'})).data;
    if (!Array.isArray(page?.value)) throw new Error('Native fixture collection missing.');
    rows.push(...page.value); next = page['@odata.nextLink'];
  }
  return rows;
}

/** Read only the explicitly declared fixture identities and current actor.
 * Recorder writes from the measurement do not alter the business snapshot. */
export async function captureNativeSnapshot(client, {siteId, contactId, catalogue, overlays = [], resolvedIds = {}, inactiveProjectionSources = []}) {
  const components = await client.list(`powerpagecomponents?$select=powerpagecomponentid,powerpagecomponenttype,name,statecode,statuscode,content,_powerpagesiteid_value&$filter=_powerpagesiteid_value eq ${siteId} and (powerpagecomponenttype eq 11 or powerpagecomponenttype eq 18)`);
  const memberships = await client.list(`contacts(${contactId})/powerpagecomponent_mspp_webrole_contact?$select=powerpagecomponentid,name,statecode,statuscode,_powerpagesiteid_value`);
  const records = [...catalogue.records, ...overlays.flatMap(overlay => overlay.records ?? [])];
  const tables = {}, rowVersions = {}, completenessErrors = [];
  const actor = await client.get(`contacts(${contactId})?$select=contactid,_parentcustomerid_value,statecode,statuscode`);
  if (identity(actor.contactid) !== identity(contactId)) throw new Error('Native actor identity readback failed.');
  const customerId = actor._parentcustomerid_value;
  let actorCustomer = null;
  if (customerId) {
    const annotatedType = actor['_parentcustomerid_value@Microsoft.Dynamics.CRM.lookuplogicalname'];
    if (annotatedType && !['account', 'contact'].includes(annotatedType)) throw new Error('Unsupported native actor customer type.');
    // Resolve an unannotated polymorphic reference through its actual typed row.
    const candidates = [];
    for (const type of annotatedType ? [annotatedType] : ['account', 'contact']) {
      const endpoint = type === 'account' ? `accounts(${customerId})?$select=accountid,name,accountnumber,_parentaccountid_value,statecode,statuscode` : `contacts(${customerId})?$select=contactid,_parentcustomerid_value,statecode,statuscode`;
      const row = await client.optional(endpoint);
      if (row) candidates.push({type, id: identity(customerId), row: omitVolatile(row), rowVersion: /^W\/"(\d+)"$/.exec(String(row['@odata.etag'] ?? ''))?.[1] ?? null});
    }
    if (candidates.length !== 1) throw new Error('Native actor customer binding is absent or ambiguous.');
    actorCustomer = candidates[0];
  }
  if (components.some(component => component._powerpagesiteid_value !== undefined && identity(component._powerpagesiteid_value) !== identity(siteId))) completenessErrors.push({kind: 'foreign-site-component'});
  const siteMemberships = memberships.filter(role => !role._powerpagesiteid_value || identity(role._powerpagesiteid_value) === identity(siteId));
  for (const role of siteMemberships) if (!components.some(component => component.powerpagecomponenttype === 11 && identity(component.powerpagecomponentid) === identity(role.powerpagecomponentid) && component.statecode === 0)) completenessErrors.push({kind: 'membership-role-unresolved', roleId: role.powerpagecomponentid});
  for (const table of catalogue.tables) {
    const ids = [...new Set(records.filter(record => record.table === table.name).map(record => resolvedIds[record.key] ?? record.id))];
    if (!ids.length) continue;
    const rows = [];
    for (let offset = 0; offset < ids.length; offset += 60) {
      const xml = `<fetch><entity name="${escapeXml(table.name)}"><all-attributes/><filter><condition attribute="${escapeXml(table.primaryId)}" operator="in">${ids.slice(offset, offset + 60).map(id => `<value>${escapeXml(id)}</value>`).join('')}</condition></filter><order attribute="${escapeXml(table.primaryId)}"/></entity></fetch>`;
      rows.push(...await fixtureRows(client, `${table.entitySet}?fetchXml=${encodeURIComponent(xml)}`));
    }
    const expectedIds = new Set(ids.map(identity)), foundIds = rows.map(row => identity(row[table.primaryId]));
    const missing = [...expectedIds].filter(id => !foundIds.includes(id)), unexpected = foundIds.filter(id => !expectedIds.has(id));
    const duplicates = [...new Set(foundIds.filter((id, index) => foundIds.indexOf(id) !== index))];
    if (missing.length || unexpected.length || duplicates.length) completenessErrors.push({kind: 'fixture-identities', table: table.name, missing, unexpected, duplicates});
    rowVersions[table.name] = Object.fromEntries(rows.map(row => [identity(row[table.primaryId]), /^W\/"(\d+)"$/.exec(String(row['@odata.etag'] ?? ''))?.[1]
      ?? (row.versionnumber !== undefined && row.versionnumber !== null ? String(row.versionnumber) : null)]));
    // Row version changes remain visible independently but do not change logical
    // fixture values. Audit timestamps and ownership are retained: they can affect
    // filters and plugin behavior, so a change prevents snapshot qualification.
    tables[table.name] = sortedRows(rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'versionnumber' && !credentialColumn(key)))));
  }
  const projections = {}, projectionCatalogueDifferences = [];
  for (const key of inactiveProjectionSources) {
    const record = records.find(record => record.key === key), table = catalogue.tables.find(table => table.name === record?.table);
    const actual = table && tables[table.name]?.find(row => identity(row[table.primaryId]) === identity(resolvedIds[key] ?? record.id));
    if (!actual || Object.entries(actual).some(([field, value]) => /_.*principalid_value$/.test(field) && value !== null)) completenessErrors.push({kind: 'inactive-projection-source-not-cleared', key});
  }
  for (const relation of [...new Set([...catalogue.associations, ...overlays.flatMap(overlay => overlay.associations ?? [])].map(association => association.relationship))]) {
    // Explicit intersect tables have no portal read path; this is an app-only
    // fixture snapshot and never a persona authorization oracle.
    if (!/^[a-z][a-z\d_]*$/i.test(relation)) throw new Error('Unsafe fixture relationship name.');
    const metadata = await client.list(`RelationshipDefinitions/Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata?$filter=SchemaName eq '${relation}'&$select=IntersectEntityName,Entity1LogicalName,Entity2LogicalName,Entity1IntersectAttribute,Entity2IntersectAttribute`);
    if (metadata.length !== 1 || !metadata[0].IntersectEntityName) throw new Error('Native projection metadata is absent or ambiguous.');
    const entity = metadata[0].IntersectEntityName;
    const mapping = await client.get(`EntityDefinitions(LogicalName='${entity}')?$select=EntitySetName`);
    const xml = `<fetch><entity name="${escapeXml(entity)}"><all-attributes/></entity></fetch>`;
    const rows = await client.list(`${mapping.EntitySetName}?fetchXml=${encodeURIComponent(xml)}`);
    const relationMetadata = metadata[0], byKey = new Map(records.map(record => [record.key, record]));
    const expected = [];
    for (const association of [...catalogue.associations, ...overlays.flatMap(overlay => overlay.associations ?? [])].filter(association => association.relationship === relation && !inactiveProjectionSources.includes(association.from))) {
      for (const target of association.to) {
        const from = byKey.get(association.from), to = byKey.get(target);
        if (!from || !to) {completenessErrors.push({kind: 'projection-endpoint-unresolved', relationship: relation, from: association.from, to: target}); continue;}
        const forward = from.table === relationMetadata.Entity1LogicalName && to.table === relationMetadata.Entity2LogicalName;
        const reverse = from.table === relationMetadata.Entity2LogicalName && to.table === relationMetadata.Entity1LogicalName;
        if (!forward && !reverse) {completenessErrors.push({kind: 'projection-endpoint-type', relationship: relation}); continue;}
        const fromId = identity(resolvedIds[from.key] ?? from.id), toId = identity(resolvedIds[to.key] ?? to.id);
        expected.push(forward ? `${fromId}:${toId}` : `${toId}:${fromId}`);
      }
    }
    const actual = rows.map(row => `${identity(row[relationMetadata.Entity1IntersectAttribute])}:${identity(row[relationMetadata.Entity2IntersectAttribute])}`);
    const expectedSet = new Set(expected), actualSet = new Set(actual);
    const missing = [...expectedSet].filter(pair => !actualSet.has(pair)), unexpected = [...actualSet].filter(pair => !expectedSet.has(pair));
    const duplicates = [...actualSet].filter(pair => actual.filter(value => value === pair).length > 1);
    // Inactive sources are an explicit journalled campaign configuration; the
    // default requires every declared projection and rejects foreign links.
    if (missing.length || unexpected.length || duplicates.length) projectionCatalogueDifferences.push({relationship: relation, missing, unexpected, duplicates});
    if (missing.length || unexpected.length || duplicates.length) completenessErrors.push({kind: 'projection-identities', relationship: relation, missing, unexpected, duplicates});
    projections[relation] = sortedRows(rows);
  }
  const permissions = sortedRows(components), members = sortedRows(memberships);
  const actorBinding = {actor: omitVolatile(actor), customer: actorCustomer ? {type:actorCustomer.type,id:actorCustomer.id,row:actorCustomer.row} : null};
  rowVersions.actor = {contact: /^W\/"(\d+)"$/.exec(String(actor['@odata.etag'] ?? ''))?.[1] ?? null};
  if(actorCustomer)rowVersions.actor.customer=actorCustomer.rowVersion;
  return {schemaVersion: 1, capturedAt: new Date().toISOString(), siteId, contactId, excludedColumnPolicy: 'Credential/token/password/securitystamp/secret/salt column names are excluded from fixture rows; portal request artifacts remain verbatim.', permissions, memberships: members, siteMemberships: sortedRows(siteMemberships), foreignSiteMemberships: sortedRows(memberships.filter(role => !siteMemberships.includes(role))), tables, projections, inactiveProjectionSources, projectionCatalogueAligned: projectionCatalogueDifferences.length === 0, projectionCatalogueDifferences, rowVersions, rowVersionSnapshotHash: snapshotHash(rowVersions), complete: completenessErrors.length === 0, completenessErrors,
    actorBinding, permissionSnapshotHash: snapshotHash(permissions), membershipSnapshotHash: snapshotHash(members), dataSnapshotHash: snapshotHash({tables, projections, actorBinding})};
}

export function compareNativeSnapshots(before, after) {
  const changed = ['permissionSnapshotHash', 'membershipSnapshotHash', 'dataSnapshotHash'].filter(field => before[field] !== after[field]);
  if (before.siteId !== after.siteId || before.contactId !== after.contactId) changed.push('identity');
  if (before.complete !== true || after.complete !== true) changed.push('incomplete-snapshot');
  const rowVersionsStable = !!before.rowVersionSnapshotHash && before.rowVersionSnapshotHash === after.rowVersionSnapshotHash;
  if (!rowVersionsStable) changed.push('rowVersionSnapshotHash');
  return {stable: changed.length === 0, changed};
}
