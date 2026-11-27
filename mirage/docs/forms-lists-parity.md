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
Number boxes show and parse the page culture's marks for en-US and de-DE (captured); another page language keeps
invariant numbers and reports `FORM_NUMBER_CULTURE_UNCAPTURED` unless `observed.nativeNumberCultures: locale-data`
takes its marks from the locale data (uncaptured).

- Mirage resolves the page's forms, actor, record and advanced-form session before decoding the WebForms target;
  posted record or session controls cannot replace that context. ASP.NET view state and event validation are not
  emulated. The postback keeps exact decimal and Int64 tokens, repeated and omitted controls, and converts textarea line
  endings to LF. Files post only through the attach-file control's multipart form; URL-encoded file submission is
  rejected. File selections do not survive a reload.
- **Attachments.** Both save transports validate the required-file setting and the remaining slots on the target
  record. A Dataverse attachment location saves the file in a note. An Azure Blob Storage location uses the configured
  `portalCloudAttachments` provider route. A form without an exported location uses the site-level storage setting.
  As in hosted session F2, with the same results at `enhancedauthorization` 3 and in its state-0 re-run (runs s0b–s0h):
  - The count covers every note of the record whose file name does not end in `.azure.txt`, read as the system. A
    note the visitor cannot read, a text-only note and an orphan staged note each use a slot.
    `AttachFile_HiddenField_MaxFile` holds the remaining count. The hint reads "You can upload a maximum of N files,
    each up to …MB." when several files are allowed. With one file allowed it reads "You can upload a maximum of 1
    file, up to …MB." while MaxFile is 0.
  - The record's existing notes do not satisfy the required-file setting. A save without a new file answers
    "<label> is a required field.", and the control stays `aria-required`.
  - `POST /_api/file/InitializeFileUpload/note` with the form (`formType`, `formId`) and a regarding record the visitor
    can read refuses a file beyond the count with 400 `{"ErrorCode":"AU00039","ErrorMessage":null}`. Otherwise it
    creates the staged note on the record at once. The note is subject "Note created on … UTC by <name>
    [contact:<id>]", notetext `*WEB*`, not private and not a document. It answers that note's id.
  - `PUT /_api/file/UploadFileBlock/note` needs annotation Write on the staged note. Without it, it answers 403
    `{"ErrorCode":"AU0005","ErrorMessage":"User does not have required permissions to {0} attachments."}` (the `{0}`
    as sent, content type `UPLOAD; charset=utf-8`), and the staged note stays.
  - `DELETE /_api/file/delete/note?noteId=` removes the visitor's own staged upload. Without annotation Delete it
    answers 403 `AU0005` "…to DELETE attachments." and the note stays. With it, it answers 204 and deletes the note.
  - The last upload block writes the file into the staged note when the form stores files in Dataverse, so an
    upload that is never submitted leaves its note with the file. The save writes the file into the same note again
    (an Azure location stores its placeholder there), so no second note is created.
  - A postback re-render keeps the posted `AttachFile_HiddenField_MaxFile`, as an ASP.NET hidden field does, while the
    hint states the current count.
  - A basic form renders `AttachFile_HiddenField_InstanceId` without a value, so `x-ms-form-session-id` is empty.
    The note's content type is `x-ms-file-type`.
  - Without annotation Create on the record (Read only, state-0 runs s0g and s0h) the edit form renders no attach-file
    control, Required does not apply and the form saves with no file. An upload request sent anyway creates no staged
    note. The captures do not separate Create from Append.
  - An upload without a resolvable form or regarding record, such as on an insert form, stays staged in memory until
    the form saves it as a new note.
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
  gives the column (`from` is Sender, `to` ToRecipient, `requiredattendees` RequiredAttendee, and so on), and
  `partners` Chat Participant (12), as a hosted form records it; a posted value for the column is replaced. Another
  column without a party type fails with 501 `FormUserAssociationUnresolved` before any write. As on the hosted site,
  the record create carries the column in its plug-in Target as activityparty entities that name only the contact,
  writes the party rows with the record (no activityparty Create of their own) and adds the activity owner's party
  (Owner, 9) when the record has an owner. A provider that writes through the Web API (the live bridge) sends the
  contact's party as a deep insert of the record create.
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
  status 200. The summary renders as the hosted site renders it: focusable (`tabindex="0"`), its header
  `role="none"` and its list `role="presentation"`, each item linking to its field (`referencecontrolid`). A failed atomic basic-form write also re-renders with escaped posted values and
  `#MessagePanel.alert-danger`; the original error stays in diagnostics. CSRF failures, malformed or forged controls,
  inaccessible pages and errors before the write keep their error status. The JSON endpoint keeps its status and the
  browser reloads the document with the posted values and error panel. Advanced forms keep their inline save-error
  contract.
