// The Dataverse caller of a portal request (a form, list, notes or Web API call of a portal visitor). Hosted session F2
// (paqvilo-developer hosted-f2, Enhanced data model, enhancedauthorization 3 per the session's setup correction): every
// message the portal sent reached the plug-in pipeline with UserId and InitiatingUserId the site's host application user
// ("# Portals-<site>"), IsPortalsClientCall true and PortalsContactId the signed-in contact. So with enhanced
// authorization the caller is the application user, not the visitor's mapped user (whose privileges authorize the
// request). The standard model (state 0, hosted F2 re-run s0n/s0q) reports the same caller, the application user portal
// queries run as (portal-authorization.mjs readerUser).

// A platform write the portal makes for the visitor without the visitor's table permissions (the multistep session row,
// web-form-session-row.mjs) is an admin write marked portalPlatformWrite: still the visitor's portal call.
const visitorOf = (identity) => {
  if (!identity?.portalPlatformWrite) return identity;
  const visitor = { ...identity };
  delete visitor.admin;
  delete visitor.portalPlatformWrite;
  return visitor;
};

/** Whether a root operation of `identity` is a portal call (IsPortalsClientCall, PortalsContactId). */
export function portalCall(store, identity, portalRequest) {
  return portalRequest === true && !store?.pluginParentContext && !visitorOf(identity)?.admin;
}

/** The site's host application user id that a portal request's plug-in contexts report as caller, or null. */
export function portalCallerUserId(store, identity) {
  const authorization = store?.portalAuthorization,
    visitor = visitorOf(identity);
  if (!authorization || !visitor || visitor.admin || visitor.dataverse) return null;
  // Enhanced authorization (captured, state 3): the host application user, whatever user the visitor maps to.
  const id = authorization.principalId?.(visitor)
    ? authorization.applicationUserId?.()
    : authorization.readerUser?.(visitor)?.systemuserid;
  return id ? String(id).replace(/[{}]/g, '').toLowerCase() : null;
}
