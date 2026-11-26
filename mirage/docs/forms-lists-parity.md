# Forms and lists

Mirage builds native basic and multistep forms, lists, lookups, subgrids and notes from the exported portal
configuration and Solution form and view metadata. Standard and enhanced records normalize into one model. Missing
managed metadata is reported and may use an explicit local fallback; it is never inferred from a customer name. Client
adapters supply platform-shaped form events, validators, date and picklist controls, lookup dialogs, grids, paging,
actions, notes and attachments, and session-sensitive requests; permissions are checked by the local data layer.
Generated fields and unsupported controls keep diagnostics.

Only form postback replay cases ([test kinds](../../docs/test-kinds.md#replay-cases)) record native forms; the rules
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
- **Global choices.** A native choice or choices (multi-select) field whose column is bound to a global choice lists
  the published options in the page language; an explicit authored options array keeps its own. A posted choice value
  outside the list fails event validation; a posted choices value outside it is refused as Dataverse refuses it
  (`PicklistValueOutOfRange`) and nothing is written. A list's dynamic choice filter on a choices column matches the
  rows that hold the selected option (`contain-values`, the operator Learn documents for choices columns); the hosted
  filter's operator is not captured.
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
- **Attachments.** Both save transports validate the required-file setting and the remaining slots on the target
  record. Each existing attachment accepted by the record reader uses a slot and satisfies the required-file setting.
  A Dataverse attachment location saves the file in a note. An Azure Blob Storage location uses the configured
  `portalCloudAttachments` provider route. A form without an exported location uses the site-level storage setting.
  The count covers every file note of the record, read as the system: a visitor who may create notes but not read
  them (or reads only their own) still uses up the slots the record's files take, and the rendered control states the
  same remaining count.
- **Number fields.** Every stock number box of a basic form or multistep form step (insert, edit, read-only and modal
  forms) shows and parses numbers in the page language, for example `1.234,5` in German; values that auto-generated
  steps carry in `__VIEWSTATE` are parsed the same way. Format and range messages are in the page language. A range
  bound the exported metadata omits beside a configured one is the column type's supported limit. A field whose code
  component mounts posts JSON instead, and the JSON transport keeps invariant numbers. The en-US and de-DE behaviour
  was observed on the platform; the other form modes are a local model.
- **Associate Current Portal User.** With **Is Activity Party**, the configured column must be a party list column of
  the form's table that accepts a contact. The save writes the contact as an `activityparty` row with the record, in
  the participation type that Learn's
  [activity party types](https://learn.microsoft.com/power-apps/developer/data-platform/activityparty-entity) table
  gives the column (`from` is Sender, `to` ToRecipient, `requiredattendees` RequiredAttendee, and so on); a posted
  value for the column is replaced. A column without a documented type, such as `partners`, fails with 501
  `FormUserAssociationUnresolved` before any write. A provider that writes through the Web API (the live bridge) sends
  the party as a deep insert of the record create.
- **Metadata validators.** The constant sum, multiple choice and rank order groups of basic form metadata are checked
  on the server as in the browser: `FormConstantSumInvalid`, `FormMultipleChoiceInvalid` and `FormRankOrderTie`
  re-render the form with the group's message. A Geolocation Lookup Validator needs the hosted map service and reports
  `FORM_GEOLOCATION_VALIDATOR_HOSTED`; Timeline metadata reports `FORM_TIMELINE_METADATA_UNSUPPORTED`.
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
- A basic form `WorkflowAction` shows its **Run workflow** button (label, tooltip and dialog texts from the action and
  the form's `WorkflowDialog` settings) when its filter matches the record. Confirming runs the workflow on the record
  when it is an exported, published, on-demand real-time workflow of the form's table with a trusted local `workflows`
  handler ([Dataverse API](dataverse-api.md)); otherwise the button is absent and `FORM_WORKFLOW_UNRESOLVED` reports
  it. A local runtime with live data or a virtual table never shows it.
- The table-specific basic form actions Microsoft Learn lists run locally on their own table: Close Case
  (`CloseIncidentAction`, with the action's `DefaultResolution` texts, else "Case Closed" and "Case Closed via Web
  Portal"), Resolve Case (`ResolveCaseAction`: its dialog asks for the resolution and its description, both required),
  Reopen Case, Cancel Case, Close as Won, Close as Lost and Set On Hold. Each button posts to the form's own action
  endpoint, which resolves the exported action, the record and the update permission again, and writes the close
  activity (`incidentresolution`, `opportunityclose`) and the state and status reason in one write. Cancel Case first
  cancels the case's open and scheduled activities (each table's Canceled state with its default status). The values
  come from the open-source legacy portal (Resolve and Close: state 1, status 5; Cancel: state 2; Reopen: state 0;
  Won: state 1, status 3; Lost: state 2, status 4; On Hold: state 0, status 2) and need the table's exported state and
  status metadata; the hosted wire and markup are not captured. An action on another table reports
  `FORM_ACTION_TABLE_MISMATCH`. Every table action, on forms and grids, first requires the record state the grid link
  shows for: an active case for Close, Resolve and Cancel, a closed one for Reopen, an open opportunity for Win, Lose
  and Generate Quote (Set On Hold: open and not on hold), a draft or active quote for Create Order and an order that is
  not canceled for Create Invoice; another state is refused with 400 `InvalidStateTransition` (inner code
  `0x8004F00E`, Mirage's state-transition refusal; the native code is not captured) before any write, and checked again
  inside the write.
- Calculate Value (`CalculateOpportunityAction`), Create Order (`ConvertQuoteToOrderAction`), Create Invoice
  (`ConvertOrderToInvoiceAction`) and Generate Quote (`GenerateQuoteFromOpportunityAction`) check Update on the record
  and Create on the new record's table, then run the Dynamics 365 messages of the local organization as the site's
  application user, as the legacy service does: `CalculateActualValueOpportunity`; for an order, activating a quote
  that is not active and `WinQuote` on one that is not won, then `ConvertQuoteToSalesOrder`;
  `ConvertSalesOrderToInvoice`; `GenerateQuoteFromOpportunity`. The conversions copy every column both tables have and
  the line items (`opportunityproduct`, `quotedetail`, `salesorderdetail`, `invoicedetail`) and link the new record to
  its source; Calculate Value sums the products' extended amounts of a won opportunity (else its estimated value) into
  `actualvalue`. These message semantics are a local model of the documented messages ([Dataverse API](dataverse-api.md)).
- Lists and subgrids offer the same table-specific actions as row actions (legacy link types 9 and 11 to 23: Close
  Case, Create Order, Create Invoice, Calculate Value, Resolve Case, Reopen Case, Cancel Case, Set On Hold, Close as
  Won, Close as Lost, Generate Quote), shown by the record's state as the legacy grid shows them (Resolve and Cancel on
  an active case, Reopen on a closed one, Create Order on an active quote, ...). Each posts the record reference to the
  legacy route `/_services/action-<name>/<website>`, which checks Write on the record (and Create on the new record's
  table) as the legacy service does and runs the same write as the form action. Resolve Case asks for the resolution
  in the grid's resolve dialog; Close Case sends the link's default resolution.
- A list or subgrid's record actions are its `ItemActions` followed by its `ExtendedItemActions`, ordered by
  `ActionIndex` (an equal index keeps that order, a missing one comes first), for rendering, row privileges, delete and
  workflow admission. A workflow action's link carries the grid `WorkflowDialog` texts, classes and size as its dialog,
  with the action's own `WorkflowDialogTitle`, `WorkflowDialogPrimaryButtonText` and `WorkflowDialogCloseButtonText`
  over them (`CustomizeModal`), in the request language like the labels. The grid renders one workflow dialog, the
  first workflow action's: its title (with `TitleCssClass`), confirmation, button texts and classes, size and dismiss
  text, on Bootstrap 3 and 5 (empty exported values keep the defaults). Choosing an action with its own texts writes
  its title, confirmation and primary text into that dialog; as in the legacy client, its close text is never applied
  (entity-grid.js stores it as `data-modal-canled-action` and reads `data-modal-cancel-action`) and nothing restores
  the dialog for a later action without its own texts. This follows the legacy list source
  (`ViewConfiguration.GetActions`, `WorkflowActionLink`, `EntityGridExtensions`, entity-grid.js); no hosted capture of
  a configured list workflow exists.
- Action filters of forms and lists match the record by its primary key, which the query selects even when the filter
  lists only other columns.
- A lookup dialog restores the current selection only when both record ID and table match a row of the authorized grid
  query. Selecting a row updates the control; the record changes only after a successful save.
- Native subgrid quick-find visibility follows the exported FormXml flag. Native PCF fields need explicit portal
  attribute enablement and a desktop binding. Standard dataset controls can use qualified list and subgrid view
  bindings. See [code components](code-components.md) for supported bindings and fallback.
- On sites where a signed-in page opens an authored modal iframe, configure `observed.modalFormShell` with site
  evidence. `signed-in-zero-website` allows the all-zero website ID with a non-empty query.
  `signed-in-exported-or-zero-website` also allows the current exported website ID and permits either ID without a
  query. The broader mode was observed on an Enhanced site. Both modes apply to signed-in reads with pages and data
  served locally. The route is `/_portal/modal-form-template-path/<website-id>/`. Its query cannot include
  `entityformid` or `entityform` in any case. The document provides the platform assets and `#content-container` for
  the host's controls. A non-empty `pageid` still requires access to the exported page and uses the exact lowercase key.
  When `observed.requestValidation` is `aspnet-query`, GET query values are validated before rendering the shell.
  URLs that supply a form continue through the usual exported Basic Form lookup and permission checks.
- Modal and quick-view documents hold the browser's `load` event with a pending image until jQuery's ready promise and
  one more macrotask (DOMContentLoaded without jQuery); a throwing ready callback does not block others. A marker script
  at the end of the body requests the image once every parser-blocking script before it has arrived and run, so
  delivery time does not count: the hold fails open 5 s after that request with `FRAME_READY_TIMEOUT`, and
  `FRAME_LOAD_ORDERING` records the release order. If `connect-src` blocks the ready notification, a same-origin image
  request releases the hold. A page whose inline script is blocked (a site
  `Content-Security-Policy` without `'unsafe-inline'` or the `'nonce'` placeholder, whose nonce the document's own
  scripts carry) is not held; after 60 s `FRAME_READY_TIMEOUT` with ordering
  `never-requested` reports it. Set
  `observed.modalLoadOrdering: immediate` (with evidence) to opt out. This stabilizes local timing only.
- A form subgrid on Document Locations renders the local document control
  ([SharePoint](sharepoint.md#adapter-a-dataverse-document-integration)).

## Notes and the activity timeline

- **Rich text notes.** With the site setting `Timeline/RTEEnabled` set to `true`
  ([Learn](https://learn.microsoft.com/power-pages/configure/configure-notes#enable-rich-text-editor)), the add and
  edit note dialogs use the rich text editor that rich text columns use (native CKEditor, or the compatibility editor).
  The control is marked `data-rte-enabled="True"`. The notes service sanitizes the note HTML before it stores it, and
  again on every read, because another author, the model-driven app or an import can store any markup. Scripts, event
  handlers, styles, frames and `javascript:` links are removed. The notes client rebuilds the HTML it shows from an
  allowlist of elements, so it never renders markup straight from the service. A note whose HTML has no visible text
  and no image is empty (HTTP 417). Without the setting, notes are plain text. Mirage does not reproduce
  the platform's request-validation error for HTML posted while the setting is off.
- **Timeline.** A form's `notescontrol` whose `DefaultTabId` parameter is `ActivitiesTab` is the activity timeline
  ([Learn](https://learn.microsoft.com/power-pages/configure/view-all-activities-in-portal-timeline), "Default tab").
  It lists the record's activities instead of its notes and posts to `/_portal/<website-id>/EntityActivity/GetActivities`.
  The diagnostic `PORTAL_TIMELINE_ACTIVITIES` reports it. On a custom (publisher-prefixed) table,
  `PORTAL_TIMELINE_CUSTOM_TABLE_NOTES` warns that notes and activities cannot both be shown on one form for a custom
  table (Learn, configure-notes). Mirage does not simulate adding portal comments or listing activity attachments.
- **Activities.** The timeline admits the activity tables named by the activitytypecode conditions of the **Portal
  Timeline View** (the activitypointer view `620cdb5e-d7c9-e511-80d1-00155d20b011`, or that name in the Solutions). The
  view's first order sets the order; the default is newest first by `createdon`. Each admitted table is read through
  the visitor's table permissions on that table, for activities regarding the record only, so a table without Read
  adds no rows. When the view is not in the configured Solutions, every activity table is admitted and
  `PORTAL_TIMELINE_VIEW_ABSENT` says so. When the view has other conditions, `PORTAL_TIMELINE_VIEW_FILTER_PARTIAL`
  names them, because they are not applied. Descriptions are sanitized and shown without inline images, as Learn
  states. Plain-text descriptions keep their line breaks. The page size is 10 by default and at most 25.
- **CustomerSupport/DisplayAllUserActivitiesOnTimeline.** Unless this setting is `true`, a case (`incident`) timeline
  shows only portal comments (`adx_portalcomment`), and `PORTAL_TIMELINE_PORTAL_COMMENTS_ONLY` says so. Other tables
  are not restricted.
- The timeline service shape, the page size limits, the portal-comment rule and the `DefaultTabId` rule come from the
  open-sourced portal code (xRM Portals Community Edition: `EntityActivityController`, `ActivityDataAdapter`,
  `ViewDataAdapter`, `FormXmlCellMetadata`). No live capture confirms them, and the activity card markup is local.

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
- The forward path rejects an already visited load step. Previous opens an earlier step and allows a new forward path
  from it. Each condition can read its named earlier step, query record, current contact, or associated contact
  record. The preceding step provides the default record.
- Committed progress is stored alongside local records and survives a restart with the same state file. Signed-in
  contacts resume after signing back in. Anonymous visitors need their browser-session cookie on the same listener
  port. The runtime keeps up to 1,000 sessions and removes them on an explicit data reset. A stale concurrent save
  must reload before it can continue.
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
| `webAPI.downloadFileFromColumn(set, id, column, { size })` | Combines 4 MiB ranges into a Blob typed from the `mimetype` header. `size` is `full` (default) or `thumbnail` for images. A replaced file fails the download. Errors are the request's `AjaxError`                                                                          |
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
- A form field hosted by a code component is a generic control, as on Power Pages: `getValue` and `setValue` throw
  `Method not implemented.`, `getType` returns `undefined`, `getVisible` returns true, `getDisabled` returns false and
  `setDisabled` changes nothing. Opaque control markup without a known field type reports `PagesClientApiUnsupported`
  for `getValue` and `setValue`.
- `$pages.agent.SendActivity` invokes a project-configured local `POST /_api/agents/<schema>/activities` endpoint.
  Use a simulator mock or a trusted pack endpoint that accepts the activity object and returns an activity or an array
  of activities. The client delivers each activity to the response callback and reports a missing endpoint to the error
  callback. This contract runs locally, including the request, token check and callback handling. Copilot Studio's
  hosted conversation and Direct Line transport need their own provider.