- **Choices.** When the validators pass, a choices value outside the column's options (its own or its bound global
  choice's) shows Dataverse's own message ("A validation error occurred. The value … is outside the valid range.
  Accepted Values: …") whatever `Site/EnableCustomPluginError` says, and sends no message to the plug-in pipeline. The
  choices control posts its selection as a JSON array of the selected options' metadata: the form stores the option
  values, `[]` clears the column and text that is not such an array answers 500. The control's option metadata lists
  every exported language label of an option, the site's base language first.
- **Request validation.** Every basic and multistep form post is checked before the form handles it, every posted
  text and repeated value included; a post to a form missing from the sources is checked as a whole. A refused post
  re-renders the form with HTTP 200, saves nothing and shows "Request validation has detected potentially dangerous
  input value(s) such as HTML, or script. Please review the input value(s) and try again." in `#MessagePanel`
  (classes `message alert error alert alert-danger`). By default (`Site/DisableFormDataSafeHtmlValidation` absent or
  true, as [Learn](https://learn.microsoft.com/power-pages/configure/basic-forms#request-validation) documents) only a
  script block is refused, on a basic form and on a multistep step alike; other markup, event handlers, `javascript:`
  links and frames included, is stored as posted, as the hosted standard-model re-run shows (session F2, runs s0g, s0h,
  s0r). With that setting false the safe-HTML rule refuses script blocks and event-handler attributes (an `onerror`
  handler is refused and `<p><strong>` saved, runs s0i and s0j); its refusal of `javascript:`, `vbscript:` and
  `data:text/html` URLs, entity-encoded text inside a tag and `iframe`, `object`, `embed` and `frame` elements is
  inferred from Learn and not captured. A field the rich text editor renders follows the same rule as any other field;
  the hosted editor post could not be captured, so this is inferred. With `DisableValidationWebTemplate` true nothing is
  refused. The JSON endpoint does not apply request validation.
- **Rich text columns.** A rich text column renders the rich text editor only when its attribute metadata sets
  Control Style to Code Component; with the editor bound in FormXml alone it renders and posts the plain textarea of
  its column, with the column's maximum length, as on the hosted site, and shell capture asks for no editor assets for
  it. A Web API update stores rich text markup as sent. Two differences from the hosted site are deliberate:
  - With the code component style the hosted portal hosts `MscrmControls.RichTextEditorV2.RichTextEditorControlV2`
    from `/_pcfwebresource`. That bundle is platform code that no export carries, so Mirage renders its local editor
    in its place (native CKEditor when captured, otherwise the compatibility editor) and reports
    `RICHTEXT_HOSTED_V2_CONTROL`.
  - The hosted control reads `/api/data/v9.1/EntityDefinitions(...)` from the page and gets 403 with an empty body.
    Mirage answers the same status from its apps-origin gate, whose body is its JSON refusal (`AppsOriginRequired`);
    that gate is a security boundary of the local runtime and keeps its body.
- **Form reads.** Form pages and saves send the Dataverse reads the hosted form sends, each a portal call of the
  contact with the site's host application user as caller. An edit page sends Retrieve, a RetrieveMultiple of every
  attribute and a one-row RetrieveMultiple; its update save sends a RetrieveMultiple naming the record id before the
  Update and the re-render's Retrieve and RetrieveMultiple; a subgrid's data request sends its rows' RetrieveMultiple.
  A multistep page sends the contact's active session read and three RetrieveMultiple reads of a saved step's record;
  a step save reads the record by id (and Retrieves it) before its Update and reads the session before the session
  Update. The first render of a postback reads nothing, and the form renders the record Mirage reads for it. Before
  the first session row adds the `adx_webformsession` table to local data, a multistep page sends no session read.
  A list's chart data and AI summary stream services answer 400 with no body, as on a hosted Customer Self-Service
  site (the hosted body was not recorded), and a timeline's activity read sends only its tables' RetrieveMultiple.
  Two hosted reads are not reproduced because their queries were not recorded: that site's list sends two
  RetrieveMultiple per grid request where Mirage sends one, and its Edit Case form reads the case with RetrieveMultiple
  only where Mirage sends the edit form's Retrieve. The platform's depth-2 Retrieve after a case Update (a Dynamics 365
  Customer Service plug-in running as SYSTEM) is not sent.
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
  status in one atomic write. Status values need exported state/status metadata; unsupported actions and unresolved
  metadata keep diagnostics. Confirmation, labels and redirects come from the source.
- An action's `FilterCriteria` (a full FetchXML query on the form table, or a bare `<filter>` read as a filter on the
  form table) is evaluated for the record with the visitor's table permissions, at render and again in the action's
  write; live mode evaluates it through the connected portal. An aggregate or grouped criterion, one on another table
  or one that is not valid FetchXML hides the action with `FORM_ACTION_FILTER_UNRESOLVED` and its request answers 403
  `FormActionFilterUnsupported`. The hosted evaluation of a bare filter and of an aggregate criterion is not captured
  (local model; the legacy portal parsed only a full fetch).
  Repeated button IDs across forms dispatch through the button's full WebForms name.
- A basic form `WorkflowAction` shows its **Run workflow** button (label, tooltip and dialog texts from the action and
  the form's `WorkflowDialog` settings) when its filter matches the record. Confirming runs the workflow on the record
  when it is an exported, published, on-demand real-time workflow of the form's table with a trusted local `workflows`
  handler ([Dataverse API](dataverse-api.md)); otherwise the button is absent and `FORM_WORKFLOW_UNRESOLVED` reports
  it. A local runtime with live data or a virtual table never shows it.
- The table-specific basic form actions Microsoft Learn lists run locally on their own table: Close Case
  (`CloseIncidentAction`, with the action's `DefaultResolution` texts, else "Case Closed" and "Case Closed via Web
  Portal"), Resolve Case (`ResolveCaseAction`: its dialog asks for the resolution and its description, both required),
  Reopen Case, Cancel Case, Close as Won, Close as Lost and Set On Hold, plus the legacy portal's Activate Quote
  (`ActivateQuoteAction`: a draft quote becomes state 1, status 2) and Reopen (`ReopenOpportunityAction`: a closed
  opportunity becomes state 0 with the partner portal's Accepted status 100000003, or status 1 when
  `adx_partnercreated` is true; a table without that status refuses with `FormActionStateUnresolved`). Each button posts to the form's own action
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
- Qualify (`QualifyLeadAction`, an open lead) checks Update on the lead and Create on contact, account and
  opportunity, then runs `QualifyLead` as the legacy service does: with every record created, the "US Dollar"
  currency (else the first transaction currency) and the Qualified status 3.
- Update Pipeline Phase (`UpdatePipelinePhaseAction`, an open opportunity) opens a dialog listing the opportunity's
  Sales Stage (`salesstage`) options and a description (labels from the action's `StepNameLabel` and
  `DescriptionLabel`, texts from `UpdatePipelinePhaseDialog`). Its save writes `salesstage` and `stepname` (the
  option's label) and a note on the opportunity, "Updated Pipeline Phase: <step name>" with the description as its
  text, in one write; a missing, empty or non-integer stage, one that is not an option, and a missing, blank or longer
  than 100,000 characters description (the note text limit; the dialog marks it required) are refused (400
  `FormActionPipelinePhaseInvalid`) before any write, and a table
  without Sales Stage options reports `FORM_ACTION_PIPELINE_PHASES_ABSENT`. The dialog and the writes follow the
  legacy portal (local model).
- Lists and subgrids offer the same table-specific actions as row actions (legacy link types 9 to 16 and 19 to 23
  and 25: Close Case, Qualify, Create Order, Create Invoice, Calculate Value, Resolve Case, Reopen Case, Cancel Case,
  Activate Quote, Set On Hold, Close as Won, Close as Lost, Generate Quote, Reopen), shown by the record's state as the
  legacy grid shows them (Resolve and Cancel on an active case, Reopen Case on a closed one, Qualify on an open lead,
  Activate Quote on a draft quote, Create Order on an active quote, Reopen on a closed opportunity, ...). Each posts the
  record reference to the legacy route `/_services/action-<name>/<website>` (Reopen: `/_services/reopen-opportunity/`),
  which checks Write on the record (and Create on the new records' tables) as the legacy service does and runs the same
  write as the form action. Resolve Case asks for the resolution in the grid's resolve dialog; Close Case sends the
  link's default resolution; a Qualify action with `ShowModal` 1 confirms in the grid's qualify dialog
  (`QualifyLeadDialog` texts, else "Qualify Lead" and the legacy confirmation), as does the form's Qualify button.
  Update Pipeline Phase is a form action only: the legacy grid builds its link (ViewConfiguration) but entity-grid.js
  draws no row link for type 24.
- A list or subgrid's record actions are its `ItemActions` followed by its `ExtendedItemActions`, ordered by
  `ActionIndex` (an equal index keeps that order, a missing one comes first), for rendering, row privileges, delete and
  workflow admission. A workflow action (`WorkflowAction` in a PAC export, `CrmEntityFormView-WorkflowAction`) draws
  no row link, in any configured shape, and a list always draws the default **Run workflow** dialog with its body
  HTML-escaped; the grid `WorkflowDialog` and the actions' dialog texts are not drawn (hosted session F2, LIST-01d).
  The action stays the list's own for `/_services/execute-workflow`: Mirage runs only that action on a record the
  visitor can read and write, with the list's signed configuration, and reports `EXECUTE_WORKFLOW_HOSTED_ACCESS`,
  because a hosted site runs any on-demand workflow posted with an anti-forgery token, as its application user, without
  them. `observed.executeWorkflowAccess: any-on-demand` reproduces the hosted service. It does not check the page or list the caller is on: a hosted site also ran the workflow posted from a page without any list (hosted session F2, state-0 runs s0a and s0b, `execute:from-home-no-list`). In both modes a post without a
  token runs nothing and answers 200 with an empty body, and a workflow of another table answers 500 with the Dataverse
  message (`Entity '<table>' With Id = <id> Does Not Exist`).
- A Bootstrap 3 list renders the list template of a Bootstrap 5 list with Bootstrap 3 tokens: div dialogs whose close
  button (`close`, `data-dismiss`, `sr-only`) comes before the title, its own create and delete icons and a
  `form-horizontal` resolve form (hosted session F2). A page control keeps the legacy grid with section dialogs, and an
  authored `{% entitylist id: ..., pp_page_control: true %}{% endentitylist %}` renders nothing, as hosted.
- A basic form with geolocation (`geolocation_enabled`) draws its hidden mapping fields in its map section, the first
  section named `section_map` or ending with `section_map` (the name the form engine looks for, Learn add-geolocation):
  latitude, longitude, address line, neighbourhood with the platform default `adx_location_neighorhood`, city, county,
  state, country, `geolocation_portalcodefieldname` for the postal code, formatted location, and the Bing Maps REST URL
  and key from `Bingmaps/restURL` (default `https://dev.virtualearth.net/REST/v1/Locations/`) and
  `Bingmaps/credentials`. The page loads the Bing Maps control and `/xrm-adx/js/bingmap.js`. The platform's Content Security
  Policy blocks the control, so a post saves the address without latitude and longitude (hosted session F2, LIST-02c).
  The fields' names keep the form view's naming container without the platform's `ctl<n>` index.
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

### Legacy action type coverage

Every action type of the legacy portal's JSON configuration (Adxstudio `ActionSerializationBinder.cs`: the form actions
of `FormActionMetadata.cs` and the grid item and view actions of `GridMetadata.cs`, with the `LinkActionType` codes of
`IViewActionLink.cs`), and where Mirage handles it. Line numbers are those of this release's sources; every row's test
is a local model (`unproven` or `contract`) unless it names a hosted capture.

| Legacy type (link code)                                                                                                                            | Where it applies                                     | Mirage handling                                                                                                          | Test                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `SubmitAction` (26)                                                                                                                                | form                                                 | `lib/platform.mjs:5029` (button), `lib/form-service.mjs:2038` (refused when not configured)                              | `test/native-form-actions.test.mjs` "native action requests re-resolve …" (`FormSubmitNotEnabled`)                          |
| `NextAction` (27), `PreviousAction` (28)                                                                                                           | multistep step; form with auto-generated steps       | `lib/platform.mjs:5058` (step buttons), `lib/platform.mjs:5429` (an action's label and class on auto-generated steps)    | `test/multistep-markup.test.mjs`, `test/auto-steps-http.test.mjs`, `test/form-step-actions.test.mjs`                        |
| `DeleteAction` (4)                                                                                                                                 | form, grid item                                      | `lib/platform.mjs:5128` (form), `lib/native-services.mjs:231` and `:4085` (grid)                                         | `test/list-bootstrap5-markup.test.mjs`, `test-browser/bootstrap5-list.test.mjs`                                             |
| `ActivateAction` (18), `DeactivateAction` (17)                                                                                                     | form, grid item                                      | `lib/native-form-actions.mjs:135`, `lib/platform.mjs:5148`, `lib/native-services.mjs:3882`                               | `test/native-form-actions.test.mjs`                                                                                         |
| `WorkflowAction` (7)                                                                                                                               | form, grid item                                      | `lib/platform.mjs:5202` (form), `lib/native-services.mjs:4229` (execute-workflow); no grid row link (hosted F2 LIST-01d) | `test/basic-form-workflow.test.mjs`, `test/list-workflow-dialog-markup.test.mjs` (observation)                              |
| `CreateRelatedRecordAction` (29)                                                                                                                   | form, grid item                                      | `lib/platform.mjs:5221`, `lib/native-services.mjs:244`                                                                   | `test-browser/form-create-related.test.mjs`                                                                                 |
| `CloseIncidentAction` (9), `ResolveCaseAction` (14), `ReopenCaseAction` (15), `CancelCaseAction` (16)                                              | form, grid item                                      | `lib/native-form-actions.mjs:137-177`, `lib/native-services.mjs:249-256`                                                 | `test/native-form-table-actions.test.mjs`, `test/grid-record-actions.test.mjs`                                              |
| `QualifyLeadAction` (10)                                                                                                                           | form, grid item                                      | `lib/native-form-actions.mjs:282` (`QualifyLead` message, `lib/dataverse-addon-d365.mjs`), `lib/native-services.mjs:250` | `test/native-form-message-actions.test.mjs`, `test/grid-sales-actions.test.mjs`, `test-browser/grid-sales-actions.test.mjs` |
| `ConvertQuoteToOrderAction` (11), `ConvertOrderToInvoiceAction` (12), `CalculateOpportunityAction` (13), `GenerateQuoteFromOpportunityAction` (23) | form, grid item                                      | `lib/native-form-actions.mjs:235-281`, `:324`, `lib/native-services.mjs:251-253`, `:261`                                 | `test/native-form-message-actions.test.mjs`                                                                                 |
| `ActivateQuoteAction` (19), `ReopenOpportunityAction` (25)                                                                                         | form, grid item                                      | `lib/native-form-actions.mjs:190`, `:223`, `lib/native-services.mjs:257`, `:263`                                         | `test/native-form-table-actions.test.mjs`, `test/grid-sales-actions.test.mjs`                                               |
| `SetOpportunityOnHoldAction` (20), `WinOpportunityAction` (21), `LoseOpportunityAction` (22)                                                       | form, grid item                                      | `lib/native-form-actions.mjs:178`, `:200`, `:211`, `lib/native-services.mjs:258-260`                                     | `test/native-form-table-actions.test.mjs`                                                                                   |
| `UpdatePipelinePhaseAction` (24)                                                                                                                   | form only (the legacy grid draws no row link for 24) | `lib/native-form-actions.mjs:315`, `lib/platform.mjs` `pipelinePhaseDialog`                                              | `test/native-form-message-actions.test.mjs`, `test/native-form-table-actions.test.mjs`                                      |
| `DetailsAction` (1), `EditAction` (2)                                                                                                              | grid item                                            | `lib/native-services.mjs:231` (link types), `lib/platform.mjs` grid modals                                               | `test/list-bootstrap5-markup.test.mjs`, `test-browser/bootstrap5-list.test.mjs`                                             |
| `CreateAction` (3)                                                                                                                                 | grid view                                            | `lib/native-services.mjs:415` (view action links)                                                                        | `test/platform.test.mjs`, `test/list-bootstrap5-markup.test.mjs`                                                            |
| `AssociateAction` (5)                                                                                                                              | subgrid view                                         | `lib/native-services.mjs:1015`, `:4151`                                                                                  | `test/form-dialogs-notes.test.mjs`, `test/portal-host-surfaces.test.mjs`                                                    |
| `DisassociateAction` (6)                                                                                                                           | subgrid item                                         | `lib/native-services.mjs:237`, `:4151`                                                                                   | `test/platform-services.test.mjs`                                                                                           |
| `DownloadAction` (8)                                                                                                                               | grid view                                            | `lib/native-services.mjs:241`, `:4191`                                                                                   | `test-browser/grid-download.test.mjs`                                                                                       |
| `SearchAction`                                                                                                                                     | grid view                                            | `lib/platform.mjs:1783` (its tooltip, button label and placeholder replace the search box texts)                         | `test/grid-view-search.test.mjs`                                                                                            |
| `NotSupportedAction` and any other type                                                                                                            | —                                                    | `lib/platform.mjs:5286` (`FORM_ACTION_UNSUPPORTED` diagnostic, no button)                                                | `test/native-form-actions.test.mjs` "native rendering keeps state action-only forms …"                                      |

## Notes and the activity timeline

- **Listed notes.** As in hosted session F2, the notes service (`/_services/entity-notes`) lists only notes whose text
  starts with the `KnowledgeManagement/NotesFilter` prefix (default `*WEB*`). A note without the prefix is not listed,
  also for its author. A `*PRIVATE*` subject is listed only for the contact its subject names. Notes the visitor adds
  through the control (`*WEB*<text>`, subject "Note created on … by <name> [contact:<id>]") are listed with that name,
  the text without the prefix and Edit and Delete; another note shows its creator's name and no toolbar (hosted F2
  notes runs a, b, s0k and s0l). The service reads every page of the record's notes, with only the columns it shows
  (no attachment bodies), up to 50,000 notes of one record (the rows are held to order and count them): a record with
  more answers 503 `NotesRowLimitExceeded` with a diagnostic (the activity timeline likewise,
  `TimelineRowLimitExceeded`). The portal Web API applies no notes filter: `$expand` of a record's notes and a single
  read return plain and `*PRIVATE*` notes alike. A note download
  (`/_entity/annotation/<id>`) names the file as `attachment;filename*=UTF-8''<name>`. A signed-in reader's download
  is cached with `private, max-age=3600` and carries the note's `Last-Modified`.
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
  table (Learn, configure-notes). Its Add control posts to `EntityActivity/AddPortalComment`. The visitor needs Create and Append on
  `adx_portalcomment` and AppendTo on the record, otherwise the control is hidden and the service answers 403. The
  service creates the comment (text in `description`, no subject, direction Incoming, regarding the record, owned by
  the record's owner) with the contact as Sender, the owner as To Recipient (not for a team) and the Owner and
  Regarding parties, then updates it to Completed / Received; both writes are portal calls of the contact, and a chosen
  file becomes a note on the comment. The messages and parties are as a hosted Customer Self-Service site records them
  (session F3); the route and the permission checks follow the open-sourced portal code. A later read of the comment
  by a platform step is not simulated, and the timeline does not list activity attachments.
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
  port. A signed-in contact's session backed by its `adx_webformsession` row is kept until an explicit data reset, as
  the hosted site keeps the rows; anonymous sessions, also those with a row, and sessions without a row are bounded to
  1,000, oldest first. A stale concurrent save must reload before it can continue.
- A signed-in contact's session is also an `adx_webformsession` row, as on the hosted site. The first saved step
  creates the row after the step's record and moves it to the next step in the same request (Create, then Update);
  each later step updates it after its record, and completion deactivates it (`statecode` 1) with the SetState
  message's own Update, which has no PreValidation stage. The row carries the contact, the user identity name (the
  portal user's `userName`), the visitor's address, `adx_currentstepindex`, the `adx_stephistory` JSON and the
  primary record; in the enhanced data model it also names the form and current step components.
- An anonymous visitor's session is a row too, as hosted session F4 recorded it on a private site: from its first
  saved step it carries a GUID in `adx_anonymousidentification`, the visitor's address, the step index, the step
  history and the record, with no contact and no user identity name, and completion deactivates it. The GUID is
  derived one way from the browser's visitor cookie, which its first page load received, so creating the session sets
  no cookie and the row never holds the cookie's value. The same browser resumes; another browser starts at the first
  step and creates no row until it saves one. A request without the visitor cookie, whose save starts a new visitor,
  gets a bounded session and no row, so cookieless clients cannot grow the table.
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

A list include with `isModern: 'true'` renders what a hosted page holds, `pages-native-container` with a
`pages-grid` naming the list (`list-id`), and the grid makes the hosted grid's calls: `GET
/_services/portal/GetListViewConfiguration/<list>` (`filterenabled`, `getDataUrl`, `getAiInsightsUrl`, `layouts`,
`defaultViewId`, `modalFormTemplateUrl`; the layouts without their FetchXML, layout XML and view name, indented with
CRLF), then the `entity-grid-data` pages with `odataFilterQuery` and `nlSearchFilter`, loading the next page (the
list's page size) as it scrolls (hosted session F2, LIST-01d). The hosted page draws the grid with Microsoft's
data_grid control from `content.powerapps.com/resource/powerappsportal/controls/data_grid/<build>/` (its
`locales/en-US/GridTranslation.json` among the page's requests), which Mirage does not serve: a local adapter
(`data-mirage-component="modern-list"`) draws the grid inside the container; it posts only to a `/_services/` route
of the portal and opens forms only from the portal's modal form route, refusing other URLs in the configuration. The
configuration route answers only for a list a source includes as a modern list the adapter serves and a visitor who may
read its table; otherwise it answers 404 with an empty object, or 403 `{"AccessDenied":true}` to a visitor who may not read the table, which the grid shows as access denied: inferred refusals, since a hosted site's answer to an anonymous visitor or for another list is not captured. Views and view selector, search,
filters, sorting and the details, edit, create, delete and download actions come from the classic grid engine; a URL
target opens its page and a basic form opens in a dialog over the modal form route. The import diagnostic
`MODERN_LIST_LOCAL_MARKUP` names these includes. A workflow action draws nothing, as hosted; other configured actions
(associate, disassociate, activate, deactivate, create related record) are absent and report
`MODERN_LIST_FEATURES_UNSERVED` with the blocking row `portal:modern-list/<list>`. A map list renders the modern grid
of its view, as hosted, and so does a calendar or dataset code component list: the page shows no calendar and mounts no
code component.

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
- `$pages.agent.SendActivity(schema, activity, onResponse, onError)` makes the requests a hosted site makes. It reads
  `GET /_services/agent/BotConfiguration`, which lists the agents whose Bot Consumer grants one of the visitor's web
  roles; when it lists none named `schema`, the error callback receives "Invalid bot schema name or access denied.
  Please check the bot schema name and try again". For a listed agent it posts `/_services/auth/portalusertoken`
  (200 `application/jwt`, signed with the implicit grant key) and requests the agent's Direct Line token at
  `/powervirtualagents/botsbyschema/<schema>/directline/token`. A missing or failed token gives "Something went wrong
  while creating direct line connection: Please try again". `POST /_api/agents/<schema>/activities` answers 400
  `9004010A`, as on a hosted site.
- Mirage holds no Copilot Studio agent: the agent's environment, tenant and template live in Copilot Studio, not in
  the export, so `BotConfiguration` answers `[]`. A simulator endpoint mock or a trusted pack endpoint stands in for
  the agent. It answers `/_services/agent/BotConfiguration` with the configuration (each entry has `botSchemaName`),
  the token path with `{ token, conversationId }`, and `POST /v3/directline/conversations/<conversationId>/activities`
  with the reply activity or an array of them. The client sends every request to the page's own origin, with the
  verification token, and passes each reply to the response callback. The hosted site gets its token from the
  environment's `environment.api.powerplatform.com` host and talks to Direct Line; Mirage never contacts either.
