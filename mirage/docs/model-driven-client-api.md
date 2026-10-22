# Model-driven client extension baseline

Mirage can execute explicitly trusted JavaScript WebResources from the selected
local Solution sources. Configure top-level `modelDriven: { trustedExtensions: true }`
in a Mirage project, or put it under the catalogue target's `mirage` settings.
The default is disabled. The same trust setting gates
form libraries, JavaScript ribbon commands and supported standard PCF components.

Treat this as running project code in your local browser. It is not a JavaScript
sandbox. The shell allows same-origin scripts and connections through its content
security policy, and its supplied client APIs use the current local staff session.
The client URL returned to scripts is the loopback runtime, never the online
organization. No online library resolution or expression evaluation is performed.

## Exported events and commands

Form libraries load in exported order. Enabled OnLoad, attribute OnChange and
OnSave handlers receive the exported execution-context argument when configured.
Promise-returning handlers are awaited. OnLoad runs once per loaded form, rather
than on every tab switch. `setValue` marks the field dirty without implicitly
firing OnChange; `fireOnChange` triggers it explicitly. OnSave `preventDefault`
cancels the local record save, including Save & Close.

The supported execution context exposes `getFormContext`, `getEventSource`,
`getEventArgs` and `getDepth`. Save arguments expose `getSaveMode`,
`preventDefault` and `isDefaultPrevented`. Exported handler parameters must be
primitive constants; JavaScript expressions are rejected.

Classic ribbon JavaScript actions support PrimaryControl, selected record IDs,
selected entity name and primitive parameters. The supported rules are
FormStateRule, EntityRule, ValueRule and SelectionCountRule. Modern AppAction
exports support a JavaScript WebResource and the captured PrimaryControl parameter
type. An explicit zero-sequence modern form action appears before standard form
actions; other command positions retain their fallback placement. Unsupported actions, parameters, rules and missing exported libraries leave
commands disabled with an explanation.

## Bounded client API

| Area | Supported baseline |
| --- | --- |
| Attributes | Get/set values, initial values, dirty state, metadata-derived type, required level, choice options/text, add/remove/fire OnChange, attribute control collection. Only the columns bound on the selected form (body, header and footer controls) are attributes: `getAttribute(name)` and `getControl(name)` return `null` for any other column, including the primary id when it is not on the form. Header and footer columns have the controls `header_<column>` and `footer_<column>`; they are not rendered, so their getters answer the column defaults and their setters throw a named error. Business process flow stage columns are not attributes |
| Controls | Get/set visibility, disabled state and label; focus; notifications; bound attribute |
| Form data | Entity ID/name/primary name, attributes, dirty state, add/remove OnSave, save and refresh |
| Form UI | Create/existing/disabled inactive form type, control collection, form notifications, close |
| Navigation | Alert and confirmation dialogs; `openForm` (another imported local form, including its app-owned `formId`); `navigateTo` for `entityrecord`, `entitylist` and `webresource` pages, inline (`target: 1`) or as a dialog (`target: 2`, `position: 1` center or `2` side). A dialog resolves when it closes; a record opened in create mode resolves with `savedEntityReference` once it was saved, and every other page resolves with no value. `pageType: 'dashboard'` opens one of the app's Solution dashboards by `dashboardId`, or the app's first dashboard when no id is given, inline or as a dialog, and rejects with `DashboardPageUnsupported` when the app's sources hold no such dashboard; `pageType: 'custom'` (a `name`, optional `entityName` and `recordId`, a GUID) opens the headless canvas host of the canvas app with that logical name (see [Canvas apps](canvas-apps.md)) |
| App | `Xrm.App.sidePanes`: `createPane`, `getAllPanes`, `getPane`, `getSelectedPane`, `state`; a pane `navigate`s to the same page types, `select`s and `close`s. Panes stay open across in-app navigation until closed. `state` reads back the value set (0 collapsed, 1 expanded) |
| Global context | Local client URL, Web client, client and online state from the session's offline mode (`getClient()` `Web`, or `Mobile` while offline; `getClientState()` `Online` or `Offline`; `isOffline()`), and `userSettings` from the [staff context](#staff-context): `userId`, `userName`, `languageId`, `isRTL`, `roles`, `securityRoles`, `transactionCurrency`, `transactionCurrencyId`, `dateFormattingInfo`, `getTimeZoneOffsetMinutes()` |
| WebApi | Retrieve one/multiple records, scalar and multiselect writes, imported single-valued lookup bindings, create/update/delete through the local staff pipeline, plus `execute` and `executeMultiple` (also on `Xrm.WebApi.online`) |

