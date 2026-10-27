// Shared harness for SDK verification gates: starts the simulated Dataverse API over an
// in-memory DataStore with invented tables and one confidential application registration.
// `npm run test:sdk` runs every gate; scripts/ci.mjs runs those whose clients CI installs from locked manifests.
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { certificateThumbprints, newClientSecret } from '../lib/dataverse-auth.mjs';
import { ensureCertificate } from '../lib/dataverse-tls.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Certificates live under the ignored .paqvilo/ tree: Mirage fingerprints every other directory at startup.
const CA_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.paqvilo/sdk-gates/dataverse-ca.pem');

const GATE_APP_ID = '11111111-1111-1111-1111-111111111111';
const SECRET_VARIABLE = 'PAQVILO_SDK_GATE_SECRET';

export function gateState() {
  const state = emptyState();
  state.mappings = {
    widget: {
      entitySet: 'widgets',
      idColumn: 'widgetid',
      nameColumn: 'name',
      userConfigured: true,
      fields: {
        widgetid: { dataverseType: 'uniqueidentifier' },
        name: { dataverseType: 'nvarchar', maxLength: 100 },
        price: { dataverseType: 'money', precision: 2 },
        quantity: { dataverseType: 'int' },
        category: {
          dataverseType: 'picklist',
          options: [
            { value: 1, label: 'Standard' },
            { value: 2, label: 'Premium' },
          ],
        },
        statecode: {
          dataverseType: 'state',
          options: [
            { value: 0, label: 'Active' },
            { value: 1, label: 'Inactive' },
          ],
        },
        statuscode: {
          dataverseType: 'status',
          options: [
            { value: 1, label: 'Active', state: 0 },
            { value: 2, label: 'Inactive', state: 1 },
          ],
        },
        ownerid: { dataverseType: 'owner', lookupTargets: ['systemuser', 'team'] },
        createdon: { dataverseType: 'datetime' },
        modifiedon: { dataverseType: 'datetime' },
      },
      stateStatusDefaults: { 0: 1, 1: 2 },
      relationships: {
        widget_gadgets: {
          entity: 'gadget',
          from: 'widgetid',
          to: 'widgetid',
          many: true,
          schemaName: 'widget_gadgets',
        },
      },
      alternateKeys: [{ name: 'widget_code', schemaName: 'widget_code', attributes: ['code'] }],
    },
    gadget: {
      entitySet: 'gadgets',
      idColumn: 'gadgetid',
      nameColumn: 'name',
      userConfigured: true,
      fields: {
        gadgetid: { dataverseType: 'uniqueidentifier' },
        name: { dataverseType: 'nvarchar' },
        widgetid: { dataverseType: 'lookup', lookupTargets: ['widget'] },
        ownerid: { dataverseType: 'owner', lookupTargets: ['systemuser', 'team'] },
      },
      relationships: {
        widgetid: { entity: 'widget', from: 'widgetid', to: 'widgetid', many: false, schemaName: 'widget_gadgets' },
      },
    },
  };
  state.mappings.widget.fields.code = { dataverseType: 'nvarchar', maxLength: 20 };
  state.tables = { widget: [], gadget: [] };
  return state;
}

/** Start the simulator; returns connection facts plus the one-time client secret. */
export async function startGate({
  port = 0,
  host = '127.0.0.1',
  tls = false,
  state = gateState(),
  serviceProtection = null,
} = {}) {
  const certificate = tls ? await ensureCertificate(CA_FILE) : null;
  const secret = newClientSecret();
  const previousSecret = process.env[SECRET_VARIABLE];
  process.env[SECRET_VARIABLE] = secret;
  const store = new DataStore({ state });
  await store.init?.();
  const settings = dataverseSettings({
    enabled: true,
    port,
    tls: Boolean(tls),
    uniqueName: 'sdkgate',
    friendlyName: 'SDK gate',
    applications: [
      {
        appId: GATE_APP_ID,
        displayName: 'SDK gate client',
        secretEnvironmentVariable: SECRET_VARIABLE,
        roles: ['System Administrator'],
      },
    ],
    ...(serviceProtection ? { serviceProtection } : {}),
  });
  let api;
  try {
    api = await startDataverseApi({
      store,
      settings,
      host,
      tls: certificate ? { key: certificate.key, cert: certificate.cert } : null,
    });
  } finally {
    if (previousSecret === undefined) delete process.env[SECRET_VARIABLE];
    else process.env[SECRET_VARIABLE] = previousSecret;
  }
  return {
    api,
    store,
    origin: api.origin,
    tlsOrigin: api.tlsOrigin,
    tenantId: api.tenantId,
    organizationId: api.organizationId,
    caFile: certificate?.file ?? null,
    caPem: certificate?.cert ?? null,
    authority: api.authority,
    clientId: GATE_APP_ID,
    clientSecret: secret,
    scope: `${api.origin}/.default`,
    requests: () => api.requests(),
    close: () => api.close(),
  };
}

/** Registers a certificate PEM for the gate application, exactly as POST /_sim/api/dataverse/applications/<appId>/certificates does. */
export async function registerCertificate(gate, certificatePem) {
  const thumbprints = certificateThumbprints(certificatePem);
  await gate.store.transact(() => {
    const app = gate.store.state.dataverse.applications.find(
      (item) => item.appId.toLowerCase() === gate.clientId.toLowerCase(),
    );
    (app.certificates ??= []).push({ ...thumbprints, publicKeyPem: certificatePem });
  });
  return thumbprints;
}

/** Plain client_credentials token from the simulated authority (no SDK), for gates that only need a bearer. */
export async function clientCredentialsToken(gate, { origin = gate.origin } = {}) {
  const response = await fetch(`${origin}/${gate.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: gate.clientId,
      client_secret: gate.clientSecret,
      grant_type: 'client_credentials',
      scope: `${origin}/.default`,
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`token endpoint ${response.status}: ${body.error} ${body.error_description}`);
  return body.access_token;
}
