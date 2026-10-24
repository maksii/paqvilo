// Shared fixture for the Dataverse contract-module tests (dataverse-calculated, dataverse-business-rules, ...): starts a
// loopback Dataverse API over an invented state with the default EXTENSIONS plus the module under test, installed
// explicitly, and returns an authenticated Web API caller.
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { randomUUID } from 'node:crypto';

const APP_ID = '77777777-7777-4777-8777-777777777777';

/**
 * contractModuleFixture(t, { mappings, tables, extension, options, providers }):
 *   mappings/tables seed the state; extension is the module's EXTENSION; options is the second install argument
 *   (the pack export and the diagnostic sink); providers, when given, are the organization's host providers (api.providers).
 *   Returns { api, server, store, request(method, path, body, headers), json(response, status) }:
 *   api is the organization's internal api object the module installed into; server is the HTTP handle (origin, close).
 */
export async function contractModuleFixture(
  t,
  { mappings = {}, tables = {}, extension, options = {}, providers = null },
) {
  const secretVar = `PAQVILO_CONTRACT_MODULE_SECRET_${process.pid}_${randomUUID().replaceAll('-', '').toUpperCase()}`;
  process.env[secretVar] = 'contract-module-secret';
  t.after(() => {
    delete process.env[secretVar];
  });
  const state = emptyState();
  Object.assign(state.mappings, structuredClone(mappings));
  for (const [table, rows] of Object.entries(tables)) state.tables[table] = structuredClone(rows);
  const store = await new DataStore({ state }).init();
  const settings = dataverseSettings({
    enabled: true,
    applications: [
      {
        appId: APP_ID,
        displayName: 'Contract module app',
        secretEnvironmentVariable: secretVar,
        roles: ['System Administrator'],
      },
    ],
  });
  // The module is installed explicitly, after the default list, with its options (the host wires the pack export).
  let internal = null;
  const installed = {
    ...extension,
    install: (api) => {
      internal = api;
      return extension.install(api, options);
    },
  };
  const extensions = [...EXTENSIONS.filter((entry) => entry.name !== extension.name), installed];
  // providers (api.providers, frozen before any extension installs) need an organization runtime built with them.
  const organization = providers ? await createOrganizationRuntime({ store, settings, extensions, providers }) : null;
  const server = await startDataverseApi({ store, settings, log: () => {}, extensions, organization });
  t.after(async () => {
    await server.close();
    await organization?.close();
  });
  const token = await (
    await fetch(`${server.origin}/${server.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: APP_ID,
        client_secret: process.env[secretVar],
        scope: `${server.origin}/.default`,
      }),
    })
  ).json();
  const request = (method, path, body, headers = {}) =>
    fetch(`${server.origin}/api/data/v9.2${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token.access_token}`,
        ...(body ? { 'content-type': 'application/json', prefer: 'return=representation' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
  const json = async (response, status) => {
    const text = await response.text();
    if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  };
  return { api: internal, server, store, request, json };
}
