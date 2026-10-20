// Managed identity token endpoints for the Dataverse simulator. Three shapes share one token issuer (authority.issueManagedIdentityToken):
// the App Service endpoint (/msi/token, header secret), the IMDS endpoint (/metadata/identity/oauth2/token, Metadata header) and,
// when a secret directory is given, the Arc challenge on that same IMDS path. Pure: no sockets; the server mounts handle() and reads env().
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { uuidV5 } from "./dataverse-security.mjs";

// Sources: learn.microsoft.com/azure/app-service/overview-managed-identity#rest-endpoint-reference
//          learn.microsoft.com/entra/identity/managed-identities-azure-resources/how-to-use-vm-token
//          learn.microsoft.com/azure/azure-arc/servers/managed-identity-authentication
const APP_SERVICE_PATH = "/msi/token";
const IMDS_PATH = "/metadata/identity/oauth2/token";
// App Service names the resource selector mi_res_id; IMDS names it msi_res_id. Both are accepted.
const SELECTORS = [
  ["client_id", "clientId"],
  ["principal_id", "principalId"],
  ["object_id", "principalId"],
  ["mi_res_id", "resourceId"],
  ["msi_res_id", "resourceId"],
];

const PENDING_LIMIT = 16;

const reply = (status, body, headers = {}) => ({ status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }, body });
const failure = (status, error, errorDescription, headers) => reply(status, { error, error_description: errorDescription }, headers);

export function createManagedIdentityEndpoints({ authority, settings, origin, secretFile, randomBytes = nodeRandomBytes }) {
  const identityHeader = randomBytes(24).toString("hex"); // per-run X-IDENTITY-HEADER value, published through env()
  const pending = new Map(); // secret -> file path of the unused Arc challenges
  const identities = () => settings.managedIdentities ?? [];

  // unverified: the docs give no body for an unknown identity; 401 unauthorized_client is the documented error for a misconfigured identity.
  const unknownIdentity = () => failure(401, "unauthorized_client", "Identity not found");

  // One selector at most. With none, the first configured identity stands in for the system-assigned one (ponytail: settings carry no system-assigned identity).
  const selectIdentity = (searchParams) => {
    const given = SELECTORS.filter(([name]) => searchParams.get(name) !== null);
    if (given.length > 1) return { error: failure(400, "invalid_request", "Only one identity selector may be given.") }; // unverified: body shape
    if (given.length === 0) return identities()[0] ? { identity: identities()[0] } : { error: unknownIdentity() };
    const [name, field] = given[0];
    const value = searchParams.get(name).toLowerCase();
    const identity = identities().find((item) => item[field]?.toLowerCase() === value);
    return identity ? { identity } : { error: unknownIdentity() };
  };

  // Shared by all three shapes; shape() picks the fields the endpoint returns.
  const issue = (searchParams, shape) => {
    const resource = searchParams.get("resource");
    if (!resource) return failure(400, "invalid_request", "The request is missing a required parameter, includes an invalid parameter value, includes a parameter more than once, or is otherwise malformed.");
    const picked = selectIdentity(searchParams);
    if (picked.error) return picked.error;
    const token = authority.issueManagedIdentityToken({ origin, clientId: picked.identity.clientId, resource });
    if (!token) return failure(400, "invalid_resource", `AADSTS50001: The application named ${resource} wasn't found.`); // unverified: wording beyond the code
    return reply(200, shape(token));
  };

  // Checked before any side effect (the Arc challenge writes a file). unverified: wording
  const missingApiVersion = () => failure(400, "invalid_request", "Required query variable 'api-version' is missing");

  const appService = ({ searchParams, headers }) => {
    if (headers["x-identity-header"] !== identityHeader) return failure(401, "unauthorized_client", "Missing or wrong X-IDENTITY-HEADER."); // unverified: status and body
    if (!searchParams.has("api-version")) return missingApiVersion();
    return issue(searchParams, (token) => ({
      access_token: token.access_token,
      expires_on: token.expires_on,
      resource: token.resource,
      token_type: token.token_type,
      client_id: token.client_id,
    }));
  };

  // Arc: an unauthenticated call gets a challenge naming a fresh single-use secret file; the re-call presents the file's contents.
  // ponytail: Map lookup, not constant-time; loopback simulator only.
  const challenge = () => {
    const secret = randomBytes(32).toString("hex");
    mkdirSync(secretFile, { recursive: true });
    const path = join(secretFile, `identity-${randomBytes(6).toString("hex")}.key`);
    writeFileSync(path, secret, { mode: 0o600 });
    // ponytail: FIFO cap of 16 unused challenges, not expiry; a loopback simulator's clients redeem theirs at once.
    while (pending.size >= PENDING_LIMIT) {
      const [oldest, oldestPath] = pending.entries().next().value;
      pending.delete(oldest);
      rmSync(oldestPath, { force: true });
    }
    pending.set(secret, path);
    // unverified: the 401 body is not in the Arc docs
    return failure(401, "unauthorized", "Authorization required", { "www-authenticate": `Basic realm=${path}` });
  };

  const imds = (req) => {
    // unverified: the docs table lists bad_request_102 in the error column; the body follows the task brief's invalid_request form.
    if (req.headers.metadata !== "true") return failure(400, "invalid_request", "Required metadata header not specified");
    if (!req.searchParams.has("api-version")) return missingApiVersion();
    if (secretFile !== undefined) {
      const auth = req.headers.authorization ?? "";
      const secret = auth.startsWith("Basic ") ? auth.slice(6) : null;
      const path = secret === null ? undefined : pending.get(secret);
      if (path === undefined) return challenge();
      pending.delete(secret);
      rmSync(path, { force: true }); // single use
    }
    return issue(req.searchParams, (token) => ({
      access_token: token.access_token,
      refresh_token: "",
      expires_in: token.expires_in,
      expires_on: token.expires_on,
      not_before: token.not_before,
      resource: token.resource,
      token_type: token.token_type,
    }));
  };

  // null when the request is not for a managed identity path (or uses a verb these endpoints do not take).
  const handle = (req) => {
    if (req.method !== "GET") return null;
    if (req.pathname === APP_SERVICE_PATH) return appService(req);
    if (req.pathname === IMDS_PATH) return imds(req);
    return null;
  };

  const env = () => ({ IDENTITY_ENDPOINT: `${origin}${APP_SERVICE_PATH}`, IDENTITY_HEADER: identityHeader, IMDS_ENDPOINT: origin });

  const close = () => { for (const file of pending.values()) rmSync(file, { force: true }); pending.clear(); };
  return { handle, env, close };
}

