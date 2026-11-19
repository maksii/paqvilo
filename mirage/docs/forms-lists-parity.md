# Forms and lists

Mirage builds native basic and multistep forms, lists, lookups, subgrids and notes from the exported portal
configuration and Solution form and view metadata. Standard and enhanced records normalize into one model. Missing
managed metadata is reported and may use an explicit local fallback; it is never inferred from a customer name. Client
adapters supply platform-shaped form events, validators, date and picklist controls, lookup dialogs, grids, paging,
actions, notes and attachments, and session-sensitive requests; permissions are checked by the local data layer.
Generated fields and unsupported controls keep diagnostics.

No replay case ([test kinds](../../docs/test-kinds.md#replay-cases)) records native form or list behaviour; the rules
below are local models of Microsoft's documentation and site observations. A locally passing flow shows that the
simulated scenario works. Compare the reference DOM and network behaviour before calling it platform parity
([reference parity evidence](parity-evidence.md)); project tests should assert their own labels, relationships,
actions and saved results against an explicitly registered dataset.

## Form selection and metadata

- **System forms.** Selection keeps both the enclosing FormXml group (`formType`; without a declared group, the
  `FormXml/<group>/` directory) and an explicit numeric `<type>` (`systemFormType`), which wins: Main is `2`, Card `11`
  ([SystemForm](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/systemform)). A
  named portal form selects an eligible Main over an earlier same-name Card. If the matching forms all have known
  non-Main types, Mirage reports `SYSTEMFORM_INELIGIBLE_TYPE` instead of approximating a layout. Microsoft documents a
  [duplicate-name issue across form types](https://learn.microsoft.com/en-us/power-pages/known-issues), so the hosted
  choice can differ when names collide.
- **Labels.** The selected metadata LCID applies to form names, field labels, tabs, sections, nested quick forms and the
  label fallback after tab-name matching; without a label in that LCID the first exported label is used.
- **Record sources.** An associated-record source checks authorized related rows first; several matches produce the
  observed server error. An attribute-query source binds the first authorized result, and no match leaves the lookup
  blank; use an exported unique key when one row must be identified.
- **Defaults.** Radio-style picklists on existing records show the exported default for a null column unless the form
  ignores defaults; stored values and prepopulation win, and the stored row is unchanged. DateOnly controls filled from
  the clock keep the observed UTC suffix in their hidden postback value; the submitter accepts it and the zone-free
  edited value.
- **Read security.** A form or advanced form step reads its record as Dataverse answers the reading principal: the
  site's application user under standard authorization, the visitor's mapped Dataverse user under enhanced authorization
  ([enhanced authorization](dataverse-parity.md#enhanced-authorization)). Unreadable secured columns are empty, masked
  columns show their mask (for example `***7003`), calculated and formula columns show computed values, lookups the
  related primary name. Lists, search, Liquid and the portal Web API follow the same rules ([column security on portal
  reads](dataverse-parity.md#column-security-on-portal-reads)). A secured column posted back unchanged in its masked or
  empty form is not written.

## Submission

A Power Pages export is a WebForms portal, so native forms post the page back by default: URL-encoded (multipart with
the attach-file control) successful controls to the form action, including modal documents and auto-generated steps.
`observed.nativeFormTransport: json` selects the local JSON form endpoint instead.

- Mirage resolves the page's forms, actor, record and advanced-form session before decoding the WebForms target;
  posted record or session controls cannot replace that context. ASP.NET view state and event validation are not
  emulated. The postback keeps exact decimal and Int64 tokens, repeated and omitted controls, and converts textarea line
  endings to LF. Files post only through the attach-file control's multipart form; URL-encoded file submission is
  rejected. File selections do not survive a reload.
- **Checkboxes** follow ASP.NET successful-control rules: a non-empty posted value (including a script's custom value)
  saves `true`, empty or omitted saves `false`. Only editable checkboxes rendered by the selected form participate.
  Boolean radio and select controls decode `1`/`0` and reject other text; the JSON API requires typed Booleans.
- **Success.** Source success settings choose an inline HTML response or the redirect target. A redirect's appended
  record-ID parameter must be configured explicitly: Mirage keeps the exported name and query settings and never
  supplies a missing `id` ([on-success
  settings](https://learn.microsoft.com/en-us/power-pages/configure/basic-forms#on-success-settings)). Redirect
  responses carry `Content-Type: text/html; charset=utf-8`. Check the resulting page and saved record, not only the
  submit response.
- **Validation and write errors.** Required, format, range and length errors re-render the form as HTML with HTTP
  status 200. A failed atomic basic-form write also re-renders with escaped posted values and
  `#MessagePanel.alert-danger`; the original error stays in diagnostics. CSRF failures, malformed or forged controls,
  inaccessible pages and errors before the write keep their error status. The JSON endpoint keeps its status and the
  browser reloads the document with the posted values and error panel. Advanced forms keep their inline save-error
  contract.
- **Plug-in refusals.** When a plug-in refuses a basic form save with `InvalidPluginExecutionException` (a declarative
  rule, a step handler's `reject(message)`, a plug-in type's throw or a CLR plug-in), the form re-renders with status
  200 and `An unknown failure has occurred. Error ID # [<id>]`; `<id>` is a new GUID also sent as `x-ms-request-id` and
  recorded as the diagnostic's `errorId`. With site setting `Site/EnableCustomPluginError` `true` (any case) the panel
  shows the plug-in's message as escaped text. The trace and diagnostic always keep the message. Multistep steps answer
  the simulator's request error page with the error's status, and lists keep their grid error message, even though
  Microsoft documents the setting for them.
- **Other write failures**, including an ordinary plug-in exception (0x80040224), show "An error occurred while
  processing your request. Please try again." unless the site sets `observed.formSubmissionErrorMessage` with
  `evidence`; that setting never changes a plug-in refusal. A permission failure inside the write uses the portal
  access-denied wording unless that setting is set, which replaces it too.

## Actions, lookups and modals

- Basic form Activate and Deactivate buttons follow exported `Actions` settings. Mirage resolves the record again from
  the configured query, current user or related record, checks read and update permissions, and changes only state and
  status in one atomic write. Status values need exported state/status metadata; unsupported actions, unresolved
  metadata and action filter criteria keep diagnostics. Confirmation, labels and redirects come from the source.
  Repeated button IDs across forms dispatch through the button's full WebForms name.
- A lookup dialog restores the current selection only when both record ID and table match a row of the authorized grid
  query. Selecting a row updates the control; the record changes only after a successful save.
- Native subgrid quick-find visibility follows the exported FormXml flag. Native PCF fields need explicit portal
  attribute enablement and a desktop binding; list and subgrid PCF hosting keeps the native grid
  ([code components](code-components.md)).
- Modal and quick-view documents hold the browser's `load` event with a pending image until jQuery's ready promise and
  one more macrotask (DOMContentLoaded without jQuery); a throwing ready callback does not block others. A marker script
  at the end of the body requests the image once every parser-blocking script before it has arrived and run, so
  delivery time does not count: the hold fails open 5 s after that request with `FRAME_READY_TIMEOUT`, and
  `FRAME_LOAD_ORDERING` records the release order. A page whose inline script is blocked (a site
  `Content-Security-Policy` without `'unsafe-inline'`) is not held; after 60 s `FRAME_READY_TIMEOUT` with ordering
  `never-requested` reports it. Set
  `observed.modalLoadOrdering: immediate` (with evidence) to opt out. This stabilizes local timing only.
- A form subgrid on Document Locations renders the local document control
  ([SharePoint](sharepoint.md#adapter-a-dataverse-document-integration)).

## Liquid form tags

`entityform` and `webform` tags follow the page template: a web-template page renders its first tag and reports each
later one; a Rewrite page renders no tag from its copy and keeps its attached basic or multistep form.

## Multistep forms

- Imports keep the exported Start Step, every owned step and explicit next and condition-failure references. A
  reference to another form's step keeps that record with an informational ownership diagnostic. Condition and
  redirect steps keep their raw settings, localized values, scripts and references. Missing or inactive referenced
  records stay explicit dependencies; a missing start step never selects an unrelated layout.
- A Condition start step is reported unsupported, as
  [documented](https://learn.microsoft.com/en-us/power-pages/configure/multistep-form-properties). During submission a
  missing next step cannot become success and a repeated condition chain cannot become a load step. Direct references
  are checked before writes; branch checks use the saved row inside the provider's write unit, before session and
  history updates, so a failed check rolls back (a provider without transactions may already have committed).
- Conditions compare Int64 and Decimal values and literals with exact arithmetic. Unquoted multiword values
  (`new_name = Jane Doe`, as in the
  [conditional step documentation](https://learn.microsoft.com/en-us/power-pages/configure/add-conditional-step)) run to
  the next logical operator or group boundary. Missing values, unbalanced groups, bad quotes and adjoining quoted and
  unquoted values are explicit unsupported-expression errors.
- Auto-generated steps render one tab per page: Next and Previous post back, the tab index and earlier values travel in
  `__VIEWSTATE`, and the last tab's Insert saves everything. A step with `adx_referenceentityshowreadonlyform` renders
  the referenced record's read-only form (`ReadOnlyFormView_<table>`) first. A control the platform cannot render (an
  inline web resource, a quick view on a postback step, a control whose ID the read-only form already rendered) stops
  the form at its cell with the platform's error alert. This undocumented behaviour is a local model; no replay case
  records it.

## Modern lists and the client API

A list include with `isModern: 'true'` renders a modern list: local markup (`data-mirage-component="modern-list"`) over
the list's secured grid query, loading the next page (the list's page size) as it scrolls. Views and view selector,
search, filters, sorting and the details, edit, create, delete and download actions come from the classic grid engine;
a URL target opens its page and a basic form opens in a dialog over the modal form route. The import diagnostic
`MODERN_LIST_LOCAL_MARKUP` names these includes. Other configured actions (associate, disassociate, workflow,
activate, deactivate, create related record) are absent and report `MODERN_LIST_FEATURES_UNSERVED` with the blocking
row `portal:modern-list/<list>`. Map, calendar and dataset code component lists render the classic list and report
`MODERN_LIST_RENDERED_CLASSIC`.

Every page runs the local [`$pages` client API](https://learn.microsoft.com/en-us/power-pages/configure/client-api)
(`mirage/lib/pages-client-api.js`), loaded right after the page runtime script: inline on pages that load the
platform bundles, otherwise from `/__sim-static/pages-client-api.js`.

| Member                                                     | Behaviour                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Microsoft.PowerPages.onPagesClientApiReady(callback)`     | Calls back, and resolves with `$pages`, once the document is parsed. The deprecated `Microsoft.Dynamic365.Portal.onPagesClientApiReady` warns once. `isClientApiEnabled` is `"True"`                                                                                        |
| `currentPage.lists`                                        | `getAll`, `getListById`; per list `id`, `isModern`, `rows`, `columns`, `getColumn`, `getVisible`, `setVisible`, `getHtmlElement`, `on`/`off` with `loaded`, `rowclick` and `cellclick`. A classic list answers empty rows and columns and ignores `on`/`off`, as documented |
| `currentPage.forms`                                        | `getAll`, `getFormById`, `getFormByName` over rendered basic and multistep forms; see below                                                                                                                                                                                 |
| `ajax.request`, `webAPI`, `user.signIn`, `user.signOut`    | Work; `webAPI` record methods use `/_api`                                                                                                                                                                                                                                   |
| `webAPI.uploadFileToColumn(set, id, column, file)`         | Sends the whole file in one request with `x-ms-file-name` (no 4 MB chunks)                                                                                                                                                                                                  |
| `webAPI.downloadFileFromColumn(set, id, column, { size })` | A Blob typed from the `mimetype` header; `size` is `full` (default) or `thumbnail` for image columns. Errors are the request's `AjaxError`                                                                                                                                  |
| `languages.getAll()`, `languages.setActive(code)`          | The site's published languages (else the page language). `setActive` loads the page under `/<code>` like the language picker; an unknown code throws `TypeError` without navigating                                                                                         |

`getAll` lists every basic form wrapper (`EntityFormControl_…`), then every multistep form wrapper
(`WebFormControl_…`) that holds one form view, as the platform's client API does. A wrapper that shows only a message
(record not found, a success message that hides the form) is a form without controls or name; modal and quick view
documents have no such wrapper and list no form.

Forms: `id` is the part of the wrapper element ID after `EntityFormControl_` or `WebFormControl_` (the form's ID
without hyphens, as a live portal answers; `getFormById` takes this value, not the element ID) and `name` the form
name; `controls`,
`tabs` (with `sections`, `getName`, `getVisible`, `setVisible`), sections (`controls`, `getName`, `getVisible`,
`setVisible`), `isMultiStep`, `getVisible`, `setVisible`, `getHtmlElement` and `getControlByLogicalName`. A multistep
form adds `nextButton`/`previousButton` (jQuery, empty when absent), `hasNextStep` and `hasPreviousStep` (the Next, or
the last step's Submit, and Previous button is present and visible, as on the platform), `goToNextStep` and
`goToPreviousStep` (click that button, or throw "No next step available in the multi-step form." or "No previous step
available in the multi-step form."). Forms and controls have no events.

Controls have `getName`, `getLogicalName`, `getType`, `getValue`, `setValue`, `getVisible`, `setVisible`, `getDisabled`,
`setDisabled`, `getRequired`, `setRequired`, `addValidator`, `removeValidator` and `clearValidators`, plus the members
of their type: String, Memo, Integer, Decimal, Double, Money, Email, URL, TickerSymbol, DateTime, Boolean (value is the
option label), MultipleChoice, Picklist (`subType`), MultiSelectPicklist, Lookup (`isDropdown`, or `isModal` with
`clearValue`), File and Image (`maxFileSizeInByte`, `removeFile`), Status and StatusReason (read-only), FormattedInteger
and AddressComposite.

- `setRequired` and `addValidator` validators run on submit and report in the validation summary; a server-required
  column stays required. A read-only control refuses `setValue`.
- A full-name control reads and writes `{ firstName, middleName, lastName }` and throws when the form has none of its
  boxes. Rich text reads and writes the editor HTML; its `getType()` is `undefined`.
- Code component controls throw `PagesClientApiUnsupported` for `Control.getValue` and `Control.setValue`, as do the
  Copilot Studio `agents` members; each logs `PAGES_CLIENT_API_MEMBER_UNSUPPORTED` once.
