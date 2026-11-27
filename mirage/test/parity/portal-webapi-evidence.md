# Native Power Pages portal Web API evidence

Two pairs of signed-in browser runs on the demo site (the demo portal `examples/project/portal` with the baseline
fixture site over it) sent portal Web API requests from a page of the site, recorded on 2026-11-08. Each run created
its own owned account, contact and note rows first, then ran the same plan of cases against them and against new rows,
and read each result back. The hosted build was not recorded.

| Suite                      | Capture IDs                                                    | Cases |
| -------------------------- | -------------------------------------------------------------- | ----- |
| `demo-writes-20261108`     | `portal-batched-1794140041144`, `portal-batched-1794142100102` | 288   |
| `demo-raw-bodies-20261108` | `portal-batched-1794144140507`, `portal-batched-1794144234893` | 20    |

`demo-writes` covers string values at each column's limits (special characters, markup, Unicode, encoded text, line
breaks, null, empty, maximum and over-long), typed values of number, money, decimal, float, choice, yes/no, date-only and
date-time columns, malformed and raw bodies, an omitted and an invalid request verification token, content types,
lookup binds and filtered queries. `demo-raw-bodies` sends raw JSON roots as PATCH bodies.

The converter (`capture-portal-webapi.mjs`) reads each run's plan and results. A case names its owned row by
placeholder (`{account}`, `__ID__`) and the run marker becomes `webapi-fixture`, so live record ids and run names never
enter a case. Each case carries the values its owned row held before it (`before`), from the run's bootstrap and the
earlier cases' read-backs, so a case replays on its own. A case enters a suite only when both runs gave it the same
input. The output keeps the status, the error's code and message and the read-back; inner error texts are not kept.
Where the two runs differ only in a value derived from the run marker (an account's ticker symbol, which a demo plug-in
derives from the name), the build records the pointer as volatile.

`lexer.string-17` is left out: it sends an encoded object naming a column the account table does not have. The
platform knows every column of the system table; the demo export describes only the columns it uses, so the local
runtime cannot tell an absent column from one that is not enabled for the Web API.

The adapter (`adapters/portal-webapi.mjs`) serves the demo site with its plug-in models and the site's observed Web API
settings, the choices that site's own captures established (the CDS error message, the anti-forgery answer, reference
errors, inner errors, invalid dates and the classic request body decoding).

To regenerate, run the converter for each pair of run folders, then build each suite:

```sh
node mirage/test/parity/capture-portal-webapi.mjs FIRST_RUN SECOND_RUN FIRST_CAPTURE SECOND_CAPTURE
node scripts/parity-cases.mjs build --surface portal-webapi --suite demo-writes-20261108 \
  --capture FIRST_CAPTURE --capture SECOND_CAPTURE
```

The existing suite supplies the oracle description when regenerating its case file.

## Hosted session F1

Hosted session F1 (2026-11-26) recorded portal Web API reads on a hosted site with an invented three-table schema
(prefix `pqf1`: an item table with a contact, an account and a hierarchical self lookup, its child table, and a custom
activity table), signed in as a contact whose web role reads items in Contact scope and their children in Parent scope.
Each group ran twice (runs `a` and `b`) and the structured run files hold each request and the whole response.

| Suite                      | Group, runs a and b                | Cases |
| -------------------------- | ---------------------------------- | ----- |
| `hosted-f1-odata-shapes`   | `odata-shapes` (API-02b/c)         | 50    |
| `hosted-f1-predefined`     | `predefined` (API-03b)             | 8     |
| `hosted-f1-activity`       | `activity-A` to `-E` (API-01c)     | 40    |
| `hosted-f1-chunked-upload` | `files`, `chunked-start` (API-04c) | 1     |

