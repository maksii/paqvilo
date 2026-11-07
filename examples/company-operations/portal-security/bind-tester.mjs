import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConnection, connectedClient } from '../../../lense/dataverse/index.mjs';
import { privateJson } from '../../../lense/dataverse/connection.mjs';
import { buildTesterOverlay, buildStressTesterOverlay } from './tester-overlay.mjs';
import { buildBlueprint, componentId } from './blueprint.mjs';

function projectionSide(relation, table) {
  if (relation.Entity1LogicalName === table) return 1;
  return relation.Entity2LogicalName === table ? 2 : 0;
}

function testerValueEqual(a, b) {
  if (a == null && b == null) return true;
  if (typeof a === 'string' && typeof b === 'string') {
    if (/^[0-9a-f-]{36}$/i.test(a) && /^[0-9a-f-]{36}$/i.test(b)) return a.toLowerCase() === b.toLowerCase();
    if (/^\d{4}-\d\d-\d\d$/.test(b) && a.startsWith(b + 'T00:00:00')) return true;
    if (/^\d{4}-\d\d-\d\dT/.test(a) && /^\d{4}-\d\d-\d\dT/.test(b)) return Date.parse(a) === Date.parse(b);
  }
  return a === b;
}

function managedResetIsAllowed(allowManagedReset, managedRevokedState, row, existing, drift) {
  return (
    allowManagedReset &&
    Number.isInteger(managedRevokedState) &&
    row.table === 'pqvd_accesspermission' &&
    existing?.pqvd_accessstate === managedRevokedState &&
    Object.keys(row.refs)
      .filter((field) => field.endsWith('principalid'))
      .every((field) => existing['_' + field + '_value'] == null) &&
    drift.every((d) => d.field === 'pqvd_accessstate' || /^_pqvd_\w+principalid_value$/.test(d.field))
  );
}

function privateRecordAction(existing, drift, resetAllowed) {
  let action = 'create';
  if (existing && !drift.length) action = 'exists';
  else if (existing) action = resetAllowed ? 'managed-reset-transition' : 'drift';
  return action;
}

function privateRecordBody(row, all, ids, navs, catalogue) {
  const body = { ...row.fields };
  for (const [field, key] of Object.entries(row.refs)) {
    const target = key ? all.get(key) : null,
      rel = navs
        .get(row.table)
        .find((r) => r.ReferencingAttribute === field && (!target || r.ReferencedEntity === target.table));
    if (!rel) throw new Error('Missing verified lookup ' + row.table + '.' + field);
    body[rel.ReferencingEntityNavigationPropertyName + '@odata.bind'] = target
      ? `/${catalogue.tables.find((t) => t.name === target.table).entitySet}(${ids.get(key)})`
      : null;
  }
  return body;
}

function privateRecordDetails({ row, all, ids, navs, catalogue, existing, allowManagedReset, managedRevokedState }) {
  const body = privateRecordBody(row, all, ids, navs, catalogue);
  const expected = {
      ...row.fields,
      ...Object.fromEntries(
        Object.entries(row.refs).map(([field, key]) => ['_' + field + '_value', key ? ids.get(key) : null]),
      ),
    },
    drift = existing
      ? Object.entries(expected)
          .filter(([field, value]) => !testerValueEqual(existing[field], value))
          .map(([field, value]) => ({ field, expected: value, actual: existing[field] ?? null }))
      : [];
  const resetAllowed = managedResetIsAllowed(allowManagedReset, managedRevokedState, row, existing, drift);
  const action = privateRecordAction(existing, drift, resetAllowed);
  const entry = {
    kind: 'private-record',
    key: row.key,
    id: row.id,
    action,
    before: existing,
    etag: existing?.['@odata.etag'] ?? null,
    drift,
  };
  return { body, drift, resetAllowed, entry };
}

function projectionNavigation(relations, source, catalogue) {
  if (relations.length !== 1) throw new Error('Missing projection relationship');
  const relation = relations[0],
    side = projectionSide(relation, source.table);
  if (!side) throw new Error('Projection source table mismatch');
  const navigation = side === 1 ? relation.Entity1NavigationPropertyName : relation.Entity2NavigationPropertyName,
    targetTable = side === 1 ? relation.Entity2LogicalName : relation.Entity1LogicalName,
    target = catalogue.tables.find((t) => t.name === targetTable);
  return { navigation, targetTable, target };
}

