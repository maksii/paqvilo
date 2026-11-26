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
- **Subgrid view picker.** A form subgrid that hosts a dataset code component, with `EnableViewPicker` on, offers
  its `ViewIds` views in its toolbar, the default view first. An ordinary subgrid keeps its default view.
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
- **Sessions that follow the site's sign-in settings.** With `Authentication/ApplicationCookie/SlidingExpiration`
  explicitly `true` and an `ExpireTimeSpan`, a local browser session renews after more than half its window.
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
  changed. A private-site admission session ends after `ExpireTimeSpan` (24 hours by default). See
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
- **HSTS, the default CSP and CORS for authored pages.** Observations a site records with evidence:
  `strictTransportSecurity` sends the site's HSTS header on the http loopback listener, where browsers ignore it, so
  `localhost` is never pinned to HTTPS. `defaultContentSecurityPolicy: platform` sends the default policy that Learn
  documents for sites created after November 10, 2025, while the site has no CSP setting. `corsPages` answers
  cross-origin GET, HEAD and preflight requests of authored pages from an exact allowed origin, with the literal page
  source and no credentials; other cross-origin requests are still refused. See
  [HTTP transport and CORS](../mirage/docs/http-headers.md).
- **Edge controls of the live site.** `readPowerPagesEdge` from `paqvilo/dataverse` reads a site's visibility, WAF
  status, custom and managed rules and IP restrictions with read-only PAC commands, and says what Mirage does not
  emulate. See [Lense](lense.md#edge-controls-of-the-live-site).
- **Calculated columns from the designer.** A calculated column exported from the column designer computes on read in
  Mirage: the exported `Formulas` XAML is compiled (arithmetic, IF / ELSE IF / ELSE, conditions, typed literals, date
  functions, text, a field of the row one lookup away) and its result keeps the column's precision. `$filter`,
  `$orderby`, FetchXML and the portal see the computed value, and writing the column is ignored with 204. Before, every
  designer column read null with `CALCULATED_UNSUPPORTED`. See
  [calculated columns](../mirage/docs/dataverse-contract-modules.md#calculated-columns).

### Improved

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
  `/_services/action-*` routes.
- Lists and subgrids include `ExtendedItemActions` after `ItemActions`, ordered by `ActionIndex`. The grid's workflow
  dialog shows the first workflow action's dialog (title, title class, confirmation, buttons, size) on Bootstrap 3 and
  5, and an action with its own dialog texts writes them into it; action labels and dialog texts follow the request
  language.
- A form's choices (multi-select) field bound to a global choice lists the published options in the page language and
  refuses a value outside them; a list's dynamic choice filter on a choices column finds the rows holding the option.
- With live data and `KnowledgeManagement/ContentAccessLevel/Enabled` true, search and `knowledge.articles` apply the
  content access levels over rows read through the live data path.

### Fixed

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
- The portal Web API (`/_api`) applies `Prefer: odata.maxpagesize` only to a query with `$top`, as Power Pages does:
  without `$top` the preference is ignored and a response holds up to 5,000 rows, as without the header. Before,
  Mirage paged such a query. To page portal reads, add `$top`; the next link keeps it and the last page stops at it.
  The Dataverse Web API still pages without `$top`. See
  [input and rendering contracts](../mirage/docs/dataverse-parity.md#input-and-rendering-contracts).
- A Custom Access table permission whose FetchXML has a `link-entity` is disabled
  (`PERMISSION_CUSTOM_ACCESS_FILTER_UNSUPPORTED`); before, Mirage dropped the link and granted every row the root
  filter matched.
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

### Upgrade notes

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
  `adx_identity_securitystamp` changes, and a private-site admission session now ends after 24 hours (or
  `ExpireTimeSpan`).
- Lense with a code-site project answers a file of the local build ahead of the exported `.powerpages-site` web file at
  the same address, as Mirage does; a rebuild reloads the tabs. Edit the build's sources rather than the exported copy
  of a built file.
- `PORTAL_SEARCH_QUERY_WEIGHTS_IGNORED` is now `PORTAL_SEARCH_QUERY_WEIGHTS_LOCAL`, because `Search/Query` weights now
  rank the default search page. Results with the same matches can come back in another order than before.
- A persona launched from the sign-in page picker, `POST /_sim/api/personas/launch` or `/_sim/sign-in` is now a browser
  session like any sign-in: it follows the site's `ExpireTimeSpan` and sliding window and the security stamp check.
  `signIn()` stays a programmatic session; pass `browserSession: true` for a browser session.

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
