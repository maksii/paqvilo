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
- **Not modelled:** native automatic folder creation. Location rows answer `RetrieveAbsoluteAndSiteCollectionUrl`.

### The integration on and off

Mirage treats the environment's SharePoint integration as on when the `sharepointDocuments` storage route is
configured (the default `local` route included). The observed choice `sharePointIntegration: off` (see [observed query
settings](dataverse-parity.md#observed-query-settings)) turns it off although the route exists, as on an environment
whose admin center shows SharePoint Integration No. Hosted session F7 recorded every hosted answer below with the
integration off; the answers with it on come from this module's folders, and their values are local.

### The sharepointdocument table

The `sharepointdocument` table (`sharepoint-document-table.mjs`) is a Standard table with the columns hosted session F7
recorded (primary name `fullname`). A read without a `regardingobjectid` condition answers no rows, and `/$count`
answers -1. With the integration off, a `$filter` or FetchXML condition on `regardingobjectid` answers 400
`0x80071017` (SharePointS2SIsDisabled). Through the portal Web API it answers 400 `9004010D` with cdscode
`0x80071017`, and in Liquid `{% fetchxml %}` it prints "Exception has been thrown by the target of an invocation." A
keyed read answers 404 `0x80040217`. With the integration on, such a read lists the top level of each named record's
document folder from the storage route, for a caller who may see that folder: in the organization, Read on the record and
on its location; through the portal, the document control's list permissions (below). The listed rows belong to the
read that listed them: none is stored, so another read never sees them. The listed columns are local. A table with document management enabled gets
`<table>_SharePointDocumentLocations` and `<table>_SharePointDocuments`, both cascading Assign, Delete, Merge, Reparent,
Share and Unshare. A regarding value names its table: a bare id names no record, so a cascade never reaches it.

### Power Pages document control

A basic or multistep form subgrid on Document Locations renders the platform's document control as hosted session F7
recorded it (diagnostic `PORTAL_SHAREPOINT_DOCUMENTS_LOCAL`, level `contract`, for the answers with the integration
on). The cell has the classes `sharepoint-documents table table-striped-cell`; inside it, `div.subgrid.sharepoint-grid`
carries:

| Attribute                                                                      | Value                                                                               |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `data-bs-target`                                                               | the record: `{"Id","LogicalName","Name":null,"KeyAttributes":[],"RowVersion":null}` |
| `data-add-enabled`, `data-delete-enabled`                                      | `True` or `False`                                                                   |
| `data-maxfileuploadsize`, `data-maxtotaluploadsize`, `data-pagesize`           | the upload limits in MB (below) and `10`                                            |
| `data-url-get`, `data-url-add-files`, `data-url-add-folder`, `data-url-delete` | `/_services/sharepoint-data.json\|addfiles\|addfolder\|deleteitem/<website id>`     |

The grid holds the platform's list template (`#sharepoint-template`), the **Add files** and **New folder** toolbar,
breadcrumbs, the empty, access-denied, configuration-error, error and loading panels, pagination, and the Add files,
New folder, Delete file and Delete folder dialogs. Add is enabled with the upload permission and delete with the delete
permission (below); a read-only form enables neither. Without add the toolbar is empty and the add dialogs are absent;
without delete the template has no action column and the delete dialogs are absent. A create-mode form renders a
multiple file input named like a form field (`…_EntityFormView$<control>`, class
`sharepoint-documents table table-striped`) and the form shows "An unknown failure has occurred. Error ID # […]"; F7
recorded that alert outside the page's forms without its exact place, and Mirage puts it before the form content. A
multistep step that edits the record named in the query string renders the same grid and needs its
`adx_primarykeyattributelogicalname`; without it the page answers 500.

The control's client (`entity-grid-compat.js`) lists on load and shows the error panel ("Error completing request.")
when the list fails, the access-denied or configuration-error panel from the answer's flags, and the empty panel for no
items. A failed Add files or New folder shows the answer's `Message` in the dialog
(`div.alert.alert-block.alert-danger.error.clearfix`). New folder's **Create folder** stays disabled until the name has
text. The client refuses a file over `data-maxfileuploadsize` MB or a total over `data-maxtotaluploadsize` MB before
sending. A service URL outside the portal, or one whose path starts like a protocol-relative address (`/.//host`), is
refused before any request, and such a file link becomes `#`. When a delete empties the last page, the control shows
the last page that has items.

The services take POST only (any other method answers 404 with no body) and do not compare the website id in the path:

| Service                 | Body                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `sharepoint-data.json`  | JSON `{ regarding, sortExpression: "FileLeafRef ASC", page, pageSize, folderPath }` and the anti-forgery header                |
| `sharepoint-addfiles`   | multipart `regardingEntityLogicalName`, `regardingEntityId`, `files` (one per file), `overwrite`, `__RequestVerificationToken` |
| `sharepoint-addfolder`  | JSON `{ regarding, name, folderPath }`                                                                                         |
| `sharepoint-deleteitem` | JSON `{ regarding, id, folderPath }`                                                                                           |

The list answers `{ SharePointItems, PageSize, PageNumber, PagingInfo: null, TotalCount, AccessDenied, ConfigError }`.
Errors use the platform's `{ "Message": … }` body. The checks run in the order F7 recorded:

| Request                                                                    | Answer                                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| a list without a valid anti-forgery token header                           | 200 with no body and `x-responded-json` `{"status":401,"headers":{"location":"…/SignIn?ReturnUrl=…"}}`  |
| a list without `X-Requested-With`                                          | 302 to `/SignIn?ReturnUrl=…`                                                                            |
| a write without its token (header or form field), Add files without a file | 500 HTML page "We're sorry, but something went wrong (500)"                                             |
| no regarding record                                                        | 500 "LogicalName is required when entity id is not specified"                                           |
| a list for a missing record, or one the visitor cannot read                | 200 with `AccessDenied: true`                                                                           |
| a write for a missing record, by a visitor who reads the whole table       | 500 "Sequence contains no elements"                                                                     |
| Add files or New folder without the upload permission                      | 400 "Permission denied. You do not have the appropriate table permissions to write SharePoint files."   |
| Delete without the delete permission                                       | 400 "Permission denied. You do not have the appropriate table permissions to delete this record."       |
| New folder with an empty name                                              | 204 with no body                                                                                        |
| the integration off                                                        | 500 "SharePoint integration is not enabled. Please contact your system administrator for more details." |

A write's token header is checked before its body is read, and a declared length over the limit answers 413 before
any read; Add files without the header is read within that bound before its form field is checked. F7 recorded the
missing record's 500 for a visitor who reads the whole table; for any other visitor a missing record gets the
permission answer (inferred: an existing record the visitor cannot read was not recorded), so the answers never tell
whether a record exists. An unexpected failure answers "Error completing request." and its detail goes to the local
diagnostics (`SHAREPOINT_SERVICE_FAILED`).

With the integration on, a list without the Document Location Read permission answers `AccessDenied: true`, and the
services serve the record's folders:

- **Items.** Folders come first, then files, each in the `sortExpression` order (`FileLeafRef` is the name, `Modified`
  the change time), paged by `page` and `pageSize`. An item carries `Id` (its name), `Name`, `IsFolder`, `IsParent`
  (false), `FolderPath`, `Url`, `FileSizeDisplay` (`<n> KB`) and `ModifiedOnDisplay` (ISO time). A file's `Url` is the
  local download route `/_apps/portal-documents/<table>/<id>/<name>[?folder=<path>]`, the stand-in for its SharePoint
  URL. It answers a missing record, one the visitor may not list the documents of and a missing file alike (404); any
  other member of that route answers 501 `PortalDocumentMemberUnsupported`. A successful write answers 204.
  These values and statuses are local: F7 could not record SharePoint on.
- **Folders.** `folderPath` (`a/b`) addresses a subfolder of the record folder (404 when absent; a new folder below the
  16th level → 400), and Add files takes it as a `folderPath` field (local). A blank, `.` or `..` segment or a `\` in
  the path answers 400 ("The folder path is not valid: … (path traversal is refused)."). Names follow SharePoint's
  rules: no `" * : < > ? / \ |`, no leading or trailing space, no trailing dot, none of the reserved names (`CON`,
  `PRN`, `AUX`, `NUL`, `COM0`–`COM9`, `LPT0`–`LPT9`, `.lock`, `desktop.ini`, `_private`, `~$…`, `_vti_`), else 400. An
  existing folder answers 409; a file and a folder cannot share a name (409), and Add files with `overwrite` false
  refuses an existing name (409). Delete takes the item's `Id` and removes a file, or a folder with its contents.
  Document requests using the same in-process storage adapter coordinate concurrent file and folder writes to the same
  case-insensitive name. Runtimes whose adapters share one backend (a persona runtime, Azurite, a pack) agree through a
  name claim: a `_name` key beside the name, created once with `If-None-Match: *` and holding the kind, so of a
  simultaneous file and folder of one name one wins and the other answers 409. A claim goes with its file or folder,
  never shows in a listing, and a claim nothing stands behind (its creator stopped) is taken over once a minute old.
  While an upload runs, its claim is renewed every 20 seconds on the runtime clock, so a long upload keeps its name.
  Names stored before claims existed are still checked by their file or folder marker.
- **Permissions** follow the documented Power Pages rules: the parent table permission needs Read and Append To (and
  Write to upload); the Document Location permission needs Read to list, Create, Write and Append to upload or create a
  folder, and Delete to delete. An upload or a new folder needs a default `sharepointsite` row (otherwise 400).
- **Upload limits.** `SharePoint/MaxUploadSize` (MB, default 10, at most 50: F7 rendered 60 as 50 and 5 as 5) bounds
  each file. The total is 50 MB: F7 rendered `SharePoint/MaxTotalUploadSize` 20 and 7 as 50, so a lower value does not
  lower it, and a higher value raises it ([Manage SharePoint
  documents](https://learn.microsoft.com/power-pages/configure/manage-sharepoint-documents)). A larger file or total
  answers 413. An extension in the organization's blocked list answers 400; without a configured `BlockedAttachments`
  the Dataverse default list applies (it blocks `exe`, `js`, `svg` and others), and any override, even an empty one,
  replaces it. A route whose provider is declared but not ready answers 503.
- Recursive folder deletion removes the files before their folder markers. If the provider fails, the site can still
  address the remaining subtree and retry the deletion.

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
