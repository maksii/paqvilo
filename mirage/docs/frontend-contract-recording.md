# Recording frontend contracts

`paqvilo/mirage/testing` exports serializable model-driven probes:
`captureModelDrivenContract(input, form)`, `captureModelDrivenControlContract(input, form)`,
`captureModelDrivenPresentationContract(input, form)` and `captureModelDrivenDirtyContract(input, form)`.
Run them against explicitly selected disposable fixture forms through an authorized, signed-in browser.
They capture bounded attribute, collection, event, control-option and validity results without saving.
The attribute probe restores field values, required levels and submit modes in cleanup; the control probe
changes options and invalid draft values and requires a disposable draft. Close that draft without saving.
Presentation and dirty-state probes also require a disposable draft; they change selected labels, notifications
and authored field values. Keep new-form defaults distinct from saved-record baselines.

Pass the same authored plan and function source to the native and local browser contexts. A plan names
fixture fields and the cases to execute; missing attributes fail rather than silently reducing coverage.
Wait for the selected tab and all required controls to render before running control probes. Reproduce
the native results in two independently opened forms and compare every result exactly. Keep raw native
captures, source plans, screenshots and environment identities in the external project's ignored evidence
directory. Public fixtures must use invented schemas and authored values.

Save-mode qualification requires a separate authorized disposable-record flow. Verify actual server
readbacks and backend Update Targets, including a second save on a clean form, then delete owned records
and verify absence. Getter results alone do not establish which columns were submitted.

For Power Pages, publish only owned fixture templates in the external project. Read every source back,
require HTTP 200 and all output markers, then repeat the native page load and compare literal fragments.
Retain include-template context and explicit site-observed settings in local replay. A sign-in response,
missing marker or failed source readback is a failed capture. Restore or document owned components and
close only browser tabs and runtimes started by the recorder.

For rendered forms, `capturePowerPagesControlContract(input)` inspects explicitly selected DOM controls
and authored draft feedback. `capturePowerPagesClientContract(input)` waits for the native client API and
checks the same source-selected form metadata. Capture the current native FormXml and form script readbacks;
a stale export must fail qualification. Neither probe submits a form or records visitor identity.

`captureCanvasDraftInputContract(adapter, fixture)` drives an authored open/edit/cancel/discard flow through
an explicit UI adapter. Bind both the installed app source and the native input plan; a pure Power Fx evaluator
does not establish player behavior. `captureCodeAppContextContract(api, input)` checks selected typed host
relationships and authored query fields, while `captureCodeAppContextCacheContract(api)` checks resolved
object identity and restores its authored query mutation. Official SDK executions with an invented bridge
response prove SDK behavior only; native host context requires a separate published-player capture.

`captureWebApiInputContract(input)` sends finite invented typed-input/binding cases through a supplied
request adapter. Keep portal and Dataverse routes, identity/permissions and native pipeline hooks explicit.
Inspect response bodies and independent persistence readbacks, and isolate recording-hook failures before
treating them as platform behavior. Preserve raw anomalies and exact restoration journals in private evidence.

Keep qualification reports and fixture manifests with repository tests or in the external project, outside
the shipped documentation. Protect expected fixture bytes and the serialized native probe function with
checksums inside each parity test. This binds shared helpers to the code that actually ran natively. A
parity tag requires reproduced native evidence for those assertions; see [test kinds](../../docs/test-kinds.md).