function projectionState(current, target, association, ids) {
  const found = new Set(current.map((row) => row[target.primaryId]));
  const expected = new Set(association.to.map((key) => ids.get(key)));
  const extras = [...found].filter((id) => !expected.has(id));
  return { found, extras };
}

function planProjectionTarget({
  key,
  targetTable,
  found,
  ids,
  all,
  source,
  table,
  navigation,
  target,
  relationship,
  from,
  projectionPlans,
}) {
  const row = all.get(key);
  if (row?.table !== targetTable) throw new Error('Projection target type mismatch');
  if (found.has(ids.get(key))) return null;
  projectionPlans.push({ source, table, navigation, target, id: ids.get(key) });
  return {
    kind: 'projection',
    relationship,
    from,
    to: key,
    action: 'add',
  };
}

/* NOSONAR: single-pass routine, splitting it would change shared state */ export async function applyTesterRecords(
  client,
  catalogue,
  overlay,
  { apply = false, allowManagedReset = false, managedRevokedState, onProgress = () => {} } = {},
) {
  const actor = overlay.personas[0];
  await client.get(`contacts(${actor.contactId})?$select=contactid`);
  const all = new Map([...catalogue.records, ...overlay.records].map((r) => [r.key, r])),
    ids = new Map([...all].map(([key, r]) => [key, r.id])),
    navs = new Map();
  for (const row of catalogue.records.filter((r) => r.external)) {
    const filter = Object.entries(row.external.match)
        .map(([k, v]) => `${k} eq '${String(v).replaceAll("'", "''")}'`)
        .join(' and '),
      matches = await client.list(
        `${catalogue.tables.find((t) => t.name === row.table).entitySet}?$filter=${encodeURIComponent(filter)}`,
      );
    if (matches.length !== 1) throw new Error('Existing external reference is unavailable or ambiguous: ' + row.key);
    ids.set(row.key, matches[0][catalogue.tables.find((t) => t.name === row.table).primaryId]);
  }
  const entries = [],
    present = new Set(),
    recordPlans = [],
    projectionPlans = [];
  for (const row of overlay.records.filter((r) => r.table !== 'contact')) {
    const declared = catalogue.tables.find((t) => t.name === row.table),
      existing = await client.optional(`${declared.entitySet}(${row.id})`);
    if (existing && existing[declared.primaryId]?.toLowerCase() !== row.id.toLowerCase())
      throw new Error('Private record primary identity mismatch');
    if (existing) present.add(row.key);
    if (existing && row.table === 'pqvd_accesspermission' && existing._pqvd_granteecontactid_value !== actor.contactId)
      throw new Error('Private grant GUID belongs to another actor');
    if (!navs.has(row.table))
      navs.set(
        row.table,
        await client.list(
          `EntityDefinitions(LogicalName='${row.table}')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencedEntity,ReferencingEntityNavigationPropertyName`,
        ),
      );
    const { body, drift, resetAllowed, entry } = privateRecordDetails({
      row,
      all,
      ids,
      navs,
      catalogue,
      existing,
      allowManagedReset,
      managedRevokedState,
    });
    entries.push(entry);
    await onProgress(entry); // NOSONAR: await kept: the value may be a thenable and timing matters
    if (drift.length && !resetAllowed)
      throw new Error('Private record identity/value drift requires review: ' + row.key);
    if (existing && drift.length && !entry.etag) throw new Error('ETag required for private reset transition');
    recordPlans.push({ row, declared, body, existing, drift, entry });
  }
  for (const association of overlay.associations) {
    const source = all.get(association.from),
      table = catalogue.tables.find((t) => t.name === source.table),
      relations = await client.list(
        `RelationshipDefinitions/Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata?$filter=SchemaName eq '${association.relationship}'`,
      );
    const { navigation, targetTable, target } = projectionNavigation(relations, source, catalogue);
    const current = present.has(source.key) ? await client.list(`${table.entitySet}(${source.id})/${navigation}`) : [];
    const { found, extras } = projectionState(current, target, association, ids);
    if (extras.length) {
      await onProgress({ kind: 'projection-drift', relationship: association.relationship, from: source.key, extras }); // NOSONAR: await kept: the value may be a thenable and timing matters
      throw new Error('Unexpected private projection targets require review: ' + association.relationship);
    }
    for (const key of association.to) {
      const entry = planProjectionTarget({
        key,
        targetTable,
        found,
        ids,
        all,
        source,
        table,
        navigation,
        target,
        relationship: association.relationship,
        from: association.from,
        projectionPlans,
      });
      if (entry) {
        entries.push(entry);
        await onProgress(entry); // NOSONAR: await kept: the value may be a thenable and timing matters
      }
    }
  }
  // Resolve and validate the complete plan before the first write. New sources
  // have no existing links, so their N:N checks do not require creating them.
  if (apply) {
    for (const { row, declared, body, existing, drift, entry } of recordPlans) {
      if (!existing)
        await client.request(declared.entitySet, { method: 'POST', body: { ...body, [declared.primaryId]: row.id } });
      else if (drift.length) {
        const resetBody = Object.fromEntries(
          Object.entries(body).filter(
            ([field]) => field === 'pqvd_accessstate' || field.includes('principalid@odata.bind'),
          ),
        );
        await client.request(`${declared.entitySet}(${row.id})`, {
          method: 'PATCH',
          body: resetBody,
          ifMatch: entry.etag,
        });
      }
    }
    for (const { source, table, navigation, target, id } of projectionPlans)
      await client.request(`${table.entitySet}(${source.id})/${navigation}/$ref`, {
        method: 'POST',
        body: { '@odata.id': client.url(`${target.entitySet}(${id})`) },
      });
  }
  return { entries, resolvedIds: Object.fromEntries(ids) };
}

