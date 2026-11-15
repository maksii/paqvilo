// Set-up shared by the secured-read tests: a Dataverse API over a fresh store with one token per invented application,
// and the SOAP RetrieveMultiple helpers. Invented names and loopback only.
import { DataStore, emptyState } from '../../lib/data.mjs';
import { dataverseSettings } from '../../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../../lib/dataverse-organization.mjs';
import { sourceOrganizationExtensions } from '../../lib/source-organization-extensions.mjs';
import { startDataverseApi } from '../../lib/dataverse-api.mjs';
import { envelope, NS } from '../../lib/dataverse-soap-xml.mjs';

export const APPS = {
  admin: { appId: '55555555-5555-4555-8555-555555555555', role: 'System Administrator' },
  customizer: { appId: '77777777-7777-4777-8777-777777777777', role: 'System Customizer' },
  basic: { appId: '66666666-6666-4666-8666-666666666666', role: 'Basic User' },
};

async function tokenFor(transport, appId, secret) {
  const response = await fetch(`${transport.authority}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: appId,
      client_secret: secret,
      scope: `${transport.origin}/.default`,
    }),
  });
  return (await response.json()).access_token;
}

async function request(origin, token, method, route, value) {
  const response = await fetch(`${origin}/api/data/v9.2/${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      prefer: 'return=representation',
      ...(value === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null };
}

const SOAP_PATH = '/XRMServices/2011/Organization.svc/web';
async function soapRequest(origin, token, body) {
  const response = await fetch(`${origin}${SOAP_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'text/xml; charset=utf-8' },
    body,
  });
  return { status: response.status, text: await response.text() };
}
const pair = (key, valueXml) =>
  `<a:KeyValuePairOfstringanyType><b:key>${key}</b:key>${valueXml}</a:KeyValuePairOfstringanyType>`;
export const str = (value) => `<b:value i:type="c:string">${value}</b:value>`;
const escapeXml = (text) =>
  text.replace(/[<>"&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' })[char]);
// A RetrieveMultiple Execute whose Query is the given QueryExpression or FetchExpression value.
export const retrieveMultiple = (query) =>
  envelope(
    `<Execute xmlns="${NS.svc}"><request i:type="a:RetrieveMultipleRequest"><a:Parameters>${pair('Query', query)}</a:Parameters><a:RequestName>RetrieveMultiple</a:RequestName></request></Execute>`,
  );
export const fetchExpression = (fetchXml) =>
  `<b:value i:type="a:FetchExpression"><a:Query>${escapeXml(fetchXml)}</a:Query></b:value>`;

// Puts back each variable as it was before the helper set it, deleting the ones that had no value.
function restoreEnvironment(previous) {
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

// Starts the API for the given applications (name to { appId, role }); each secret comes from `${envPrefix}_<NAME>_SECRET`.
// `call(who, method, route, value)` answers the Web API and `soap(who, body)` the Organization service.
// `close()` stops both services and restores the secret variables.
export async function startSecuredOrganization({ envPrefix, apps, tls }) {
  const previous = new Map();
  const applications = Object.entries(apps).map(([name, app]) => {
    const secretEnvironmentVariable = `${envPrefix}_${name.toUpperCase()}_SECRET`;
    previous.set(secretEnvironmentVariable, process.env[secretEnvironmentVariable]);
    process.env[secretEnvironmentVariable] = `invented-${name}-secret`;
    return { appId: app.appId, displayName: `Invented ${name}`, secretEnvironmentVariable, roles: [app.role] };
  });
  const store = await new DataStore({ state: emptyState() }).init();
  const organization = await createOrganizationRuntime({
    store,
    extensions: await sourceOrganizationExtensions({}),
    settings: dataverseSettings({ enabled: true, applications }),
  });
  const transport = await startDataverseApi({ organization, tls });
  const tokens = {};
  for (const [name, app] of Object.entries(apps))
    tokens[name] = await tokenFor(transport, app.appId, `invented-${name}-secret`);
  const call = (who, method, route, value) => request(transport.origin, tokens[who], method, route, value);
  const soap = (who, body) => soapRequest(transport.origin, tokens[who], body);
  const close = async () => {
    try {
      await transport.close();
      await organization.close();
    } finally {
      restoreEnvironment(previous);
    }
  };
  return { store, call, soap, close, transport, tokens };
}
