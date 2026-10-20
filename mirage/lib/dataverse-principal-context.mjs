import { DataError } from './data-error.mjs';
import { dataverseIdentity } from './dataverse-security.mjs';

/** Organization authorization remains with principals/FLS; admin only bypasses
 * the separate Power Pages visitor permission model in the shared row store. */
export function organizationPrincipalContext(store, user, { caller = user, appId } = {}) {
  if (!user || user.isdisabled === true)
    throw new DataError('The selected staff user is unavailable or disabled.', 401, 'StaffPrincipalUnavailable');
  const { hierarchy, userHierarchy, ...facts } = dataverseIdentity(store, user);
  const dataverse = Object.defineProperties({ appId, ...facts, callerId: caller.systemuserid, accessMode: user.accessmode }, {
    hierarchy: { value: hierarchy }, userHierarchy: { value: userHierarchy },
  });
  return { user, caller, identity: { admin: true, id: user.systemuserid, systemUserId: user.systemuserid,
    businessUnitId: facts.businessUnitId, dataverse } };
}
