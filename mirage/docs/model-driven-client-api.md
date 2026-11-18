# Model-driven client API

Mirage runs explicitly trusted JavaScript web resources from the selected local Solution sources. Set
`modelDriven: { trustedExtensions: true }` in the project (or under the catalogue target's `mirage` settings); it is
off by default. The same switch gates form libraries, JavaScript ribbon commands and standard PCF components. Setup,
resource import and PCF hosting are in [Solution customizations](model-driven-customizations.md).

Trusted code runs in your local browser with the current local staff session. It is not a sandbox: the shell's CSP
allows same-origin scripts and connections. `getClientUrl()` is the loopback runtime, never the online organization.
No library is resolved online and no expression is evaluated.

Every client object is bounded: reading a member that is not listed below throws
`Mirage client API does not support <path>.<member>.`, so a script fails visibly instead of receiving `undefined`.

## Events and commands

- **Form libraries** load in exported order. Enabled OnLoad, attribute OnChange and OnSave handlers receive the
  execution context when the export asks for it, then the exported parameters. Parameters must be primitive constants;
  JavaScript expressions are rejected. Promise-returning handlers are awaited.
- **OnLoad** runs once per loaded form, not per tab switch. A save or `data.refresh()` reloads the open form in place:
  only handlers added from script run again, with the new load state.
- **OnChange.** `setValue` marks the field dirty without firing OnChange; `fireOnChange()` fires it.
- **OnSave.** `preventDefault()` cancels the local save, including Save & Close. Saving from inside an active
  lifecycle handler rejects; finish the handler first.
- **Ribbon commands.** Classic JavaScript actions support `PrimaryControl`, `SelectedControlSelectedItemIds`,
  `SelectedEntityTypeName` and primitive parameters, and the rules `FormStateRule`, `EntityRule`, `ValueRule` and
  `SelectionCountRule`. Modern AppAction exports support a JavaScript web resource with the `PrimaryControl` parameter;
  an explicit zero-sequence modern form action appears before the standard form actions. Unsupported actions,
  parameters, rules and missing libraries leave the command disabled with the reason. `$LocLabels:` labels use the
  imported Solution LCID, falling back to the first exported label.
- **Inactive records.** A two-state row in state 1 opens as disabled form type 4 with Save hidden. A script can call
  `setDisabled(false)`, `setValue` and save when source and staff permissions allow; form-state rules see `Disabled`.
  Form XML disabling is the initial presentation only: scripts can unlock a control or set and save its value, but
  never enable a write that metadata, source ownership or staff field security forbid.

## Supported members

| Object              | Members                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Execution context   | `getFormContext`, `getEventSource` (the changed attribute, else `data.entity`), `getEventArgs`, `getDepth`                                                                                                                                                                                                                                                         |
| Event arguments     | OnLoad: `getDataLoadState` (1 initial, 2 after save, 3 after refresh). OnSave: `getSaveMode`, `preventDefault`, `isDefaultPrevented`, `preventDefaultOnError`, `shouldPreventDefaultOnError`, `disableAsyncTimeout`, `shouldDisableAsyncTimeout`. OnChange: `getEventArgs()` returns `undefined`                                                                   |
| `formContext`       | `getAttribute(name?)`, `getControl(name?)`, `data`, `ui`                                                                                                                                                                                                                                                                                                           |
| Attribute           | `getName`, `getValue`, `getInitialValue`, `setValue`, `getFormat`, `getIsDirty`, `getAttributeType`, `getOptions`, `getOption`, `getText`, `getRequiredLevel`, `setRequiredLevel`, `getSubmitMode`, `setSubmitMode`, `addOnChange`, `removeOnChange`, `fireOnChange`, `controls`; numbers add `getMin`, `getMax`, `getPrecision`; text and memo add `getMaxLength` |
| Control             | `getName`, `getAttribute`, `getControlType`, `getParent`, `getDisabled`, `setDisabled`, `getVisible`, `setVisible`, `getLabel`, `setLabel`, `setFocus`, `setNotification`, `clearNotification`; Choice and Choices controls add `getOptions`, `addOption`, `removeOption`, `clearOptions`                                                                          |
| `data`              | `entity`, `getIsDirty`, `isValid`, `save(saveOptions?)`, `refresh(save?)`, `addOnLoad`, `removeOnLoad`                                                                                                                                                                                                                                                             |
| `data.entity`       | `getId`, `getEntityName`, `getPrimaryAttributeValue`, `getIsDirty`, `isValid`, `attributes`, `addOnSave`, `removeOnSave`, `save(mode?)`                                                                                                                                                                                                                            |
| `ui`                | `controls`, `getFormType` (1 create, 2 existing, 4 disabled inactive), `formSelector` (`getCurrentItem`, `items`; an item has `getId`, `getLabel`), `tabs` (`getName`, `getLabel`, `setLabel`, `getVisible`, `setVisible`, `sections`), `setFormNotification`, `clearFormNotification`, `close`                                                                    |
| Tab section         | `getName`, `getLabel`, `setLabel`, `getParent`, `getVisible`, `setVisible`                                                                                                                                                                                                                                                                                         |
| Collections         | `get(name \| index \| predicate)`, `getLength`, `forEach`                                                                                                                                                                                                                                                                                                          |
| `Xrm.Page`          | The current `formContext`                                                                                                                                                                                                                                                                                                                                          |
| `Xrm.Navigation`    | `openAlertDialog`, `openConfirmDialog`, `openUrl` (http(s) only, new window), `openForm` (another imported local form, including `formId`), `navigateTo`                                                                                                                                                                                                           |
| `Xrm.App.sidePanes` | `createPane`, `getAllPanes`, `getPane`, `getSelectedPane`, `state` (0 collapsed, 1 expanded); a pane can `navigate`, `select` and `close`                                                                                                                                                                                                                          |
| `Xrm.Utility`       | `getPageContext()` (`input`: `entityrecord` with table, record ID and form ID, or `entitylist` with table and view ID), `getGlobalContext()`                                                                                                                                                                                                                       |
| Global context      | `getClientUrl`, `getVersion` (`9.2.0.0`), `client` (`getClient`: `Web`, or `Mobile` offline; `getClientState`: `Online`/`Offline`; `isOffline`), `userSettings` (`userId`, `userName`, `languageId`, `isRTL`, `roles`, `securityRoles`, `transactionCurrency`, `transactionCurrencyId`, `dateFormattingInfo`, `getTimeZoneOffsetMinutes`)                          |
| `Xrm.WebApi`        | `retrieveRecord`, `retrieveMultipleRecords`, `createRecord`, `updateRecord`, `deleteRecord`, `execute`, `executeMultiple`, `isAvailableOffline`, `online`, `offline`                                                                                                                                                                                               |

### Attributes and controls

- Only columns bound on the selected form (body, header and footer controls) are attributes; `getAttribute` and
  `getControl` return `null` for any other column, including an unbound primary key. Header and footer controls are
  `header_<column>` and `footer_<column>`; they are not rendered, so their getters return the column defaults and their
  setters throw. Business process flow stage columns are not attributes.
- `getMin`, `getMax`, `getPrecision` and `getMaxLength` read imported `minValue`, `maxValue`, `precision` and
  `maxLength`; a missing value throws the unsupported-API error instead of guessing. Choice attributes have no numeric
  range methods. An exported empty option list still reports `optionset`.
- Multiselect attributes return numeric arrays from `getValue`, label arrays from `getText`, and report
  `multiselectoptionset`.
- `addOption({ text, value }, index?)` requires numeric `value` (otherwise a `UciError`), `removeOption(value)` and
  `clearOptions()` change only the offered options: not the column value, OnChange or the exported metadata, and
  `attribute.getOptions()` keeps returning the source options. Changes survive tab re-rendering. They apply to the
  calling control, and to every control of the column when a PCF control binds it. Calling them on a read-only text
  control throws the unsupported-API error.
- `formSelector.items.get(id)` accepts GUIDs regardless of casing and braces. Switching forms from a script is not
  supported (`item.navigate` throws).
- `data.entity.isValid()` checks visible, enabled controls against their source-derived constraints (requiredness,
  number bounds) and active control notifications. `data.isValid()` also reports native field validation and sets
  `aria-invalid`. Neither saves nor clears dirty state. Header/footer fields, unsupported controls and
  `attribute.setIsValid` are outside this validator.

### Saving

| Call                               | OnSave `getSaveMode()`         | Result                                                                |
| ---------------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| `data.save(saveOptions)`           | `saveOptions.saveMode`, else 1 | Promise of `savedEntityReference` (`entityType`, braced `id`, `name`) |
| `data.entity.save()`               | 1                              | Same                                                                  |
| `data.entity.save('saveandclose')` | 2                              | Saves, then closes                                                    |
| `data.entity.save('saveandnew')`   | 59                             | Returns nothing; saves, then opens a blank create form                |

- A refused save rejects with `{ errorCode, code, message, title }`: 2200000005 when OnSave prevents it, 2200000007
  when a required column is empty, 2200000003 when another save is in flight (the first one still resolves). The form
  stays dirty.
- A save the staff user cannot make, or one whose changes cannot be carried locally, rejects with an `Error` whose
  `code` is `SaveDenied` or `SaveUnsupported`. A failed server write rejects.
- After `saveandnew`, the old context keeps answering with its record ID, form type 2 and saved values, refuses every
  call that would change the form, and keeps `Xrm.WebApi`. A host that cannot open a new record refuses the mode.
- Ribbon commands may call `PrimaryControl.data.save()`. Held form contexts are revoked when their form is disposed
  or the staff identity changes (not by a save); revoked members reject or throw.

### Navigation and side panes

`navigateTo` opens `entityrecord`, `entitylist` and `webresource` pages inline (`target: 1`) or as a dialog
(`target: 2`, `position: 1` center or `2` side). A dialog resolves when closed; a create-mode record resolves with
`savedEntityReference` once saved, other pages with no value.

- `pageType: 'dashboard'` opens one of the app's Solution dashboards by `dashboardId` (or the first), and rejects with
  `DashboardPageUnsupported` when the sources hold none.
- `pageType: 'custom'` (`name`, optional `entityName` and GUID `recordId`) opens the headless host of the Canvas app
  with that logical name ([Canvas apps](canvas-apps.md)).
- Record inputs keep `formId`, `tabName` and create defaults; a named visible tab is selected and focused, an
  unavailable tab is an error, and a `formId` outside the loaded main forms is refused with `FormUnavailable`.
  Existing-record navigation ignores create defaults.
- List inputs accept imported `savedquery` views; a missing view reports its limitation rather than switching to the
  default. `userquery` personal views reject with `PersonalViewUnsupported`.
- Panes stay open across in-app navigation until closed. `getPane(id).navigate(input)` reuses a pane; `select()`
  expands it and clears its badge unless `keepBadgeOnSelect` is true. `isSelected: false` keeps the current selection.
  `hideHeader` hides title and close button; `canClose: false` hides only the button. Closing the selected pane
  selects the last visible one; a closed pane refuses navigation with `PaneClosed`. `hidden` and `title` apply; badges
  are kept as state but not drawn, and inactive pane content stays mounted (no `alwaysRender` lifecycle).

### Web API

- Reads use the organization query engine as the current staff user, also when the public Dataverse listener is off.
  `retrieveMultipleRecords` queries the table, not the selected view, and returns `entities`, an optional `nextLink`
  and an optional FetchXML paging cookie. `$select`, `$filter`, `$orderby`, `$expand`, FetchXML and continuation paging
  behave as in the local Dataverse API. Options must start with `?`; a continuation URL must target this runtime and
  table. `maxPageSize` is 1–5000. Records keep lookup properties such as `_parentid_value`.
- Writes accept scalar values, comma-separated multiselect values and `@odata.bind` lookups to imported single-valued
  relationships with exact entity-set names (`/entityset(guid)` or `null`). Unknown relationships, conflicting values
  and external URLs fail before any request. Many-to-many associations and deep inserts are unsupported.
- `Xrm.WebApi.offline` reads and writes the staff session's offline copy of the app's mobile offline profile
  (capability record `model-driven:offline`); the server refuses its CRUD while online. While offline, `Xrm.WebApi`'s
  record methods use that copy.

## Xrm.WebApi.execute

`execute` reads `request.getMetadata()`:

| `operationType` | Sends                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 0               | An action (POST), bound to `request.entity` when `boundParameter` is `entity`                                            |
| 1               | A function (GET with `@p1…` aliases; entity parameters become `@odata.id` references, enumerations use their `typeName`) |
| 2               | `Create`, `Retrieve`, `Update`, `Delete`, `Associate` or `Disassociate`                                                  |

The organization's Web API answers as the selected staff user (the local administrator when none is selected), so custom
APIs, custom actions and the standard messages it implements behave as through the Dataverse API, also when its listener
is off. The response has `ok`, `status`, `statusText`, `headers`, `url`, `json()` and `text()`. A failure rejects with
`message`, `status` and, for Dataverse codes, `errorCode`; an undeclared operation rejects with its 404.
`executeMultiple` (1–1000 requests) runs top-level requests in order; a nested array is one `$batch` change set that
commits or rolls back together and rejects with the failing request's error. Requests go to `POST /_apps/api/webapi`
(see [routes](model-driven-apps.md#routes)).

## Staff context

The host builds one staff context on the server for the selected staff user and serves it with the staff session.
The PCF context (`userSettings`, `formatting`) and `Xrm.Utility.getGlobalContext().userSettings` read only that object.

| Value      | Source                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| Roles      | The user's role assignments (role IDs)                                                                                    |
| Language   | `usersettings.uilanguageid`, else the organization `languagecode`                                                         |
| Locale     | `usersettings.localeid`, else the organization `localeid`; an unknown LCID formats as en-US with `localeResolved: false`  |
| Time zone  | `usersettings.timezonecode`; UTC without a usersettings row                                                               |
| Currency   | The user's `transactioncurrencyid`, else the organization base currency                                                   |
| Formatting | The locale's number and date formats with the user's overrides; the short date keeps a four-digit year (en-US `M/d/yyyy`) |

A staff user reads and updates its own row at `/api/data/v9.2/usersettingscollection(<systemuserid>)` (GET, and PATCH
of `uilanguageid`, `localeid`, `timezonecode`, the format columns and `transactioncurrencyid@odata.bind`); another
user's row answers 403. Page scripts reach it with `Xrm.WebApi.retrieveRecord` and `updateRecord` on `usersettings`, or
`Xrm.WebApi.execute` `Retrieve` and `Update`; other organization tables that the Solution does not import stay out of
reach. The row lives in the private runtime table `usersettings`, and seeded rows win on reset.
Without a readable staff session, scripts and components get the anonymous context: no user or roles, language 1033,
UTC, no currency and no formatting information.

## Page markers and the Web API on the app address

The shell marks what tools such as Lense X-ray read: each form section, field (container `data-id="<control>"`,
control `data-id="<control>.fieldControl-<type>"`), tab (`tablist-<tab>`), subgrid (`dataSetRoot_<control>`) and each
grid header and cell with its column name.

Pages of the app (`/main.aspx` and `/_apps/`, by same-origin referrer) may `GET` and `HEAD` `/api/data/v9.x/` on the
apps address as the staff user (or local administrator), through the same in-process Web API as `Xrm.WebApi`. Other
methods are refused with `AppAddressReadOnly`; other pages, such as a Power Pages page on a shared address, get no Web
API there. Programs use the Dataverse Web API listener with a token. Portal contact sessions stay separate from staff
identities, and this client API is never injected into Power Pages.

Quick-create forms, separate form windows and any member not listed here are unsupported.
