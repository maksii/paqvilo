# Release notes

Each version lists what changed for users of the package and what to do when upgrading. Update with
`npm install --save-dev paqvilo@^<version>`, commit the lockfile and run your project's tests.

## 0.9.9

### New

- **Classic workflows run their designer steps.** A classic workflow whose exported XAML stays within the supported
  steps (conditions, field reads, create, update, set state and stop workflow) runs in Mirage, real-time or in the
  background, as its run-as user, with one log row per step, as a hosted environment runs them. A failing step refuses
  a real-time write or leaves a background job waiting with its error; a wait condition holds the job until a write of
  a column it reads. You can create and activate designer workflows through the Web API; other XAML is refused as the
  platform refuses it, and activation reports lookups to missing rows. Preflight counts these workflows as covered.
  Other XAML keeps the placeholder and says which step it could not run. See
  [Dataverse API](../mirage/docs/dataverse-api.md).
- **Azure file downloads through a short-lived URL.** With `Site/FileManagement/DownloadViaSASUri` on, as it is by
  default, a file Web API download redirects to a read URL that expires after `DownloadSASUriExpiryTimeSpan`, answers
  byte ranges so a download can resume, and is refused in another browser. With the setting off the portal streams the
  file in `DownloadChunkSizeInKB` reads. See [storage providers](../mirage/docs/storage-providers.md#azure-file-web-api).
- **JPEG, GIF and BMP thumbnails.** Portal image reads of a JPEG, GIF or BMP get the documented 144-pixel thumbnail,
  as PNG already did, and a JPEG uploaded with a rotation in its Exif data is stored upright.
- **Publishing preview switch.** A contact allowed to preview unpublished content turns preview on or off in
  `/_sim/` and in Lense **Tweaks**.
- **Every element of a live page is identified.** Lense aligns the page the portal sent with your export: X-ray names
  an element's own tag in the template, snippet or page copy that wrote it, the Liquid code that generated it, the
  form, list, column or code component it belongs to, the web file or portal file it loads, the portal's page shell,
  or the identified element a script created it in. `paqvilo lense agent coverage` and the panel's **Check
  identification** count the answers for a whole page. See [selection evidence](lense.md#selection-evidence).
- **Page requests.** Overrides lists every request of the page by where its answer came from (your sources, the
  page, portal data, portal runtime files, other sites, not identified) and says why a file of your sources was not
  laid over. `agent state` carries the same under `requests`.
- **A checkout ahead of the portal, or behind it.** Lense tells when the portal serves another version of a
  template, snippet or page copy than your baseline holds, lists the places, asks Git which branch or tag holds the
  served version and offers **Compare with \<ref\>**. A file the portal already serves from your working copy is not
  laid over twice. See [a checkout ahead of the portal, or behind it](lense.md#a-checkout-ahead-of-the-portal-or-behind-it).
- **Code component files.** A bundle or style sheet the page loads from `/_pcfwebresource/` is served from your
  Solution's `Controls/<name>` folder, and a Solution web resource from `WebResources/`, when the page declares them.
- **PCF on every Power Pages host.** Mirage mounts code components where Power Pages does: the `codecomponent` Liquid
  tag, basic and multistep form fields, lists and form subgrids (also many-to-many), each with the `context` of the
  Power Pages host. A form field holds the column value in a hidden JSON input and saves through both form transports;
  a list or subgrid reads its rows through the native grid services with their table permissions, and a list record
  saves its changes. A list with several views, or a subgrid with its view picker on, draws its own view dropdown
  above the control, and choosing a view destroys the control and starts a new one on that view. `context.webAPI`
  calls `/_api/<table logical name>` with the `pcf-entity-logical-name` header, and `retrieveMultipleRecords` ignores
  `maxPageSize` and resolves `{ entities, nextLink: undefined }`. See
  [code components](../mirage/docs/code-components.md).
- **Subgrid view picker.** A form subgrid with `EnableViewPicker` on, ordinary or hosting a dataset code component,
  offers its `ViewIds` views in its toolbar, the default view first; choosing one loads that view's rows, sorted as
  the view sorts them.
- **The `pcf` setting.** `pcf.sources` serves pcf-scripts build outputs (an `out/controls` folder or a `.pcfproj`)
  under the name `pac pcf push` gives them, ahead of the exported controls, and a rebuild reloads only the code
  components. `pcf.platformLibraries` supplies React 16.14.0, ReactDOM 16.14.0 and Fluent UI 8.122.8 from project
  files, so standard controls that declare React and virtual controls mount. `pcf.maxResourceBytes` sets the per-file
  cap (8 MiB by default) and `pcf.liquidDatasetBinding: view` keeps a local view binding for data sets in Liquid tags.
  See [configuration](configuration.md).
- **Code component checks.** `lense audit` checks every `codecomponent` tag of the export against the Solution and
  `pcf.sources` controls, and `analyze` reports the Power Pages limits of a manifest (`APP-PCF-013` to `APP-PCF-017`).
  See [Lense](lense.md).
- **Static analysis of large sources.** A site raises the inventory ceilings it needs in the catalogue
  (`sites.<id>.analysis.limits`) or for one run (`--analysis-limit files=50000` on `doctor` and `analyze`, repeatable),
  up to fixed maximums. The report lists every changed ceiling and names the one a source tree exhausts. See
  [bounded local inventory](static-analysis.md#bounded-local-inventory).
- **`uploadedAssemblies`.** The catalogue or project setting chooses whether registered plug-in steps and Custom API
  main operations of an assembly with uploaded content run it (`clr`, the default) or start as placeholders; a choice
  in `/_sim/` still overrides it, and preflight says where a step's mode came from. See
  [configuration](configuration.md).
- **Sessions that follow the site's sign-in settings.** A local browser session follows
  `Authentication/ApplicationCookie/ExpireTimeSpan` and `SlidingExpiration` (24 hours, sliding, by default) and
  renews after more than half its window.
  `Authentication/Registration/RememberMeEnabled` adds **Remember me?** to the local password form, and
  `RememberBrowserEnabled` adds **Remember browser?** to the email code form (a later sign-in still needs the
  password). An OpenID Connect provider with `UseTokenLifetime` ends the local session at the ID token's deadline. See
  [sign-in and sessions](../mirage/docs/sim-administration.md#sign-in-and-sessions).
- **SAML 2.0, WS-Federation and OAuth 2.0 sign-in.** Each exported provider now signs in with its own protocol
  against the local identity provider: SAML 2.0 with an `AuthnRequest` and a signed response (also started by the
  identity provider, with a `RelayState` `ReturnUrl`), WS-Federation with `wsignin1.0` and a signed token, and OAuth
  2.0 with an authorization code and the user profile. The portal checks the signature with the provider's metadata
  key, the issuer, audience (`ValidateAudience`, `ValidAudiences`), lifetime, reply URL and replay, and maps the issued
  claims to the contact, also through `RegistrationClaimsMapping` and `LoginClaimsMapping`. SAML 2.0 sign-out sends a
  signed `LogoutRequest` when `ExternalLogoutCertThumbprint` is set. Twitter signs in with OAuth 1.0a and signed
  requests, and the local identity provider honours `IsPassive` and `ForceAuthn` in an `AuthnRequest`. See
  [OAuth 2.0, SAML 2.0 and WS-Federation providers](../mirage/docs/sim-administration.md#oauth-20-saml-20-and-ws-federation-providers).
- **Security stamp validation.** After `Authentication/ApplicationCookie/SecurityStampValidator/ValidateInterval`
  (30 minutes by default), a persona or external sign-in session ends when its contact's `adx_identity_securitystamp`
  changed. See
  [sign-in and sessions](../mirage/docs/sim-administration.md#sign-in-and-sessions).
- **Stable implicit grant tokens.** The project setting `implicitGrant.signingKeys` lists PEM RSA key files that sign
  `/_services/auth/token`; a key with a `thumbprint` signs when `CustomCertificates/ImplicitGrantflow` names it, and
  `/_services/auth/publickey` serves the signing key. See
  [implicit grant tokens](../mirage/docs/sim-administration.md#implicit-grant-tokens).
- **Publishing preview toggle.** `GET` and `POST /_sim/api/session/preview` read and set this browser's
  `adxPreviewUnpublishedEntities` cookie for a contact with **Preview Unpublished Entities**. See
  [publishing preview toggle](../mirage/docs/sim-administration.md#publishing-preview-toggle).
- **Run workflow on a basic form.** A basic form's `WorkflowAction` shows its button and confirmation dialog and runs
  an exported, published, on-demand real-time workflow through a trusted local `workflows` handler when the action's
  filter matches the record; otherwise the form reports `FORM_WORKFLOW_UNRESOLVED`.
- **Associate Current Portal User as an activity party.** With **Is Activity Party**, the save writes the contact as
  an `activityparty` row of the configured party list column with the record, in the participation type that column
  records. See [forms and lists](../mirage/docs/forms-lists-parity.md#submission).
- **Rich text notes and the activity timeline.** `Timeline/RTEEnabled` gives the note dialogs the rich text editor,
  with the note HTML sanitized when it is stored and when it is read. A notes control whose default tab is
  `ActivitiesTab` lists the record's activities from the **Portal Timeline View**, each table through the visitor's
  table permissions, and `CustomerSupport/DisplayAllUserActivitiesOnTimeline` decides whether a case timeline shows
  more than portal comments. See
  [notes and the activity timeline](../mirage/docs/forms-lists-parity.md#notes-and-the-activity-timeline).
- **More of the portal search syntax.** Proximity (`"a b"~N`) and fuzzy (`term~`, `term~N`) queries, the
  `Search/Query` template on the default search page, the `Search/Filters` drop-down and, with
  `Search/IndexNotesAttachments` and `KnowledgeManagement/DisplayNotes`, the notes of knowledge articles. See
  [search](../mirage/docs/liquid-parity.md#search).
- **Content access levels on the enhanced data model.** With `KnowledgeManagement/ContentAccessLevel/Enabled` on an
  enhanced site, `knowledge.articles`, the `fetchxml` tag and search show no knowledge article, `entities` still
  returns them only with `observed.knowledgeEntitiesContentAccess: unfiltered` (by default it keeps the filter and
  warns `KNOWLEDGE_CONTENT_ACCESS_ENTITIES_UNFILTERED`), and the Knowledge Article page answers 500, as a hosted
  site does. See [search](../mirage/docs/liquid-parity.md#search).
- **Knowledge content access levels.** With `KnowledgeManagement/ContentAccessLevel/Enabled`, search, its totals and
  facets, search summary sources and `knowledge.articles` keep only the articles that share a content access level
  with the visitor's web roles, contact or account. See [search](../mirage/docs/liquid-parity.md#search).
- **Azure file Web API.** `/_api/file/InitializeUpload`, `UploadBlock`, `download` and `delete` store chunked uploads
  on the `portalCloudAttachments` route with the `Site/FileManagement/*` settings, the table permissions and the
  `FU000xx` errors of the platform. See [Azure file Web API](../mirage/docs/storage-providers.md#azure-file-web-api).
- **Search summary and data summarization fixtures.** A trusted pack exports `portalSearchSummary` for
  `POST /_api/search/v1.0/summary` or `portalDataSummary` for `POST /_api/summarization/data/v1.0/<set>(<id>)` and
  `/_api/summarization/data/v1.0/<set>`; each receives only the rows and columns the visitor may read. A data
  summary takes the Web API read options (`$filter`, `$orderby`, `$top`, `$count`, `$apply`, nested `$expand` options
  and paging), addresses a record by its primary or alternate key, and answers recommendations whose `Config` replays
  as `RecommendationConfig` for the same visitor and query. `observed.siteUserGenerativeAi: disabled` records Copilot
  hub governance that blocks AI for site users: the API then answers 400 `90041001`. See
  [portal search summary](../mirage/docs/data-packs.md#portal-search-summary-fixture) and
  [data summarization](../mirage/docs/data-packs.md#portal-data-summarization-fixture).
- **Nonce Content Security Policy.** A site policy (`HTTP/Content-Security-Policy` or its `-Report-Only` form) that
  uses the `'nonce'` placeholder is sent with a fresh nonce per page response, and the scripts that the exported
  source, the platform and Mirage wrote carry it, also in modal forms and quick views. Inline event handlers on those
  elements are allowed by their hashes. A script that page data writes keeps no nonce and is blocked;
  `PORTAL_CSP_NONCE_WITHHELD` names the page. A directive whose `https:` source would not match the loopback origin
  also allows `'self'` locally (`PORTAL_HTTP_CSP_LOOPBACK_TRANSPORT`). See
  [Content Security Policy](../mirage/docs/content-security-policy.md).
- **Formula column rules.** A formula column that breaks a documented formula column restriction (`Text()` of a single
  number, a number joined as text, a direct currency column, a formula over 1,000 characters and others) reads `null`
  with `FORMULA_UNSUPPORTED` and the restriction; numeric functions are typed by their first argument, and a decimal
  result outside the formula column range reads `null` with `FORMULA_OUT_OF_RANGE`. See
  [formula columns](../mirage/docs/dataverse-contract-modules.md#formula-columns).
- **Deployment codes and an output cache rule in Lense.** `audit` resources and `verify` needsDeploy rows carry the same
  `deploymentCode` for the same condition, and `analyze` reports `PP-CACHE-001` when a cached header or footer reads
  request-dependent values outside a substitution block. See [Lense](lense.md).
- **A code site's local build over the live site.** With a code-site project as its source, Lense answers the files of
  the build (`compiledPath`) at their addresses, ahead of the exported web file at the same address, and on an
  application route lays the local landing page over the deployed one the portal served, keeping what the portal added
  (its client context, `isSpaSite` included). A rebuild reloads the tabs, and a route that cannot take the local
  landing page says why. See
  [code sites](lense.md#code-sites-single-page-applications).
- **Basic form postback replay.** The `portal-form-postback` replay surface posts back a basic form of the invented
  baseline fixture in Mirage and compares status, redirect, message panel and validation summary with 18 scenarios
  recorded twice on Power Pages (create, update, plug-in rejection at each stage, plug-in mutation, range error, CAPTCHA,
  redirects), and with 2 creates that upload an attachment and post the form as multipart, comparing the attachments
  the new record lists.
- **Portal Web API replay.** The `portal-webapi` replay surface sends 308 recorded portal Web API requests of the demo
  site to Mirage (column limits, typed values, malformed and raw bodies, request verification tokens, content types,
  lookups and filtered queries) and compares status, error code and message and the read-back with two Power Pages
  runs each.
- **Publish to web Power BI reports.** A `{% powerbi %}` tag with the default `Anonymous` authentication type and a
  Publish to web URL (`https://app.powerbi.com/view?r=…`) renders the report's iframe, and the browser loads the
  public report. `AAD` and `powerbiembedded` reports keep the placeholder, whose diagnostic now says they need the
  platform's embed token and points to Lense. See [service fixtures](../mirage/docs/service-fixtures.md#power-bi-in-liquid).
- **HSTS, the default CSP and the CORS settings as hosted sites send them.** `strictTransportSecurity`, an
  observation a site records with evidence, sends the site's HSTS header on every response of the http loopback
  listener, where browsers ignore it, so `localhost` is never pinned to HTTPS.
  `defaultContentSecurityPolicy: platform` sends the default policy of sites created after November 10, 2025 with the
  exact text hosted sites send while they have no CSP setting: a 256-bit nonce for each response on every response
  kind, and `'inject-hashes'` replaced by the page's inline-handler hashes on rendered pages and kept on files,
  redirects and error pages. A site's own `'nonce'` setting expands the same way and reaches every response.
  Scripts and handlers that data writes still get no nonce or hash by default (`PORTAL_CSP_NONCE_WITHHELD` now says
  hosted sites nonce them); `scriptNonceScope: every-script` gives every script the nonce and every handler its hash,
  as hosted sites do. Handler hashes are listed in the hosted groups (the platform's, then the page's). The
  `HTTP/Access-Control-*` settings are sent as written as fixed headers on every
  response, without origin logic or `Vary: Origin`; a wildcard origin is never sent with the credentials header (`PORTAL_HTTP_CORS_WILDCARD_CREDENTIALS`).
  Cross-origin requests to the loopback runtime are still refused (the warning `PORTAL_HTTP_CORS_LOOPBACK_BOUNDARY`)
  unless `corsPages` admits an authored page a public site was observed sharing, and a setting value a header cannot carry is
  dropped and reported (`PORTAL_HTTP_HEADER_INVALID`). An application route of a code site whose Home page the visitor
  may not read answers as the root does.
  See [HTTP transport and CORS](../mirage/docs/http-headers.md) and
  [Content Security Policy](../mirage/docs/content-security-policy.md).
- **Code sites served as the hosted platform serves the uploaded build.** The root renders the Home page with the
  landing page as its copy, and an application route renders the Page Not Found page with HTTP 200 and the landing
  page in place of its content. Each build folder is a page (`/assets` redirects to `/assets/`), build files and the
  landing page's own address are raw web files with case-insensitive paths, the captured types (WebAssembly and web
  app manifests as `application/octet-stream`), public or private caching, ETags and gzip. A missing file of a static
  type answers the platform's plain 404 document, and a path with any other extension is an application route.
  Mirage no longer adds `<base href="/">` to the landing page, so a build's relative asset URLs resolve as they do
  online. See [Liquid parity](../mirage/docs/liquid-parity.md).
- **Edge controls of the live site.** `readPowerPagesEdge` from `paqvilo/dataverse` reads a site's visibility, WAF
  status, custom and managed rules and IP restrictions with read-only PAC commands, and says what Mirage does not
  emulate. See [Lense](lense.md#edge-controls-of-the-live-site).
- **Calculated columns from the designer.** A calculated column exported from the column designer computes on read in
  Mirage: the exported `Formulas` XAML is compiled (arithmetic, IF / ELSE IF / ELSE, conditions, typed literals, date
  functions, text, a field of the row one lookup away) and its result keeps the column's precision. `$filter`,
  `$orderby`, FetchXML and the portal see the computed value, and writing the column is ignored with 204. Before, every
  designer column read null with `CALCULATED_UNSUPPORTED`. See
  [calculated columns](../mirage/docs/dataverse-contract-modules.md#calculated-columns).
- **The SharePoint document control as Power Pages renders it.** A Document Locations subgrid on a basic or multistep
  form renders the platform's grid, list template, toolbar, panels and dialogs, with add and delete following the
  visitor's document permissions, and talks to `/_services/sharepoint-data.json`, `sharepoint-addfiles`,
  `sharepoint-addfolder` and `sharepoint-deleteitem` with the platform's request bodies, answers and check order,
  as a hosted site recorded them with the SharePoint integration off. With SharePoint storage configured the same
  services list, upload, create folders and delete in the record's folders. A create-mode form shows the platform's
  file input and its unknown-failure alert. The new observed choice `sharePointIntegration: off` gives the hosted
  answers of an environment whose integration is off. See
  [SharePoint documents](../mirage/docs/sharepoint.md#power-pages-document-control).
- **The `sharepointdocument` table.** Reads answer as a hosted environment does: no rows without a regarding
  condition, `/$count` -1, 400 `0x80071017` for a regarding read while the integration is off (portal Web API
  `9004010D`, Liquid's target-invocation error), and 404 `0x80040217` for a keyed read. With SharePoint storage
  configured, a regarding read lists the record's folder. Document management now infers
  `<table>_SharePointDocuments` next to `<table>_SharePointDocumentLocations`, both with the recorded cascade.
  See [SharePoint documents](../mirage/docs/sharepoint.md#the-sharepointdocument-table).

- **Chart data.** `/_services/visualizations/get-chart-builder` answers the chart tag's data from the exported
  system chart and view: the chart's aggregate FetchXML with the view's filters, the rows the visitor may read in
  `DataJson` with the platform's `for(;;);` prefix, and the chart, view and table metadata. Without a table
  permission that grants read it answers `{"ChartDefinition":"","EntityPermissionDenied":true}`, and the platform's
  chart script shows its permission message. See [charts](../mirage/docs/liquid-parity.md#charts).
- **Snapshots inside closed shadow roots and cross-origin frames.** `paqvilo lense agent snapshot --pierce` reads the
  page through the browser's DevTools protocol, read-only, so it also reports elements in closed shadow roots and in
  cross-origin frames, out-of-process ones included, with the shadow root and frame each one stands in. Field values
  stay out. See [agent snapshot](lense.md#agent-snapshot).
- **Inspect inside closed shadow roots and cross-origin frames.** Picking a closed shadow root's host or a cross-origin
  frame now also shows the element under the pointer inside it, read the same way: its tag, text, attributes, the path
  from the selection and where it stands. A closed declarative shadow root your template, page copy or snippet writes
  maps to its file and line like other markup, also inside a same-origin portal frame; content a script creates in a
  closed root takes its host's source; a cross-origin frame's content is shown as not portal source. See
  [selection evidence](lense.md#selection-evidence).
- **Portal pages in out-of-process frames.** With site isolation, a portal page nested in a cross-site frame runs in a
  frame target of its own. Lense now holds each such target until it is set up, so that page is served with your local
  changes and identified like the tab, closed declarative shadow roots included. See
  [selection evidence](lense.md#selection-evidence).
- **IP restrictions and WAF custom rules in Mirage.** `observed.ipRestrictions` answers a visitor address outside the
  site's allow list with the hosted 403 page, and `observed.firewall` evaluates the site's WAF custom rules and rate
  limits before the site, as `readPowerPagesEdge` reads them; a rule Mirage cannot decide locally fails closed and is
  logged. The managed rule set is not emulated. See [edge controls](../mirage/docs/http-headers.md#edge-controls).

### Improved

- Lense previews a local page title change (`adx_title`) in the page's `<title>`, HTML-encoded as the document
  shell writes it; a title that holds markup is no longer reported as deployment-only.
- With `observed.nativeNumberCultures: locale-data`, Basic Form and multistep form number boxes in a page language
  other than en-US and de-DE show and parse that language's decimal and group marks from the locale data (fr-FR
  `12 345,00`, ja-JP `12,345.00`); a space group mark accepts a typed space, U+00A0 and U+202F. Without it such
  boxes keep invariant numbers, as before, and the form reports `FORM_NUMBER_CULTURE_UNCAPTURED`. Validator messages
  stay English outside de-DE.
- In a portal Web API FetchXML read, a primary key the query did not list now follows the authored columns in the
  `@odata.context` column list, as a hosted site answers.
- **Search finds word forms.** With Dataverse search, a plain word or phrase also finds its other forms: `lantern`
  finds `lanterns`, `run` finds `running` and `catalog` finds `catalogue`, as hosted search does. See
  [search](../mirage/docs/liquid-parity.md#search).
- **Search summary as the hosted API answers it.** The summary cites the web pages and the readable knowledge
  articles the visitor's search finds, with
  the keys, titles, miss and error answers of the hosted API, accepts a JSON `userQuery` and serves
  `/_api/search/v1.0/summarystream` as an event stream. See
  [portal search summary](../mirage/docs/data-packs.md#portal-search-summary-fixture).
- **Data summarization as the hosted API answers it.** `InstructionIdentifier` is optional and a prompt setting the
  site does not have is accepted; a missing record answers 404 `9004010D`, and a disabled site the hosted text. See
  [data summarization](../mirage/docs/data-packs.md#portal-data-summarization-fixture).
- **Site agent requests.** `$pages.agent.SendActivity` reads `/_services/agent/BotConfiguration`, then requests
  `/_services/auth/portalusertoken` and a Direct Line token, and fails with the hosted texts. Mirage answers the
  configuration with `[]`; an endpoint mock supplies an agent. See
  [forms and lists](../mirage/docs/forms-lists-parity.md#modern-lists-and-the-client-api).
- PAC 2.13.1 downloads enhanced data model sites with `adx_` keys (`--modelVersion 2` and `Enhanced`), so the
  `mspp_`-key YAML layout is labelled as one PAC 2.13.1 does not write; it is still read as before. Set
  `dataModel: enhanced` for an `adx_` export of an enhanced site.
- `readPowerPagesEdge` reads PAC 2.13.1 WAF output (bare rule arrays, dotted managed rule-set keys with
  `ruleGroups` and `rules` counts) and classifies refusals as `firewall-not-created` (HTTP 500 before the WAF is
  Created) and `operation-in-progress` (HTTP 409). `readPowerPagesSites` keeps a site that is still provisioning,
  with `websiteRecordId: null`, and a visibility change to public refused with HTTP 400 names the tenant control
  "Set site visibility to public access for non-production sites" as the cause to check.
- `PERSONA_ACCOUNT_ROLES_NOT_APPLIED` now states the hosted evidence: a web role associated only with a contact's
  parent account was not applied on a hosted site, so Mirage does not apply it either.
- Inspect names its frame boundary: selecting a cross-origin or sandboxed frame says the browser keeps it closed to the
  page, and **Not everything was read** counts the frames the page read could not enter.
- A Power Pages cloud flow request whose run waits before its Response now waits for that Response, up to the
  120 seconds Power Automate allows, instead of answering 202 at once.
- SharePoint document requests from different runtimes over one storage backend can no longer create a file and a
  folder with the same name.
- A change on a template line that also holds Liquid code is laid over where the page shows the file's markup between
  two of its tags; before, such a line always waited for a deployment.
- A form post with a file, a fragment a page fetches and a page the portal answers with an error status are laid
  over and identified like any page; the upload is sent once.
- A local change is laid over a place only when the changed file wrote it: the same line in another template, or in
  another language's copy, keeps the served text.
- Code components: controls of Solution ZIPs and of YAML solutions (only the folders the solution lists) are
  imported; `html` resources, source maps, images and fonts are served with their content types; a control folder
  without a readable name withdraws only the controls it could replace instead of the whole catalogue; strings come
  from one language per control. Lense lays over a control's bundle and its style sheets separately, lists a manifest
  difference under **Needs deployment or a source fix** and serves `pcf.sources` builds too.
- The `codecomponent` tag follows the Power Pages Liquid host: an unquoted name or GUID (in either letter case, with or
  without hyphens) names the control, a braced GUID renders nothing and ends the template (`PCF_LIQUID_NAME_BRACED`),
  the `name` key takes any letter case, argument names match property names exactly, and each argument reaches the
  control as the server writes it into the host's `ControlProperties`, in the host's markup.
- `context.utils.getEntityMetadata` reads table and column metadata through `/_api/EntityDefinitions`, as on Power
  Pages, and the reason of a rejected `context.webAPI` call is kept in the debugger's `webApiErrors`.
- X-ray says what page scripts did to the page. An element of the template that a script moves keeps its template
  line and gains **Moved by this script**, also through a document fragment, a new wrapper, a range or `moveBefore`;
  one a script changes gains **Changed by this script: \<what\>**; rows, cells, captions and options that table and
  select calls make name the calling line.
- Number fields of basic forms and multistep form steps show, parse and validate numbers in the page language in every
  mode (insert, edit, read-only and modal forms, and values carried between auto-generated steps), with localized
  format and range messages; a range bound the metadata omits is the column type's supported limit. A field whose code
  component mounts keeps its JSON value.
- Constant sum, multiple choice and rank order groups of basic form metadata are validated on the server too
  (`FormConstantSumInvalid`, `FormMultipleChoiceInvalid`, `FormRankOrderTie`). A Geolocation Lookup Validator reports
  `FORM_GEOLOCATION_VALIDATOR_HOSTED` and Timeline metadata reports `FORM_TIMELINE_METADATA_UNSUPPORTED`.
- Legacy search (`Search/EnableDataverseSearch` `false`) runs on local data even when the organization's Dataverse
  search index is off.
- Portal search orders results by the relevance factors Learn documents: how many query words match, how often and
  how close together, how short the text holding them is, and term and phrase boosts. On the default search page the
  `Search/Query` weights and boosts rank too, so `_title:(@Query)` lifts a title match. The scores are a local model
  (`PORTAL_SEARCH_RANKING_LOCAL`), not the hosted ones. See [search](../mirage/docs/liquid-parity.md#search).
- Source bootstrap reports `CMS_CONTENT_EDITOR_REMOVED` once for each page and web template whose Liquid still uses
  the removed portal content editor (`{% editable %}` tags or `.editable` checks). Rendering is unchanged. See
  [platform changes](../mirage/docs/dataverse-parity.md#platform-changes).
- Portal reads of virtual tables load current provider rows for navigation paths in `$filter` (also `any` and `all`),
  for `$filter` inside `$expand`, for `$apply` filters, groupings and aggregates and for `/$count`, and for the
  intersect and identity tables that a table permission's many-to-many path joins. An `$orderby` through a navigation path answers 400
  `UnsupportedQuery` before any provider is read.
- A shortcut follows the documented target order, and a standard export's survey, event or forum target reports
  `SHORTCUT_TARGET_UNSUPPORTED` and leaves the shortcut without a URL; a lower-priority web file does not take its
  place.
- A code component bundle that is an ES module reports `PCF_CODE_RESOURCE_MODULE` at import, since the page loads code
  resources as classic scripts. A list's dataset `getTitle()` is the view's name, and an authored
  `{% entitylist %}...{% endentitylist %}` block on a code-component list renders only its body.
- `lense verify` edits the page script and style of the language the browser displays.
- Code components follow the Power Pages hosts more closely: the field and Liquid tag hosts call `getOutputs` once,
  100 ms after the last `notifyOutputChanged`; the field host then calls `updateView` unless the output repeats the
  previous one, and the Liquid tag host not at all. `context.webAPI.retrieveRecord` resolves
  `{ data, entityType, values }` and a read sends `accept: */*`. A list's or subgrid's data set has `aggregation` and
  `grouping`, whole-number columns of every format are `Whole.None`, file and image columns `SingleLine.Text`, and a
  party list column reads `null`. The Liquid tag host lists one string placeholder per RESX file (none without one), and
  `/_pcfwebresource/` answers 403 for a control's images, HTML and RESX files.
- Basic forms run the table-specific actions Microsoft Learn lists for cases, opportunities, quotes and orders: Close
  Case, Resolve Case (asking for the resolution), Reopen Case, Cancel Case (which also cancels the case's open
  activities), Close as Won, Close as Lost, Set On Hold, Calculate Value, Create Order, Create Invoice and Generate
  Quote. Each checks the exported action and the visitor's rights again; the last four run the new local
  `CalculateActualValueOpportunity`, `WinQuote`, `ConvertQuoteToSalesOrder`, `ConvertSalesOrderToInvoice` and
  `GenerateQuoteFromOpportunity` messages, which the Dataverse API also answers.
- Lists and subgrids offer the same actions as row actions, shown by the record's state and posted to the legacy
  `/_services/action-*` routes, Qualify, Activate Quote and Reopen included. A Qualify action with `ShowModal` 1
  confirms in the legacy qualify dialog first, on a form and in a grid.
- A list or subgrid `SearchAction` view action sets the search box placeholder, tooltip and button label, and a
  `NextAction` or `PreviousAction` sets the label and class of a basic form's auto-generated step buttons, as the legacy
  portal applies them.
- Lists and subgrids include `ExtendedItemActions` after `ItemActions`, ordered by `ActionIndex`, with labels in the
  request language. A workflow action draws no row link and a list always draws the default **Run workflow** dialog
  with its body HTML-escaped, ignoring `WorkflowDialog` and the actions' dialog texts, as a hosted site does.
- **Modern lists as hosted.** A list included with `isModern: 'true'` is a `pages-native-container` holding a
  `pages-grid`, and its grid reads `GET /_services/portal/GetListViewConfiguration/<list>` and the `entity-grid-data`
  pages with `odataFilterQuery` and `nlSearchFilter`. The hosted page draws it with Microsoft's data_grid control
  from content.powerapps.com, which is not served locally: Mirage draws its own grid in the container. A map list
  included as modern renders the modern grid of its view. The configuration route answers only for a list included
  as modern and a visitor who may read its table (otherwise 404 or 403, inferred), and the grid uses only portal routes from
  it. See
  [forms and lists](../mirage/docs/forms-lists-parity.md#modern-lists-and-the-client-api).
- A Bootstrap 3 list renders the hosted list template with Bootstrap 3 tokens (div dialogs with the close button before
  the title, its create and delete icons and resolve form); a page control keeps the legacy grid.
- **Basic form geolocation.** A basic form with geolocation draws its hidden mapping fields in its map section
  (named `section_map` or ending with it), with `Bingmaps/restURL` and `Bingmaps/credentials`, and loads the Bing Maps control and `/xrm-adx/js/bingmap.js`; the platform's Content Security Policy blocks
  the control, so a post saves the address without latitude and longitude, as hosted.
- **`observed.executeWorkflowAccess`.** `/_services/execute-workflow` runs only a list's own workflow action on a
  record the visitor can read and write, and reports `EXECUTE_WORKFLOW_HOSTED_ACCESS`: a hosted site runs any
  on-demand workflow posted with an anti-forgery token, as its application user. `any-on-demand` reproduces that.
  Without a token the service runs nothing and answers 200 with an empty body; a workflow of another table answers 500
  with the Dataverse message. See [configuration](configuration.md).
- A form's choices (multi-select) field bound to a global choice lists the published options in the page language and
  refuses a value outside them; a list's dynamic choice filter on a choices column finds the rows holding the option.
- With live data and `KnowledgeManagement/ContentAccessLevel/Enabled` true, search and `knowledge.articles` apply the
  content access levels over rows read through the live data path.
- **Virtual tables answer portal reads as their provider does.** A Liquid `{% fetchxml %}`, Web API `fetchXml` or
  OData collection read of a virtual table hands its provider the portal's translated query as well as the OData
  text: `retrieveMultiple` receives `query`, the QueryExpression a hosted site gives a data provider plug-in, and
  `ctx.userId` is the site's application user. The rows come back as the provider returned them, with no local
  filter, order, `top`, paging or `$select` projection and a total record count of 0. Table permissions and the
  Web API column settings still apply to them. See
  [contract modules](../mirage/docs/dataverse-contract-modules.md).
- **Portal FetchXML as the portal sends it.** With `observed.portalFetchXmlAuthoring: portal-classic`, Liquid and
  Web API FetchXML lose `rowaggregate`, `datasource` and a valid `top` before Dataverse runs them, as on Power Pages.
  With `observed.portalFetchIdentityOperators: application-user`, `eq-userid` and `eq-businessid` compare with the
  site's application user. A paging cookie of a distinct query that selects the primary key ends with that key. See
  [Dataverse parity](../mirage/docs/dataverse-parity.md).
- **Portal date conditions in the visitor's zone.** `observed.portalQueryTimeZone` names the zone (an IANA name, or
  `runtime` for the local one) in which portal queries evaluate `on`, `today` and the other calendar conditions on
  UserLocal columns, daylight saving time included; DateOnly and TimeZoneIndependent columns and direct Dataverse
  queries keep the fixed offset. Where Power Pages takes the zone from is not known, so name the zone the site was
  observed in.
- **Local accounts as Power Pages serves them.** With `identityProvider.localAccounts`, the local sign-in posts
  `Username`, `PasswordValue` and `RememberMe` to `/SignIn`, registration takes the platform's WebForms controls and
  signs in at once without an email, and the account pages answer the platform's messages on the page ("Invalid sign-in
  attempt.", the lockout and password policy messages, "Invalid token.", "Invalid code."). The credentials are the
  contact's `adx_identity_*` columns, the password as an ASP.NET Identity version 3 hash, so an account lasts as long as the data. A hosted site writes
  version 2; Mirage verifies it and replaces it with version 3 at the next successful sign-in. A hosted site (ASP.NET
  Identity 2) may not read the version 3 hashes Mirage writes, so exported local-account hashes are for Mirage only.
  The local account pages send `Referrer-Policy: strict-origin` instead of `no-referrer`: with `no-referrer` a browser
  posts their forms with `Origin: null`, which the portal's origin check refuses; only the origin, never the reset or
  confirmation code in the address, leaves as a referrer. Confirmation is sent only when the profile asks for it (`PostConfirmEmailRequest`), and the mailbox items
  carry the platform's subjects, bodies and `userId`/`code` links. Two-factor sign-in goes through `SendCode` and
  `VerifyCode`, and `Authentication/LoginThrottling/*` throttles sign-in by address. See
  [sign-in and sessions](../mirage/docs/sim-administration.md#sign-in-and-sessions).
- **Invitation codes for local accounts.** The `/register/?invitation=` link of an invitation email opens the
  redemption form with its code; a valid code opens the local registration page, which makes the invited contact the
  account, and **I have an existing account** redeems the code for the contact who signs in. A redemption records an
  `adx_inviteredemption` activity, and its redemption workflow, real-time or background, runs after the redemption.
- **Send Invitation and UpdateInvitationCode.** With the Dataverse API on, Mirage provides the Power Pages invitation
  processes: a new invitation gets its 172-character code, and `ExecuteWorkflow` on **Send Invitation** starts a
  background job that emails the invited contact the redemption link (to Mirage's own origin, where the hosted email
  links to `http://localhost:7500`) and sets the invitation Sent. See
  [sign-in and sessions](../mirage/docs/sim-administration.md#sign-in-and-sessions).

### Fixed

- With source maps on (the default), an authored inline script in a page copy rendered by `{% editable page 'adx_copy' %}`
  now keeps the nonce of a nonce policy; the editable tag read the copy without its source-debugging offsets and
  withheld the nonce. Decisions for data-written scripts are unchanged.
- **Pages follow hosted session F3.** On the enhanced data model `Page.aspx` and `Listing.aspx` rewrite layouts
  answer 500, an `.aspx` page the runtime does not ship answers the route-handler 500 and `Search.aspx` renders the
  header and footer around its captured content region (the native search summary control, no page copy); the
  standard model keeps its layouts. With `pageErrorPresentation: generic-error` every 500
  server exception of a GET page request answers the generic error page with `Error ID # [<id>]`, the UTC time and
  the DevTools server log (`RTSS09`, `RTDV01`, `RTGE01`); `customErrors: disabled` names the exception in the log.
  A private site without an exported `robots.txt` answers the platform's 26-byte `Disallow: /` file; `sitemap.xml`
  stays 404. `page.parent` is empty when the visitor may not read the parent. See
  [liquid parity](../mirage/docs/liquid-parity.md#pages-and-web-links) and
  [error pages](../mirage/docs/liquid-parity.md#error-pages).
- **Header and footer output caching.** With `Header/OutputCache/Enabled` or `Footer/OutputCache/Enabled` true, the
  header or footer is cached for 5 minutes from its render: one copy for all anonymous visitors per website and
  language, one per signed-in contact, `{% substitution %}` rendered on every request, a Liquid error kept in the
  copy. A template change or a change of the contact's web roles renders it afresh.
- **Editable wrappers and the PWA as hosted.** `{% editable %}` writes the lowercase `data-languagecontext`; with the
  editing right (Manage Content Snippets for a snippet, a Grant Change rule for a page) the wrapper adds only
  `data-encoded`, `data-liquid` and, on a missing snippet with a default, `data-default`; `page.editable` and
  `snippets.editable` follow the same rights, and `{% editable <web link set> %}` writes nothing. The legacy CMS
  file browser answers 500 and the other legacy CMS services 404. `PWAFeature` enabled adds the manifest link, the
  service worker registration and `/js/sw.js` with `Service-Worker-Allowed: /` (a local worker that handles no
  request in place of Microsoft's Workbox build); disabled adds the script that unregisters service workers.
- **Request tokens belong to one browser.** As hosted session F4 showed, a portal request token is now tied to the
  browser and its current sign-in by default. A token from another browser, or from before sign-in or LogOff, is
  refused. A portal Web API or file API write answers every refusal with 401 `90040107` and the hosted text after
  `Request validation failed : `: the form field is not present, the token could not be decrypted, the cookie and
  form field tokens do not match, or the token was meant for a different claims-based user. The token fragment's
  `__RequestVerificationToken` cookie is `SameSite=Lax`, and the browser binding cookie is a browser-session cookie.
- **Application cookies follow hosted session F4.** Without `Authentication/ApplicationCookie/ExpireTimeSpan` or
  `SlidingExpiration`, a session has a 24-hour sliding lifetime, and the cookie persists only for a remembered local
  sign-in. A portal Web API response renews a sliding session, as a page load does. A cookie longer than 4,050
  characters is sent in `chunks:<n>` and `C1`…`C<n>` parts. An anonymous LogOff redirects to
  `/SignIn?ReturnUrl=/Account/Login/LogOff`.
- **Private-site admission is separate from portal sign-in.** Admission does not sign the browser in and survives
  LogOff. It still ends at the application cookie's `ExpireTimeSpan` (24 hours without it); a shorter deadline reports
  `PRIVATE_SITE_ADMISSION_HOSTED_LIFETIME`, because hosted session F4 kept an admission at least 59 minutes with a
  6-minute cookie. Set `observed.privateSiteAdmissionLifetime: fixed-day`, with evidence, for 24 hours whatever the
  cookie lifetime.
- **Local account defaults that stay stricter than hosted sites.** A registration with a taken user name or address
  answers 409 "These details cannot be used for local registration." naming neither, and a confirmation link is used
  once, each with a warning (`LOCAL_ACCOUNT_DUPLICATE_HOSTED_MESSAGES`, `LOCAL_ACCOUNT_CONFIRMATION_HOSTED_REUSE`).
  `observed.registrationDuplicateMessages: named` and `observed.confirmationLinkReuse: reusable`, with evidence,
  reproduce the hosted `The username "<name>" is already taken.` messages and the reusable link.
- **Implicit grant errors use the hosted IDs.** `/_services/auth/token` refuses a long `state` with `PortalSTS0005`, a
  long `nonce` with `PortalSTS0006`, a `client_id` over 36 characters with `PortalSTS0010`, an unregistered one with
  `PortalSTS0001` and another `response_type` with `PortalSTS0007`, in that order and with the hosted texts. A `state`
  with a control character, or a signing key that became unusable, answers 400 `PortalSTS0018`. Every answer is
  `no-cache, no-store, must-revalidate`, `GET` answers 404 without a body, and an anonymous AJAX call's
  `X-Responded-JSON` is written as .NET writes it.
- **Anonymous multistep sessions are `adx_webformsession` rows.** From its first saved step, an anonymous visitor's
  session row carries a GUID in `adx_anonymousidentification`, the visitor's address, the step index, the step history
  and the record, without a contact, as hosted session F4 recorded. The same browser resumes, another browser starts
  fresh, completion sets `statecode` 1 and no cookie is set when the session starts. Only a browser that already holds
  its visitor cookie gets a row, and anonymous sessions stay within the 1,000-session bound.
- The attach-file control follows hosted session F2. Every note of the record takes a slot, including notes the
  visitor cannot read, text-only notes and orphan staged notes. Existing notes no longer satisfy **Attach File
  Required**. The hint reads "a maximum of N files, each up to" when several files are allowed, and "1 file, up to"
  with one file. `InitializeFileUpload` creates the staged note on the record and refuses a file beyond the count with
  400 `AU00039`. `UploadFileBlock` needs annotation Write, otherwise it answers 403 `AU0005` with the literal `{0}`.
  The new `DELETE /_api/file/delete/note` route needs annotation Delete (403 `AU0005` "…to DELETE attachments.") and
  deletes the staged note. The last upload block writes the file into the staged note, so an upload that is never
  submitted keeps its file; a postback re-render keeps the posted MaxFile. Without annotation Create on the
  record the edit form renders no attach-file control and Required does not apply (state-0 re-run s0g/s0h; every other
  attachment and notes behaviour is the same in state 0 and state 3).
  `InitializeFileUpload` refuses a file over the form's maximum size or outside its restricted types with 400 before
  anything is stored (the hosted server answer is not captured; the code and message are the form service's). See
  [attachments](../mirage/docs/forms-lists-parity.md#submission).
- The notes service no longer lists an author's own note that lacks the `*WEB*` prefix. Note downloads answer
  `attachment;filename*=UTF-8''<name>`, and a signed-in download answers `private, max-age=3600` with
  `Last-Modified`.
- Portal files follow hosted sessions F1 and F2. Image thumbnails are a centred square of the shorter side, at most
  144 px, in the source format: JPEG at quality 75 and 96 dpi (progressive sources included), RGBA PNG, GIF89a on the
  halftone colour table, and 32-bit BMP. The organization `$value` read serves the same thumbnail, and a portal
  thumbnail read ignores `Range`. `size=full` returns the upload byte for byte, Exif included, and a nameless image
  upload is stored as `Untitled.txt`. The file control's `/File/download.aspx` link downloads the file as an attachment
  for visitors who can read the record and its column (column security applies, as on `/_api`), with `nosniff`, and every
  refusal answers the same 404. A thumbnail of an image that already is that square is re-encoded too, so it carries no
  Exif. With `Site/FileManagement/EnableWebAPI` off, the Azure file Web API answers
  501 `{"ErrorCode":"FU0009","Message":"Azure webapi is not enabled for use"}` (captured on the download route; the
  other routes are assumed to answer the same). A portal `/_api` file or `size=full`
  read answers `inline; filename=<name>` with `x-ms-file-name`, a thumbnail neither, and no `mimetype` or
  `x-ms-file-size` header; `size=thumbnail` answers 400 `9004010D` (cdscode `0x80060888`). Mirage keeps sending
  `X-Content-Type-Options: nosniff`, which hosted does not.
- Power Pages cloud flow requests answer as on a hosted site. The flow receives `siteId`, `siteUrl` (the site origin
  without a trailing slash) and `userId` before the `eventData` values, also through
  `Server.Connector.CloudFlow.TriggerAsync`. Its declared trigger schema is still enforced (400 `IncorrectPayload`) and
  each refusal reports `FLOW_TRIGGER_SCHEMA_ENFORCED`, since a hosted site does not enforce it; the new
  `observed.powerPagesFlowTriggerSchema: not-enforced` runs the flow with what was sent. `siteId` is the site's hosted portal
  id when the new `observed.portalId` records it (then also the page's `Portal.id`), else the website id. A 200
  Response comes back as `text/html` without its custom headers; other answers are `{ ErrorCode, Message }`: 202
  `Default` for a flow without a Response, 201 and 202 `Default`, 404 `FlowNotFound`, 400 and 409 `IncorrectPayload`,
  500 and 503 400 `BadGateway` (other statuses follow their class; that is inferred, not captured). A run that ends
  without answering its Response answers 400 with its run id; one still waiting 120 seconds after the request arrived
  answers 400 `BadGateway`, and its later Response fails the run with `ActionFailed`, also after a restart.
  `CloudFlow.TriggerAsync` answers the same statuses and bodies in its envelope. A request without the session's token
  or `X-Requested-With`, or with a body that does not parse, gets the 500 error page and runs nothing; an id that is not
  a consumer's process id answers 404 `IncorrectFlowId`, a role not held 403 `MissingPermissions`, an exported flow
  whose workflow is not activated 400 `FlowDisabled` and a consumer without its workflow 404 `FlowNotFound`; a local
  mock or pack handler still answers. Any version segment is routed. See
  [the flow API](../mirage/docs/operations.md#power-pages-flow-api).
- A PAC export's list workflow action (`WorkflowAction`, with `WorkflowModal` and `LanguageResources`) is the list's
  own action; before, only `CrmEntityFormView-WorkflowAction` was read and the action was lost.
- An authored `{% entitylist id: ..., pp_page_control: true %}{% endentitylist %}` renders nothing, as hosted; before,
  it rendered the list.
- A dataset code component subgrid mounts on an insert-mode form, as hosted: its requests send an empty `entityId`, a
  related subgrid lists no rows and an unrelated one its view. A subgrid over a self-referential relationship lists the
  related rows; before, the page answered 501. The control is hosted in the subgrid's grid element with its parent reference (`data-ref-*`), as hosted.
- A site whose `enhancedauthorization` is 1 (Migration in progress) or 2 (Migration Failed) runs the standard
  authorization model, as a hosted site does until the migration sets 3; before, Mirage ran the enhanced model for both.
  Custom Access grants nothing in these states, as before.
- In the enhanced model the security role mapped to a web role grants every table permission at depth 16 (record
  filter), with the record filter a hosted site writes for its scope, and also reads the visitor's own contact, parent
  account and user mapping and the metadata and SharePoint privileges at Global. An activity table permission uses the
  shared activity privileges. A Canvas app or workflow that runs as the mapped user reaches only the rows the filters
  select. Before, scopes mapped to Global, Local and Basic depths. What a visitor reads through the portal is unchanged.
  See [enhanced authorization](../mirage/docs/dataverse-parity.md#enhanced-authorization).
- A `$ref` on a contact's web role memberships (`powerpagecomponent_mspp_webrole_contact`) answers the hosted
  refusals `90040106` and `90040103` instead of 501, a permitted one adds or removes the membership (stored as local
  data, so the visitor's roles, Liquid `user.roles` and table permissions follow it and it survives a restart), a DELETE
  of a membership the contact does not hold answers 204, and `mspp_webrole_contact` or `adx_webrole_contact` answers
  400 `9004010A`. With `Webapi/mspp_webrole` enabled, `/_api/mspp_webroles` lists the site's web roles instead of a
  read refusal. A collection-valued navigation read checks Read on the related table before the navigation's field
  check (403 `90040120`), and an unlisted navigation answers 403 `90040101` naming "All Columns" of the request's
  table. See
  [portal associations](../mirage/docs/dataverse-parity.md#column-security-on-portal-reads).
- With live data and `KnowledgeManagement/ContentAccessLevel/Enabled` true, knowledge articles are no longer shown
  unfiltered: when the live level links cannot be read, every article is hidden (`KNOWLEDGE_CONTENT_ACCESS_LIVE_HIDDEN`).
- A code component's date-only value no longer moves a day west of UTC, a number in a comma-decimal language saves
  its digits, and a Two Options output saves on every field style.
- A page restored from the back/forward cache keeps working code components; before, they were destroyed and no
  longer responded.
- A dataset control that sets its selection inside `updateView` no longer recurses until the stack overflows.
- A Liquid decimal argument no longer makes the `codecomponent` tag fail with "Do not know how to serialize a BigInt".
- `lense verify` finds a Solution's `Controls` folder in any letter case.
- A script a web template writes itself is no longer taken for a form's or page's custom script that shares its lines.
- Short markup that merely looks like a template (a link of the header inside a menu, the portal's own breadcrumb) is
  no longer named as that template.
- Mirage writes the portal's own breadcrumb on pages whose page template is a rewrite layout (`FullPage.aspx`,
  `WebForm.aspx`): every page of the path with its whole title, in the site's Bootstrap build. Before, it rendered
  the site's Breadcrumbs web template there, and page inspection listed that template for such pages. A page title
  keeps the spaces its record holds around it.
- An option of another action beside `--help` (for example `paqvilo mirage stop --headed --help`) fails with
  `unsupported_option`, as it does without `--help`, instead of printing help.
- Static analysis no longer counts .NET build output (`bin`, `obj`) or a folder of restored NuGet packages (one that
  holds `.nupkg` files) against the inventory ceilings; an authored `packages` folder is still analysed.
- A lookup that a plug-in sets or changes on create or update is not checked against the visitor's table permissions,
  as on the portal; a lookup the request sends still is.
- A write that includes a calculated column succeeds and ignores its value (warning `CALCULATED_WRITE_IGNORED`), as
  Dataverse and the portal do; before, Mirage refused it.
- `PATCH /_sim/api/config` no longer fails with 409 `StateConflict` while a background job commits.
- A Bootstrap 3 `data-dismiss="modal"` control inside nested `.modal` markup closes the dialog that is shown.
- Portal associations check the table permissions the way the portal does: a lookup bind, a `$ref` and a many-to-many
  `$ref` need Append To on the table of the request and Append on the related table, and either refusal is 403
  `90040106`. A collection-valued `$ref` also needs Write on its own row (403 `90040103`) and its navigation listed in
  `Webapi/<table>/fields`, which listing the table's key no longer stands in for. Before, Mirage required Append and
  Append To the other way round and, for grants from an export, did not check them at all for a lookup bind.
- The portal Web API (`/_api`) applies `Prefer: odata.maxpagesize` to a query with `$top` and to a permission-filtered
  read (no Global grant), as Power Pages does: a Global-scope read without `$top` ignores the preference and holds up to
  5,000 rows, as without the header. The next link of a permission-filtered read is checked like the portal's, which
  carries the permission filter: with only the logical lookup in the column list, following it answers 403 `90040101`
  naming `_<lookup>_value`. The Dataverse Web API still pages without `$top`. See
  [input and rendering contracts](../mirage/docs/dataverse-parity.md#input-and-rendering-contracts).
- Portal Web API reads answer as a hosted site does (two recorded runs, replayed by the `hosted-f1-*` suites of the
  `portal-webapi` surface): a read without `$select` (a collection, a key, `/$count`, `$apply`, a navigation's row) is
  refused at the first column of `Webapi/<table>/fields`, in list order, that the list does not enable;
  `GET .../$ref` answers 400 `9004010A`; `$skip`, `$search`,
  `$compute`, `savedQuery` and `userQuery` answer 400 `9004010B` "The `<option>` query parameter is not supported";
  a missing row answers 404 `9004010D` without `cdscode` or inner error; `any` and `all` lambdas need no listing of
  their collection and `all` over no rows is false; a collection read's collection-valued `$expand` carries the
  parent lookup in each child row and a next link; every response carries `x-ms-request-id`, JSON answers a
  `Server-Timing` correlation id. A chunked upload (`x-ms-transfer-mode: chunked`) answers 500 `9004010A`; before, it
  stored the file in one request. A lookup's `_<name>_value` is enabled only when the list names it, and `/<column>` and
  navigations to another table answer 403 "Attribute All Columns in table `<table>` ..." before any read (403
  `90040120` first when the related table cannot be read). A navigation's `/$count` answers 400 `9004010A` in every
  shape.
  See [input and rendering contracts](../mirage/docs/dataverse-parity.md#input-and-rendering-contracts).
- The inherited columns of a custom activity table (`activityid`, `subject`, `description`, ...) are checked against
  `Webapi/activitypointer/fields`, and a selection of only inherited columns answers "Attribute All Columns in table
  `<table>` is not enabled for Web Api."; before, the table's own list decided and a list without a column of the
  table's own refused every request. A list of inherited columns alone no longer does; a list with other entries that
  are no column of the table's own, or a Web API view without one, still refuses every request. A select-less read of
  such a table returns its listed columns.
- Under `odataPermissionQueryPipeline: native-classic`, keyed reads, navigation collections, `$expand`, `$top`, paged
  reads and navigation and lambda filters over ordinary tables run the modeled permission pipeline instead of answering 501.
- Provider-backed (virtual) tables on the portal Web API answer as a hosted site does (replayed by the
  `hosted-f1-nav-followup` suites): a `$filter` path into the table answers 500 `9004010D` with `cdscode` `0x80044150`
  and calls no provider, in both pipelines (before, the default pipeline filtered the provider's rows locally and
  native-classic answered 501); a single-valued `$expand` into it reads `null`; a throwing provider answers 400
  `9004010D` (`cdscode` `0x80040265`, its message hidden) to a collection read or `$expand` and 500 `9004010A` to a
  keyed read, instead of 400 `VirtualProviderFailed`. Mirage keeps the column list on provider rows although the hosted
  site returned every provider column, and reports `WEBAPI_PROVIDER_COLUMNS_HOSTED_EXPOSED`. A site observed with the
  hosted read cache can set `observed.webApiReadCache: { seconds }`; it is off by default. See [provider-backed
  tables](../mirage/docs/dataverse-parity.md#provider-backed-tables-on-the-portal-web-api).
- A Custom Access table permission whose FetchXML has a `link-entity` is disabled
  (`PERMISSION_CUSTOM_ACCESS_FILTER_UNSUPPORTED`); before, Mirage dropped the link and granted every row the root
  filter matched. `PERMISSION_CUSTOM_ACCESS_HOSTED_JOIN_DROPPED` and `paqvilo analyze` rule `PP-PERM-001` warn that a
  hosted site does drop the join: it grants every row the root filter matches, or every row when the permission
  filters only through joins.
- A local account stays usable after its contact's email address changes. Email sign-in and password recovery use the
  current address, a confirmation link is sent again when a reset replaces the credentials of an unconfirmed account or
  its link has expired, wrong email two-factor codes count toward the lockout, and an unknown user name takes as long
  to refuse as a wrong password.
- The remaining file count and **Attach File Required** count every file of the record, also the notes the visitor
  cannot read; before, a visitor with create-only note access got the full count again on each save.
- A form or list action whose filter selects columns other than the primary key matches its record again; before, the
  state actions and **Run Workflow** were refused.
- A note's download, its size in the notes list and its Web API body come from the version of the note that the
  visitor's read admitted, also while the note is being replaced.
- A table with more than ten formula columns computes them all; before, some of them read `null` because each one
  computed the others.
- Designer rollups read Sum, Average, Minimum and Maximum, filters (option set and Boolean `Equal`, decimal
  `GreaterThan`, `NotNull`, joined by `And`), hierarchical rollups over a parent and its descendants, and date
  Minimum and Maximum, with the values hosted runs show: Average counts a null child as 0 and is 0 over none, Minimum and
  Maximum are null over none and then absent from the `CalculateRollupField` response. A new parent is Calculated at
  its creation time with the value of no children; a child write no longer changes the parent's `_state` or `_date`
  (Mirage keeps its recalculation marks to itself, `api.rollups.isStale`); and a write to a rollup column answers 204
  and is ignored instead of 400 `0x80048d19`. A rollup column whose designer Aggregate says `Min` or `Max` is refused
  at create with 400 `0x80060417`. See [rollups](../mirage/docs/dataverse-contract-modules.md#rollup).
- A designer Count rollup is marked for recalculation when a row of another table that a child's untyped lookup could name is
  created, deleted, purged after its time to live (elastic targets, matched in the child's partition) or brought in by
  replacing the whole table. A rollup on or over a virtual or elastic table stores state 2 with `ROLLUP_UNSUPPORTED`,
  and a bare GUID of a lookup that also targets a virtual table is not counted (`ROLLUP_BARE_LOOKUP_UNRESOLVED`).
- Rollups saved by the classic rollup designer are read as it writes them: Yes/No filter values `1` and `0`, date
  filter values, the **Does not equal**, **Does not contain data**, **Is greater than or equal to**, **Is less than** and
  **Is less than or equal to** operators, several checked choice options in one condition, source filters on a
  hierarchy, and a hierarchical rollup of the table's own column. Before, these read state 2 with `ROLLUP_UNSUPPORTED`.
- `observed.rollupCreateState: not-calculated` stamps new rows NotCalculated, as rollup columns saved by the classic
  rollup designer do (state 0, an empty `_date` until the column's mass calculation, 0 or null);
  `api.rollups.massCalculate(table, column)` runs a column's mass calculation; and a child update marks only the rollups
  that read a column it writes.
- Calculated columns saved by the classic designer are read as it writes them: `TrimLeft` and `TrimRight`, a Yes/No value
  saved as `1` or `0`, and `DiffInHours`, `DiffInWeeks` and `DiffInYears` counting unit boundaries (23:30 to 00:29 is
  one hour); before, those columns read null or a truncated difference.
- Classic workflows with the process designer's Timeout waits (`{Due}`, `{2 Minutes After Due}`), parallel wait branches
  and Yes/No conditions run: the job waits until the due time and completes then, or completes earlier when a write
  makes a branch's condition hold; before, such a workflow was refused as unsupported XAML.
- One malformed component file (for example a character reference outside Unicode) no longer stops Lense from loading
  the whole Solution; it is skipped, as in Mirage.
- Lense and Mirage read an enhanced site's site and language records from the same place, `Assets/` (or the root) of
  the folder that holds `powerpagecomponents/`; Mirage reports copies elsewhere as `ENHANCED_SITE_METADATA_IGNORED`.
- A compiled code site no longer serves a dotfile through a Windows short name (`ENV~1`) or a link.
- Runtimes that start from the same imported export no longer share one runtime's `observed` settings.
- A Power Pages management read that PAC answers with an "Error: … [HTTP 4xx]" text and exit code 0 now fails with
  `POWER_PAGES_MANAGEMENT_FAILED` and its status; before, it failed as an answer without JSON. The text stays withheld.
- The Power BI placeholder no longer shows a user name or password written in the report URL
  (`https://user:password@…`); it shows `[redacted]`, as it already did for query values.
- A calculated or rollup column loaded from a Solution serves its exported `Formulas` file unchanged as
  `FormulaDefinition`, line ends and indentation included, as an imported column does. Before, Mirage added an XML
  declaration and removed the whitespace between elements.
- An exported relationship cascade `ActiveOnly` reads as `Active`: assigning a parent now reassigns the active rows
  of a relationship whose Assign is Active Only, and the metadata Web API answers `Active`. Before, Mirage did not
  cascade such an Assign, Share or Unshare.
- A delete that a Restrict relationship holds is refused with the platform's full text: the deleted table and id, the
  restricting row and the relationship. The status and code (405 `0x80040227`) are unchanged.
- Creating a second parental relationship from a table through `RelationshipDefinitions` is refused with 400
  `0x80047007`, and creating a calculated column whose designer XAML reads a literal without `SelectFirstNonNull` with
  400 `0x80060424`, as Dataverse refuses them.
- A plug-in that rebinds a portal query to a virtual table now fails as on Power Pages: the Web API answers 500
  `9004010D` with the inner code `0x80044150` and Liquid shows "Exception has been thrown by the target of an
  invocation." when `liquidFetchErrorMessage` is `target-invocation`. Before, Mirage answered 501
  `LocalPluginQueryUnsupported`.
- A Web API `fetchXml` query with `eq-businessid` or `ne-businessid` on a column outside `Webapi/<table>/fields`
  answers 403 `90040101` for that column, as on Power Pages, instead of the local 400 refusal of the operator.
- Rejected basic form posts answer as on Power Pages. A choices value outside the column's options re-renders the form
  with HTTP 200 and Dataverse's own message in the danger panel, whatever `Site/EnableCustomPluginError` says, once the
  form's validators pass; before, Mirage answered 400 for a bound global choice and saved an unlisted value of the
  column's own options. Basic and multistep form posts go through request validation ("Request validation has
  detected potentially dangerous input value(s)…"): by default only a script block is refused and other markup is stored
  as posted, as the hosted site does; with `Site/DisableFormDataSafeHtmlValidation` false event handlers, script URLs
  and embedding elements are refused too, and with `DisableValidationWebTemplate` true nothing is. The choices control's posted JSON selection is stored as the column's values, `[]` clears
  the column and text that is not such a list answers 500; before, the posted JSON was stored as text. The control's
  option metadata lists every exported language label of an option. See
  [validation and write errors](../mirage/docs/forms-lists-parity.md#forms).
- A basic form that associates the current contact with an activity's `partners` column records the Chat Participant
  party (12) instead of answering 501. The activity create carries the party list in its plug-in Target as
  activityparty entities naming the contact, writes the parties with the record (no activityparty Create of their own)
  and adds the activity owner's party (Owner, 9).
- Rich text columns follow the hosted form: a column whose FormXml binds only the rich text editor renders, posts and
  validates as the plain textarea of its column. The editor renders when the column's form metadata sets the code
  component style; there the hosted portal hosts `RichTextEditorControlV2` from `/_pcfwebresource`, and Mirage renders
  its local editor in its place and reports `RICHTEXT_HOSTED_V2_CONTROL`. Shell capture no longer asks for editor
  assets for a FormXml-only binding.
- Portal form writes and multistep sessions reach plug-ins as on Power Pages: `IsPortalsClientCall` true,
  `PortalsContactId` the signed-in contact and the site's host application user as `UserId` and `InitiatingUserId`, in
  the hosted message order. A signed-in contact's multistep session is an `adx_webformsession` row (contact, user
  identity name, visitor address, step index, step history, primary record), deactivated on completion and never
  removed. Anonymous sessions and sessions without a row stay bounded to 1,000, oldest first. The caller is the host
  application user in both authorization models, as captured. A real-time classic workflow that runs inside a portal
  call keeps `IsPortalsClientCall` and `PortalsContactId` on its writes at depth 2, and a background workflow job
  reports false and the empty GUID. Form pages and saves also send the reads a
  hosted form sends: an edit page's Retrieve and RetrieveMultiple reads, the update save's RetrieveMultiple before the
  Update, a multistep page's session and record reads and the session read before each session Update. See
  [multistep forms](../mirage/docs/forms-lists-parity.md#forms).
- A list's `entity-grid-chart-data.json` and `entity-grid-ai-summary-stream.json` services answer 400, as on a hosted
  Customer Self-Service site, instead of 405, and a timeline's activity read no longer sends a Retrieve of the record.
- A record's timeline adds portal comments: Add posts to `EntityActivity/AddPortalComment`, which creates the comment
  regarding the record (text in the description, direction Incoming) and completes it as Received in a second write,
  with the contact as Sender, the owner as To Recipient and the Owner and Regarding parties. The visitor needs Create and
  Append on portal comments and AppendTo on the record. See
  [notes and the activity timeline](../mirage/docs/forms-lists-parity.md#notes-and-the-activity-timeline).
- A portal `$apply` whose filter, groupby or aggregate path reaches a provider-backed (virtual) table answers 500
  `9004010D` with cdscode `0x80044150` before the provider is read, as a `$filter` path does (hosted session F1).
- A collection `$expand` into a provider-backed table hands its nested `$select`, `$filter`, `$orderby` and `$top` to the
  provider and keeps the provider's rows as returned, still behind table permissions and the Web API column settings.
- A portal `$apply` of `filter(<navigation path>)/aggregate($count as <alias>)` answers one empty object per matching
  row, as hosted session F1 captured it.
- With `observed.webApiFileDownload: portal-range` a file download refuses several ranges with the captured 100-byte
  416 body, a reversed range with 500 `9004010A` and an unparseable `Range` header with the front end's 400 page; each
  error carries its `Content-Length`.
- A direct `POST /EntityList/Map/Search/` answers the platform's 500 error page, as hosted session F2 captured it.
- `scripts/parity-cases.mjs build --redact <term>` replaces a hosted site's host or name with `<redacted>` in every
  capture input and output before the cases are built, and records only the placeholder and counts in the case file.
  The thirteen hosted session F1 file-range downloads are now replay cases (`portal-file-range/hosted-f1-20261126`).
- A calendar or dataset code component list included as modern now reports the classic layout it renders to render
  provenance, with its `MODERN_LIST_RENDERED_CLASSIC` diagnostic.
- A calendar or dataset code component list included as modern renders the modern grid of its view, with no calendar
  and no code component, as hosted session F2 captured it; `MODERN_LIST_RENDERED_CLASSIC` and the `portal:modern-list`
  preflight row are gone for these lists.
- A calendar list's event feed refuses a `from` or `to` outside `yyyy-MM-ddTHH:mm:ssZ` with the platform's messages,
  answers indented JSON and sends no event URL; its iCalendar download has the platform's shape (UID with the host,
  DTSTAMP, HTML description, alarm, folded lines), lists every event unless the range is in that format and sends no
  `Content-Disposition`, as hosted session F2 captured it.
- A calendar list's events are selected by calendar day as on the platform: an event matches when its start day or its
  end day lies in the range (bounds inclusive) or it starts on or before `from` and ends on or after `to`, so a reversed
  range lists the events spanning it; UserLocal days follow `observed.portalQueryTimeZone`.
- A classic workflow of a virtual table never runs: Dataverse does not trigger workflows on virtual tables
  (`CanTriggerWorkflow` is false). Publishing or executing one answers 400 `WorkflowVirtualTableUnsupported`, and a write
  to the table reports `WORKFLOW_VIRTUAL_TABLE_UNSUPPORTED` once per activated definition.
- The notes control and the activity timeline read every page of their notes and activities, following the provider's
  paging cookies, or the page number when a page carries none, instead of answering 501 beyond four pages of 5,000. The
  notes read selects only the columns the control shows, so it no longer carries attachment bodies. A provider page that
  cannot be continued (a repeated paging cookie or key) answers 502 `NotesProviderPagingInvalid` or
  `TimelineProviderPagingInvalid`. A record with more than 50,000 notes or activities answers 503
  `NotesRowLimitExceeded` or `TimelineRowLimitExceeded` with a diagnostic, instead of a truncated list.
- Basic forms run **Activate Quote** (a draft quote becomes Active, In Progress), **Reopen** for a closed
  opportunity (Open with the partner portal's Accepted status, or In Progress for a partner-created one), **Qualify**
  for an open lead (the new local `QualifyLead` message, with an account, a contact and an opportunity) and **Update
  Pipeline Phase** (a dialog of the opportunity's Sales Stage options and a description, saved with a note), as the
  legacy portal's actions do.
- The Dataverse API answers `QualifyLead` on a lead: the lead becomes Qualified and gets the account, contact and
  opportunity the request asks for, and the answer lists their references.
- A Basic Form action's filter criteria can be a bare `<filter>` on the form table as well as a full FetchXML query,
  and are evaluated in live mode through the connected portal. An aggregate or grouped criterion, or one on another
  table, hides the action with a `FORM_ACTION_FILTER_UNRESOLVED` diagnostic naming the reason, and its request answers
  403 instead of 501.

### Upgrade notes

- A test that read a header or footer value from the request, the page or the time outside `{% substitution %}` on a
  site with `Header/OutputCache/Enabled` or `Footer/OutputCache/Enabled` true now reads the value of the request that
  filled the cached copy, `website.sign_in_url` with that request's returnUrl included, as on Power Pages; the page
  reports `OUTPUT_CACHE_REQUEST_VALUE` and `paqvilo analyze` reports `PP-CACHE-001`. Move the value into a
  substitution block, use `website.sign_in_url_substitution`, or set the setting to false.
- A test that matched `data-languageContext`, the CMS metadata a content editor's wrapper carried (`data-cms*`,
  `data-editable-url`, `data-filebrowser-url`) or the hidden `data-mirage-editable` span of a web link set now reads
  the hosted markup. With `pageErrorPresentation: generic-error`, read the error id from `Error ID # [<id>]`; the
  page-query rejection text is no longer shown on the page, and an exported `Portal Generic Error` snippet sits in the
  same dialog instead of the `Error ID: [<id>]`, date and portal ID lines. A visitor whose only website access right
  is Preview Unpublished Entities no longer gets `page.editable`, `snippets.editable` or the editor attributes.
  page-query rejection text is no longer shown on the page.
- Web pages in search results and search summary sources no longer need an `adx_webpage` table permission, as on a
  hosted site: the page's web page access control rules decide, so a Restrict Read page is found only by its roles.
- Search results leave out web pages in a non-visible publishing state for a visitor who cannot preview them, and
  report `PORTAL_SEARCH_UNPUBLISHED_PAGES_EXCLUDED`. A hosted site with Dataverse search lists them to every visitor;
  set `observed.searchUnpublishedPages: listed`, with evidence from your site, to get its results. The same rule
  decides which web pages are search summary sources.
- With `KnowledgeManagement/ContentAccessLevel/Enabled`, `entities.knowledgearticle` answers nil for an article outside
  the visitor's content access levels, as `knowledge.articles` does. A hosted enhanced site returns every article
  there; Mirage warns (`KNOWLEDGE_CONTENT_ACCESS_ENTITIES_UNFILTERED`), and
  `observed.knowledgeEntitiesContentAccess: unfiltered`, with evidence, reproduces the hosted site.
- The search summary and data summarization answers send `Cache-Control: private` to an anonymous visitor and
  `no-cache, no-store, must-revalidate` with `Expires: -1` to a signed-in one, as hosted; `summarystream` stays
  `private`.
- A search test that expected a plain word to miss its plural or other forms now finds them.
- A `portalSearchSummary` pack now receives web pages as `sources` (`id`, `title`, page text) as well as knowledge
  articles, and the answer carries `SummaryTitle`, `SearchTitle`, `ErrorMessage`, `ResponseStatus`,
  `CitationTitleMapping` and `Chunks` too. A request to either summary API sends `X-Requested-With`, as the
  platform's scripts do: without it a signed-out request answers the 500 error page and a signed-in one 401, and
  without a verification token the answer is 401.
- A `$pages.agent.SendActivity` mock moves from `/_api/agents/<schema>/activities` (which now answers 400
  `9004010A`, as hosted) to endpoint mocks for `/_services/agent/BotConfiguration`,
  `/powervirtualagents/botsbyschema/<schema>/directline/token` and
  `/v3/directline/conversations/<conversationId>/activities`.
- A script or test that posts to `/_api/cloudflow/<version>/trigger/<id>` sends `X-Requested-With`, as jQuery and
  `shell.ajaxSafePost` do, and its parameters as the `eventData` JSON string: a raw JSON body no longer reaches the
  flow. Read a 200 answer as text and an error from `ErrorCode` and `Message`. An exported flow whose `.data.xml` has a
  `StateCode` other than 1, or no `StateCode` (Mirage then seeds its workflow row as Draft), answers `FlowDisabled`
  unless it is explicitly activated locally; add `<StateCode>1</StateCode>` to an invented fixture.
- A test that relied on the enhanced authorization model with `enhancedauthorization` 1 or 2 now gets the standard
  model; set 3 in the site record to keep the enhanced model.
- The security roles Mirage maps to web roles hold depth 16 with a `recordfilterid` on each table permission privilege;
  a test that read `privilegedepthmask` 1, 2 or 8 from them now reads 16.
- `Webapi/mspp_webrole/enabled` now reports `WEBAPI_WEBROLE_HOSTED_EXPOSURE` (and `PP-SEC-004` in `paqvilo analyze`):
  a hosted site answers `/_api/mspp_webroles` with the web roles of every site in the environment.
- A test that read a designer calculated column as null, or a rollup `FormulaDefinition` with an XML declaration,
  now reads the computed value and the exported file text.
- Write `codecomponent` names unquoted (`name:pub_Namespace.Control`). A quoted name, an unknown control and a second
  tag of the same control now render nothing and end the rest of the template, as on Power Pages; `lense audit` lists
  each one. Tag arguments reach the control only when their name equals the property name, letter case included.
- A data set in a Liquid tag is now unbound, as on Power Pages. Set `pcf.liquidDatasetBinding: view` to keep the view
  binding of a tag argument.
- A form field with a code component no longer renders its native control: the value is in a hidden input as JSON,
  `$pages` `getValue` and `setValue` throw on that field, and a page script reaches the control by changing that input
  and raising `change`.
- A rejected `context.webAPI` call rejects with `undefined`, and the navigation dialogs throw instead of opening a
  browser dialog, as on Power Pages; read the reason in `__paqviloPcf.inspect(id)[0].webApiErrors`.
- A control that declares a platform library now needs the library files in `pcf.platformLibraries`.
- Grants from a portal export now enforce Append and Append To on lookup binds and associations. A project whose
  local grants were set for Mirage's former direction now gets the portal's 403 `90040106`; set the flags as on the
  portal (Append To on the table that holds the lookup, Append on the related table). The state setting
  `settings.associationPermissions: "compatibility"` keeps the former read-or-Append-To check for local experiments.
- A site policy with the `'nonce'` placeholder is now sent instead of omitted, so inline scripts that page data writes
  are blocked locally. Write such scripts in a web template, snippet or page copy instead of printing them from data;
  `PORTAL_CSP_NONCE_WITHHELD` lists the pages that have them. A fixed `'nonce-<value>'` source is still omitted
  (`PORTAL_HTTP_CSP_NONCE_UNSUPPORTED`).
- A business rule's **Set Business Required** action (`SetFieldRequiredLevelStep`) no longer fails a server-side save
  with 400 `0x80040203`: it applies only to model-driven forms and reports `BUSINESS_RULE_CLIENT_ONLY`.
- A formula column that uses a construct formula columns do not support now reads `null` with `FORMULA_UNSUPPORTED`
  instead of a value.
- Editing a local account's email address marks it unconfirmed and ends its sessions, remembered browsers and pending
  links; with `RequiresConfirmation`, sign-in waits for the new confirmation.
- A local OAuth 2.0 provider (`Authentication/OpenAuth/<Name>/*`) now needs its `ClientSecret` (`ConsumerSecret`,
  `AppSecret`): the code is redeemed with it, and sign-in fails without it. Its answer comes back on the query string
  of `CallbackPath` (default `/signin-<name>`), and its claims use the `ClaimTypes` names, so a claims mapping names
  those types. SAML 2.0 and WS-Federation providers no longer accept OpenID Connect answers. A Twitter provider signs
  in with OAuth 1.0a at `/signin-twitter` and needs `ConsumerSecret`.
- A browser session that was signed in more than 30 minutes ago (or `ValidateInterval`) ends when its contact's
  `adx_identity_securitystamp` changes.
- Lense with a code-site project answers a file of the local build ahead of the exported `.powerpages-site` web file at
  the same address, as Mirage does; a rebuild reloads the tabs. Edit the build's sources rather than the exported copy
  of a built file.
- `PORTAL_SEARCH_QUERY_WEIGHTS_IGNORED` is now `PORTAL_SEARCH_QUERY_WEIGHTS_LOCAL`, because `Search/Query` weights now
  rank the default search page. Results with the same matches can come back in another order than before.
- Portal Web API defaults follow the hosted captures: a CDS error reads "Common Data Service error occurred." and
  carries `error.cdscode`, and `$skip`, `$search`, `$compute`, `savedQuery` and `userQuery` answer `9004010B` instead of
  `9004010A` or `9004010D`. A site observed otherwise keeps the former text or code with evidence:
  `observed.webApiCdsErrorMessage: "CDS error occurred."`, `observed.webApiCdsErrorCode: "innererror"`.
- List a lookup's `_<name>_value` next to its logical name (`parentcustomerid,_parentcustomerid_value`) where a
  script reads, filters or orders by the value, or reads without `$select`, `/$count` or `$apply`; with the logical name
  alone these answer 403 `90040101`. Read a column with `$select` or `/<column>/$value` instead of `/<column>`, and
  related rows with `$expand` instead of a navigation route. A site observed otherwise keeps the former model with
  evidence: `observed.webApiLookupFields: "logical-aliases"`, `observed.webApiMemberReads: "served"`.
- A select-less read of a custom activity table whose list names only inherited columns, or whose inherited columns
  `Webapi/activitypointer/fields` does not list, now answers 403; add the table's own column and list the inherited
  ones in `Webapi/activitypointer/fields`.
- A persona launched from the sign-in page picker, `POST /_sim/api/personas/launch` or `/_sim/sign-in` is now a browser
  session like any sign-in: it follows the site's `ExpireTimeSpan` and sliding window and the security stamp check.
  `signIn()` stays a programmatic session; pass `browserSession: true` for a browser session.
- A provider whose portal reads relied on Mirage filtering, ordering or paging its rows now returns them as they are:
  apply `request.query` (or the OData text) in the provider. Rows outside a scoped table permission are still removed.
- The local document grid route `/_apps/portal-documents/<table>/<id>` now only downloads a file
  (`…/<name>[?folder=<path>]`). List, upload, new folder and delete go through the `/_services/sharepoint-*`
  services; their failures are the platform's `{ "Message": … }` bodies: a missing or invalid write token answers the
  500 page instead of 403, a missing permission 400 instead of 403, a list without permission `AccessDenied: true`, and
  no SharePoint storage 500 "SharePoint integration is not enabled…" instead of 501. A successful write answers 204.
- `SharePoint/MaxTotalUploadSize` no longer lowers the total upload limit below 50 MB, and an unset value is 50 MB
  instead of unlimited.
- A multistep step that shows the document control for the record in its query string needs
  `adx_primarykeyattributelogicalname`; without it the page answers 500, as on Power Pages.
- A deleted record now deletes its document locations (the recorded Cascade Delete), and a `Webapi/<table>/fields`
  wildcard answers 403 `90040122` "You are unauthorized to process this request." for every table.
- Local account routes and fields follow the hosted pages. Post the local sign-in to `/SignIn` (the site's sign-in
  path) with `Username` and `PasswordValue` instead of `/Account/Login/Login` with `UserName` and `Password`. Register
  with `ctl00$ctl00$ContentContainer$MainContent$MainContent$EmailTextBox`, `…UserNameTextBox`, `…PasswordTextBox` and
  `…ConfirmPasswordTextBox`; `LastName` is gone. A reset posts `UserId` and `Code` from the
  `/Account/Login/ResetPassword?userId=&code=` link (was `account` and `token`) and redirects to
  `/Account/Login/ResetPasswordConfirmation`; the confirmation link is `/Account/Manage/ConfirmEmail?userId=&code=` (was
  `/Account/Login/ConfirmEmail`), redirects to the profile page and is used once. **Change password** posts
  `NewPassword` (was `Password`). Two-factor enrollment is `/Account/Manage/ChangeTwoFactor`, posting only the form
  token to `/Account/Manage/EnableTFA` or `DisableTFA` (was `/Account/Manage/TwoFactor` with `OldPassword` and
  `Enabled`), and a two-factor sign-in redirects to `/Account/Login/SendCode`, which sends the code.
- Local account refusals that the platform shows on the page now answer 200 with its message instead of 400, 401, 403
  or 409; a throttled sign-in and a taken user name or address answer 409. Read the message, or the session, instead of the status.
- Local registration needs a CAPTCHA when `Authentication/Registration/CaptchaEnabled` is absent, as on a new hosted
  site: set it to `false` or supply the local CAPTCHA fixture. `RememberMeEnabled` and `RememberBrowserEnabled` are on
  when absent. Registration sends no confirmation unless `RequiresConfirmation` is on; request one through
  `POST /Account/Manage/PostConfirmEmailRequest`.
- After registration, and after a sign-in without a return URL, a site with a **Profile** site marker opens the profile
  page (`Authentication/Registration/ProfileRedirectEnabled`, on by default).
- Every refused invitation code answers "Invalid invitation code." with 200; the reason is in an `INVITATION_INVALID`
  diagnostic. A group invitation is refused at local registration. An invitation's redemption workflow now runs after
  the redemption has committed: a failure keeps the redemption and the sign-in (`INVITATION_WORKFLOW_FAILED`) instead of
  rolling them back with 500, and a background workflow qualifies too.
- A system job that `ExecuteWorkflow` starts for a background classic workflow is now created by SYSTEM; it is still
  owned by the caller. Hosted session F4 observed this for Send Invitation; for other workflows it is inferred.
- A local password reset or change no longer clears an account's lockout or failure count: the new password signs in
  once the lockout has passed. An invitation whose invited contact already has a local account is redeemed through
  **I have an existing account**; local registration with its code answers "Invalid invitation code.".
- Browser request tokens are now paired by default. A browser test or page script that sent `simulator.portalToken`
  (or one runtime token for every browser) from a page, or that posted the sign-in form without its token, is now
  refused. Read the token from the page or from `/_layout/tokenhtml` in the same browser, after its latest sign-in or
  LogOff, and send the browser's cookies with it. Tools without Fetch Metadata keep `simulator.portalToken`. Set
  `identityProvider.pairedBrowserTokens: false` to keep one shared browser token.
- A refused portal Web API token now answers 401 instead of 403, with the text after `Request validation failed : `.
  Set `observed.webApiAntiForgery: cookie-mismatch-403` to keep the former answer for a site observed giving it.
- A test that expected a local session without lifetime settings to last until the browser closes now sees a 24-hour
  sliding session. A test that read `PortalSTS0002`, `PortalSTS0004` or a 500 `PortalSTS0006` from the token service now
  reads the hosted IDs listed under Fixed.

## 0.9.8

This release lets you see and debug what the local runtime does: every request becomes a trace, original C#
plug-ins stop at breakpoints in VS Code, and a new analyzer reviews your Power Platform sources. Canvas apps
get a local player, Code Apps get a managed multi-app workflow, and the .NET Framework SDK can read a local
organization's metadata. Large datasets use far less memory.

### New

- **Request tracing and Monitor.** Each request becomes one tree of steps: HTTP request, Web API or form step, page
  render with its templates and Liquid reads, Dataverse operation, plug-in stages, table-permission decisions and the
  web hooks, jobs, flows and connector calls it starts. An activity whose plug-in refused the save reads `error` even
  when the page answered 200. The `_sim` **Monitor** has **Health** and **Activity** views. Read traces with
  `paqvilo mirage trace`, `/_sim/api/trace` or `connectRuntime().trace`, and export JSON, NDJSON or OTLP.
  `mirage.trace.level` is `off`, `summary` (default) or `full` (redacted payloads). See
  [request tracing](../mirage/docs/tracing.md).
- **Debug original C# plug-ins** in VS Code from your Debug DLL and PDB; `defaultMode: 'clr'` on a descriptor runs the
  original assembly on every start. See
  [debug original C# in VS Code](../mirage/docs/dataverse-plugins.md#debug-original-c-in-vs-code).
- **`paqvilo analyze`.** Offline rules for Dataverse and ALM, model-driven apps, Canvas, PCF, Code Apps, cloud flows,
  connectors, MCP, mobile declarations and Power Pages, on a folder or a project. Nothing is built or executed and no
  tenant is contacted; Doctor shows the findings and stays advisory unless you set `--fail-on`. See
  [static analysis](static-analysis.md).
- **Canvas player.** `/_apps/canvas/<app>` runs a Canvas app from its exported source, with an inspector for source
  locations, state and errors. `canvas.sources` folders reload on edit and replace a Solution app with the same unique
  name. A visitor without a Dataverse user gets 401 `CanvasPrincipalRequired`. See
  [Canvas apps](../mirage/docs/canvas-apps.md).
- **Code Apps development.** `mirage dev` starts your app servers and opens a workbench to switch apps, set parameters
  and watch connections and requests. The Vite plug-in keeps the SDK's `/app` and `/data` imports working against
  Mirage, with HMR and source breakpoints. See
  [Code Apps](../mirage/docs/code-apps.md#develop-sdk-apps-with-vite-and-the-workbench).
- **`CrmServiceClient` (.NET Framework)** connects through `AuthOverrideHook` and reads organization metadata from the
  SOAP Organization service. See [Dataverse API](../mirage/docs/dataverse-api.md#soap-organization-service).
- **Connector definitions.** Data packs can register captured Swagger 2.0 connector definitions; inputs are validated
  before your provider runs. See [data packs](../mirage/docs/data-packs.md).
- **Test data tooling** in `paqvilo/mirage/fixtures` and `paqvilo/mirage/testing`: generate datasets from your schema,
  remap identities, report coverage, emit TypeScript declarations, compare permission models and plug-in
  registrations. See [public API](public-api.md).
- **Large generated datasets.** `createOwned()` preset factories stream rows into compressed, checksummed record pages;
  `load()` presets are unchanged. See [paged record storage](../mirage/docs/state-storage.md#paged-record-storage).
- **Pack transactions.** Opt-in, authenticated, local-only pack endpoints with rollback, concurrency checks and
  idempotency receipts. See [data packs](../mirage/docs/data-packs.md#authenticated-local-endpoint-writes).
- **SPA registrations.** A `publicClient: true` Dataverse API registration takes `spaRedirectUris` (PKCE `S256`
  required, CORS for that origin). See [Dataverse API](../mirage/docs/dataverse-api.md).
- **Approvals** model Basic, AwaitAll, Custom and CustomAwaitAll; only assignees can respond.
- **Excel export.** The grid action `download-as-excel` returns a typed `.xlsx` workbook.
- **`mirage status --site <name>`** lists only the runtimes of that catalogue site. `paqvilo lense --version` and
  `paqvilo mirage --version` print the toolkit version.
- **Parity cases.** A rebuilt case keeps the volatile pointers earlier captures recorded; `revise.dropVolatile`
  (`--revise-drop-volatile <case-id>#<pointer>` in `scripts/parity-cases.mjs`) removes one, and is refused while the
  new captures still differ there. A replay failure shows declared gaps as `<known gap>`. See
  [test kinds](test-kinds.md).
- **Example scripts** in `examples/company-operations` and `examples/project` take `--help`, check their arguments
  before reading inputs or connecting, and fail with one line. A demo copy (`mirage demo`, also with `--scaffold`)
  includes their shared `cli.mjs` helper, which the copied scripts import. `plugins/prepare-registration.mjs --out FILE`
  and `baseline/generate.mjs --out DIR` write somewhere other than the example.

### Improved

- **Separate addresses.** `/_sim/` and `/_setup/` are served on their own loopback port (`adminUrl`), and on the Power
  Pages host the model-driven, Canvas and Code Apps surfaces on another (`appsUrl`). Portal pages cannot read the
  administration or call the apps. Tokens: `csrf` (administration, accepted everywhere), `portalToken`, `appsToken`.
  See [administration](../mirage/docs/sim-administration.md).
- **Dataverse behaviour.** Plug-in contexts (images, shared variables, parent contexts, async targets), column security
  on every read path (Web API, FetchXML, `$apply`, SOAP, TDS), add-on message authorization, solution staged upgrades,
  custom API deletion, notes and file writes, TDS types and limits, SOAP decimals, FetchXML paging and `count`, money
  in the row's currency, and `AttributeType` codes follow the platform more closely. Mirage is still not complete
  Dataverse parity; see [plug-in execution boundaries](../mirage/docs/dataverse-plugins.md#execution-boundaries).
- **Model-driven apps** load metadata on demand, show counts above 5,000 as `5000+`, and match the platform's
  `data.save()` error codes, save-and-new, OnLoad state and form/grid controls. See
  [client API](../mirage/docs/model-driven-client-api.md).
- **Flows.** Stricter expression parsing (`inspectFlowExpression`), more functions, trigger conditions, JSON Schema for
  inputs, time functions on the run's clock, and a deadline only when `limits.timeoutMs` is set.
- **Power Fx.** Runaway regular expressions stop after `host.regexGuardMs` (default 10,000 ms); one scope budget covers
  a formula and its component functions (`host.scopeBudget`, default 5,000,000).
- **Liquid and forms.** A missing `include` renders `Template "<name>" not found.` as text; only the first
  `entityform`/`webform` on a page renders; `request.params` includes cookies; plug-in errors on basic-form saves show
  the platform's generic message unless `Site/EnableCustomPluginError` is `true`.
- **Code Apps.** `devServer.timeoutMs` (1000 to 300000, default 120000) bounds a dev server that never becomes ready;
  connector calls wait up to 120 s; `PAQVILO_MIRAGE_URL` is the apps address.
- **Server logic.** `serverLogicTimeoutMs` (and `runExportedServerLogic`'s `timeout`) replaces the local 5 s limit, from
  100 ms up to the site's `ServerLogic/TimeoutInSeconds`.
- **Performance.** Row writes no longer scale with solution size; start-up, restarts, status and the catalogue use less
  memory.
- **Lense.** `--startup-timeout <ms>` (default 120000, cap 600000) bounds silence without progress for `mirage start`,
  `mirage dev` and `model-driven dev`. `agent sessions --timeout <ms>` sets the probe budget. Source attribution finds
  grid columns, forms, quick views, modals and rich-text frames more reliably. Ctrl+C runs each command's own cleanup;
  a third interrupt exits at once (130, or 143 for SIGTERM). A failed cleanup exits 1 and names what was left running.
  In the model-driven **Actions** panel each row has **Run**, a favorite star and **Hide** (hidden actions are listed
  under **Hidden (N)**); inputs and the result open under the row. While an action's page change is in place its
  **Run** reads **Reset**, which puts the page back; other results offer **Close**. Actions that open a page say
  "Opened in a new tab."; actions the current page cannot run are grouped under **Not available here** with the
  reason. A result stays in the view (Built-in, Identity or Custom) that ran it. Picking a label that **Logical names** added selects
  its field, and copying answers on the label (`<name> copied`). The X-ray details card, in portal and model-driven
  Lense, opens beside the picked element, stays inside the window and follows the element on scroll and resize.
  Declared model-driven sources are **Edited** when Git reports them changed; a source Git ignores shows
  **Git ignores this file**. The text report of `model-driven inspect` is a summary (the full report with `--json`),
  `model-driven --help` names `dev` as the default action, and with `--no-reload` the start-up line says live reload is
  paused.
- **Lense panel.** The header shows paqvilo on its first line and the site and environment on the second; it has no
  Reload button (F5 reloads). **Local** and **Online** each say what they show and that all tabs of the site switch.
  The panel keeps its own look whatever the page's CSS, rows do not move when hovered, and a tooltip stays open while
  the panel updates. Tab and pill counts appear only when there is something to count. Error messages wrap, stay long
  enough to read and are announced to screen readers at once. Inspect uses plain words ("your sources", "on this
  page", "not found") and no longer lists what Lense cannot observe. Opening a file finds `code` on PATH or in the VS
  Code install folders; when the editor is not found, the message names the setting to change and any PATH folder it
  could not search. The pill shows **LOCAL** or **ONLINE** and the site (the environment is in its tooltip); the header
  has a gear for project setup and a target button for X-ray. Row actions are always visible, the same on every tab,
  and the confirmation after opening a file uses the row's name. Overrides says **differs from deployed**, **same as
  deployed** and **N requests**, and its switch reads **Local files: all | changed vs Git**; with no local file on the
  page, it shows only the empty state. Inspect starts with its tools (one **Expand all**/**Collapse all** button, a
  tooltip on each control), lists page facts as "Template: … · Parent: … · Published", and a model-driven page names
  its table, app and form instead of their IDs. The selected element's details scroll with the panel's content
  instead of in a box of their own. Without a Git baseline the header shows **No Git baseline** and Issues explains
  why under **Comparison unavailable** (Git's message is behind the copy button). In front of the site's own local
  Mirage (and in a model-driven local simulation) there is no Local/Online switch, since both would show the same
  sources. The Portal / environment row appears only when there is another target, and Go only for a different one.
  Turning X-ray off brings back the panel it replaced, on the same tab. In X-ray, **tap Ctrl** (alone) or click
  **Inspect** to switch to Interact and back; holding Ctrl no longer interacts. The panel, X-ray and the selection
  details share one set of icons, buttons, chips, selects and rows; X-ray's **Parent** and **Child** use the panel's
  arrows. Under `mirage dev` a **Mirage** tab lists the runtime (site, revision, source, reload state), its
  diagnostics, content policy, records and the `_sim` pages for this page as rows; Inspect starts with the inspection
  and Tweaks no longer repeats them. Tweaks says who this browser is on one line (**Not signed in · Anonymous Users**,
  or **Signed in as … · roles** with **Sign out**; how the portal signs in is its tooltip). Each persona row signs in
  with its own button and pins with a star; the search has a filter button that opens web role, tag, account and group
  chips, and a button for the full picker in `_sim`. Pinned, Recent and Default personas are listed once, before the
  catalogue groups, which use the panel's group headers. Overrides lists the page's files as rows under **Page files**.
  Explore shows its count only when a search narrows or cuts the list. The model-driven **Actions** tab uses the
  panel's search box and group headers, and the selection details clear with the same close button as X-ray.
- **CLI.** Arguments are validated before any file, browser or PAC work; JSON errors go to stdout, readable errors to
  stderr; report paths cannot overwrite inputs or credentials. Each `mirage` action accepts only the options its
  `--help` lists. An unknown command or subcommand is one line naming it and the valid choices (exit 1; with `--json`,
  `paqvilo <unknown>` and `paqvilo mirage <unknown>` report `unknown_command`); an unknown option, also beside
  `--help`, fails in one line with the command's argument-error exit code, and with `--json` every
  command reports it as `unsupported_option` ([argument errors](cli.md#argument-errors)). An argument refusal ends its
  first sentence with a full stop before the help hint
  (`Option '--config <value>' argument missing. Run with --help to see supported options.`). The input files and
  folders of `mirage` commands and tools are checked first
  (`--source directory not found: <path>. Pass an existing directory.`). A catalogue that is not valid YAML is reported
  by position (`paqvilo.config.yml is not valid YAML (BAD_INDENT at line 2, column 1). Fix the file.`). Hints name the
  command as it runs from your folder: `npm run <script>` when a project script runs it, `npx --no-install paqvilo`
  in a project, `node bin/paqvilo.mjs` in the toolkit checkout. Every `mirage` action checks its option values before
  writing anything (`mirage init --port x` answers `--port must be an integer from 0 to 65535`), and `mirage init`
  uses `--solution-root`, `--state`, `--port` and `--preset`. In a folder without a catalogue, commands refuse with
  `No catalogue: <folder>/paqvilo.config.yml does not exist. …` (JSON code `CONFIG_NOT_FOUND`, also for the `mirage`
  commands and for `doctor --setup --config <missing file>`) instead of using the bundled
  sample, except a `--source` or `--project` run without `--site`, whose settings and state stay in the working
  folder, and `mirage status` and `stop`, which select the folder's runtimes; a `--config` file that does not exist is
  refused by every command except `mirage status` and `stop`, which select the runtimes recorded for it.
  `mirage webapi-inventory` without `--portal`, `--config`
  or `--site` reads `paqvilo.config.yml` in the working folder and its default site, like the other catalogue
  commands. The reference tools print one shared line for a `--local` origin or `--cdp` endpoint that does not answer
  (`Nothing answers at the --local origin <origin>; …`). `mirage trace export --limit` is checked before connecting,
  and `mirage data` without an action names `generate` and `scaffold`.
- **Runtime reports.** `mirage start` prints `State: not persisted (dry-run keeps state in memory)` for a dry-run
  runtime and `Dataverse API: <url>` for a standalone API; `mirage status` adds `dataverse api` and `authority`, and the
  runtime links add `dataverseAuthority`. `mirage stop` names each runtime it stops by its URL, as `status` lists it.
  Preflight and the capability registry rate each built-in Dataverse module and its operations `behaviour`,
  `contract` or `inventory` with a reason.
- **Setup checks.** `doctor --setup` reads the browser from `./paqvilo.config.yml` when `--config` is not given, and
  says `Browser: not checked` (JSON `prerequisites.browserNotChecked`) when nothing names one; with an unreadable
  `./paqvilo.config.yml` it still runs its checks and gives the reason. `init --ready` reports
  `PORTAL_SOURCE_MISSING`, and other commands name the folder, for a site source that does not exist.
  `setup --project FILE --json` prints `project` beside `config`. Commands shown on the setup page start the way
  paqvilo runs in the served folder: `npx --no-install paqvilo` in a project that depends on it, an npm script only
  when the project defines it.
- **Administration API.** HEAD answers every GET route; a 400 for a refused query parameter names it in `parameter`;
  the trace `host` filter accepts only the hosts it lists (`mirage trace` checks it and `export --format` before
  connecting). A missing preset answers `Preset '<name>' not found` with where to list presets. Each audit entry
  records `startedHostMs`, its start on the host's monotonic clock, and `/_sim/api/audit/export` answers `hostMs`, that
  clock read while serving.
- **Help everywhere.** Every `paqvilo dataverse <command>`, every direct Mirage command and lifecycle action, and every
  repository script in `scripts/` that is run directly answer `--help` and `-h`; `mirage data --help` describes each
  option of `generate` and `scaffold`. `paqvilo --help` lists `--version`; `mirage --help` lists `--state-dir` and the
  `setup` alias; `mirage baseline-suite --help` explains `LABEL`. `baseline-inventory.mjs --check` compares the
  committed inventories without writing.
- **Options.** A repeated single-value option is refused by every command (`--X may be given only once`; with `--json`,
  Mirage answers `invalid_argument`), and so do the repository scripts `ci`, `parity-cases`, `pr-readiness`,
  `runtime-performance`, `benchmark`, `benchmark-xray` and `power-fx-oracle`. `conventional-commit.mjs` refuses extra
  arguments, and `runtime-performance.mjs` refuses a `--records` value that is not a positive whole number (`--records
must be a positive safe integer.`, exit 2). A setting outside its enumerated values names them and the value given
  (`runtime.kind must be one of power-pages, model-driven or dataverse-api; got "x".`). A runtime started in the
  foreground with `mirage serve` is labelled `foreground` by `status`; `stop` leaves it running and names its URL and
  PID (`foreground` in `--json`). `mirage status` and `mirage stop` accept only their own options and list other
  toolkit-owned runtimes outside the selection as `others`; `stop` still finds the runtimes of a `--project` file that
  has been deleted, and `stop` with nothing to stop exits 0 with one line naming what it selected (`No toolkit-owned
Mirage session for <site>.` with `--site`); in a folder without a catalogue that is `the runtimes started in <folder>
without a catalogue site`. `status` labels each runtime with the site it was started for, also when two sites share a
  source folder. `liquid-conformance --json --markdown` is a usage error (exit 2).
- **Messages.** A documented public function or class called without a required argument throws a `TypeError` naming
  the call and the argument, such as `initialState(portal) requires a portal (the importPortal result).`; so do the
  methods of a `connectRuntime()` handle, which send no request, `trace.subscribe()`, `signIn()`, the Code Apps
  `configure()` and the in-process trace store ([public API](public-api.md)). `loadCatalogue()` without a catalogue
  throws `CONFIG_NOT_FOUND`. A runtime start that fails prints the reason and the startup log path without raw progress
  records. Simulation settings and project files name the refused key or the file and parse error in one line, and a
  project file that cannot be parsed is reported by position only, without its content. `connectRuntime` fails with
  `RuntimeNotMirage` when something other than a Mirage runtime answers. `trace.query` refuses a `limit` outside
  1–2000 and a `traceId` shorter than 8 hexadecimal characters (`InvalidTraceFilter`), and `logs` an unknown `type`
  (`InvalidLogFilter`), each naming the `parameter`. A start whose state file pins a deployment profile that is not
  configured names the pinned profile, the configured ones and the state file (`Select a configured deployment
profile: the locally pinned profile "<name>" is not configured (configured: …). Remove
simulator.deploymentProfilePin from <state file>, or restore the profile.`). A `FLOW_ACTION` message ends with one full
  stop. A canvas driver request without an action answers `A canvas action is required; use <actions>.` A model-driven
  PCF control whose local bundle does not register its constructor is reported as `The local bundle did not register
<constructor>.`, with the reason that a development build loading its modules with eval is refused and that the
  control must be built in production mode. A portal write without a verification token answers `Missing portal
verification token.`, and one with a token from another session `The portal verification token is not valid for
this session.` A trusted CLR plug-in descriptor with
  more than 100 `dependencies` or `symbols` is refused with a message naming the limit.
- **Project files.** An unknown key in a version 1 project file is reported as `PROJECT_CONFIG_KEY_UNKNOWN` by
  `mirage inspect` and at startup while the file still loads. A deployment profile environment variable that no
  Solution defines changes nothing and is reported as `DEPLOYMENT_PROFILE_VARIABLE_UNDEFINED` on both hosts.
- **Dataverse.** Duplicate detection and `RetrieveDuplicates` work on the standalone host, including standard tables
  without a mapping. The metadata API honours `ChangeTrackingEnabled` (off when omitted, enforced on change tracking)
  and `IsSecured` on a column POST, and column PUT/DELETE and key DELETE accept `LogicalName='x'` addressing. TDS
  refuses a column the caller reads masked as a `WHERE`, `ORDER BY`, grouping or aggregate operand (`0x80041155`), as
  the Web API does. Privilege refusals count the caller's real roles and privileges. The Code Apps bridge runs built-in
  Web API functions with their parameters and answers refusals with the Web API's status and code;
  `executeDataverseAction` takes only the name of an unbound action or function. A calculated column reads the same
  value whatever `$select` lists; in a chain deeper than five calculated columns the column reads null on every surface
  with `CALCULATED_UNSUPPORTED` naming it, and so does a column calculated through a cycle of calculated columns. A
  contact or lead write composes `fullname` from the name parts in the organization's `fullnameconventioncode` order and
  replaces a supplied `fullname`. Every signed-in user can read the `privilege` table. Rollup columns have their `_date`
  and `_state` columns and their exported formula, and attribute formats read as names. `Xrm.WebApi.retrieveRecord` and
  `updateRecord` work on the caller's own `usersettings` row. Exported server logic that reaches its time limit answers
  500 `ServerLogicTimeout`, and one that throws answers 500 `ServerLogicFailed` with the exception's message, instead of
  501 `LocalOperationUnsupported`.
- **Baseline comparison.** A scenario that cannot be compared has the verdict `ERROR`, like `PASS`, `ALLOWED` and
  `FAIL`. `parity-suite` (page DOM and shell), baseline compare and `verify` ignore toolkit-owned markup and headers
  through one shared definition: provenance attributes are ignored and injected elements dropped. The runtime
  `parity-suite` starts serves web files without appended source maps. `baseline-suite` live capture checks record
  aliases and `--ids` before any hook runs. `capture-snippet-composition` refuses in one line with a
  `SNIPPET_COMPOSITION_INVALID` reason, also when the page served is the sign-in page. `capture-stylesheets` refuses
  more than 32 paths before it starts a runtime, and both captures refuse a state file whose saved reference origin
  differs from the requested portal instead of reading that other origin. On the Power Pages host an accepted source
  reload keeps its `SOURCE_EXTENSIONS_REFRESHED` diagnostic beside `SOURCES_RELOADED`.
  `liquid-conformance` splits `staleRules` into `passingRules` and `missingRules`. `mirage verify` reports the first
  line of a browser error and saves the whole text as `artifacts.error`.
- **Dataverse CLI.** A remote `dataverse plan` lists the membership writes and blocked roots of `apply`; reads retry on
  429 and 503. A drifted action lists its `differences` (property, declared, actual). Label-only drift on declared
  tables and columns (`labelsOnly`, `summary.labelDrift`) changes only with `apply --update-labels`. The apply journal
  `state` is `Created`, `Updated` or `Unchanged`; `data-apply` reports `Created`, `Linked` or `Unchanged`.
  `DataverseClient` keeps an integer beyond 2^53 as its digit string instead of rounding it. A new table can declare
  `includeAllSubcomponents: true` to keep its solution root with every subcomponent; `plan` lists a root whose scope
  differs as `membership:scope-root`, and `plan`, `apply` and `scope-solutions` honour the declaration, so the table
  converges ([Dataverse provisioning](dataverse-provisioning.md)).
- **Baseline capture.** Live writes need `--allow-writes`, live captures name scenarios with `--only` or
  `--all-scenarios`, and scenarios can wait for popups with `wait: { popup: <n> }`. Captures and acceptance flows on
  `live.cdpUrl` refuse writes from every page, popup and frame they drive. A missing `--state` file is refused before
  capture (`--state file not found: <path>. Pass an existing file.`). A signed-in scenario without a contact names the
  input of the command that runs it: `--persona-contact` for `parity-suite`, the persona's `mirageContact` in the
  matrix for `baseline-suite`.
- **Parity suite.** `mirage parity-suite --list` prints the ID, tags and title of each scenario the selection would
  run, tab-separated; `--only` takes those IDs. `--scenarios` replaces the core scenarios unless `--core` is given.
- **Acceptance.** `mirage acceptance --cdp` accepts only a loopback `http:` or `ws:` debugging endpoint
  (`Use a loopback browser debugging endpoint.`) and reports an endpoint it cannot reach in one line. A step's document
  status is read from the committed document when another debugging client, such as a Lense session with overrides,
  serves the tab; when it is not observable, the step fails and says so.
- **Browser reports.** `model-driven dev` and a standalone `mirage dev` print the `browser` line with the browser and
  profile they use.
- **Company Operations example.** `plugins/deploy.mjs` plans exactly what `--apply` writes (create, update with the
  differing properties, or unchanged), writes a secure step configuration only when it is missing, so an existing one
  keeps its secret, and never prints secret values. `plugins/verify-live.mjs --cleanup RUN_ID` lists the rows one run
  left, and with `--apply` removes the run completely: chain nodes leaf to root (unsealed depth nodes first get their
  chain-step seal), probes, plug-in events through one maintenance intent each, test operations and the run.
  `verify-live.mjs` exits 2 when any case fails, names other assemblies with synchronous steps before the run and
  reports cases they abort as `SuiteBudgetExceeded` (see the example's plug-ins README). The lab's guards accept the
  platform's own root Delete wrapper for the sole trusted writer; the owned-evidence deletion contract binds the payload
  hash in the intent's name, and `deploy.mjs` switches it on for the `EvidenceWriteGuard` steps. The plug-in plan's
  `readiness` flags come from the installed steps, and `forms:audit` lists the solution additions `forms:apply` would
  make (`membershipAdd`). The example plug-in projects, here and in `examples/project`, no longer embed the commit hash
  or the build folder, so a new commit or another checkout alone does not show as an assembly change. The project
  baseline provisioning converges and reports `manual-step-mismatch` when a stored rollup definition differs from the
  declared one; `data.mjs reset` sends `Edm.Int64` fixture values as JSON numbers with their exact digits and reports
  `changes` and `unchanged`.
- **`_sim` layout** is consistent, works at phone width and follows dark mode.
- **Redaction** covers connection strings, URL credentials and invitation codes.

### Fixed

- A data pack plug-in step handler that never returns no longer freezes Mirage for good: a served runtime ends at the
  2-minute plug-in limit with a message naming the step. An error that pack code throws later, from a timer or an
  unawaited promise, is the diagnostic `PROJECT_CODE_UNCAUGHT` instead of the end of the runtime.
- Two runtimes can no longer write one state file: the second refuses to start with `StateFileInUse`, naming the first
  one's process ID and address, also for `mirage serve` and for the same `--state` used from another folder.
- A `cloudFlows` pack handler that returns nothing answers 500 naming the handler instead of an internal TypeError, and a
  `cloudFlows` or `serverLogics` handler that never settles ends its request with 504 after 120 s. The same holds for
  the other asynchronous pack handlers: a `workflows` or `dataverseMessages` handler that never settles ends its
  invocation with 504 `PackHandlerTimeout` after 120 s and can no longer write through the API it kept, and a pack
  connector operation or `httpFixtures` responder that never settles fails its call with 504 `ProviderTimeout` at the
  call's time limit (120 s by default).
- A data pack module that cannot be loaded, and a cloud flow definition that is not valid JSON or XML, are reported with
  their file name. A pack file saved while Mirage runs is reported as `PACK_FILE_CHANGED` (packs load at startup).
- A reload that loses a whole kind of portal source (every web template, every table permission, the website record)
  reports `PORTAL_SOURCE_REMOVED` with what is gone.
- A start refused because an identical start is still running says so, instead of "with different settings", and a
  `.paqvilo` folder that cannot be created is reported with its path, the cause and the next step.
- Snapshot folders of isolated persona runtimes left by a killed Mirage are removed by the next persona launch.
- `mirage dev` on a Mirage that was already running (for example after an earlier dev command was killed) ends with
  "is no longer running" when that Mirage ends, instead of staying open on an address nothing answers.
- A crashed tab no longer delays the end of a dev session by about a minute of clean-up timeouts; the tab is reported
  at once.
- A source change that arrives while a Mirage reload fails (a checkout that is still writing) is read by a further
  reload, instead of staying unread until the next save.
- A web file that is deleted or rewritten while Mirage runs (a save, `git checkout`) answers 404 or its new content
  until the reload, not a 500 "Portal rendering needs attention" page.
- A state file that cannot be parsed stops the start with a message that names the file and what to do, instead of a
  bare JSON parser message.
- The next start removes the records of Mirage runtimes that were killed; before, they stayed until `mirage stop`.
- Locks left by killed or interrupted processes (Mirage ownership, setup save) no longer block later commands; a lock
  taken on another machine or in WSL is never taken over, and a lock that cannot be cleared ends the command after
  30 s with a message naming the file.
- Commands report Git that does not answer within 120 s, or is missing, instead of treating the folder as "not a
  repository"; `lense dev` keeps watching sources meanwhile.
- CLR plug-in hosts: slow host creation no longer fails steps, hosts end with Mirage, a host that is not verified
  stopped keeps its cache and reports `PLUGIN_CLR_CLEANUP`, and Windows path-limit compile errors (`CS1619`) name the
  cache path length.
- Mirage no longer ends with a V8 fatal error when a worker thread finishes, and a listener error is recorded as
  `LISTENER_ERROR` instead of ending the process.
- Trace timelines stay correct after a system clock step (VM or WSL time sync, laptop resume).
- Modal and quick view frames on a slow or loaded machine no longer report loaded before their form scripts ran: the 5 s
  limit of Mirage's frame load ordering starts when the page requests its marker image, once its parser-blocking
  scripts have run, not when the document is served.
- Stored dates (record `createdon` and `modifiedon`, audit, async jobs, flow runs, approvals, queue items) no longer go
  backwards when the system clock steps back by up to 5 s (VM or WSL time sync). A larger change, such as
  `fixedClock.set` to an earlier hour, is honoured, and applying a preset or replacing the state starts from the clock
  again.
- Record change history, flow run lists and pruning, and approval pruning follow write order. Among equal dates,
  `RetrieveProcessInstances`, the personal wall and post comment lists show the later-inserted row first, and `Dequeue`
  serves equal dates in enqueue order.
- `mirage acceptance`: identity and preset steps let the page's queued requests settle before they leave the page, and
  a system clock step no longer breaks the proof of superseded and authored-aborted reads.
- `$pages.currentPage.forms.getAll()` lists forms by their `EntityFormControl_…` and `WebFormControl_…` wrappers, as
  Power Pages does: a form that shows only a message (record not found, success) is listed without controls, and modal
  and quick view documents list none. A form's `id` is the wrapper ID's part after the prefix, and `getFormById` takes
  that value, as on a live portal. A multistep form's `hasNextStep` and `hasPreviousStep` follow the visible Next (or
  Submit) and Previous buttons, and `goToNextStep` and `goToPreviousStep` throw the platform's "No next step available
  in the multi-step form." (or previous) instead of clicking a hidden button.
- Switching the model-driven target on a slow machine no longer ends the dev session; the Tweaks tab recovers from a
  slow or dropped runtime read.
- `lense verify` follows a start page that reloads itself or returns from sign-in, and reports interruption as
  `VERIFY_INTERRUPTED`.
- `lense verify` no longer reports page, form or list custom JavaScript as "inline <script> not replaced", or page
  custom CSS as "inline <style> not replaced", when the edit reached the page before the reload that records the
  replacement.
- `lense verify` no longer fails with "Execution context was destroyed" when a reload for its later saves replaces the
  page while it checks that the rest of the page still comes from the online site.
- Local sources reach slow-starting tabs and popups; element provenance no longer stays pending on scripts read with
  `fetch` or XHR.
- Element provenance survives a DevTools session re-attach of an unchanged document; a page script can no longer read
  the provenance keys or take the place of a provenance registry; an authored `debugger;` statement no longer pauses an
  inspected tab.
- A frame or popup document that takes over the window of its initial empty document (when page code touched that
  window before the document committed) has no element provenance; the tab reports it once per frame for script and for
  page provenance (`provenance_unrecorded`) without asking for a reload. Documents restored from the
  back/forward cache keep theirs.
- `like` patterns, FetchXML, form XML, deeply nested `$filter` (400 above 100 levels) and malformed Canvas control
  versions can no longer hang the runtime.
- Sign-in and sign-out `returnUrl` values can no longer redirect off the site.
- `lense list --settings` and the `verify` sign-in message no longer print credentials or URL query values.
- `paqvilo analyze` reviews folders named `build`, `dist` or `metrics` and no longer flags unpacked solutions as
  incomplete.
- A missing record page stops the start with `StateIntegrity` and leaves the state file untouched.
- CreateMultiple and UpsertMultiple stay linear in the number of targets.
- Default grids work on partial exports without the primary name column; updates no longer fail on exported audit
  relationships; a server-logic Create no longer exposes a secured column.
- Absent or empty enhanced payloads report `PAQ-SOURCE-002` instead of a syntax error.
- The temporary Edge used for shell capture no longer signs in to the Windows Microsoft account.
- Monthly flow recurrences skip short months in every time zone.
- Two Code Apps on the same dev-server address are refused at start; Code App module scripts run in document order.
- The rich-text compatibility editor sanitizes with DOMPurify and keeps tables and paragraphs.
- Plug-in packages with overlapping ZIP entries or oversized content are refused.
- The Service Bus emulator transport connects only to loopback addresses.
- Source files are read in code-unit name order and Lense sorts names with English collation on every machine.
- `mirage stop` of a runtime started by `mirage dev` also ends that dev command and its browser.
- `mirage serve --site` uses the site's `mirage.port` when `--port` is not given; `mirage data scaffold` for a
  catalogue site uses the site's `solutionRoots`; `mirage dev` or `start` with `--project` takes the catalogue settings
  (such as `personaContexts` and `identityProvider`) of the site `--site` selects, else of the site whose
  `mirage.project` is that file, and so does `mirage serve --project`; `--config` alone selects no site.
- A `--runtime model-driven` or `dataverse-api` start for a catalogue site uses that site's Solution roots, data packs
  and port, and belongs to the site (`status --site` and `stop --site` find it); one started with no `--config`,
  `--site` or `--project` belongs to its folder, where a bare `status` and `stop` select it
  ([which runtimes status and stop select](../mirage/docs/toolkit-integration.md#which-runtimes-status-and-stop-select)).
  `mirage data generate` finds the data packs of the catalogue site, as `serve` registers them.
- A state file or pack DATA file lock (`<file>.lock`) records its owner (process, host, toolkit). A lock whose owner
  process on this host has ended is reclaimed at the next start or write with a `WRITER_LOCK_RECLAIMED` warning. A lock
  of a running writer, of another host, or without owner identity (an older toolkit's) is never reclaimed; the message
  says which files to delete once no runtime uses them.
- `dataverse register` reads PAC's application listing by its header columns and matches the name whole, ignoring
  case; a listing it cannot read refuses registration instead of creating another application.
- `dataverse apply` sets the declared primary-name length after creating a table (Dataverse stores 850 at create) and
  verifies it.
- The standalone host changes and resets an operation through `PATCH` and `DELETE /_sim/api/operations/<key>`,
  answers an unknown administration path with 404 `Admin endpoint not found.` and a `summary` or `strict` query flag
  that is not a boolean with 400 `InvalidQueryParameter`, and records a refused token request, such as one for an
  unknown client, as a `DATAVERSE_API` diagnostic, as the Power Pages host does. A flow's `CONNECTOR_AUTH_UNSUPPORTED`
  warning is reported once in diagnostics and preflight on both hosts.
- An exported plug-in handler that answers a promise fails like its exception: a step handler with 400 `0x80040224`
  and the transaction rolled back, a plug-in type handler with `0x80040265` and its `SubErrorCode`.
- The sign-in page remembers the persona that signed in as a recent choice. A group of the persona picker folded or
  opened just before the picker updates keeps that state. `mirage demo` restores the sample dataset on every start and
  keeps source edits.
- The standalone host's deployment-profile switch answers 501 with where to set `deploymentProfiles.default` and that
  a restart applies it.
- Dataverse platform behaviour: each managed import adds a layer for every component, and managed tables, keys,
  relationships, global choices and every column of a managed table report `IsManaged: true`; an image column's
  `CanStoreFullImage` and a file or image column's `MaxSizeInKB` are stored on POST and PUT, and `MaxSizeInKB` is
  enforced on Web API, chunked and portal uploads however the column was created; a table's `IsAuditEnabled` from a
  Solution or an `EntityDefinitions` POST or PUT is kept and drives its audit rows, Solution-imported tables have audit
  history, and role assignments write audit rows; `DeleteRecordChangeHistory` accepts a typed entity reference as well
  as `@odata.id`; a PUT of a managed table that is not customizable answers 400 `0x80047008`; a failing mocked
  real-time workflow answers `0x80040265`; `observed.fetchLinkBudgetError` applies on every path that checks the join
  budget; `PublishXml` and `PublishAllXml` run the plug-in steps registered on `Publish` and `PublishAll`; an
  `InvalidPluginExecutionException` carries the `SubErrorCode` and `OperationStatus` annotations from CLR steps as from
  JavaScript handlers; `ownerid@odata.bind` assigns a standard user-owned table whose export declares no owner
  relationship.
- `observed.liquidFetchRights: native-classic` requires `tablePermissionQueryPipeline: native-classic`; without it the
  runtime does not start, and `mirage preflight` reports the same error. A custom connector using the OAuth implicit
  or password flow runs with a connection's static token (a `CONNECTOR_AUTH_UNSUPPORTED` warning instead of a block;
  preflight rates it `contract`). The portal Web API refuses `savedQuery` and `userQuery` (400) instead of answering
  unfiltered rows, and answers a JSON body over 8 MiB with 413 `0x8004418a` in its error envelope.
  `POST /_sim/api/flow-runs` returns the Response a run produced before it started waiting.
  Preflight rates an inventory module with its source-graph node's level and reason, and an unreachable local service
  declared `required: true` blocks with and without `--strict`. Status `capabilities.modelDriven` is `false` when the
  model-driven surface is turned off. Connection settings messages name the full key path.
- HEAD requests to administration routes answer on both hosts without side effects; a HEAD of a
  `/__sim/session-token/` ticket answers 405 and leaves the ticket for the navigation.
- A preset's table mappings are accepted at every simulation level; other schema it changes keeps the level's rule.
- A startup preset no longer replaces the rows of a table that a pack DATA file owns, and a preset that carries
  mappings applies through `/_sim/` at the `simulation` level.
- `POST /_sim/api/dataverse/users` with a `domainname` already in use answers 409 `DATAVERSE_USER_EXISTS`;
  `POST /_sim/api/dataverse/applications` with an `appId` a managed identity uses answers 409
  `DATAVERSE_APPLICATION_EXISTS`.
- The Code Apps bridge answers `WhoAmI` and the other built-in Web API functions as the Web API does.
- A relative plug-in source `root` in `observed.pluginSources` resolves against the project file's folder or the
  catalogue's `sourceRoot`; `mirage init` writes roots inside the catalogue folder relative to the project file.
- `mirage inspect` refuses a `dataverse-api` runtime with `dataverse.enabled: false`, as start does.
- `render-sweep` of a local-only site no longer treats its loopback environment URL as a live origin.
- Model-driven Lense: **Start acting as selected user** works on the native app, and application users can be found
  and acted as. Comparing a source with the native app accepts web resources served as `text/jscript`. In a headed
  session a native confirm or before-unload prompt waits for you; a headless session dismisses confirms, accepts
  before-unload prompts and records each one. **Discard and refresh** relies on the app's own unsaved-changes prompt
  instead of adding a second one.
- Lense: when your edit cancels the late reload of a tab that opened before local interception was ready, the
  `reload_required` warning is reported even when the browser drops the page's own notification, and at most once per
  tab. A paused request whose answer the browser refuses is failed and reported instead of staying paused until
  interception stops.
- Lense setup page: a status refresh that arrives while a button is pressed, by pointer or by a held Space, waits
  until the press ends, so the click is not lost. Switching to All settings or choosing another project no longer
  discards what is ticked or typed while the page is still reading the preview status. A section opened or closed
  just before the page repaints keeps that state.
- Mirage lists: a click on a column header while the list is loading sorts, and header links are disabled only for
  the load a sort click started, as on the portal. List loads and Bootstrap 5 note loads raise no jQuery global ajax
  events.
- Mirage: a source change reported while a reload restarts the watcher is reloaded instead of dropped. Status reports
  `pendingReload` from the first change notification until its reload publishes, and a reload that fails before it
  starts records `RELOAD_FAILED`.
- `mirage acceptance`: on a later hop of a redirect chain, `writeHoldAllowanceMs` reports what is left of the shared
  hold instead of a new step budget.

### Upgrade notes

- Node.js 26.13.1 or a newer 26.x release is required.
- Tracing is on at `summary`; set `mirage.trace.level: off` to turn it off.
- Source and implementation fingerprints change once (code-unit name order). Saved native network baselines report
  `NATIVE_BASELINE_SOURCE_CHANGED` and must be captured again; saved verify and acceptance evidence shows as stale.
  For names that differ only in case or punctuation, which control or record wins can change.
- Old `_sim` addresses `#dashboard`, `#logs`, `#audit`, `#trace` and `#evidence` redirect to Monitor; `#overview` opens
  Home.
- The CLI rejects extra or misplaced arguments it used to ignore, and every command refuses a repeated single-value
  option instead of keeping the last value. Check scripts that call it.
- No dependency risk acceptance is in force (`scripts/dependency-risk-acceptance.json` holds `{}`), and an acceptance
  is valid only with an `approval`.
- Reach the administration and apps on the printed `adminUrl` and `appsUrl`. A script that sends `Origin` or
  `Sec-Fetch-Site` to `/_sim/` or `/_apps/` on the portal address gets 403 `AdminOriginRequired` or
  `AppsOriginRequired`; clients without those headers keep the portal address. A request whose `Host` is not the
  listener's own address gets 403 `INVALID_REQUEST`.
- `handle.csrf` is the administration token; the portal form token is `handle.portalToken`, the apps token
  `handle.appsToken`.
- Delete a custom API's plug-in steps before the API: the delete answers 405 `0x80040227` while a step is registered.
  A second custom API with the same unique name answers 400 `0x80072013`.
- A staged upgrade of an unmanaged solution is refused with 400 `InvalidRequest`; use managed solutions for upgrades.
  `ImportJobId` must be an unused GUID.
- FetchXML `count` must be a positive integer (0 and other values answer 400 `InvalidFetchXml`); for a bounded total
  use `count="1" returntotalrecordcount="true"`.
- Browser session cookies are saved per portal scope in `<profile>.session.<hash>.json`; the old unscoped file is
  deleted, so a headed `verify --signed-in` signs in once more.
- Live baseline captures need `--allow-writes` for cache refresh and clear-cache steps, and `--only` or
  `--all-scenarios`.
- `mirage stop` exits 2 when it keeps a session it could not verify. A bare `mirage stop` also stops the runtimes
  started in the folder without a catalogue site.
- Mirage ownership records and discovery files name the host that wrote them. On folders shared between hosts
  (Windows and WSL, runners sharing a checkout), a runtime recorded on another host is no longer listed, selected,
  pruned, removed or signalled, and no shutdown request reaches it: `mirage stop` keeps it with its reason
  (`foreignHost: true` in `--json`) and does not exit 2 for it, and `mirage start` and offline state writes refuse its
  state file. When that host is gone (renamed or removed), delete its entry from the ownership file the message names.
  On Windows and macOS a runtime recorded before this machine's name changed counts as this machine's while its
  recorded identity still verifies. The sessions of `status --json` and `start --json` carry no `host` field. `mirage status` notes a runtime that did not answer the status in time instead of showing an empty site.
- In a folder without `paqvilo.config.yml`, commands no longer fall back to the bundled sample catalogue: they refuse
  with `CONFIG_NOT_FOUND`. Pass `--config`, or run `--source` or `--project` without `--site`.
- `mirage acceptance --cdp` accepts only a loopback `http:` or `ws:` endpoint.
- `lense agent status` no longer reports `debugger.attached`; read `debugger.port`.
- The model-driven **Actions** list keeps actions the page cannot run in the collapsed **Not available here** group;
  scripts and tests that look for those buttons must open it first.
- Scripts that parse `--json` errors: an unknown option is `unsupported_option` in every command, including `init`,
  `setup`, `doctor`, `dataverse` and the direct Mirage commands and tools.
- `mirage init`, `start`, `stop`, `status` and `inspect` refuse options they used to ignore, such as `--port` on
  `status` or `--headless` on `start`.
- A virtual table provider whose `*Sync` operation is an `async` function is refused at startup; use the operation
  without `Sync` for asynchronous work.
- The `examples/company-operations` scripts read their default connection from
  `<toolkit checkout>/.paqvilo/dataverse/provisioning.connection.json` whatever the working directory.
- Tests that pinned `AttributeType` 16 (multi-select) or 14 (partylist), or `...Type` names from Liquid
  `attribute_type`, use 17, 10 and the `AttributeTypeCode` names.
- `navigationCommitReserveMs` in `runAcceptance` reserves at most half of the remaining action time for held writes.
- On Linux and macOS, `paqvilo` does not forward SIGINT to its child (Ctrl+C reaches both); stop it from a script with
  SIGTERM, because a SIGINT sent only to the `paqvilo` process is ignored.
- Pack storage providers: `preflight` must settle once its `signal` aborts; closing a provider waits for its probes.
  The Service Bus emulator's `preflight()` without a probe context ends after a 30 s idle window with
  `SERVICEBUS_EMULATOR_UNREACHABLE`.
- Parity reference captures run under a debugging client: a message a cross-site frame posts within milliseconds of
  loading can be lost while a popup is held, and requests of a frame that another debugging client resumed first are
  not counted. Writes are refused in both cases.

## 0.9.7

### Improved

- Share selected-element evidence between Inspect and X-ray, with independent owner/source certainty,
  explicit alternatives, search limits and served/executed distinctions.
- Retain one-shot selections while hidden; clear detached nodes and navigated frames, reject stale updates,
  and preserve keyboard focus and disclosures across redraws.
- Validate evidence source identity and revisions before opening; label candidate actions explicitly and disable stale
  links. Recheck local content after the final browser selection check so a save during that check cannot open a stale
  location.
- Trace Power Pages rendering to the actual template, snippet, page field and platform component, retaining language,
  deployment profile and record identity across shared export files.
- Resolve model-driven forms, views, columns and control placements from Solution metadata and current browser
  observations; keep generated controls and unavailable definitions explicit.
- Link script-created DOM to acknowledged local implementation bytes and observed creation, clone or insertion
  callsites.
- Keep ordinary Mirage project stop hints readable across Windows shells while preserving directory and special-path
  handling.
- Add model-driven JavaScript/CSS debugger maps. To serve original asset bytes, set `mirage.sourceMaps: false`
  on the catalogue site, or `sourceMaps: false` in a Mirage project, and restart. Lense overlay source maps are
  configured separately; see [configuration](configuration.md).

### Fixed

- Fix native model-driven startup hangs and cancellation; honor the configured editor for source opening.
- Guard corrective startup navigation when a tab loads before interception attaches. Preserve edited controls and
  observed rich-text edits, cancel an owned corrective load if typing begins before it commits, keep newer
  documents intact, and report when a manual reload is needed. Clean popups still receive a one-time GET repair
  across initial blank-page and rapid document transitions; form submissions are never replayed.
- Preserve runtime selection and literal paths in Mirage stop commands across CMD, PowerShell and POSIX shells.
  Keep recorded ownership when project mappings change or portals are renamed or removed, so copied stop commands
  cannot select a same-source sibling runtime.
- Reject pipes and other nonregular external stop-command payloads before reading, preventing copied commands from
  hanging.
- Report disabled-preview edits requiring deployment and reveal Tweaks scenario/preset confirmations.
- Clear grid loading notices after completion, cancellation or failure; restore alternating column sort direction.
- Retain demo view/search through reload and history, include demo agent guidance and test dependencies,
  and clarify preset `personaRoles` behavior.

Update with `npm install --save-dev paqvilo@^0.9.7` and commit the lockfile.

## 0.9.6

This release runs much more of the Power Platform locally: a simulated Dataverse organization with its Web API,
model-driven and canvas apps from Solutions, and the automation around them. Setup and the simulator workspace are
redesigned, and Lense works on model-driven apps.

### New

- **Dataverse Web API:** a local organization API with OAuth (client secret, certificate and delegated flows),
  security roles, teams, sharing, column security, `$batch`, `$metadata`, change tracking, file and image columns,
  metadata writes, platform messages and a read-only TDS (SQL) endpoint. It can run without a Power Pages export.
  See [Dataverse API](../mirage/docs/dataverse-api.md) and
  [apps and APIs without a portal](../mirage/docs/standalone-organization.md).
- **Model-driven apps:** apps from your Solutions open at `/main.aspx` with their forms, views, dashboards, ribbon
  commands, web resources, PCF controls and the `Xrm` client API, including mobile offline. See
  [model-driven apps](../mirage/docs/model-driven-apps.md) and [client API](../mirage/docs/model-driven-client-api.md).
- **Canvas and code apps:** canvas apps run headlessly on Mirage's Power Fx interpreter, which also evaluates formula
  columns, Dataverse Functions and low-code plug-ins; code apps get a local client-library bridge. See
  [canvas apps](../mirage/docs/canvas-apps.md) and [code apps](../mirage/docs/code-apps.md).
- **Automation:** plug-ins, cloud flows, classic workflows, custom connectors and background jobs run against the
  local organization, with jobs committed in the triggering transaction. See [operations](../mirage/docs/operations.md)
  and [plug-ins](../mirage/docs/dataverse-plugins.md).
- **Platform services:** Azurite blob storage, the Service Bus emulator, the outbox, SharePoint document adapters and
  fixtures for services Paqvilo does not execute. See [platform stack](../mirage/docs/platform-stack.md).
- **Enhanced authorization:** sites on the enhanced Power Pages authorization model use mapped Dataverse users, roles
  and column security locally.
- **Model-driven Lense:** the Lense panel, Inspect, X-ray and Explore work on model-driven apps and name the table,
  column, form and view behind what you select. An **Actions** tab adds inspection, navigation, diagnostics,
  reversible form overrides and Web API request impersonation. See [model-driven actions](model-driven-actions.md).
- **Quick setup:** `/_setup/` starts with five plain steps that find your exports, write the configuration and start
  the preview without a terminal; **All settings** covers every key. See [setup](setup.md#quick-setup).
- **Simulator workspace:** `/_sim/` opens on an Infrastructure view with a live system map, activity and diagnostics,
  and adds Providers & services, Flows & jobs, Capabilities & preflight and Data packs. Setup and `/_sim/` share one
  shell. See [simulation administration](../mirage/docs/sim-administration.md).

### Improved

- X-ray identifies sources faster on large exports, inspects same-origin frames in place and never activates a control
  inside a frame.
- Large Solutions and data sets start and load their first catalogue several times faster; startup reports its
  progress and can be cancelled.
- Portal lists, subgrids and lookups resolve bare-ID lookups; portal reads mask secured columns as Dataverse does.
- New projects set up dependencies and browsers explicitly, and readiness checks no longer treat an empty starter as
  tested.
- Acceptance runners can observe request lifecycles; reference parity accepts explicit local visitors.

### Fixed

- JSON `$batch` change sets keep their atomicity when requests depend on each other.
- Changed settings no longer reuse a running preview started with the old ones.
- Localized Solution labels apply to tabs, sections and nested quick forms.
- Setup and `/_sim/` fit narrow screens, and the system map no longer overlaps labels or tooltips.
- Setup preserves unchanged YAML scalar formatting, flow collections and comments when saving other settings.
- Exported JavaScript server logic allows separately bounded worker startup on busy hosts while retaining its
  script execution limits.

### Upgrade notes

Node.js **24.22.1 or a newer 24.x release** is required; Node 22 is no longer supported.

Update with `npm install --save-dev paqvilo@^0.9.6` and commit the lockfile. Model-driven Lense runs project scripts
in the live app, so it requires `modelDriven.trustedExtensions: true` in the project file. Turn the model-driven surface
off with `modelDriven.enabled: false`. Reference reads still require explicit authorization and the intended signed-in
browser.

## 0.9.5

This release fixes demo, panel and setup issues and adds an illustrated guide to the project site.

### Changed

- **Demo:** the reader persona is Alex Demo 01 everywhere; the access-denied and page-not-found
  pages no longer reference a missing image; narrow viewports keep their side padding; `yaml`
  and `playwright-core` are declared so `npm test` passes in a fresh demo; the VS Code launch
  configurations use `msedge` with source-map resolution and no path mapping; Solution roots
  are listed in dependency order; the copied scaffold uses LF line endings so a Git baseline
  matches the served bytes.
- **Lense panel and X-ray:** hold **Ctrl** (previously Alt) to use the portal while X-ray is on;
  the Details button reports its state; the card shows code-component bindings and Web API
  page context; the header links to Project setup and, in Mirage, to Manage data and personas;
  a save toast is not replayed when you switch Online / Local.
- **Inspect:** Forms & controls lists the modal forms configured by a list's actions.
- **Setup workspace:** a form save writes only the fields you changed and keeps the original
  scalar formatting and comments; the workspace links back to the running portal.
- **Mirage:** DateOnly values keep their calendar date on non-UTC hosts; saving a configuration
  preset, or re-applying one already in effect, no longer reloads open pages; stale per-port
  session cookies are dropped from toolkit browser profiles.
- **Documentation and CLI help:** the page is called Backend operations; Alt+Shift+O and
  Alt+Shift+L, the `markup` setting, `agent pages` fields, the debugger port, plugin DLL execution
  and Windows long paths are documented; `paqvilo mirage --help` examples are corrected.
- **Site:** an interactive guide with clips and stills from the recorded walkthroughs.

### Upgrade notes

Update with `npm install --save-dev paqvilo@^0.9.5` and commit the lockfile. If you relied on
Alt to interact with the portal while X-ray is on, use Ctrl.

## 0.9.4

This release expands project configuration, improves local rendering and makes large
datasets and automated testing more practical.

### New

- **Project setup:** `paqvilo init` creates an empty project with packs, tests and editor
  tasks. `paqvilo setup --open` provides a local configuration workspace.
- **Personas and scenarios:** grouped, searchable persona catalogues, isolated setups,
  deployment profiles and project-owned settings, snippet and presentation overrides.
- **Public APIs:** supported runtime, pack, fixture, acceptance, testing, Lense and
  Dataverse entry points. `createMirageContext` binds packs once; `connectRuntime` and
  session helpers support independent visitors and concurrent tests.
- **Shell capture:** `paqvilo mirage capture-shell` captures platform styles using a
  temporary browser or an existing loopback browser connection. Reports identify missing,
  excluded and blocking resources.
- **Dataverse tooling:** a separate API and CLI for project-owned schema/data provisioning,
  comparison and solution exports. These are explicit operations, separate from previews.

### Improved

- Forms, lists, lookups, quick views, modal dialogs, multistep navigation, attachments and
  validation use more of the exported configuration. The [native component baseline](baseline.md)
  provides reusable fixtures and comparison tools; it does not certify complete parity.
- Liquid, FetchXML, permissions, PCF, supported local plugins and flows have broader
  regression coverage and clearer diagnostics for unsupported behavior.
- Large states use streamed checkpoints and durable row journals. Ordinary writes avoid
  rewriting every record. Acceptance handles document replacement and bounded settling.
- npm installations pass readiness checks without a second dependency install. CLI help,
  runtime status, worktree paths and the local demo have been refreshed.

### Fixed

- Unknown navigation bindings are rejected atomically under association enforcement.
- Footer spacing repairs respect clipping and modal layers and restore the original layout.
- Capture recognizes platform-provided jQuery and distinguishes broken native resources
  from local capture failures.
- DateOnly storage is distinguished from date-only display. Fractional seconds truncate;
  independent values avoid UserLocal shifts. Evidenced month-first parsing and seasonal
  formatting profiles are available for sites that need them.
- Migration and preset persistence preserve local edits and explicit definitions. Concurrent
  browser identities remain isolated; Windows state reads do not invalidate writer ownership.
- Staged attachments belong to their browser and persona, survive failed saves and are
  consumed once. Editor refresh preserves project scripts and validates debugger settings.
- Administration preserves active inputs, selections and drafts while background data loads.
- Inactive plugin steps preserve scoped-create behavior and efficient row persistence.
  Executing trusted handlers retain authorization and transaction safeguards.
- Persona pages follow group order and keep the default reachable. Saved configuration
  collisions remain manageable; linked configuration can be applied explicitly at startup.
- Acceptance and parity settling distinguish hash/history changes from document commits,
  and redirects share one bounded navigation wait.
- Native checkboxes save Boolean values using the platform's posted-control semantics.
  Solution date-only display and configured minimum-date errors retain their source meaning.
- X-ray source matches compare container modifiers and complete class lists, keep ambiguous
  snippets as possible matches, and reuse unchanged inspection reports and source hints.
  Element picks consume the full mouse or touch gesture before reopening the panel.
- Content-policy provenance survives unrelated configuration edits. Persona shortcuts,
  permission diagnostics, dialog reporting and CLI argument errors are more consistent.

### Upgrade notes

The published version line is **0.9.x**. Projects pinned to old checkout versions such as
`^1` or `1.2.0` must change that range explicitly.

For previews, follow [branch package installation](branch-packages.md). Update to stable
0.9.4 with `npm install --save-dev paqvilo@^0.9.4`, commit the lockfile and
run your project tests. Use your existing dependency category if it differs.

Large state files may use a format older releases cannot read. Back up state before
upgrading and use `readStateFile` rather than `JSON.parse`; see [state storage](../mirage/docs/state-storage.md).
Deep imports such as `paqvilo/mirage/lib/data.mjs` are not supported entry points; use the
[public API](public-api.md).

Mirage implements selected platform contracts. Validate critical project scenarios against
Power Pages; see [coverage](coverage.md) and the relevant [runtime reference](../mirage/docs/README.md).