// The managedidentity table (Microsoft Learn: reference/entities/managedidentity). One row per configured identity; an
// identity's application user is created by the security seeding (dataverse-security.mjs applicationUser).
// unverified: live capture. credentialsource 2 (IsManaged) and subjectscope 1 are the docs' example values; version 0 is a placeholder.
const MANAGED_IDENTITY_FIELDS = {
  managedidentityid: { dataverseType: "uniqueidentifier" }, name: { dataverseType: "nvarchar" },
  applicationid: { dataverseType: "uniqueidentifier" }, tenantid: { dataverseType: "uniqueidentifier" },
  credentialsource: { dataverseType: "picklist", options: [{ value: 0, label: "ClientSecret" }, { value: 1, label: "KeyVault" }, { value: 2, label: "IsManaged" }, { value: 3, label: "MicrosoftFirstPartyCertificate" }] },
  // unverified: the docs table spells value 1 "EnviornmentScope"; the configure-app article says "EnvironmentScope".
  subjectscope: { dataverseType: "picklist", options: [{ value: 0, label: "GlobalScope" }, { value: 1, label: "EnvironmentScope" }, { value: 2, label: "DevOnlyScope" }] },
  version: { dataverseType: "int" },
  statecode: { dataverseType: "int", options: [{ value: 0, label: "Active" }, { value: 1, label: "Inactive" }] },
  statuscode: { dataverseType: "picklist", options: [{ value: 1, label: "Active", state: 0 }, { value: 2, label: "Inactive", state: 1 }] },
  ownerid: { dataverseType: "lookup" },
};

const lowerGuid = (value) => String(value ?? "").toLowerCase();

// Keeps the managedidentity rows equal to the configured identities: each is upserted and rows of identities no longer
// configured are dropped. Runs inside the caller's store.transact, from the same registration that seeds the applications.
// Also called by the runtime POST /_sim/api/dataverse/managed-identities route with the configured plus runtime list.
export function seedManagedIdentityRows(store, { tenantId, identities = [] }) {
  const mapping = (store.state.mappings.managedidentity ??= {
    logicalName: "managedidentity", entitySet: "managedidentities", idColumn: "managedidentityid", nameColumn: "name",
    userConfigured: true, dataverseOnly: true, fields: {}, relationships: {},
  });
  for (const [name, type] of Object.entries(MANAGED_IDENTITY_FIELDS)) mapping.fields[name] ??= type;
  const rows = (store.state.tables.managedidentity ??= []);
  const wanted = new Map(identities.map((identity) => {
    const applicationid = lowerGuid(identity.clientId);
    return [applicationid, {
      managedidentityid: uuidV5(tenantId, `managedidentity:${applicationid}`), name: identity.displayName, applicationid, tenantid: tenantId,
      credentialsource: 2, subjectscope: 1, version: 0, statecode: 0, statuscode: 1,
    }];
  }));
  for (let i = rows.length - 1; i >= 0; i--) if (!wanted.has(lowerGuid(rows[i].applicationid))) rows.splice(i, 1);
  for (const [applicationid, row] of wanted) {
    const existing = rows.find((item) => lowerGuid(item.applicationid) === applicationid);
    if (existing) Object.assign(existing, row);
    else rows.push(row);
  }
  return rows;
}
