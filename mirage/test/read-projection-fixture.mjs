// Shared fixture for the read-projection, paging, exact-JSON, collation and file-name tests: a loopback Dataverse API
// over a state with the default EXTENSIONS and two application users: ADMIN (System Administrator) and
// CUST (System Customizer, which does not bypass column security).
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import { createOrganizationRuntime } from "../lib/dataverse-organization.mjs";
import { EXTENSIONS } from "../lib/dataverse-extensions.mjs";
import { randomUUID } from 'node:crypto';

export const ADMIN = "77777777-7777-4777-8777-777777777777";
export const CUST = "77777777-7777-4777-8777-777777777778";

/**
 * readFixture(t, { mappings, tables, settings }) -> { store, api, server, request(method, path, body, headers, as), json(response, status) }.
 * body may be a raw string (sent as is) or a value (JSON.stringify); as is ADMIN (default) or CUST.
 */
export async function readFixture(t, { mappings = {}, tables = {}, settings: extra = {} } = {}) {
  const secretVar = `PAQ_READ_FIXTURE_${process.pid}_${randomUUID().replaceAll('-', '').toUpperCase()}`;
  process.env[secretVar] = "read-fixture-secret";
  t.after(() => { delete process.env[secretVar]; });
  const state = emptyState();
  Object.assign(state.mappings, structuredClone(mappings));
  for (const [table, rows] of Object.entries(tables)) state.tables[table] = structuredClone(rows);
  Object.assign((state.settings ??= {}), extra);
  const store = await new DataStore({ state }).init();
  const settings = dataverseSettings({ enabled: true, applications: [
    { appId: ADMIN, displayName: "Invented admin", secretEnvironmentVariable: secretVar, roles: ["System Administrator"] },
    { appId: CUST, displayName: "Invented customizer", secretEnvironmentVariable: secretVar, roles: ["System Customizer"] },
  ] });
  let api = null;
  const spy = { name: "read-fixture-spy", install: (a) => { api = a; }, reset() {}, describe: () => ({ name: "read-fixture-spy", level: "contract" }) };
  const extensions = [...EXTENSIONS, spy];
  const organization = await createOrganizationRuntime({ store, settings, extensions });
  const server = await startDataverseApi({ store, settings, log: () => {}, extensions, organization });
  t.after(async () => { await server.close(); await organization.close(); });
  const tokens = {};
  for (const id of [ADMIN, CUST]) {
    tokens[id] = (await (await fetch(`${server.origin}/${server.tenantId}/oauth2/v2.0/token`, { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: process.env[secretVar], scope: `${server.origin}/.default` }) })).json()).access_token;
  }
  const request = (method, path, body, headers = {}, as = ADMIN) => fetch(`${server.origin}/api/data/v9.2${path}`, { method,
    headers: { authorization: `Bearer ${tokens[as]}`, ...(body !== undefined ? { "content-type": "application/json", prefer: "return=representation" } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000) });
  const json = async (response, status) => {
    const text = await response.text();
    if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  };
  return { store, api: api ?? organization.api, organization, server, request, json };
}
