import { randomUUID } from 'node:crypto';
import { DataError } from './data-error.mjs';
import { dataverseIdentity } from './dataverse-security.mjs';
import { parseDataverseRoute, parsePrefer } from './dataverse-odata.mjs';

/** Local administration uses the organization record pipeline, including its
 * validation, plug-ins, workflows, audit and optimistic concurrency. The host
 * supplies the principal and the outer serialized transaction; this adapter
 * neither authenticates portal visitors nor opens an HTTP connection. */
export function createModelDrivenRecordService({ store, records, principal, origin, run }) {
  return async ({ entity, id, values = {}, remove = false, etag }) => {
    const mapping = store.resolveMapping(entity);
    const user = principal();
    if (!user) throw new DataError('The local administration principal is unavailable.', 409, 'LocalPrincipalUnavailable');
    const { hierarchy, userHierarchy, ...facts } = dataverseIdentity(store, user);
    const dataverse = Object.defineProperties({ ...facts, callerId: user.systemuserid, accessMode: user.accessmode }, {
      hierarchy: { value: hierarchy }, userHierarchy: { value: userHierarchy },
    });
    const identity = { admin: true, id: user.systemuserid, systemUserId: user.systemuserid, businessUnitId: facts.businessUnitId, dataverse };
    const body = {};
    for (const [name, value] of Object.entries(values)) {
      const field = store.fieldDefinition(entity, name);
      if (!['lookup', 'customer', 'owner'].includes(String(field?.dataverseType ?? field?.type).toLowerCase())) {
        body[name] = value;
        continue;
      }
      const targetEntity = value?.logical_name ?? value?.logicalName ?? value?.entity ?? field.targets?.[0];
      const target = targetEntity && store.resolveMapping(targetEntity);
      const navigation = Object.entries(mapping.relationships ?? {}).find(([, relationship]) => relationship.many === false && relationship.from === name && (!targetEntity || relationship.entity === targetEntity))?.[0] ?? name;
      if (value == null || value === '') body[`${navigation}@odata.bind`] = null;
      else {
        const targetId = value?.id ?? value?.value ?? value;
        if (!target || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(String(targetId)))
          throw new DataError(`Choose a record for ${name}.`, 400, 'InvalidLookup');
        body[`${navigation}@odata.bind`] = `/${target.entitySet}(${targetId})`;
      }
    }
    const method = remove ? 'DELETE' : id ? 'PATCH' : 'POST';
    const url = new URL(`/api/data/v9.2/${mapping.entitySet}${id ? `(${id})` : ''}`, origin());
    const response = await run(() => records.handle({
      method, url, origin: url.origin, version: 'v9.2', route: parseDataverseRoute(url.pathname),
      prefer: parsePrefer('return=representation'), headers: { ...(etag ? { 'if-match': etag } : {}) },
      body, user, caller: user, identity, requestId: randomUUID(),
    }));
    return remove ? { deleted: true } : { id: id ?? response.body?.[mapping.idColumn] };
  };
}
