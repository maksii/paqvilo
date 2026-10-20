// Shared local administration for every Mirage organization host. The caller enforces CSRF/origin.
import { randomUUID, X509Certificate, createPublicKey } from 'node:crypto';
import { dataverseSettings, GRANT_TYPES } from './dataverse-settings.mjs';
import { createApplicationUser, assignRoles, uuidV5 } from './dataverse-security.mjs';
import { hashSecret, newClientSecret, certificateThumbprints } from './dataverse-auth.mjs';
import { seedManagedIdentityRows } from './dataverse-managed-identity.mjs';
import { classicWorkflowsView, runOverride } from './dataverse-workflows.mjs';
const error = (message, status = 400, code = 'INVALID_REQUEST') => Object.assign(new Error(message), { status, code });
const decodeAdminIdentifier = value => { try { return decodeURIComponent(value); } catch { throw error('Administration identifier has invalid URL encoding.'); } };
export function createDataverseAdmin({ store, getDataverse, dataverseConfig, dataverseSummary, managedIdentitySummary = () => ({ enabled: false }), managedIdentityList = () => [...(dataverseConfig.managedIdentities ?? []), ...(store.state.dataverse?.managedIdentities ?? [])], environmentValue = (key, fallback) => store.state.dataverse?.environment?.[key] ?? fallback, json, jsonObjectBody, change }) {
  const DATAVERSE_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return async (req, res, relative) => {
    const dataverse = getDataverse();
    const method = req.method;
    if (!dataverse) throw error("The Dataverse API is disabled for this runtime.", 404, "DATAVERSE_DISABLED");
    const lower = (value) => String(value ?? "").toLowerCase();
    const refId = (value) => (value !== null && typeof value === "object" ? value.id : value);
    const registrations = () => store.state.dataverse.applications;
    // Password sign-in (ROPC) secrets: hashed, keyed by systemuserid, never returned.
    const passwords = () => (store.state.dataverse.passwords ??= {});
    const checkPassword = (value, { allowNull = false } = {}) => {
      if (allowNull && value === null) return;
      if (value !== undefined && (typeof value !== "string" || value.length < 8 || value.length > 256))
        throw error("password must be a string of 8 to 256 characters.");
    };
    const roleRows = () => store.tableRows("role");
    const userRows = () => store.tableRows("systemuser");
    const requireApp = (appId) => {
      const app = registrations().find((item) => lower(item.appId) === lower(decodeAdminIdentifier(appId)));
      if (!app) throw error("Application registration not found.", 404, "DATAVERSE_APPLICATION_NOT_FOUND");
      return app;
    };
    const roleIdsFor = (names) => {
      if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) throw error("roles must be an array of role names.");
      return names.map((name) => {
        const role = roleRows().find((item) => item.name === name);
        if (!role) throw error(`Role ${name} does not exist.`, 400, "DATAVERSE_ROLE_NOT_FOUND");
        return role.roleid;
      });
    };
    const removeRows = (logical, predicate) => {
      const rows = store.tableRows(logical);
      for (let i = rows.length - 1; i >= 0; i--) if (predicate(rows[i])) store.removeRow(logical, rows, i);
    };
    const roleNames = (userId) => {
      const names = new Map(roleRows().map((role) => [lower(role.roleid), role.name]));
      return store
        .tableRows("systemuserroles")
        .filter((link) => lower(refId(link.systemuserid)) === lower(userId))
        .map((link) => names.get(lower(refId(link.roleid))))
        .filter(Boolean);
    };
    const userView = (user) => ({
      systemuserid: user.systemuserid,
      fullname: user.fullname,
      domainname: user.domainname ?? null,
      applicationid: user.applicationid ?? null,
      azureactivedirectoryobjectid: user.azureactivedirectoryobjectid ?? null,
      accessmode: user.accessmode,
      isdisabled: user.isdisabled === true,
      passwordSet: Boolean(store.state.dataverse.passwords?.[user.systemuserid]),
      roles: roleNames(user.systemuserid),
    });
    // Organization row the auditing and duplicate detection checks read per request; the restart list is set at start-up.
    const organizationRow = () => store.tableRows("organization").find((item) => lower(item.organizationid) === lower(dataverse.organizationId)) ?? null;
    const environmentView = () => ({
      auditing: organizationRow()?.isauditenabled === true,
      duplicateDetection: organizationRow()?.isduplicatedetectionenabled !== false,
      tdsEnabled: environmentValue("tdsEnabled", dataverseConfig.tds.enabled),
      pluginTimeoutSeconds: environmentValue("pluginTimeoutSeconds", dataverseConfig.pluginTimeoutSeconds),
      requestsPer300s: environmentValue("requestsPer300s", dataverseConfig.serviceProtection?.requestsPer300s ?? null),
      // Read once when the API starts: shown here, changed in the settings and restarted.
      restartRequired: {
        port: dataverseConfig.port,
        tls: dataverseConfig.tls,
        tenantId: dataverse.tenantId,
        organizationId: dataverse.organizationId,
        localeId: dataverseConfig.localeId,
        currencyCode: dataverseConfig.currencyCode,
      },
    });
    const publicApp = (app) => ({
      appId: app.appId,
      displayName: app.displayName,
      secrets: (app.secrets ?? []).map(({ id, hint, expiresOn }) => ({ id, hint, expiresOn })),
      certificates: (app.certificates ?? []).map(({ thumbprint, thumbprint256 }) => ({ thumbprint, thumbprint256 })),
      // Same default as grantAllowed: a missing list allows every grant.
      allowedGrants: app.allowedGrants ?? Object.keys(GRANT_TYPES),
      publicClient: app.publicClient === true,
      redirectUris: app.redirectUris ?? [],
      // Issuer and subject are not secret; the issuer's public keys stay in dataverse.federatedIssuers.
      federatedCredentials: (app.federatedCredentials ?? []).map(({ issuer, subject, audiences }) => ({ issuer, subject, audiences })),
      systemuserid: userRows().find((user) => lower(user.applicationid) === lower(app.appId))?.systemuserid ?? null,
    });
    // Identities from the settings are read-only in the admin view; runtime ones can be removed.
    const configuredIdentities = new Set(dataverseConfig.managedIdentities ?? []);
    const managedIdentityView = (identity) => ({ ...identity, source: configuredIdentities.has(identity) ? "settings" : "runtime" });
    const expiry = () => new Date(Date.now() + 2 * 365 * 24 * 3600 * 1000).toISOString();
    const NOT_AVAILABLE = (message) => error(message, 501, "NOT_AVAILABLE");
    // A redirect URI lands in a form action and a Location header, so only http(s) is accepted; grants must be known.
    const httpUrl = (value) => { try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } };
    const grantNames = new Set([...Object.keys(GRANT_TYPES), ...Object.values(GRANT_TYPES)]);
    // Shared by create and PATCH: only the fields present in the body are checked and returned.
    const registrationFields = (body, { requireName = false } = {}) => {
      const fields = {};
      if (body.displayName !== undefined || requireName) {
        if (typeof body.displayName !== "string" || !body.displayName.trim()) throw error("displayName is required.");
        fields.displayName = body.displayName;
      }
      if (body.publicClient !== undefined) {
        if (typeof body.publicClient !== "boolean") throw error("publicClient must be a boolean.");
        fields.publicClient = body.publicClient;
      }
      if (body.redirectUris !== undefined) {
        if (!Array.isArray(body.redirectUris) || !body.redirectUris.every(httpUrl)) throw error("redirectUris must be http(s) URLs.");
        fields.redirectUris = [...body.redirectUris];
      }
      if (body.allowedGrants !== undefined) {
        if (!Array.isArray(body.allowedGrants) || !body.allowedGrants.every((grant) => grantNames.has(grant))) throw error("allowedGrants must name known grant types.");
        fields.allowedGrants = [...body.allowedGrants];
      }
      return fields;
    };

    if (method === "GET" && relative === "/dataverse")
      return json(res, 200, {
        ...dataverseSummary(),
        managedIdentity: managedIdentitySummary({ reveal: true }),
        // Grant names for the admin checkboxes; the registration accepts these names or their URN forms.
        grantTypes: Object.keys(GRANT_TYPES),
        applications: registrations().map(publicApp),
        managedIdentities: managedIdentityList().map(managedIdentityView),
        environment: environmentView(),
        users: userRows().map(userView),
        roles: roleRows().map(({ roleid, name }) => ({ roleid, name })),
        workflows: classicWorkflowsView(store, store.state.dataverse.workflowOverrides ?? {}),
        requests: dataverse.requests().slice(-50),
      });
    if (method === "GET" && relative === "/dataverse/requests")
      return json(res, 200, { requests: dataverse.requests() });
    if (method === "POST" && relative === "/dataverse/token")
      throw NOT_AVAILABLE("Create a secret and use the token endpoint.");

    if (method === "POST" && relative === "/dataverse/applications")
      return change(async () => {
        const body = await jsonObjectBody(req);
        const appId = lower(body.appId ?? randomUUID());
        if (!DATAVERSE_GUID.test(appId)) throw error("appId must be a GUID.");
        if (registrations().some((app) => lower(app.appId) === appId)) throw error("An application with this appId is already registered.", 409, "DATAVERSE_APPLICATION_EXISTS");
        const fields = registrationFields(body, { requireName: true });
        const roleIds = roleIdsFor(body.roles ?? ["System Administrator"]);
        // Creates the application user in its own transaction first, so a refusal leaves no registration behind.
        const systemuserid = await createApplicationUser(store, { organizationId: dataverse.organizationId, tenantId: dataverse.tenantId }, { appId, displayName: fields.displayName, roles: roleIds });
        const secret = newClientSecret();
        const { hash, salt } = hashSecret(secret);
        const entry = { id: randomUUID(), hash, salt, hint: secret.slice(0, 3), expiresOn: expiry() };
        await store.transact(() => {
          registrations().push({
            appId, createdOn: new Date().toISOString(), secrets: [entry], certificates: [],
            publicClient: false, redirectUris: [], allowedGrants: ["client_credentials"], ...fields,
          });
        });
        json(res, 201, { appId, systemuserid, secret });
      });

    // Edits the registration's name, grants, redirect URIs and client type; secrets and certificates have their own routes.
    const [, patchAppId] = /^\/dataverse\/applications\/([^/]+)$/.exec(relative) ?? [];
    if (method === "PATCH" && patchAppId)
      return change(async () => {
        const app = requireApp(patchAppId);
        const fields = registrationFields(await jsonObjectBody(req));
        await store.transact(() => {
          // The application user carries the display name, as it does at registration.
          if (fields.displayName !== undefined) {
            const user = userRows().find((item) => lower(item.applicationid) === lower(app.appId));
            if (user) user.fullname = fields.displayName;
          }
          Object.assign(app, fields);
        });
        json(res, 200, publicApp(app));
      });

    // Run mode of a classic workflow (handler, placeholder, mock or disabled); the trigger rules are not editable here.
    const [, workflowId] = /^\/dataverse\/workflows\/([^/]+)$/.exec(relative) ?? [];
    if (method === "PATCH" && workflowId)
      return change(async () => {
        const id = lower(decodeAdminIdentifier(workflowId)).replace(/[{}]/g, "");
        const body = await jsonObjectBody(req);
        if (!classicWorkflowsView(store).some((row) => row.workflowid === id)) throw error("Classic workflow not found.", 404, "DATAVERSE_WORKFLOW_NOT_FOUND");
        const override = runOverride(body.mode, body.mock ?? {});
        await store.transact(() => {
          const overrides = (store.state.dataverse.workflowOverrides ??= {});
          if (override) overrides[id] = override;
          else delete overrides[id];
        });
        json(res, 200, classicWorkflowsView(store, store.state.dataverse.workflowOverrides).find((row) => row.workflowid === id));
      });

    const [, secretAppId] = /^\/dataverse\/applications\/([^/]+)\/secrets$/.exec(relative) ?? [];
    if (method === "POST" && secretAppId)
      return change(async () => {
        const app = requireApp(secretAppId);
        const secret = newClientSecret();
        const { hash, salt } = hashSecret(secret);
        const entry = { id: randomUUID(), hash, salt, hint: secret.slice(0, 3), expiresOn: expiry() };
        await store.transact(() => {
          app.secrets ??= [];
          app.secrets.push(entry);
        });
        json(res, 201, { id: entry.id, secret, hint: entry.hint, expiresOn: entry.expiresOn });
      });

    const [, deleteSecretAppId, secretId] = /^\/dataverse\/applications\/([^/]+)\/secrets\/([^/]+)$/.exec(relative) ?? [];
    if (method === "DELETE" && deleteSecretAppId)
      return change(async () => {
        const app = requireApp(deleteSecretAppId);
        const index = (app.secrets ?? []).findIndex((item) => item.id === decodeAdminIdentifier(secretId));
        if (index < 0) throw error("Secret not found.", 404, "DATAVERSE_SECRET_NOT_FOUND");
        await store.transact(() => app.secrets.splice(index, 1));
        json(res, 204, null);
      });

    const [, certAppId] = /^\/dataverse\/applications\/([^/]+)\/certificates$/.exec(relative) ?? [];
    if (method === "POST" && certAppId)
      return change(async () => {
        const app = requireApp(certAppId);
        const body = await jsonObjectBody(req);
        // A certificate PEM keeps its X.509 fingerprints as x5t / x5t#S256 (what MSAL sends); a bare public key
        // PEM gets digests of its DER SPKI instead. The verifier accepts either PEM as the signing key.
        const pem = String(body.certificatePem ?? body.publicKeyPem ?? "");
        let key;
        try {
          key = createPublicKey(pem);
        } catch {
          throw error("certificatePem or publicKeyPem must be a PEM certificate or public key.");
        }
        const publicKeyPem = /-----BEGIN CERTIFICATE-----/.test(pem) ? new X509Certificate(pem).toString() : key.export({ type: "spki", format: "pem" });
        const { thumbprint, thumbprint256 } = certificateThumbprints(publicKeyPem);
        await store.transact(() => {
          app.certificates ??= [];
          app.certificates.push({ thumbprint, thumbprint256, publicKeyPem });
        });
        json(res, 201, { thumbprint, thumbprint256 });
      });

    // The SHA-1 or SHA-256 thumbprint names the certificate; a token signed with it stops verifying.
    const [, removeCertAppId, removeThumbprint] = /^\/dataverse\/applications\/([^/]+)\/certificates\/([^/]+)$/.exec(relative) ?? [];
    if (method === "DELETE" && removeCertAppId)
      return change(async () => {
        const app = requireApp(removeCertAppId);
        const wanted = lower(decodeAdminIdentifier(removeThumbprint));
        const index = (app.certificates ?? []).findIndex((item) => lower(item.thumbprint) === wanted || lower(item.thumbprint256) === wanted);
        if (index < 0) throw error("Certificate not found.", 404, "DATAVERSE_CERTIFICATE_NOT_FOUND");
        await store.transact(() => app.certificates.splice(index, 1));
        json(res, 204, null);
      });

    // Workload identity federation: the issuer's public JWKS (kept in dataverse.federatedIssuers) and one subject per application.
    const [, federatedAppId] = /^\/dataverse\/applications\/([^/]+)\/federated-credentials$/.exec(relative) ?? [];
    if (method === "POST" && federatedAppId)
      return change(async () => {
        const app = requireApp(federatedAppId);
        const body = await jsonObjectBody(req);
        // dataverseSettings checks the shapes: an http(s) issuer, exactly one audience, public keys only in the JWKS.
        let normalized;
        try {
          normalized = dataverseSettings({
            applications: [{ appId: app.appId, displayName: app.displayName, federatedCredentials: [{ issuer: body.issuer, subject: body.subject, audiences: body.audiences }] }],
            federatedIssuers: [{ issuer: body.issuer, jwks: body.jwks }],
          });
        } catch (failure) {
          throw error(failure.message);
        }
        const [credential] = normalized.applications[0].federatedCredentials;
        const [issuer] = normalized.federatedIssuers;
        if ((app.federatedCredentials ?? []).some((item) => item.issuer === credential.issuer && item.subject === credential.subject))
          throw error("A federated credential with this issuer and subject already exists.", 409, "DATAVERSE_FEDERATED_CREDENTIAL_EXISTS");
        await store.transact(() => {
          app.federatedCredentials ??= [];
          app.federatedCredentials.push(credential);
          const issuers = (store.state.dataverse.federatedIssuers ??= []);
          const known = issuers.find((item) => item.issuer === issuer.issuer);
          if (known) known.jwks = issuer.jwks;
          else issuers.push(issuer);
        });
        json(res, 201, credential);
      });
    if (method === "DELETE" && federatedAppId)
      return change(async () => {
        const app = requireApp(federatedAppId);
        const body = await jsonObjectBody(req);
        const index = (app.federatedCredentials ?? []).findIndex((item) => item.issuer === body.issuer && item.subject === body.subject);
        if (index < 0) throw error("Federated credential not found.", 404, "DATAVERSE_FEDERATED_CREDENTIAL_NOT_FOUND");
        await store.transact(() => app.federatedCredentials.splice(index, 1));
        json(res, 204, null);
      });

    // Managed identities become application users, as registrations do; the token endpoints read the list back.
    if (method === "POST" && relative === "/dataverse/managed-identities")
      return change(async () => {
        const body = await jsonObjectBody(req);
        const clientId = lower(body.clientId ?? randomUUID());
        if (!DATAVERSE_GUID.test(clientId)) throw error("clientId must be a GUID.");
        const principalId = lower(body.principalId ?? randomUUID());
        if (!DATAVERSE_GUID.test(principalId)) throw error("principalId must be a GUID.");
        if (typeof body.displayName !== "string" || !body.displayName.trim()) throw error("displayName is required.");
        const roleNamesIn = body.roles ?? ["Basic User"];
        const roleIds = roleIdsFor(roleNamesIn);
        if (managedIdentityList().some((item) => lower(item.clientId) === clientId) || userRows().some((user) => lower(user.applicationid) === clientId))
          throw error("A managed identity with this clientId already exists.", 409, "DATAVERSE_MANAGED_IDENTITY_EXISTS");
        const systemuserid = await createApplicationUser(store, { organizationId: dataverse.organizationId, tenantId: dataverse.tenantId }, { appId: clientId, displayName: body.displayName, roles: roleIds });
        // Same sync as the registration at startup: the managedidentity rows follow the configured plus runtime list.
        await store.transact(() => {
          (store.state.dataverse.managedIdentities ??= []).push({ clientId, principalId, displayName: body.displayName, roles: roleNamesIn });
          seedManagedIdentityRows(store, { tenantId: dataverse.tenantId, identities: managedIdentityList() });
        });
        json(res, 201, { clientId, systemuserid });
      });

    // Only identities added through this API can be removed; settings identities stay until the settings change.
    const [, removeIdentityId] = /^\/dataverse\/managed-identities\/([^/]+)$/.exec(relative) ?? [];
    if (method === "DELETE" && removeIdentityId)
      return change(async () => {
        const clientId = lower(decodeAdminIdentifier(removeIdentityId));
        const runtime = store.state.dataverse.managedIdentities ?? [];
        const index = runtime.findIndex((item) => lower(item.clientId) === clientId);
        if (index < 0) {
          if (managedIdentityList().some((item) => lower(item.clientId) === clientId)) throw error("This managed identity comes from the settings and cannot be removed here.", 409, "DATAVERSE_MANAGED_IDENTITY_CONFIGURED");
          throw error("Managed identity not found.", 404, "DATAVERSE_MANAGED_IDENTITY_NOT_FOUND");
        }
        await store.transact(() => {
          runtime.splice(index, 1);
          // The application user goes too, unless a registration with the same id owns it.
          if (!registrations().some((app) => lower(app.appId) === clientId)) {
            const userIds = new Set(userRows().filter((user) => lower(user.applicationid) === clientId).map((user) => lower(user.systemuserid)));
            removeRows("systemuserroles", (link) => userIds.has(lower(refId(link.systemuserid))));
            removeRows("systemuser", (user) => userIds.has(lower(user.systemuserid)));
          }
          // Same sync as the start-up seeding: managedidentity rows follow the configured plus runtime list.
          seedManagedIdentityRows(store, { tenantId: dataverse.tenantId, identities: managedIdentityList() });
        });
        json(res, 204, null);
      });

    const [, removeAppId] =/^\/dataverse\/applications\/([^/]+)$/.exec(relative) ?? [];
    if (method === "DELETE" && removeAppId)
      return change(async () => {
        const app = requireApp(removeAppId);
        await store.transact(() => {
          const userIds = new Set(userRows().filter((user) => lower(user.applicationid) === lower(app.appId)).map((user) => lower(user.systemuserid)));
          removeRows("systemuserroles", (link) => userIds.has(lower(refId(link.systemuserid))));
          removeRows("systemuser", (user) => userIds.has(lower(user.systemuserid)));
          registrations().splice(registrations().indexOf(app), 1);
        });
        json(res, 204, null);
      });

    if (method === "POST" && relative === "/dataverse/users")
      return change(async () => {
        const body = await jsonObjectBody(req);
        checkPassword(body.password);
        if (body.accessmode !== undefined && !Number.isInteger(body.accessmode)) throw error("accessmode must be an integer.");
        if (typeof body.fullname !== "string" || !body.fullname.trim()) throw error("fullname is required.");
        if (typeof body.domainname !== "string" || !body.domainname.trim()) throw error("domainname is required.");
        const objectId = lower(body.objectId ?? randomUUID());
        if (!DATAVERSE_GUID.test(objectId)) throw error("objectId must be a GUID.");
        const systemuserid = uuidV5(dataverse.organizationId, `systemuser:oid:${objectId}`);
        if (userRows().some((user) => lower(user.systemuserid) === systemuserid)) throw error("A user with this objectId already exists.", 409, "DATAVERSE_USER_EXISTS");
        const units = store.tableRows("businessunit");
        const unit = body.businessUnitId ? units.find((item) => lower(item.businessunitid) === lower(body.businessUnitId)) : units.find((item) => !item.parentbusinessunitid);
        if (!unit) throw error("Business unit not found.", 404, "DATAVERSE_BUSINESS_UNIT_NOT_FOUND");
        const org = store.tableRows("organization").find((item) => lower(item.organizationid) === lower(dataverse.organizationId));
        const roleIds = roleIdsFor(body.roles ?? ["Basic User"]);
        await store.transact(() => {
          store.insertRow("systemuser", userRows(), {
            systemuserid, fullname: body.fullname, domainname: body.domainname, internalemailaddress: body.domainname,
            azureactivedirectoryobjectid: objectId, accessmode: body.accessmode ?? 0, isdisabled: false,
            businessunitid: { id: unit.businessunitid, logical_name: "businessunit", name: unit.name ?? "" },
            organizationid: { id: dataverse.organizationId, logical_name: "organization", name: org?.name ?? "" },
          });
          if (body.password !== undefined) passwords()[systemuserid] = hashSecret(body.password);
        });
        await assignRoles(store, { systemuserid, roleIds });
        json(res, 201, { systemuserid, azureactivedirectoryobjectid: objectId });
      });

    const [, patchUserId] = /^\/dataverse\/users\/([^/]+)$/.exec(relative) ?? [];
    if (method === "PATCH" && patchUserId)
      return change(async () => {
        const systemuserid = decodeAdminIdentifier(patchUserId);
        const body = await jsonObjectBody(req);
        checkPassword(body.password, { allowNull: true });
        const find = () => userRows().find((user) => lower(user.systemuserid) === lower(systemuserid));
        if (!find()) throw error("User not found.", 404, "DATAVERSE_USER_NOT_FOUND");
        if (body.isdisabled !== undefined && typeof body.isdisabled !== "boolean") throw error("isdisabled must be a boolean.");
        if (body.accessmode !== undefined && !Number.isInteger(body.accessmode)) throw error("accessmode must be an integer.");
        const roleIds = body.roles === undefined ? null : roleIdsFor(body.roles);
        await store.transact(() => {
          const user = find();
          if (body.isdisabled !== undefined) user.isdisabled = body.isdisabled;
          if (body.accessmode !== undefined) user.accessmode = body.accessmode;
          // null clears the password: the user then cannot sign in with one until it is set again.
          if (body.password === null) delete passwords()[user.systemuserid];
          else if (body.password !== undefined) passwords()[user.systemuserid] = hashSecret(body.password);
        });
        if (roleIds) {
          await store.transact(() => removeRows("systemuserroles", (link) => lower(refId(link.systemuserid)) === lower(systemuserid)));
          await assignRoles(store, { systemuserid, roleIds });
        }
        json(res, 200, userView(find()));
      });

    // Runtime environment settings: each field is optional and validated before anything is written.
    if (method === "PATCH" && relative === "/dataverse/environment")
      return change(async () => {
        const body = await jsonObjectBody(req);
        for (const name of ["auditing", "duplicateDetection", "tdsEnabled"])
          if (body[name] !== undefined && typeof body[name] !== "boolean") throw error(`${name} must be a boolean.`);
        if (body.pluginTimeoutSeconds !== undefined && (!Number.isInteger(body.pluginTimeoutSeconds) || body.pluginTimeoutSeconds < 1 || body.pluginTimeoutSeconds > 3600))
          throw error("pluginTimeoutSeconds must be an integer from 1 to 3600.");
        if (body.requestsPer300s !== undefined && body.requestsPer300s !== null && (!Number.isInteger(body.requestsPer300s) || body.requestsPer300s < 1))
          throw error("requestsPer300s must be a positive integer, or null to turn the limit off.");
        if ((body.auditing !== undefined || body.duplicateDetection !== undefined) && !organizationRow())
          throw error("Organization row not found.", 404, "DATAVERSE_ORGANIZATION_NOT_FOUND");
        await store.transact(() => {
          if (body.auditing !== undefined) organizationRow().isauditenabled = body.auditing;
          if (body.duplicateDetection !== undefined) organizationRow().isduplicatedetectionenabled = body.duplicateDetection;
          const environment = (store.state.dataverse.environment ??= {});
          for (const key of ["tdsEnabled", "pluginTimeoutSeconds", "requestsPer300s"]) if (body[key] !== undefined) environment[key] = body[key];
        });
        json(res, 200, environmentView());
      });

    throw error("Admin endpoint not found.", 404);
  };

}