/* NOSONAR: single-pass routine, splitting it would change shared state */ export async function resetTesterRecords(
  client,
  catalogue,
  overlay,
  { apply = false, managedRevokedState, onProgress = () => {} } = {},
) {
  if (!Number.isInteger(managedRevokedState)) throw new Error('Reset requires the configured Revoked option value');
  // Preflight every managed row before any revocation. This rejects ID takeover,
  // immutable reference drift and unexpected projection targets even on reruns.
  const audit = await applyTesterRecords(client, catalogue, overlay, {
      apply: false,
      allowManagedReset: true,
      managedRevokedState,
      onProgress,
    }),
    byKey = new Map(overlay.records.map((r) => [r.key, r])),
    plans = [];
  for (const key of overlay.provenance.newGrantKeys) {
    const row = byKey.get(key);
    if (row?.table !== 'pqvd_accesspermission') throw new Error('Reset key is not an authored private grant');
    const before = audit.entries.find((e) => e.kind === 'private-record' && e.key === key)?.before;
    if (!before) continue;
    const table = catalogue.tables.find((t) => t.name === row.table),
      navs = await client.list(
        `EntityDefinitions(LogicalName='${row.table}')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencedEntity,ReferencingEntityNavigationPropertyName`,
      ),
      body = resetPrincipalBody(row, navs, managedRevokedState);
    if (!before['@odata.etag']) throw new Error('ETag required for private grant reset');
    const links = [];
    for (const association of overlay.associations.filter((a) => a.from === key)) {
      const relations = await client.list(
        `RelationshipDefinitions/Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata?$filter=SchemaName eq '${association.relationship}'`,
      );
      if (relations.length !== 1) throw new Error('Missing reset projection relationship');
      const relation = relations[0],
        side = projectionSide(relation, row.table);
      if (!side) throw new Error('Reset projection source table mismatch');
      const navigation = side === 1 ? relation.Entity1NavigationPropertyName : relation.Entity2NavigationPropertyName,
        target = catalogue.tables.find(
          (t) => t.name === (side === 1 ? relation.Entity2LogicalName : relation.Entity1LogicalName),
        ),
        current = await client.list(`${table.entitySet}(${row.id})/${navigation}`);
      appendResetLinks(association, navigation, target, current, audit, links);
    }
    const entry = {
      kind: 'reset-grant',
      key,
      id: row.id,
      entitySet: table.entitySet,
      before,
      etag: before['@odata.etag'],
      body,
      links,
      action: 'revoke-and-unlink',
    };
    plans.push(entry);
    await onProgress(entry); // NOSONAR: await kept: the value may be a thenable and timing matters
  }
  if (apply)
    for (const plan of plans) {
      await client.request(`${plan.entitySet}(${plan.id})`, { method: 'PATCH', body: plan.body, ifMatch: plan.etag });
      for (const link of plan.links)
        await client.request(`${plan.entitySet}(${plan.id})/${link.navigation}(${link.targetId})/$ref`, {
          method: 'DELETE',
        });
      const after = await client.get(`${plan.entitySet}(${plan.id})`),
        principals = Object.keys(byKey.get(plan.key).refs).filter((f) => f.endsWith('principalid'));
      verifyRevokedGrant(after, managedRevokedState, principals);
      for (const navigation of new Set(plan.links.map((l) => l.navigation)))
        if ((await client.list(`${plan.entitySet}(${plan.id})/${navigation}`)).length)
          throw new Error('Private reset projection unlink verification failed');
      /* NOSONAR: await kept: the value may be a thenable and timing matters */ await onProgress({
        kind: 'reset-grant-verified',
        key: plan.key,
        id: plan.id,
        principalsCleared: true,
        projectionLinksRemoved: plan.links.length,
      });
    }
  return { plans, applied: apply };
}

