# SharePoint documents

Two separate adapters cover SharePoint. Neither reaches a SharePoint tenant. Adapter A stores Dataverse document locations and their files through the storage provider. Adapter B is a fixture server that answers Graph and SharePoint REST requests from declared data.

| Adapter                                       | Module                                | Level                                                                         |
| --------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------- |
| A: Dataverse document integration             | `mirage/lib/sharepoint-documents.mjs` | `behaviour` when a storage router or provider is passed, otherwise `contract` |
| B: Graph and SharePoint REST contract fixture | `mirage/lib/sharepoint-contract.mjs`  | `contract`, mounted only for a connection that declares it                    |

## Adapter A: Dataverse document integration

Module: `mirage/lib/sharepoint-documents.mjs` (`EXTENSION`, name `sharepoint-documents`). Capability record: level `behaviour` when a storage router or provider is passed, otherwise `contract`; requires `provider:storage/sharepointDocuments` and `table:sharepointdocumentlocation`. Per-operation levels are listed as `{ name, level }` objects.

**Behaviour.** `install(api, { storage, diagnostic })` exposes `api.sharepoint`. The last argument of each call is the identity: `{ admin: true }`, or `{ user, caller? }` where `user` is a `systemuser` row (the request's `c.user`).

| Call                                                                                             | What it does                                                                                                                                                                               | Privilege on the regarding record |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `locationsFor({ logicalName, id }, identity)`                                                    | active `sharepointdocumentlocation` rows regarding the record                                                                                                                              | read                              |
| `ensureLocation(regarding, { parentSite?, relativeUrl? }, identity)`                             | returns the record's active location, or creates a table library location under the site (relative URL = table logical name, created once) and a record location under it, plus the folder | write                             |
| `listDocuments(locationId, identity, { path })`                                                  | one folder, subfolders first (`{ name, folder: true }`), then its files: `name`, `size`, `etag`, `contentType`, `lastModified`                                                             | read                              |
| `createFolder(locationId, { path, name }, identity)`, `deleteFolder(locationId, path, identity)` | create or delete a subfolder of the record folder                                                                                                                                          | write                             |
| `upload(locationId, { name, bytes, contentType, ifMatch? }, identity)`                           | stores the file; answers the provider ETag; `ifMatch` → 412 on mismatch                                                                                                                    | write                             |
| `delete(locationId, name, { ifMatch? }, identity)`                                               | removes the file; 404 when absent, 412 on an ETag mismatch                                                                                                                                 | write                             |

`upload`, `download` and `delete` take `path` for a file inside a subfolder.
| `describe()` | the capability record for this api | — |

The site is the `sharepointsite` row with `isdefault: true`, or `parentSite` (an id). Location rows are created through the record pipeline (write hooks, ownership, plug-in steps) inside one transaction; the folder marker is stored first. Bytes live in the storage route `sharepointDocuments` under `sharepoint/<siteid>/<relative url segments>/<name>` (each segment lower-cased, characters outside `[a-z0-9.-]` escaped as `_<hex>_`), so names are case-insensitive. The organization attachment limit (`MaxUploadFileSize`, compared with the base64 length, `/_sim` overrides apply) refuses larger uploads with `AttachmentTooLarge`. Location rows also answer the existing `RetrieveAbsoluteAndSiteCollectionUrl` message.

**Contract.** Without storage, `ensureLocation`, `listDocuments`, `upload` and `delete` answer 501 `SharePointStorageNotConfigured`; `locationsFor` still reads rows. The native auto-folder naming is not modelled.

**Power Pages document control (contract).** A basic or multistep form subgrid on Document Locations renders a local, labelled document grid (`data-mirage-component="portal-documents"`, diagnostic `PORTAL_SHAREPOINT_DOCUMENTS_LOCAL`); the platform's markup and `/_services/` wire format are not documented. The grid calls the local route `/_apps/portal-documents/<table>/<id>`: `GET` lists one folder (`{ folder, folders, documents, canUpload, canCreateFolder, canDelete }`), `POST ?name=<file>` uploads one file, `POST ?newFolder=<name>` creates a subfolder (409 when it exists), `GET …/<name>` downloads, `DELETE …/<name>` deletes a file and `DELETE ?folder=<path>` deletes a subfolder with its contents. Every call takes `?folder=<a/b>` to address a subfolder of the record folder (404 when it does not exist; a name with `/`, `\` or `..` answers 400; at most 16 levels, so New folder inside a 16th-level folder answers 400). A new file or folder name follows SharePoint's naming rules: no `" * : < > ? / \ |`, no leading or trailing space, no trailing dot, and none of the reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`, `LPT0`–`LPT9`, `.lock`, `desktop.ini`, `_private`, `~$…`, `_vti_`), else 400. A file and a folder cannot share a name in one folder (409). The grid shows folders first, opens a folder on click and navigates back with its breadcrumb. Permissions follow the documented Power Pages rules: the parent table permission needs Read and Append To (and Write to upload); the child permission on Document Location needs Read to list, Create, Write and Append to upload, and Delete to delete (`permissions.mjs` `portalDocumentAccess`). The parent record must exist, so a create-mode form shows a notice instead of the grid. Writes need the portal verification token. New folder needs the upload privileges (Create, Write and Append on Document Location). Any other member answers 501 `PortalDocumentMemberUnsupported`; without storage every call answers 501, and a route whose provider is declared but not ready answers 503 `Unavailable`.

An upload whose extension is in the organization's blocked list answers 400 `AttachmentTypeBlocked`. Without a configured `BlockedAttachments` (organization row, catalogue default or instance override) the list is the Dataverse default, which blocks `exe`, `js`, `svg` and the other listed types; an override, even an empty one, replaces it.

**Diagnostics.** `SHAREPOINT_ROUTE_MISSING`: once per api, the first time a storage-backed call has no storage.

**Site settings.** From [Manage SharePoint documents](https://learn.microsoft.com/power-pages/configure/manage-sharepoint-documents): `SharePoint/MaxUploadSize` (MB, default 10, at most 50) bounds each portal upload and `SharePoint/MaxTotalUploadSize` (MB) bounds the request; a larger file answers 413 `SharePointFileTooLarge`. The organization's blocked attachment extensions also apply. Outside the portal path the organization attachment limit applies.

**Naming and limits.** The default folder name is `<record name>_<record id>` ([documented format](https://learn.microsoft.com/dynamics365/customerengagement/on-premises/basics/manage-sharepoint-documents-document-locations-in-dynamics-365-apps)); the id is written upper-case without dashes and characters `" * : < > ? / \ |` are dropped from the name. The record location is named `Documents on <site name>`. The error codes `SharePointInvalidName`, `SharePointInvalidRegarding`, `SharePointDefaultSiteMissing` and `SharePointLocationUnresolved` are local names. The `sharepointdocument` virtual table is not seeded.

## Adapter B: Graph and SharePoint REST contract fixture

Module: `mirage/lib/sharepoint-contract.mjs`. Capability record `sharePointContractDescriptor`: level `contract`, requires `connection:sharepoint`. Exports `createSharePointContractRoutes({ fixtures, diagnostic })`, `createSharePointFixtureServer({ fixtures, diagnostic, host, traces })` (with a trace store, each request is an `http` trace root on host `sharepoint` that joins the caller's trace headers and records the Graph error of a refused request), `dispatchSharePointRoute(routes, req)`, `validateSharePointFixtures(value)` and `SHAREPOINT_CONTRACT_OPERATIONS`.

**Behaviour.** Routes answer from an in-memory store seeded by `fixtures`:

```js
{ sites: { "site-a": {} }, drives: { "drive-a": { siteId: "site-a" } },
  items: [{ driveId: "drive-a", path: "x_case/Case one/notes.txt", content: "hello", contentType: "text/plain" },
          { driveId: "drive-a", path: "x_case/Empty", folder: true }] }
```

| Operation     | Request                                                       | Answer                                                                                     |
| ------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| listChildren  | `GET /sites/{siteId}/drives/{driveId}/root:/{path}:/children` | 200 `{ value: [driveItem] }`                                                               |
| uploadContent | `PUT …/root:/{path}:/content`                                 | 201 new, 200 replaced; `If-Match` → 412; `?@microsoft.graph.conflictBehavior=fail\|rename` |
| createFolder  | `POST …/root:/{path}:/children` with `{ name, folder: {} }`   | 201; conflict `fail` (default) → 409, `rename` → `name 1`                                  |
| deleteItem    | `DELETE /sites/{siteId}/drives/{driveId}/items/{itemId}`      | 204; `If-Match` → 412; 404 when absent                                                     |

An optional `/v1.0` prefix is accepted. A `driveItem` carries `id`, `name`, `eTag`, `cTag`, `size`, `createdDateTime`, `lastModifiedDateTime`, `parentReference` and `folder { childCount }` or `file { mimeType }`. Errors use the Graph body `{ error: { code, message } }` with `itemNotFound` (404), `nameAlreadyExists` (409), `resourceModified` (412) and `invalidRequest` (400). The fixture server listens on loopback port 0 only and caps request bodies at 4 MiB (413).

**Diagnostics.** Any other request answers 501 `notSupported` with `innerError.code` `ProviderOperationUnsupported` and reports `SHAREPOINT_CONTRACT_UNSUPPORTED` once per method and route shape.

**Limits.** The eTag text, item id format and root `parentReference` are local; error bodies carry no `innerError` date or request id. A PUT to a missing parent folder answers 404, and `createFolder` defaults to `fail`. `createUploadSession` and the SharePoint REST `_api/web/...` surface are not modelled.

## Connecting the adapters

1. Adapter A is installed by the organization runtime through the extension list in `mirage/lib/dataverse-extensions.mjs`, directly after `dataverse-files`. It needs the standard tables from `dataverse-standard`, which is installed first, and reuses `createThroughPipeline` from `dataverse-files`:

   ```js
   import { EXTENSION as sharepointDocuments } from "./sharepoint-documents.mjs";
   // after { name: "dataverse-files", ... }:
   sharepointDocuments,
   ```

   The module reads its storage from `api.providers.storage`, which the organization host builds with `createStorageRouter({ config, providers })` for route `sharepointDocuments` (default `local`). An explicit `storage` install option takes precedence. Without a router the module reports `contract`.

2. Adapter B is mounted only for a connection that declares it. A connector `http` rewrite in project config routes the Graph host to the fixture server:

   ```yaml
   connections:
     shared_sharepointonline:
       connector: shared_sharepointonline
       provider: http
       settings:
         rewrites:
           'https://graph.microsoft.com': 'http://127.0.0.1:<fixture port>'
   ```

   A project starts `createSharePointFixtureServer({ fixtures })`, or registers its routes through the `httpFixtures` pack export.

3. The `RetrieveAbsoluteAndSiteCollectionUrl` message stays registered in `mirage/lib/dataverse-org-messages.mjs`, bound to `sharepointsite` and `sharepointdocumentlocation`. Location rows answer it through that registration.

Related guides: [storage providers](storage-providers.md) for the storage routes and provider contract, [data packs](data-packs.md) for pack exports and [capabilities and preflight](capabilities-and-preflight.md) for the level reported for each adapter.
