// The Dataverse listener with its own trace store, for the trace-listener, trace-soap, trace-batch and trace-tds suites: one
// invented user-owned table, one System Administrator application with its bearer token, and a request helper that names the
// trace each answer opened. Loopback only.
import { DataStore, emptyState } from '../../lib/data.mjs';
import { dataverseSettings } from '../../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../../lib/dataverse-api.mjs';
import { createTraceStore } from '../../lib/trace-store.mjs';
import { endedTree } from './trace-scenario.mjs';

export const APP_ID = '7a3c0000-0000-4000-8000-0000000000a1';
export const ORGANIZATION_ID = '7a3c0000-0000-4000-8000-0000000000b2';
export const MISSING_ID = '7a3c0000-0000-4000-8000-0000000000ff';
const SECRET_VARIABLE = 'PAQVILO_TRACE_LISTENER_SECRET';
const SECRET = 'invented-trace-listener-secret-5c2e';

// options: level (the trace level), traces (a trace store or stand-in to use instead of a new one), tls ({ key, cert } for
// the TDS endpoint), tds (the TDS endpoint on).
export async function startListener({ level = 'full', traces, tls = null, tds = false } = {}) {
  process.env[SECRET_VARIABLE] = SECRET;
  const state = emptyState();
  state.mappings.fx_widget = {
    logicalName: 'fx_widget',
    entitySet: 'fx_widgets',
    idColumn: 'fx_widgetid',
    nameColumn: 'fx_name',
    ownership: 'UserOwned',
    fields: { fx_name: { dataverseType: 'nvarchar' }, ownerid: { dataverseType: 'lookup' } },
  };
  state.tables.fx_widget = [];
  const store = await new DataStore({ state }).init();
  store.traces = createTraceStore({ settings: { level } });
  const settings = dataverseSettings({
    enabled: true,
    organizationId: ORGANIZATION_ID,
    applications: [
      {
        appId: APP_ID,
        displayName: 'Invented trace client',
        secretEnvironmentVariable: SECRET_VARIABLE,
        roles: ['System Administrator'],
      },
    ],
    tds: { enabled: tds },
  });
  const api = await startDataverseApi({ store, settings, tls, traces: traces ?? null, log: () => {} });
  const issued = await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: APP_ID,
      client_secret: SECRET,
      scope: `${api.origin}/.default`,
    }),
  });
  const token = (await issued.json()).access_token;
  // One request on the listener: { status, text, json, traceId }. bearer null sends no Authorization header.
  const request = async (method, path, { body, headers = {}, bearer = token } = {}) => {
    const response = await fetch(api.origin + path, {
      method,
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(body !== undefined && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON (SOAP, multipart, empty): the text is the answer.
    }
    return { status: response.status, text, json, traceId: response.headers.get('x-trace-id') };
  };
  return {
    api,
    store,
    traces: store.traces,
    token,
    request,
    tree: (traceId) => endedTree(store.traces, traceId),
    close: async () => {
      await api.close();
      delete process.env[SECRET_VARIABLE];
    },
  };
}

/** The spans of an ended tree whose parent is span. */
export const childrenOf = (tree, span) => tree.spans.filter((item) => item.parentSpanId === span.spanId);
/** The first span of an ended tree matching every given field. */
export const spanOf = (tree, fields) =>
  tree.spans.find((span) => Object.entries(fields).every(([key, value]) => span[key] === value));