function hasUnrelatedGlobalGrant(components, schema, ids) {
  return components.some((c) => {
    if (c.powerpagecomponenttype !== 18 || c.statecode !== 0) return false;
    const p = JSON.parse(c.content ?? '{}');
    return (
      p.scope === 756150000 &&
      schema.tables.some((t) => t.name === p.entitylogicalname) &&
      p.adx_entitypermission_webrole?.some((id) => ids.has(id))
    );
  });
}

function hasUnregisteredBusinessGrant(components, schema, ids, registered) {
  return components.some((c) => {
    if (c.powerpagecomponenttype !== 18 || c.statecode !== 0 || registered.has(c.powerpagecomponentid)) return false;
    const p = JSON.parse(c.content ?? '{}');
    return (
      schema.tables.some((t) => t.name === p.entitylogicalname) &&
      p.adx_entitypermission_webrole?.some((id) => ids.has(id))
    );
  });
}

function roleMutationVerified(wanted, current, own, found) {
  return (
    [...wanted].some((id) => !found.has(id)) ||
    current.filter((r) => !own.has(r.powerpagecomponentid)).some((r) => !found.has(r.powerpagecomponentid)) ||
    [...found].some((id) => own.has(id) && !wanted.has(id))
  );
}

function addExistingSystemRoles(components, ids) {
  for (const role of components.filter(
    (c) =>
      c.powerpagecomponenttype === 11 &&
      c.statecode === 0 &&
      (JSON.parse(c.content ?? '{}').authenticatedusersrole || JSON.parse(c.content ?? '{}').anonymoususersrole),
  ))
    ids.add(role.powerpagecomponentid);
}

function assertNoUnrelatedGlobalGrant(components, schema, ids) {
  if (hasUnrelatedGlobalGrant(components, schema, ids))
    throw new Error('Actual tester has an unrelated Global business grant');
}

function assertNoUnregisteredBusinessGrant(components, schema, ids, registered) {
  if (hasUnregisteredBusinessGrant(components, schema, ids, registered))
    throw new Error('Unrelated active business permission makes the configured fixture oracle incomplete');
}

function roleNeedsRemoval(id, own, wanted) {
  return own.has(id) && !wanted.has(id);
}

function roleNeedsAddition(id, actual) {
  return !actual.has(id);
}

function* roleIdsToRemove(actual, own, wanted) {
  for (const id of actual) if (roleNeedsRemoval(id, own, wanted)) yield id;
}

function* roleIdsToAdd(wanted, actual) {
  for (const id of wanted) if (roleNeedsAddition(id, actual)) yield id;
}

function chooseRoleVariant(overlay, selected) {
  return selected === 'baseline'
    ? ['IT']
    : overlay.personas[0].webRoleVariants?.find((v) => v.roles.length === Number(selected))?.roles;
}

function validateRoleVariant(chosen, selected) {
  if (!chosen || !['baseline', '0', '1', '2', '4', '8', '12'].includes(String(selected)))
    throw new Error('Unknown authored role variant');
}

function hasDeployedWebRole(components, id) {
  return components.some((c) => c.powerpagecomponentid === id && c.powerpagecomponenttype === 11 && c.statecode === 0);
}

