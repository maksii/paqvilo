# Dataverse Web API: how it is built

Contributor notes for the simulated Dataverse Web API. For enabling it, connecting SDKs, settings, the supported surface and
limits, read [Dataverse Web API simulation](../../mirage/docs/dataverse-api.md).

## Shape

Mirage serves the Dataverse Web API (`/api/data/v9.x/`), an Entra-shaped token authority, discovery and the SOAP
organization service from the **same process and the same `DataStore`** as the portal, but on **its own loopback
listener(s)**, never on the portal origin.

Why separate listeners:

- It matches the real topology. The organization URL, the portal URL and `login.microsoftonline.com` are three origins;
  SDKs build `${orgUrl}/api/data/v9.2/` and MSAL builds `${authority}/oauth2/v2.0/token`, so pointing an SDK at loopback
  needs no code change.
- The portal pipeline (`Host`/`Origin` checks, audit classification, HTML error pages, live page forwarding) is untouched.
  Portal behaviour under `/_api/`, `/_sim/` and page rendering does not depend on whether the Dataverse API is enabled.
- Every absolute URL the API emits (`@odata.context`, `@odata.nextLink`, `OData-EntityId`, token endpoints, discovery
  `ApiUrl`) is built from the listener that received the request, so HTTP, HTTPS and port 80 all produce consistent links.

The portal still sees Dataverse tables only through its own `Webapi/<table>/*` site settings and table permissions.

## Modules

All modules are flat files in `mirage/lib/` (the release allowlist is `mirage/lib/[a-z0-9-]+.mjs`). The main ones:

| Module                   | Owns                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dataverse-api.mjs`      | `startDataverseApi()`: listeners, routing, bearer verification, impersonation, service protection, request log (500-entry ring buffer; `Authorization` and bodies are never logged). |
| `dataverse-records.mjs`  | Record handlers behind one `handle(ctx)` interface: CRUD, queries, paging, navigation and `$ref`, bulk actions.                                                                      |
| `dataverse-auth.mjs`     | Signing keys, JWKS, OpenID documents, every OAuth grant, token issue and verification, `AADSTS` errors.                                                                              |
| `dataverse-security.mjs` | Security tables and their seed, principal resolution, privileges and depth, sharing, ownership columns.                                                                              |
| `dataverse-metadata.mjs` | `EntityDefinitions`, relationships, option sets, the service document, `$metadata` CSDL, `RetrieveMetadataChanges`.                                                                  |
| `dataverse-odata.mjs`    | Route grammar, `Prefer` parsing, URLs, skip tokens, error envelopes and status/code mapping, response headers.                                                                       |
| `dataverse-batch.mjs`    | `$batch` multipart parsing, change sets and `$n` references.                                                                                                                         |
| `dataverse-soap*.mjs`    | The SOAP organization service used by `ServiceClient`.                                                                                                                               |
| `dataverse-tds*.mjs`     | The read-only SQL (TDS) endpoint.                                                                                                                                                    |
| `dataverse-tls.mjs`      | The self-signed loopback certificate (`node:crypto` only).                                                                                                                           |
| `dataverse-settings.mjs` | Validation and defaults of the `dataverse` configuration section.                                                                                                                    |

`mirage/server.mjs` starts and stops the listeners, reports them in status and serves the `/_sim/api/dataverse/*`
administration endpoints.

## Rules contributors keep

- **Authorize, then call the store.** The Dataverse layer checks privileges and depth with `createPrincipals()` before
  every store call, then calls the store with an internal administrative identity, so portal table permissions never apply
  to Dataverse callers. Collection reads filter rows through the store's backend row-filter hooks.
- **Ownership and audit columns come from the Dataverse layer** (`systemColumns` write option), not from the store's
  default behaviour, so portal writes are unaffected.
- **Secrets never touch disk or logs in plain form.** Client secrets come from named environment variables or are generated
  and shown once; they are stored as salted SHA-256 hashes. Tokens, authorization codes and refresh tokens live in memory
  only, so tokens from a previous process fail verification and SDKs re-acquire them. Snapshots strip passwords and secret
  hashes.
- **Security principals are ordinary rows** (`organization`, `businessunit`, `systemuser`, `team`, `role`, `privilege` and
  their intersect tables) with user-configured mappings, so a Solution re-import never drops them. Default identifiers are
  deterministic (`uuidV5` from the organization id), so fixtures can quote them.
- **No new dependencies.** ESM, Node 24.22.1+ (24.x LTS), `node:crypto` only.

## Tests

- `mirage/test/dataverse-*.test.mjs` cover the modules and HTTP behaviour with invented schemas over loopback. They run in
  `npm run validate`.
- `mirage/test-sdk/` holds opt-in gates that drive real client libraries against the simulator (`toolkit-client`,
  `dynamics-web-api`, `python-dataverse`, `webapi-samples`, `serviceclient`, `cert-auth`, `tds`). Run them with
  `npm run test:sdk`; they are not part of `npm run validate` because they need .NET, Python or extra npm installs.
  `mirage/test-sdk/harness.mjs` starts the API over an in-memory store with one application registration.