The converter (`capture-portal-webapi.mjs --hosted-f1`) keeps each request (method, path, headers, and for the
activity suite the phase settings the session's phase scripts set) and projects the response: status, `OData-Version`,
whether `x-ms-request-id` is present, `Server-Timing` with its ids masked, then the error object as sent, or the body's
context path, counts, nextLink presence and rows (without ETags; a nested next link is `true`). A request that followed
a recorded next link names the request that produced it (`follow`), so the replay follows Mirage's own link. The
recorded contact becomes `{contact}`, its name `{contactName}` and the environment's view ids `{view-N}`; any other
identifier outside the session's synthetic `f1f1f1f1-0000-4000-8000-…` rows stops the conversion. FetchXML reads of
the odata-shapes group are left out (the FetchXML surface's own groups record them). Run `b`'s phase A is its retry,
which waited for the new setting to reach the portal; the first attempt read 404 for every request. Run `b` held four
more DST rows than run `a`, so the rows and counts of unfiltered collection reads are volatile.

The adapter serves `hosted-f1-fixture-site.mjs`: the schema as invented Solution XML, the session's Web API settings,
table permissions and synthetic rows, and an invented contact; each distinct set of phase settings gets its own
simulator.

```sh
node mirage/test/parity/capture-portal-webapi.mjs --hosted-f1 SUITE RUNS/a RUNS/b FIRST_CAPTURE SECOND_CAPTURE
node scripts/parity-cases.mjs build --surface portal-webapi --suite SUITE --oracle-kind native \
  --oracle-name "Power Pages portal Web API (/_api)" --oracle-version "hosted Power Pages site, 2026-11-26" \
  --oracle-scope "<scope>" --capture FIRST_CAPTURE --capture SECOND_CAPTURE
```

### Follow-up 2026-11-27

The follow-up ran on a disposable trial site with its own schema (`hosted-f1-nav-fixture-site.mjs`): a Contact-scope
root table with a lookup to and a 1:N collection of a custom-provider virtual table, a Global-scope table and a
Global-scope child table, each list naming lookups by their logical name. Runs a and b agree on every case (no volatile
pointer).

| Suite                           | Group, runs a and b                                 | Cases |
| ------------------------------- | --------------------------------------------------- | ----- |
| `hosted-f1-nav-followup`        | `nav-followup` (provider healthy)                   | 31    |
| `hosted-f1-nav-followup-throw`  | `nav-followup-throw` (provider throwing)            | 34    |
| `hosted-f1-nav-followup-marked` | `nav-followup-marked`: phase-marked and keyed reads | 3     |

The projection leaves out `pqf1_query`, the test provider's echo of the query it received (it carries the platform's own
user ids). The `nav-followup-throw-cache` runs read cached answers in one run and fresh ones in the other: they are the
read cache's evidence, not replay cases. The adapter's provider answers the session's three rows or throws, as the
session's failure switch made the live provider throw. `known-gaps/portal-webapi.json` declares, for the five cases whose
provider rows carry columns outside the Web API list, those columns: the hosted site returned them, Mirage keeps the
column list (a security decision, reported as `WEBAPI_PROVIDER_COLUMNS_HOSTED_EXPOSED`).

## Hosted session F7

Hosted session F7 (2026-11-27) recorded reads of the SharePoint document tables on a hosted site and its environment with
the SharePoint integration off (it needs a Global Administrator), with an invented case table (`pqf7_case`, document
management on), twice (runs `a` and `b`). Each run read a different record of the session's synthetic rows.

| Surface            | Suite                            | Files, runs a and b                                   | Cases |
| ------------------ | -------------------------------- | ----------------------------------------------------- | ----- |
| `portal-webapi`    | `hosted-f7-sharepoint-reads`     | `api-s0`, `api-s1-loc-fields`                         | 19    |
| `dataverse-webapi` | `hosted-f7-sharepoint-documents` | `dv-reads-s0`, `dv-reads-s1-loc` (only `documents-*`) | 18    |

The portal converter (`capture-portal-webapi.mjs --hosted-f7`) keeps each read with its phase and projects the answer as
the hosted-F1 converter does; a read that names the record gives the record, its name, its folder id and its location as
`{record}`, `{recordName}`, `{RECORD}` and `{location}`. The Dataverse converter (`capture-dataverse-webapi.mjs
--hosted-f7`) keeps the status, the error code, message and the raising plug-in, message name, category and status
annotations (not the organization's step and activity ids), the `/$count` text, the table properties without `MetadataId`
and its columns as `name:type:readable`, or the context path, the total record count annotations and the rows. The
location and site reads are left out: they carry the tenant's SharePoint URLs. The adapters serve
`hosted-f7-fixture-site.mjs` (one simulator per phase, observed `sharePointIntegration: off`) and an invented organization
without SharePoint storage.

```sh
node mirage/test/parity/capture-portal-webapi.mjs --hosted-f7 hosted-f7-sharepoint-reads RUNS/a RUNS/b FIRST SECOND
node mirage/test/parity/capture-dataverse-webapi.mjs --hosted-f7 hosted-f7-sharepoint-documents RUNS/a RUNS/b FIRST SECOND
node scripts/parity-cases.mjs build --surface <surface> --suite <suite> --capture FIRST --capture SECOND
```
