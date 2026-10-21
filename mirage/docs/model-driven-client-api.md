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
| Attributes | Get/set values, initial values, dirty state, metadata-derived type, required level, choice options/text, add/remove/fire OnChange, attribute control collection |
| Controls | Get/set visibility, disabled state and label; focus; notifications; bound attribute |
| Form data | Entity ID/name/primary name, attributes, dirty state, add/remove OnSave, save and refresh |
| Form UI | Create/existing/disabled inactive form type, control collection, form notifications, close |
| Navigation | Alert and confirmation dialogs; opening another imported local form, including its app-owned `formId` |
| Global context | Local client URL, selected staff ID/name, Web client and online state |
| WebApi | Retrieve one/multiple records, scalar and multiselect writes, imported single-valued lookup bindings, create/update/delete through the local staff pipeline |

WebApi reads use the canonical organization query engine and current staff
identity, including when the public Dataverse HTTP listener is disabled.
Multiple-record reads use table scope rather than the currently selected saved
view. `$select`, `$filter`, `$orderby`, `$expand`, FetchXML and continuation
paging have the same supported semantics as the local Dataverse record API.
`retrieveMultipleRecords` returns `entities`, an optional `nextLink`, and an
optional FetchXML paging cookie. A continuation URL must belong to this local
runtime and imported table; callers can also pass its query string. Record
reads preserve native lookup properties such as `_parentid_value`.
The same record methods are available through `Xrm.WebApi.online`. Unsupported
execution/action APIs and offline APIs still fail explicitly.

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
