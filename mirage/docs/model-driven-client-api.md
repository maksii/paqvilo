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
type. Unsupported actions, parameters, rules and missing exported libraries leave
commands disabled with an explanation.

## Bounded client API

| Area | Supported baseline |
| --- | --- |
| Attributes | Get/set values, initial values, dirty state, metadata-derived type, required level, choice options/text, add/remove/fire OnChange, attribute control collection |
| Controls | Get/set visibility, disabled state and label; focus; notifications; bound attribute |
| Form data | Entity ID/name/primary name, attributes, dirty state, add/remove OnSave, save and refresh |
| Form UI | Create/existing form type, control collection, form notifications, close |
| Navigation | Alert and confirmation dialogs; opening another imported local form |
| Global context | Local client URL, Web client and online state |
| WebApi | Retrieve one/multiple records and scalar create/update/delete through the local staff pipeline |

WebApi multiple-record reads use table scope rather than the currently selected
saved view. Queries support `$select`, `$top`, one-column `$orderby`, and simple
`and` comparisons (`eq`, `ne`, `gt`, `ge`, `lt`, `le`, including `eq/ne null`).
Continuation paging, `$expand`, FetchXML and query functions are unsupported in
this browser adapter. They can be tested through the separate Dataverse HTTP API.

WebApi navigation-property writes using `@odata.bind` are explicitly rejected
before a record request. Use a supported form lookup control for local form edits,
or the Dataverse HTTP API for integration tests requiring navigation bindings.
The browser adapter does not guess navigation-property names from column names.

Saving recursively from an active form lifecycle handler is rejected; finish the
event before saving. Ribbon commands may call `PrimaryControl.data.save()`.
Quick-create forms, separate form windows, unsupported client APIs and unsupported
event parameter expressions fail visibly. This baseline does not claim complete
Xrm, PCF, modern-command or client scripting compatibility.

Client methods cannot enable writes denied by metadata, source ownership or staff
field security. Held form contexts are revoked when their form is disposed or the
staff identity changes. Portal contact sessions remain separate from staff
identities and this shell does not inject its client API into Power Pages.
