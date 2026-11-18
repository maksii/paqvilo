# Storage providers

File bytes (Dataverse file and image columns, note and email attachment bodies, portal web files, portal attachments and
SharePoint documents) go through one small storage contract instead of the state file. The state keeps only keys.

| Provider                    | Module                              | What it is                                                                                   |
| --------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------- |
| `local-disk`                | `mirage/lib/storage-local-disk.mjs` | Real implementation, the default; content-addressed files under the state directory.         |
| in-memory                   | `mirage/lib/storage-memory.mjs`     | Real implementation used in place of `local-disk` when a runtime has no state directory.     |
| `azurite`                   | `mirage/lib/storage-azurite.mjs`    | Real Blob REST client for an Azurite you run; refuses non-loopback endpoints. Never started. |
| `pack:<packId>/<name>`      | your pack's `storageProviders`      | Your implementation, checked by the shared contract suite.                                   |
| Azure Storage, other clouds | none                                | Refused: every endpoint must be loopback.                                                    |

`mirage/lib/storage-provider.mjs` holds the contract (`ProviderError`, `validateKey`, `assertProvider`, `guardProvider`,
`createStorageRouter`, `STORAGE_OPERATIONS`); `storageSettings` validates the configuration; `runStorageContract` and
`STORAGE_CONTRACT_CASES` come from `paqvilo/mirage/testing`.

## Contract

