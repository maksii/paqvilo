# SharePoint documents

Two separate adapters cover SharePoint; neither reaches a SharePoint tenant.

| Adapter                                       | Module                                | Level                                                                    |
| --------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------ |
| A: Dataverse document integration             | `mirage/lib/sharepoint-documents.mjs` | `behaviour` with a storage router or provider, otherwise `contract`      |
| B: Graph and SharePoint REST contract fixture | `mirage/lib/sharepoint-contract.mjs`  | `contract`; not started by the runtime: a project test or pack starts it |

## Adapter A: Dataverse document integration

The organization extension `sharepoint-documents` stores document location files in the `sharepointDocuments` [storage
route](storage-providers.md#routes) (default `local`), read from `api.providers.storage` unless an explicit `storage`
install option is given. Its capability record requires `provider:storage/sharepointDocuments` and
`table:sharepointdocumentlocation`.

`api.sharepoint` takes the identity as the last argument of each call: `{ admin: true }`, or `{ user, caller? }` with a
`systemuser` row. `path` is an array of folder names from the record folder down (`['Reports', '2026']`); `upload`,
`download` and `delete` take it for a file inside a subfolder, and `deleteFolder` takes it as its second argument.

| Call                                                                                             | What it does                                                                                                                         | Privilege on the regarding record |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `locationsFor({ logicalName, id }, identity)`                                                    | active `sharepointdocumentlocation` rows regarding the record                                                                        | read                              |
| `ensureLocation(regarding, { parentSite?, relativeUrl? }, identity)`                             | the record's active location, or creates a table library location (relative URL = table logical name) and a record location under it | write                             |
| `listDocuments(locationId, identity, { path })`                                                  | one folder: subfolders first (`{ name, folder: true }`), then files with `name`, `size`, `etag`, `contentType`, `lastModified`       | read                              |
| `createFolder(locationId, { path, name }, identity)`, `deleteFolder(locationId, path, identity)` | create or delete a subfolder                                                                                                         | write                             |
| `upload(locationId, { name, bytes, contentType, ifMatch? }, identity)`                           | stores the file and answers its ETag; `ifMatch` mismatch → 412                                                                       | write                             |
| `download(locationId, name, identity, { path })`                                                 | reads a file; 404 when absent                                                                                                        | read                              |
| `delete(locationId, name, { ifMatch? }, identity)`                                               | removes the file; 404 when absent, 412 on an ETag mismatch                                                                           | write                             |
| `describe()`                                                                                     | the capability record for this runtime                                                                                               | —                                 |

- **Storage layout.** The site is the `sharepointsite` row with `isdefault: true`, or `parentSite`. Location rows go
  through the record pipeline (hooks, ownership, plug-in steps) in one transaction. Bytes are stored under
  `sharepoint/<siteid>/<relative url segments>/<name>` with each segment lower-cased and characters outside
  `[a-z0-9.-]` escaped as `_<hex>_`, so names are case-insensitive.
- **Limits.** The organization attachment limit (`MaxUploadFileSize`, compared with the base64 length; `/_sim`
  overrides apply) refuses larger uploads with `AttachmentTooLarge`. Subfolders nest at most 16 levels (a local bound).
- **Naming.** The default folder name is `<record name>_<record id>` ([documented
  format](https://learn.microsoft.com/dynamics365/customerengagement/on-premises/basics/manage-sharepoint-documents-document-locations-in-dynamics-365-apps)):
  the id upper-case without dashes, characters `" * : < > ? / \ |` dropped from the name. The record location is named
  `Documents on <site name>`. `SharePointInvalidName`, `SharePointInvalidRegarding`, `SharePointDefaultSiteMissing` and
  `SharePointLocationUnresolved` are local error codes.
- **Without storage** every call except `locationsFor` and `describe` answers 501
  `SharePointStorageNotConfigured` and `SHAREPOINT_ROUTE_MISSING` is reported once; `locationsFor` still reads rows.
- **Not modelled:** native automatic folder creation and the `sharepointdocument` virtual table (not seeded). Location
  rows answer `RetrieveAbsoluteAndSiteCollectionUrl`.

### Power Pages document control

A basic or multistep form subgrid on Document Locations renders a local, labelled document grid
(`data-mirage-component="portal-documents"`, diagnostic `PORTAL_SHAREPOINT_DOCUMENTS_LOCAL`, level `contract`): the
platform's markup and `/_services/` wire format are not documented. The grid calls
`/_apps/portal-documents/<table>/<id>`:

| Request                  | Effect                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `GET`                    | lists one folder: `{ folder, folders, documents, canUpload, canCreateFolder, canDelete }` |
| `POST ?name=<file>`      | uploads one file                                                                          |
| `POST ?newFolder=<name>` | creates a subfolder (409 when it exists)                                                  |
| `GET …/<name>`           | downloads a file                                                                          |
| `DELETE …/<name>`        | deletes a file                                                                            |
| `DELETE ?folder=<path>`  | deletes a subfolder with its contents                                                     |

- Every call takes `?folder=<a/b>` to address a subfolder (404 when absent; a new folder below the 16th level → 400).
  A blank, `.` or `..` segment or a `\` in the path answers 400 `SharePointInvalidName` ("The folder path is not
  valid: … (path traversal is refused)."). Names follow SharePoint's rules: no `" * : < > ? / \ |`, no leading or
  trailing space, no trailing dot, none of the reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`,
  `LPT0`–`LPT9`, `.lock`, `desktop.ini`, `_private`, `~$…`, `_vti_`), else 400 `SharePointInvalidName`. An existing
  folder answers 409 `SharePointFolderExists`; a file and a folder cannot share a name (409 `SharePointNameExists`).
- Permissions follow the documented Power Pages rules: the parent table permission needs Read and Append To (and Write
  to upload); the Document Location permission needs Read to list, Create, Write and Append to upload or create a
  folder, and Delete to delete (otherwise 403 `PermissionDenied`). Writes need the portal verification token in the
  `__RequestVerificationToken` header (otherwise 403 `Forbidden`). A create-mode form shows a notice instead of the grid
  because the parent record must exist.
- Uploads are bounded by the site settings `SharePoint/MaxUploadSize` (MB, default 10, at most 50) per file and
  `SharePoint/MaxTotalUploadSize` (MB) per request (413 `SharePointFileTooLarge`), from
  [Manage SharePoint documents](https://learn.microsoft.com/power-pages/configure/manage-sharepoint-documents). An
  extension in the organization's blocked list answers 400 `AttachmentTypeBlocked`; without a configured
  `BlockedAttachments` the Dataverse default list applies (it blocks `exe`, `js`, `svg` and others), and any override,
  even an empty one, replaces it.
- Any other member answers 501 `PortalDocumentMemberUnsupported`. Without storage every call answers 501; a route whose
  provider is declared but not ready answers 503 `Unavailable`.

## Adapter B: Graph and SharePoint REST contract fixture

`paqvilo/mirage/lib/sharepoint-contract.mjs` exports `createSharePointContractRoutes({ fixtures, diagnostic })`,
`createSharePointFixtureServer({ fixtures, diagnostic, host, traces })` (resolves to `{ url, routes, close }`),
`validateSharePointFixtures(value)` and the record `sharePointContractDescriptor` (`contract`, requires
`connection:sharepoint`, `operations` lists the four operations below). With a trace store, each fixture-server request
is an `http` trace root on host `sharepoint`. Routes answer from an in-memory store seeded by `fixtures`:

```js
{ sites: { "site-a": {} }, drives: { "drive-a": { siteId: "site-a" } },
  items: [{ driveId: "drive-a", path: "x_case/Case one/notes.txt", content: "hello", contentType: "text/plain" },
          { driveId: "drive-a", path: "x_case/Empty", folder: true }] }
```

| Operation     | Request                                                       | Answer                                                                                                                                               |
| ------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| listChildren  | `GET /sites/{siteId}/drives/{driveId}/root:/{path}:/children` | 200 `{ value: [driveItem] }`                                                                                                                         |
| uploadContent | `PUT …/root:/{path}:/content`                                 | 201 new, 200 replaced; `If-Match` → 412; `?@microsoft.graph.conflictBehavior=` `replace` (default), `fail` → 409, `rename`; an existing folder → 409 |
| createFolder  | `POST …/root:/{path}:/children` with `{ name, folder: {} }`   | 201; the body's `@microsoft.graph.conflictBehavior`: `fail` (default) → 409, `rename` → `name 1`, `replace`                                          |
| deleteItem    | `DELETE /sites/{siteId}/drives/{driveId}/items/{itemId}`      | 204; `If-Match` → 412; 404 when absent                                                                                                               |

An optional `/v1.0` prefix is accepted. A `driveItem` carries `id`, `name`, `eTag`, `cTag`, `size`, `createdDateTime`,
`lastModifiedDateTime`, `parentReference` and `folder { childCount }` or `file { mimeType }`. Errors use the Graph body
`{ error: { code, message } }` with `itemNotFound` (404), `nameAlreadyExists` (409), `resourceModified` (412) and
`invalidRequest` (400). The server listens on loopback port 0 and caps bodies at 4 MiB (413). Any other request answers
501 `notSupported` (`innerError.code` `ProviderOperationUnsupported`) and reports `SHAREPOINT_CONTRACT_UNSUPPORTED` once
per method and route shape.

Limits: the eTag text, item id format and root `parentReference` are local; errors carry no `innerError` date or request
id; a PUT to a missing parent folder answers 404. `createUploadSession` and the SharePoint REST `_api/web/...` surface
are not modelled.

To use it, start `createSharePointFixtureServer({ fixtures })` and route the Graph host to it with a connection rewrite
(the route list of `createSharePointContractRoutes` is `{ method, operation, pattern, handle(req) }` against the request
path, not the pack `httpFixtures` shape):

```yaml
connections:
  shared_sharepointonline:
    connector: shared_sharepointonline
    provider: http
    settings:
      rewrites:
        'https://graph.microsoft.com': 'http://127.0.0.1:<fixture port>'
```