function resetPrincipalBody(row, navs, managedRevokedState) {
  const body = { pqvd_accessstate: managedRevokedState };
  for (const field of Object.keys(row.refs).filter((f) => f.endsWith('principalid'))) {
    const relation = navs.find((r) => r.ReferencingAttribute === field && r.ReferencedEntity === 'contact');
    if (!relation?.ReferencingEntityNavigationPropertyName)
      throw new Error('Reset principal lookup navigation unavailable');
    body[relation.ReferencingEntityNavigationPropertyName + '@odata.bind'] = null;
  }
  return body;
}

function appendResetLinks(association, navigation, target, current, audit, links) {
  const expected = new Set(association.to.map((key) => audit.resolvedIds[key]));
  if (current.some((item) => !expected.has(item[target.primaryId])))
    throw new Error('Unexpected private reset projection targets require review');
  for (const targetRow of current)
    links.push({
      relationship: association.relationship,
      navigation,
      targetId: targetRow[target.primaryId],
      before: targetRow,
    });
}

function verifyRevokedGrant(after, managedRevokedState, principals) {
  if (
    after.pqvd_accessstate !== managedRevokedState ||
    principals.some((field) => after['_' + field + '_value'] != null)
  )
    throw new Error('Private grant revocation verification failed');
}

export async function setTesterRoles(
  client,
  siteId,
  catalogue,
  schema,
  overlay,
  { selected = 'baseline', apply = false, onProgress = () => {} } = {},
) {
  const b = buildBlueprint(schema, catalogue),
    actor = overlay.personas[0],
    current = await client.list(
      `contacts(${actor.contactId})/powerpagecomponent_mspp_webrole_contact?$select=powerpagecomponentid,name`,
    ),
    components = await client.list(`powerpagecomponents?$filter=_powerpagesiteid_value eq ${siteId}`),
    ids = new Set(current.map((r) => r.powerpagecomponentid));
  const site = await client.get(`powerpagesites(${siteId})`);
  if (site.datamodelversion !== '2.0' || site.enhancedauthorization !== 0)
    throw new Error('Requires enhanced model with traditional authorization');
  addExistingSystemRoles(components, ids);
  assertNoUnrelatedGlobalGrant(components, schema, ids);
  const registered = new Set(b.nodes.map((n) => n.id));
  assertNoUnregisteredBusinessGrant(components, schema, ids, registered);
  const chosen = chooseRoleVariant(overlay, selected);
  validateRoleVariant(chosen, selected);
  const wanted = new Set([...chosen, 'TESTRUNNER'].map((code) => componentId('role:' + code))),
    own = new Set(b.roles.map((r) => r.id)),
    actual = new Set(current.map((r) => r.powerpagecomponentid)),
    entries = [];
  for (const id of roleIdsToRemove(actual, own, wanted)) {
    if (apply)
      await client.request(`contacts(${actor.contactId})/powerpagecomponent_mspp_webrole_contact(${id})/$ref`, {
        method: 'DELETE',
      });
    const entry = { kind: 'role', id, action: 'remove' };
    entries.push(entry);
    await onProgress(entry); // NOSONAR: await kept: the value may be a thenable and timing matters
  }
  for (const id of roleIdsToAdd(wanted, actual)) {
    if (!hasDeployedWebRole(components, id)) throw new Error('Required web role not deployed to this site');
    if (apply)
      await client.request(`contacts(${actor.contactId})/powerpagecomponent_mspp_webrole_contact/$ref`, {
        method: 'POST',
        body: { '@odata.id': client.url(`powerpagecomponents(${id})`) },
      });
    const entry = { kind: 'role', id, action: 'add' };
    entries.push(entry);
    await onProgress(entry); // NOSONAR: await kept: the value may be a thenable and timing matters
  }
  if (apply) {
    const after = await client.list(
        `contacts(${actor.contactId})/powerpagecomponent_mspp_webrole_contact?$select=powerpagecomponentid`,
      ),
      found = new Set(after.map((r) => r.powerpagecomponentid));
    if (roleMutationVerified(wanted, current, own, found)) throw new Error('Tester role mutation verification failed');
  }
  return {
    selected,
    businessRoles: chosen,
    preservedOriginalRoleIds: current
      .filter((r) => !own.has(r.powerpagecomponentid))
      .map((r) => r.powerpagecomponentid),
    entries,
    portalQualification:
      'Refresh target site cache or re-sign in, then require Liquid user.roles to match this selected variant before interpreting results.',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    arg = (name) => {
      const i = args.indexOf(name);
      return i < 0 ? undefined : args[i + 1];
    },
    project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    mode = arg('--mode') ?? 'baseline',
    contactId = arg('--contact')?.toLowerCase(),
    siteId = arg('--site')?.toLowerCase();
  if (
    !['baseline', 'stress', 'roles', 'reset'].includes(mode) ||
    ![contactId, siteId].every((v) => /^[0-9a-f-]{36}$/i.test(v ?? ''))
  )
    throw new Error('Select --mode baseline/stress/roles/reset and provide --contact and --site GUIDs.');
  const directory = arg('--out') ?? path.join(project, '.paqvilo/portal-security/tester-' + contactId.slice(0, 8));
  if (!path.resolve(directory).split(path.sep).includes('.paqvilo'))
    throw new Error('Actual identities and state must stay under ignored .paqvilo');
  await fs.mkdir(directory, { recursive: true });
  const catalogue = JSON.parse(
      await fs.readFile(arg('--catalogue') ?? path.join(project, 'data/stress-catalogue.json')),
    ),
    schema = JSON.parse(await fs.readFile(path.join(project, 'dataverse/manifest.json'))),
    connection = await loadConnection(arg('--connection') ?? '.paqvilo/dataverse/provisioning.connection.json'),
    client = connectedClient(connection);
  await client.verify(connection.organisationId);
  const baseline = buildTesterOverlay(catalogue, contactId);
  let overlay = baseline;
  if (arg('--overlay')) overlay = JSON.parse(await fs.readFile(arg('--overlay')));
  else if (mode !== 'baseline') overlay = buildStressTesterOverlay(catalogue, baseline);
  if (overlay.personas?.[0]?.contactId !== contactId || !overlay.private)
    throw new Error('Private overlay identity mismatch');
  const before = await client.list(
      `contacts(${contactId})/powerpagecomponent_mspp_webrole_contact?$select=powerpagecomponentid,name`,
    ),
    journal = {
      startedAt: new Date().toISOString(),
      organisationId: connection.organisationId,
      mode,
      selectedRoleVariant: mode === 'roles' ? String(arg('--role-count')) : 'baseline',
      contactId,
      siteId,
      apply: args.includes('--apply'),
      beforeRoles: before,
      entries: [],
    },
    file = path.join(directory, 'journal-' + Date.now() + '.json'),
    save = () => privateJson(file, journal);
  await save();
  const progress = (e) => {
    journal.entries.push(e);
    return save();
  };
  await setTesterRoles(client, siteId, catalogue, schema, overlay, { selected: 'baseline', apply: false });
  if (['baseline', 'stress'].includes(mode))
    journal.records = await applyTesterRecords(client, catalogue, overlay, {
      apply: journal.apply,
      allowManagedReset: args.includes('--allow-managed-reset'),
      managedRevokedState: schema.choices
        .find((c) => c.name === 'pqvd_accessstate')
        .options.find((o) => o.label === 'Revoked').value,
      onProgress: progress,
    });
  journal.roles = await setTesterRoles(client, siteId, catalogue, schema, overlay, {
    selected: mode === 'roles' ? String(arg('--role-count')) : 'baseline',
    apply: journal.apply,
    onProgress: progress,
  });
  if (mode === 'reset')
    journal.reset = await resetTesterRecords(client, catalogue, overlay, {
      apply: journal.apply,
      managedRevokedState: schema.choices
        .find((c) => c.name === 'pqvd_accessstate')
        .options.find((o) => o.label === 'Revoked').value,
      onProgress: progress,
    });
  overlay.personas[0].webRoles = journal.roles.businessRoles;
  overlay.provenance.originalRoles = before;
  overlay.provenance.journal = file;
  await privateJson(path.join(directory, 'overlay.json'), overlay);
  journal.finishedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify({
      mode,
      applied: journal.apply,
      privateRecords: overlay.records.length,
      businessRoles: journal.roles.businessRoles,
      journal: file,
      overlay: path.join(directory, 'overlay.json'),
    }),
  );
}
