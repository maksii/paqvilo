# Dataverse Web API: design decisions

Status: implemented. Contributor notes for the simulated Dataverse organization. Settings, endpoints, supported messages
and limits are in [Dataverse Web API simulation](../../mirage/docs/dataverse-api.md).

## Separate loopback listeners

The Web API (`/api/data/v9.x/`), the token authority, discovery and the SOAP organization service run in the **same
process and on the same `DataStore`** as the portal, but on **their own loopback listeners**, never on the portal
origin:

- It matches the real topology. The organization URL, the portal URL and `login.microsoftonline.com` are three origins;
  SDKs build `${orgUrl}/api/data/v9.2/` and MSAL builds `${authority}/oauth2/v2.0/token`, so an SDK points at loopback
  without code changes.
- The portal pipeline (`Host`/`Origin` checks, audit classification, HTML error pages, live page forwarding) is
  untouched: `/_api/`, `/_sim/` and page rendering behave the same whether or not the API is enabled.
- Every absolute URL the API emits (`@odata.context`, `@odata.nextLink`, `OData-EntityId`, token endpoints, discovery
  `ApiUrl`) is built from the listener that received the request, so HTTP, HTTPS and port 80 produce consistent links.

## Rules contributors keep

- **Authorize, then call the store.** The Dataverse layer checks privileges and depth with `createPrincipals()` before
  every store call, then calls the store with an internal administrative identity, so portal table permissions never
  apply to Dataverse callers. Collection reads filter rows through the store's backend row-filter hooks.
- **Ownership and audit columns come from the Dataverse layer** (the `systemColumns` write option), not from the store's
  defaults, so portal writes are unaffected.
- **Secrets never reach disk or logs in plain form.** Client secrets come from named environment variables or are
  generated and shown once; client secrets and user passwords are stored as salted scrypt hashes (`hashSecret`; a salted
  SHA-256 hash already in a state file is verified, never written). Tokens, authorization codes and refresh tokens live
  in memory only, so tokens from an earlier process fail verification and SDKs re-acquire them. The request log records
  method, path, status, timing, caller IDs and trace ids, never `Authorization` or bodies.
- **Security principals are ordinary rows** (`organization`, `businessunit`, `systemuser`, `team`, `role`, `privilege`
  and their intersect tables) with user-configured mappings, so a Solution re-import never drops them. Default
  identifiers are deterministic (`uuidV5` from the organization id), so fixtures can quote them.
- **Signing keys, JWKS and the TLS certificate use `node:crypto` only**; the API adds no dependency.

## Module map

The Dataverse modules are flat files in `mirage/lib/`: the release allowlist accepts
`mirage/lib/[a-z0-9-]+.(mjs|js|css|json)` and lists subfolder files explicitly. The table names the entry points;
related `dataverse-*.mjs` modules hold individual message families.

| Module                   | Owns                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `dataverse-api.mjs`      | `startDataverseApi()`: listeners, routing, bearer verification, impersonation, service protection, request log. |
| `dataverse-records.mjs`  | Record handlers behind one `handle(ctx)`: CRUD, queries, paging, navigation and `$ref`, bulk actions.           |
| `dataverse-auth.mjs`     | Signing keys, JWKS, OpenID documents, OAuth grants, token issue and verification, `AADSTS` errors.              |
| `dataverse-security.mjs` | Security tables and seed, principal resolution, privileges and depth, sharing, ownership columns.               |
| `dataverse-metadata.mjs` | `EntityDefinitions`, relationships, option sets, the service document, `$metadata`, `RetrieveMetadataChanges`.  |
| `dataverse-odata.mjs`    | Route grammar, `Prefer`, URLs, skip tokens, error envelopes, status and code mapping, response headers.         |
| `dataverse-batch.mjs`    | `$batch` multipart parsing, change sets and `$n` references.                                                    |
| `dataverse-soap*.mjs`    | The SOAP organization service.                                                                                  |
| `dataverse-tds*.mjs`     | The read-only SQL (TDS) endpoint.                                                                               |
| `dataverse-tls.mjs`      | The self-signed loopback certificate.                                                                           |
| `dataverse-settings.mjs` | Validation and defaults of the `dataverse` settings section.                                                    |
| `dataverse-admin.mjs`    | The `/_sim/api/dataverse/*` administration endpoints.                                                           |

`composeOrganizationHost` (`mirage/lib/organization-host.mjs`) starts and stops the listeners, and `mirage/server.mjs`
reports them in status. Tests in
`mirage/test/dataverse-*.test.mjs` use invented schemas over loopback; real-client gates are in `mirage/test-sdk/`.