A provider is an object with a `descriptor` (a [capability record](capabilities-and-preflight.md#capability-records)
whose `id` is the configured id) and the operations it declares:

| Member                                                                             | Semantics                                                                                                                                                                         |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `put(key, body, { contentType, metadata, ifMatch, ifNoneMatch, blockId, signal })` | `body` is a Buffer or an AsyncIterable of Buffers. Atomic; returns `{ key, size, sha256, etag, version, lastModified, contentType, metadata }`. With `blockId` it stages a block. |
| `commit(key, blockIds, options)`                                                   | Assembles staged blocks in the listed order (a block may repeat) and publishes them like `put`.                                                                                   |
| `get(key, { range: { start, end }, ifNoneMatch, signal })`                         | Metadata plus `body` (AsyncIterable); `end` is inclusive. A matching `ifNoneMatch` answers `notModified: true`, `body: null`.                                                     |
| `head(key)`                                                                        | Metadata, or `null`.                                                                                                                                                              |
| `delete(key, { ifMatch })`                                                         | Idempotent; returns whether the object existed.                                                                                                                                   |
| `list(prefix, { pageSize, continuation })`                                         | `{ items: [{ key, size, etag, lastModified }], continuation }`, sorted by key.                                                                                                    |
| `sas(key, { permission: 'r' \| 'w' \| 'rw', expiresOn })`, `verifySas(url, opts)`  | Signed URL and its server-side check (`{ key, permission, expiresOn }`).                                                                                                          |
| `close()`                                                                          | Releases handles; later calls answer `Unavailable`.                                                                                                                               |
| `preflight({ signal, progress })` (optional)                                       | `{ ready, reason? }`. Without it the provider is reported declared (`placeholder`), never satisfied.                                                                              |

**Preflight probes** run under an idle guard: a probe that makes no progress for 30 seconds
(`PREFLIGHT_IDLE_TIMEOUT_MS`) ends `unknown` with `PROVIDER_PREFLIGHT_TIMEOUT`; each `progress()` call restarts the
window, and `signal` aborts the work when the probe ends, after which `preflight` must settle. `ready: true` is
`satisfied`; `ready: false`, a throw or a refused connection is `missing` with the reason. The same rules apply to
[message providers](messaging-and-outbox.md#configuration-keys).

**Errors** are `ProviderError` (a `DataError`) with `code`, HTTP `status`, the `provider` id and an optional
`diagnostic`: `NotFound` 404, `PreconditionFailed` 412, `Conflict` 409 (`ifNoneMatch: '*'` on an existing object),
`TooLarge` 413, `InvalidKey` 400, `InvalidRange` 416, `Unavailable` 503, `Unauthorized` 401, `Unsupported` 501. Messages
never contain a URL query, SAS signature, connection string or rejected key.

**Keys** match `[a-z0-9][a-z0-9-_./]{0,1023}` after lower-casing, with no leading `/` or `\`, no NUL and no `..`, `.` or
empty segment. `guardProvider` validates keys and list prefixes before the implementation sees them, answers
`Unsupported` for undeclared operations and maps connection failures to `Unavailable`; the router and the contract suite
always go through it.

## Local disk and in memory

`local-disk` keeps immutable content-addressed bytes in `objects/<sha256>` and an `index.json` of key → metadata.
Uploads stream to `tmp/` while hashing and are renamed into place; the index is written to a synced temporary file and
renamed. Blocks stage under `staging/`. Every path derives from digests or generated ids and is checked against the
root; objects are opened with `O_NOFOLLOW` where available. Unreferenced bytes are removed when their last key goes;
`compact()` removes leftovers. SAS URLs are HMAC-SHA256 signed with a per-process secret under `/_sas/storage/<id>/`.
Its preflight is ready once the root opens.

The in-memory provider loses its bytes on restart. A runtime without a state directory (`dry-run`, or no state file)
creates every `local-disk` id, `local` included, as an in-memory provider under the same id, so every default route
stays ready. Every persistent level (`simulation`, `deep`, or no level) uses local disk under `<stateDirectory>/blobs`,
and the simulation report lists that directory as a target.

At `simulation` and `deep`, a note or attachment body of a table that a pack DATA file owns stays inline (base64) in the
DATA row up to 64 KiB of decoded bytes, so a committed DATA file reads on another machine; a larger body and every file
or image column lives in `<stateDirectory>/blobs`, and the row keeps only its internal `__blobkey`.

## Routes

| Route                    | Default  | Consumer                                                                         | Unset or unavailable                             |
| ------------------------ | -------- | -------------------------------------------------------------------------------- | ------------------------------------------------ |
| `dataverseFiles`         | `local`  | Dataverse file and image columns                                                 | bytes stay inline base64 in state                |
| `annotations`            | `local`  | `annotation.documentbody`, `activitymimeattachment.body`, portal staged uploads  | bytes stay inline base64 in state                |
| `portalWebFiles`         | `export` | Web files when the site setting `WebFiles/StorageLocation` is `AzureBlobStorage` | 503 `WEBFILE_CLOUD_STORAGE_UNAVAILABLE`          |
| `portalCloudAttachments` | unset    | Portal form attachments when `FileStorage/CloudStorageAccount` is set            | the save fails with 500 `PROVIDER_ROUTE_MISSING` |
| `sharepointDocuments`    | `local`  | [SharePoint documents](sharepoint.md)                                            | 501 `SharePointStorageNotConfigured`             |

`createStorageRouter({ config, providers })` takes the `storageSettings()` output and the created providers.
`forRoute(name)` returns the guarded provider, `null` for `export`, throws `Unsupported` (`PROVIDER_ROUTE_MISSING`) for
an unset route and `Unavailable` (`PROVIDER_NOT_READY`) for a declared provider that was not created. `describe()` lists
each provider with its descriptor, readiness and routes. No route silently falls back to another place.

## Routing

The extension `dataverse-storage-routing` (installed after `dataverse-files`) takes the router from its `storage`
install option, else `api.providers.storage`; both hosts pass one.

| What                                                       | Provider key                                  | State keeps                                                                      |
| ---------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------- |
| File and image columns, temporary files (`dataverseFiles`) | `files/<fileId>`                              | `state.dataverse.files[fileId]` with metadata and `key`, no `data`               |
| Note and attachment bodies (`annotations`)                 | `annotations/<rowId>/<n>`, `n` grows per body | the row with a null body, its `filename`, `mimetype`, `filesize` and `__blobkey` |

- **Writes.** Uploads (`PATCH`, chunked, block messages, SAS) stage blocks in the provider and commit them, so a block
  upload is never joined in memory. Image values and note bodies on record writes are put in a `beforeWrite` hook; only
  canonical base64 moves. `MaxUploadFileSize` is checked first.
- **Reads.** Downloads, ranges and `DownloadBlock` read from the provider. A response that selects an image or note body
  reads it in the `project` hook, so Web API and SOAP answers are unchanged; `__blobkey` never appears in a response.
  `GetFileSasUrl` answers the provider's `sas()` URL.
- **Deletes and rollback.** The `put` happens before the row transaction. Keys a committed write replaced or released,
  and keys of deleted rows, are checked after commit; a key that no committed row or recycle-bin snapshot references is
  deleted with `ifMatch` on its ETag, so bytes put again under the same key survive. Bytes of a transaction that failed
  stay until the next sweep. A failed delete reports `STORAGE_DELETE_FAILED`. An upload holds its key until the write
  that owns it settles.
- **Sweep.** Lists `files/` and `annotations/`, removes file entries whose row is gone and deletes unreferenced objects
  (`STORAGE_SWEPT`). With an outbox it also runs `outbox.sweep()` ([outbox](messaging-and-outbox.md#outbox)).
- **Migration.** Install and reset move inline legacy bytes to the provider once, in one transaction written as a full
  checkpoint, and report `STORAGE_MIGRATED` with counts. A migrated state needs the same storage root to read its bytes
  back.
- **Missing objects.** At start and after reset the router checks every referenced key once and reports
  `STORAGE_OBJECTS_MISSING` (error). A missing object never fails a read: the body reads as `null` with
  `STORAGE_OBJECT_MISSING`, and a `$value` read answers 404 with that code. A key whose provider this runtime lacks
  answers 503 `StorageUnavailable`.
- **Code that reads rows directly** sees a null body and `__blobkey` (plug-ins and audit included) and reads the body
  with `attachmentBody(api, logical, row)`. `api.storageRouting` exposes `settle()`, `sweep()` and `diagnostics()`.

## Portal routes

- **Notes.** The notes service, `/_entity/annotation/<id>` and the portal Web API (`/_api/annotations`, entity,
  collection or `documentbody`) read routed bodies. A note body under `$expand` of another table is not read back.
- **Web files.** With `WebFiles/StorageLocation` `AzureBlobStorage`, a web file's bytes are the object
  `webfiles/<webfileid>/<filename>` (lower case) of route `portalWebFiles`; the export file is never served in its
  place. Your project puts the objects; the importer still needs the web file record to know the URL.
- **Cloud attachments.** With `FileStorage/CloudStorageAccount` set, a form attachment is put as
  `attachments/<uuid>/<file name>` before the record write, and the note is the placeholder `<name>.txt` whose body is
  `{ Name, Type, Size, Url }` with the provider key as `Url`. A failed save deletes the object again.
- **Staged uploads.** `/_api/file/InitializeFileUpload/note` and `/_api/file/UploadFileBlock/note` stage blocks on route
  `annotations` under `staged/<id>`; the form save reads and deletes the object. The pending-upload list is
  process-local: at most 50 uploads, each for one hour, and a restart discards it. Blocks of an abandoned upload stay in
  the provider's staging area.

## Configuration keys

`providers.storage` and `providers.routes` (the rest of `providers` is described in
[messaging and outbox](messaging-and-outbox.md#configuration-keys) and [configuration](../../docs/configuration.md)):

```yaml
providers:
  storage:
    local: { kind: local-disk, root: blobs } # root resolves under the state directory
    emulator:
      { kind: azurite, connectionString: env:AZURITE_CONNECTION, container: paqvilo-attachments, start: external }
  routes:
    portalCloudAttachments: emulator
```

| Key                             | Rule                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `storage.<id>`                  | id matches `[a-z][a-z0-9-]{0,63}`; `local` (`local-disk`) always exists                                                   |
| `storage.<id>.kind`             | `local-disk`, `azurite` or `pack:<packId>/<name>`; keys are strict per kind                                               |
| `storage.<id>.root`             | `local-disk` only; must stay inside the runtime's private state directory (checked the same way by the offline preflight) |
| `storage.<id>.connectionString` | `azurite` (required) and pack kinds; `env:NAME` only, a literal is rejected and never echoed                              |
| `storage.<id>.container`        | `azurite` (default `paqvilo`) and pack kinds; Blob container name rules                                                   |
| `storage.<id>.start`            | `azurite`; `external` only                                                                                                |
| `storage.<id>.timeoutMs`        | `azurite`; per request until the response headers arrive, 100 to 600000, default 30000                                    |
| `storage.<id>.options`          | pack kinds; a plain object passed to the factory                                                                          |
| `routes.<route>`                | a route above; a storage id, or `export` for `portalWebFiles` only                                                        |

## Pack storage providers

A `kind: 'pack:<packId>/<name>'` entry is created by that pack's `storageProviders.<name>` factory, called once per host
as `factory({ id, kind, settings, stateDirectory, clock, ids, own })`. Message providers and outbox observers follow the
same composition rules ([messaging and outbox](messaging-and-outbox.md#configuration-keys)).

- The factory is synchronous and returns a provider that passes the shape check with `descriptor.id` equal to the id;
  open connections on first use. A factory that throws, returns a promise or returns an invalid provider fails host
  start with `PROVIDER_FACTORY_FAILED` naming the pack.
- `own(resource)` registers something the factory opened (an object with optional `settle()` and `close()`). When
  composition fails, Mirage settles and closes, in reverse creation order, the instances created before the failure, the
  rejected instance (a promise once it resolves) and every owned resource. A rejected instance is never returned.
- A declared entry with no factory stays not ready: its routes answer `PROVIDER_NOT_READY`, `PROVIDER_NOT_REGISTERED` is
  reported and preflight lists `provider:storage/<id>` as missing.
- The host settles and closes providers in reverse creation order. Each provider is attempted separately; failures
  aggregate into `PROVIDER_SETTLE_FAILED` or `PROVIDER_CLOSE_FAILED`, and the next close retries only the providers
  whose close failed, without settling them again.

## Azurite

Core implements the contract against Azurite's Blob REST API with native `fetch` and
[Shared Key authorization](https://learn.microsoft.com/rest/api/storageservices/authorize-with-shared-key)
(`x-ms-version: 2021-08-06`), with no dependency. Paqvilo never starts Azurite; run it yourself, for example
`npx azurite --location .paqvilo/azurite`. Every `azurite` entry is created by core; a pack factory is not consulted.

- **Connection string.** `env:NAME` is read once when the host composes providers. Choose a name without the `PAQVILO_`
  prefix: the toolkit refuses any `PAQVILO_` variable it does not know (`Unknown setting <NAME>`, exit 2). Accepted forms:
  `UseDevelopmentStorage=true` (the documented `devstoreaccount1` at `http://127.0.0.1:10000/devstoreaccount1`) and
  `AccountName=…;AccountKey=…;BlobEndpoint=…`. A non-loopback endpoint is refused without network
  (`PROVIDER_NOT_LOOPBACK`). The account key never leaves the provider's memory.
- **Level.** `behaviour` with a usable connection string. Unset (`PROVIDER_SECRET_MISSING`), invalid
  (`PROVIDER_CONNECTION_STRING_INVALID`, `PROVIDER_ENDPOINT_INVALID`) or non-loopback makes it `contract`, and every
  operation answers 503 `Unavailable` with that reason. A request without response headers within `timeoutMs` answers
  `Unavailable` (`PROVIDER_UNREACHABLE`); a streamed download is not cut off after its headers.
- **Mapping.** `put` is Put Blob up to 4 MiB, else 4 MiB Put Block calls and Put Block List; `put` with `blockId` is Put
  Block and `commit` Put Block List; `get` is Get Blob with `x-ms-range`; `head` Get Blob Properties; `delete` Delete
  Blob; `list` List Blobs. The container is created on first write, and again once if a write answers
  `ContainerNotFound` (an in-memory Azurite restarted). `sas()` returns a service SAS that addresses Azurite directly.
- **Errors** map by status with `x-ms-error-code` as the diagnostic: 404 → `NotFound` (`PreconditionFailed` for a
  conditional write), 412 → `PreconditionFailed` (`Conflict` for `If-None-Match: *`), 409 → `Conflict`, 416 →
  `InvalidRange`, 401/403 → `Unauthorized`, 413 → `TooLarge`, 400 `InvalidBlockList` → `NotFound`, other 400 →
  `Unsupported`, anything else → `Unavailable`.
- **Preflight** sends an authorized List Containers and is ready only on 200 with an `EnumerationResults` body. The
  exported `preflight({ blobEndpoint })` is only an unauthenticated reachability probe. `health()` holds the last
  observed state, shown on the dashboard's Azurite node as `ready`, `error`, `missing` or `declared`.
- **Differences.** Metadata names must be C# identifiers (else `InvalidKey`) and come back lower-case; `commit()`
  reports no `sha256`. Azurite itself differs from Azure Storage as
  [documented](https://learn.microsoft.com/azure/storage/common/storage-use-azurite#differences-between-azurite-and-azure-storage).

## Run the contract suite against your provider

```js
import test from 'node:test';
import { runStorageContract } from 'paqvilo/mirage/testing';
import { createInventedBlobStorage } from '../storage/blob.mjs';

runStorageContract(
  test,
  async (t) => {
    const storage = await createInventedBlobStorage({ container: `contract-${Date.now()}` });
    t.after(() => storage.close());
    return storage;
  },
  { label: 'project blob', skip: [] },
);
```

`makeProvider(t)` returns a fresh, empty provider; the `clock` option (default the system clock) sets SAS expiries.
`STORAGE_CONTRACT_CASES` names the cases (round trip, ranges, conditions, block commit, paging, SAS, key rejection, a 20
MiB stream, unavailability, preflight settling and more). Skip a case only when the provider does not declare its
operation. Core runs the suite against local disk, in-memory storage and the Azurite client (against the test-only
Shared Key-verifying fake `mirage/testing/azurite-fake.mjs`).
