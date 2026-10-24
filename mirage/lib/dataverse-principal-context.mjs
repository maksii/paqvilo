import { DataError } from './data-error.mjs';
import { dataverseIdentity } from './dataverse-security.mjs';

/** Organization authorization remains with principals/FLS; admin only bypasses
 * the separate Power Pages visitor permission model in the shared row store. */
export function organizationPrincipalContext(store, user, { caller = user, appId } = {}) {
  if (!user || user.isdisabled === true)
    throw new DataError('The selected staff user is unavailable or disabled.', 401, 'StaffPrincipalUnavailable');
  const { hierarchy, userHierarchy, ...facts } = dataverseIdentity(store, user);
  const dataverse = Object.defineProperties(
    { appId, ...facts, callerId: caller.systemuserid, accessMode: user.accessmode },
    {
      // The organization's hierarchy module (api.hierarchy.resolve: metadata and pack-declared hierarchies) answers first.
      hierarchy: {
        value: (table, attribute, id, mode) =>
          store.hierarchyResolver?.(table, id, mode) ?? hierarchy(table, attribute, id, mode),
      },
      userHierarchy: { value: userHierarchy },
    },
  );
  return {
    user,
    caller,
    identity: {
      admin: true,
      id: user.systemuserid,
      systemUserId: user.systemuserid,
      businessUnitId: facts.businessUnitId,
      dataverse,
    },
  };
}