WebApi reads use the canonical organization query engine and current staff
identity, including when the public Dataverse HTTP listener is disabled.
Multiple-record reads use table scope rather than the currently selected saved
view. `$select`, `$filter`, `$orderby`, `$expand`, FetchXML and continuation
paging have the same supported semantics as the local Dataverse record API.
`retrieveMultipleRecords` returns `entities`, an optional `nextLink`, and an
optional FetchXML paging cookie. A continuation URL must belong to this local
runtime and imported table; callers can also pass its query string. Record
reads preserve native lookup properties such as `_parentid_value`.
The same record methods are available through `Xrm.WebApi.online`.

WebApi navigation-property writes using `@odata.bind` resolve imported
single-valued relationships and exact target entity-set names from the local
catalogue. Values must be `/entityset(guid)` paths or `null` to clear the lookup.
Unknown relationships, conflicting values and external URLs fail before a record
request. The browser adapter does not guess navigation-property names or plural
entity sets. Many-to-many associations and deep inserts remain unsupported.

Multiselect form attributes expose numeric arrays and label arrays through
`getValue` and `getText`, and report `multiselectoptionset` as their type. WebApi
writes accept the native comma-separated choice representation; the shell
normalizes selections before the shared Dataverse pipeline validates them.

Saving recursively from an active form lifecycle handler is rejected; finish the
event before saving. Ribbon commands may call `PrimaryControl.data.save()`.
Quick-create forms, separate form windows, unsupported client APIs and unsupported
event parameter expressions fail visibly. This baseline does not claim complete
Xrm, PCF, modern-command or client scripting compatibility.

Client methods cannot enable writes denied by metadata, source ownership or staff
field security. Held form contexts are revoked when their form is disposed or the
staff identity changes. Portal contact sessions remain separate from staff
identities and this shell does not inject its client API into Power Pages.

Form XML control disabling defines the initial presentation. Explicit client
scripts can unlock that control or set its attribute value and save while the
control stays disabled. Column update metadata, ownership and staff permissions
continue to govern each write.

An inactive two-state record initially exposes disabled form type 4. Its default
disabled presentation permits an explicit client `setDisabled(false)`, attribute
`setValue` and SDK save when source and staff permissions allow the write. The
standard Save buttons remain hidden. Form-state ribbon rules distinguish this
disabled form from an editable existing record.

## Xrm.WebApi.execute

`Xrm.WebApi.execute` reads `request.getMetadata()`: operation type 0 sends an action
(POST, bound to `request.entity` when `boundParameter` is `entity`), type 1 a function
(GET with `@p1…` parameter aliases; entity parameters become `@odata.id` references and
enumerations use their `typeName`), and type 2 a `Create`, `Retrieve`, `Update`, `Delete`,
`Associate` or `Disassociate` request. The organization's own Web API answers as the
selected staff user (local administrator when none is selected), so custom APIs, custom
actions and the standard messages the organization implements behave as through the
Dataverse API, including when its HTTP listener is disabled. The response has `ok`,
`status`, `statusText`, `headers`, `url`, `json()` and `text()`; a failure rejects with
`message`, `status` and, for Dataverse codes, `errorCode`. An operation the organization
does not declare rejects with its 404 error. `executeMultiple` runs top-level requests in
order; a nested array is one `$batch` change set that commits or rolls back as a whole.
A change set that fails rejects with the failing request's error: `message`, `status`
and, for a Dataverse code, `errorCode` (for example 0x80044331 for a column length).
`Xrm.WebApi.offline` reads and writes the staff session's offline copy of the app's mobile
offline profile (capability record `model-driven:offline`); the server refuses its create,
read, update and delete while the session is online, and while the session is offline
`Xrm.WebApi`'s own record methods use that copy. Online requests go to
`POST /_apps/api/webapi` (see [model-driven apps](model-driven-apps.md#routes)).

## Staff context

The model-driven host builds one staff context on the server for the selected staff user
and serves it with the staff session (`current.context`). The PCF context
(`userSettings`, `formatting`) and `Xrm.Utility.getGlobalContext().userSettings` read only
that object. Security roles are the user's role assignments (role ids). The language is
the user's `usersettings.uilanguageid`, else the organization `languagecode`; the locale is
`usersettings.localeid`, else the organization `localeid`. Locales resolve through the
Power Pages language catalogue; another LCID formats with the en-US culture and reports
`localeResolved: false`. The time zone is `usersettings.timezonecode` (UTC without a
usersettings row). The currency is the user's `transactioncurrencyid`, else the
organization base currency. Number and date formatting information comes from that locale,
with the user's decimal, group, date and time format overrides; the short date pattern keeps
the .NET four-digit year (en-US `M/d/yyyy`). A staff user reads and updates its own row
through `/api/data/v9.2/usersettingscollection(<systemuserid>)` (GET, PATCH of `uilanguageid`,
`localeid`, `timezonecode`, the format columns and `transactioncurrencyid@odata.bind`), a
registered organization extension; the row lives in the private runtime table
`usersettings`, seeded rows win on reset, and another user's row answers 403. When the
staff session cannot be read, components and scripts get the documented anonymous context:
no user, no roles, language 1033, UTC, no currency and no formatting information.
