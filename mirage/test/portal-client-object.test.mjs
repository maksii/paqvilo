import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  PORTAL_OBJECT_KEYS,
  PORTAL_USER_KEYS,
  clientPortalObjectRuntime,
  portalClientObject,
} from "../lib/portal-client-object.mjs";
import { injectRuntime } from "../lib/platform.mjs";

// Key set and order observed on sandbox (agent G, read-only capture of window.Microsoft.Dynamic365.Portal),
// signed in and anonymous alike.
const REFERENCE_KEYS = [
  "User", "type", "id", "geo", "tenant", "correlationId", "orgEnvironmentId", "orgId",
  "portalProductionOrTrialType", "isTelemetryEnabled", "InstrumentationSettings",
  "timerProfileForBatching", "activeLanguages", "isClientApiEnabled", "isSpaSite",
  "onPagesClientApiReady", "dynamics365PortalAnalytics",
];
const REFERENCE_USER_KEYS = ["userName", "firstName", "lastName", "email", "contactId", "userRoles"];
const SITE = "d0000000-0000-4000-8000-000000000001";
const persona = { contactId: "c0000000-0000-4000-8000-000000000001", firstname: "Ada", lastname: "Local", emailaddress1: "ada@example.invalid", adx_identity_username: "e0000000-0000-4000-8000-000000000001" };

function evaluate(source, window = {}) {
  window.window = window;
  vm.runInNewContext(source, window);
  return window.Microsoft;
}

test("the portal client object has the reference keys in the reference order, without version", () => {
  assert.deepEqual([...PORTAL_OBJECT_KEYS], REFERENCE_KEYS);
  assert.deepEqual([...PORTAL_USER_KEYS], REFERENCE_USER_KEYS);
  for (const identity of [persona, {}]) {
    const microsoft = evaluate(clientPortalObjectRuntime(identity, { websiteId: SITE, language: "en-US", traceId: "11111111-2222-4333-8444-555555555555" }));
    const portal = microsoft.Dynamic365.Portal;
    assert.deepEqual(Object.keys(portal), REFERENCE_KEYS);
    assert.deepEqual(Object.keys(portal.User), REFERENCE_USER_KEYS);
    assert.equal("version" in portal, false);
    assert.equal(typeof portal.onPagesClientApiReady, "function");
    assert.equal(microsoft.PowerPages.onPagesClientApiReady, portal.onPagesClientApiReady);
  }
});

test("values follow the reference shapes and the session persona", () => {
  const values = portalClientObject(persona, { websiteId: SITE.toUpperCase(), language: "en-US", traceId: "11111111-2222-4333-8444-555555555555" });
  assert.deepEqual(values.User, { userName: persona.adx_identity_username, firstName: "Ada", lastName: "Local", email: "ada@example.invalid", contactId: persona.contactId, userRoles: [] });
  assert.equal(values.id, SITE);
  assert.equal(values.correlationId, "11111111-2222-4333-8444-555555555555");
  for (const key of ["tenant", "orgEnvironmentId", "orgId"]) assert.match(values[key], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  // Stable per site, distinct per key.
  assert.equal(portalClientObject({}, { websiteId: SITE }).tenant, values.tenant);
  assert.notEqual(values.tenant, values.orgId);
  assert.deepEqual(
    { type: values.type, geo: values.geo, portalProductionOrTrialType: values.portalProductionOrTrialType, timerProfileForBatching: values.timerProfileForBatching, isSpaSite: values.isSpaSite, activeLanguages: values.activeLanguages },
    { type: "StarterPortal", geo: "EUR", portalProductionOrTrialType: "Production", timerProfileForBatching: "NEAR_REAL_TIME", isSpaSite: "False", activeLanguages: ["en-US"] },
  );
  // A local runtime sends no telemetry and has no pages client API.
  assert.equal(values.isTelemetryEnabled, "False");
  assert.equal(values.isClientApiEnabled, "False");
  assert.deepEqual(values.InstrumentationSettings, { instrumentationKey: "", collectorEndpoint: "" });
  // Anonymous visitors keep every User key with empty strings, so contactId.toString() works.
  const anonymous = portalClientObject({}, { websiteId: SITE });
  assert.deepEqual(anonymous.User, { userName: "", firstName: "", lastName: "", email: "", contactId: "", userRoles: [] });
  assert.deepEqual(portalClientObject(null, { websiteId: SITE }).User, anonymous.User);
  // Without a trace id, each page gets its own correlation id.
  assert.match(portalClientObject({}, {}).correlationId, /^[0-9a-f-]{36}$/);
});

test("an existing page definition wins and the injected runtime takes the site from the ResourceManager script", () => {
  const microsoft = evaluate(clientPortalObjectRuntime(persona, { websiteId: SITE }), { Microsoft: { Dynamic365: { Portal: { type: "Authored", User: { contactId: "kept" } } } } });
  assert.equal(microsoft.Dynamic365.Portal.type, "Authored");
  assert.equal(microsoft.Dynamic365.Portal.User.contactId, "kept");
  assert.equal(microsoft.Dynamic365.Portal.User.firstName, "Ada");
  const html = injectRuntime(`<!doctype html><html lang="fr-FR"><head><script src="/_portal/${SITE}/Resources/ResourceManager?lang=fr-FR"></script></head><body></body></html>`, "token", "1", persona);
  const runtime = /<script data-paqvilo-mirage-runtime>([\s\S]*?)<\/script>/.exec(html)[1];
  const parsed = JSON.parse(/const values=(\{[\s\S]*?\});const ready=/.exec(runtime)[1]);
  assert.equal(parsed.id, SITE);
  assert.deepEqual(parsed.activeLanguages, ["fr-FR"]);
  assert.equal(parsed.User.contactId, persona.contactId);
});
