// The platform's page-level client object window.Microsoft.Dynamic365.Portal.
//
// The local client contract exposes the 17
// top-level keys below, in this order, and the 6 User keys, signed in and anonymous alike;
// there is no `version` key. Microsoft.PowerPages carries onPagesClientApiReady too. Local values:
// - User.* come from the session persona's contact; an anonymous visitor has empty strings
//   (contactId included) and userRoles is always an empty array, as on the platform;
// - the site id is the exported website id; tenant and organisation ids are stable local
//   GUIDs derived from it; correlationId is the request trace id;
// - type, geo and portalProductionOrTrialType remain unknown unless the page supplies them;
//   activeLanguages is the page language; batching and SPA flags use local compatibility values;
// - isTelemetryEnabled and isClientApiEnabled are "False": a local
//   runtime sends no telemetry and provides no pages client API, so onPagesClientApiReady
//   never settles; InstrumentationSettings and dynamics365PortalAnalytics are empty strings.
// Values already present on the page (an authored or captured definition) are kept.
import { createHash, randomUUID } from "node:crypto";

export const PORTAL_OBJECT_KEYS = Object.freeze([
  "User",
  "type",
  "id",
  "geo",
  "tenant",
  "correlationId",
  "orgEnvironmentId",
  "orgId",
  "portalProductionOrTrialType",
  "isTelemetryEnabled",
  "InstrumentationSettings",
  "timerProfileForBatching",
  "activeLanguages",
  "isClientApiEnabled",
  "isSpaSite",
  "onPagesClientApiReady",
  "dynamics365PortalAnalytics",
]);
export const PORTAL_USER_KEYS = Object.freeze(["userName", "firstName", "lastName", "email", "contactId", "userRoles"]);

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stable GUID-shaped value derived from `seed`. */
function localGuid(seed) {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The object's JSON values for one page (every key but the onPagesClientApiReady function):
 * `identity` is the session persona, `site` the website id, page language and trace id.
 */
export function portalClientObject(identity = {}, { websiteId = "", language = "", traceId = null } = {}) {
  identity ??= {};
  const site = String(websiteId ?? "").toLowerCase();
  const contactId = String(identity.contactId ?? identity.id ?? "");
  return {
    User: {
      userName: String(identity.adx_identity_username ?? identity.username ?? contactId),
      firstName: String(identity.firstname ?? ""),
      lastName: String(identity.lastname ?? ""),
      email: String(identity.emailaddress1 ?? identity.email ?? ""),
      contactId,
      userRoles: [],
    },
    type: "",
    id: site,
    geo: "",
    tenant: localGuid(`tenant:${site}`),
    correlationId: GUID.test(String(traceId ?? "")) ? String(traceId) : randomUUID(),
    orgEnvironmentId: localGuid(`environment:${site}`),
    orgId: localGuid(`organization:${site}`),
    portalProductionOrTrialType: "",
    isTelemetryEnabled: "False",
    InstrumentationSettings: { instrumentationKey: "", collectorEndpoint: "" },
    timerProfileForBatching: "NEAR_REAL_TIME",
    activeLanguages: language ? [language] : [],
    isClientApiEnabled: "False",
    isSpaSite: "False",
    dynamics365PortalAnalytics: "",
  };
}

/** Browser script that completes window.Microsoft.Dynamic365.Portal in the compatibility key order. */
export function clientPortalObjectRuntime(identity, site) {
  const values = JSON.stringify(portalClientObject(identity, site)).replace(/</g, "\\u003c");
  const keys = JSON.stringify(PORTAL_OBJECT_KEYS);
  return `(()=>{const values=${values};const ready=function(){return new Promise(()=>{});};window.Microsoft||={};Microsoft.Dynamic365||={};const portal=Microsoft.Dynamic365.Portal||={};for(const key of ${keys}){if(key==="User"){portal.User||={};for(const [name,field] of Object.entries(values.User))if(!(name in portal.User))portal.User[name]=field;}else if(key==="onPagesClientApiReady"){if(typeof portal[key]!=="function")portal[key]=ready;}else if(!(key in portal))portal[key]=values[key];}Microsoft.PowerPages||={};if(typeof Microsoft.PowerPages.onPagesClientApiReady!=="function")Microsoft.PowerPages.onPagesClientApiReady=portal.onPagesClientApiReady;})();`;
}
