# PCF code components on Power Pages

Mirage hosts standard PCF code components on local Power Pages pages and native forms. It loads the code, styles and
strings declared in exported Solution control manifests. `paqvilo mirage inspect` connects each component reference to
its manifest, resources, native FormXml binding and literal dataset sources. Model-driven hosting is described in
[PCF inputs and limits](model-driven-customizations.md#pcf-inputs-and-limits); both hosts use the same admission rule
(`pcfAdmission` in `mirage/lib/code-components.mjs`).

## Page components

Use the exported schema name in a `codecomponent` Liquid tag. A GUID reference needs an explicit
`observed.codeComponents` entry mapping it to the schema name. Component names and dataset bindings chosen at run time
stay unresolved in static inspection.

For a standard dataset control, bind the manifest's exact dataset argument to an exported view ID or name, or a table
logical name. Prefer a view ID when names are ambiguous:

```liquid
{% codecomponent name:'vendor.Controls.RecordGrid', Records:'exported-view-id' %}
```

This binding is Mirage's local contract: the manifest alone does not identify the portal table or view, and the native
Liquid dataset configuration must be observed separately. Dataset adapters expose the exported columns and local Web
API records, paging, supported sorting and filtering, selection and refresh, under the visitor's identity, field
restrictions and table permissions. `paging.reset()` returns to page 1 and reloads through the dataset load (it returns
the load promise; `hasPreviousPage` is then false), as `refresh()` does.

## Native form fields

A native form field hosts a component only with all of: portal attribute metadata with code-component style
`756150001`, an exported desktop FormXml custom-control binding, and the manifest and resources. A model-driven form
default alone does not enable it.

The bridge supports single-field bindings, keeps the original form input and validators, and syncs component output
with native save and script updates. Inspect shows the FormXml, bound column, attribute metadata, form factor and
enablement evidence. Type groups use the exported FormXml parameter type; an unresolved group of incompatible types is
a diagnostic, not the first declaration. Bound parameters carry the available column name, label, required level,
length, numeric bounds and precision, format, date behavior, targets, options and defaults; missing metadata is
omitted. Date outputs keep the native form's seven fractional digits and date/time behavior.

## Manifest feature declarations

Import keeps each `uses-feature` declaration's attributes and order. Power Pages
[excludes required feature declarations](https://learn.microsoft.com/en-us/power-pages/configure/component-framework#unsupported-code-components-in-power-pages):
such a component reports `PCF_HOST_UNSUPPORTED` with reason `PCF_FEATURE_DECLARATIONS_UNSUPPORTED` and the
declarations, before any mount or bundle load. `required` is `true`/`1` or `false`/`0`; a missing name or invalid
Boolean gives `PCF_FEATURE_DECLARATION_INVALID`.

Eligibility is separate from API availability: an optional `WebAPI` declaration keeps the local Web API facade;
optional Device or Utility declarations mount without those APIs; undeclared controls keep the default host. A
required `WebAPI` declaration is still ineligible. Local diagnostic HTML and wording are not claimed to match native
errors.

## Localized resources

Import keeps each declared RESX resource, its attributes, order and data nodes. The documented `filename.LCID.resx`
suffix gives its language; `version`, `order` and other attributes never override language selection. Values keep
whitespace and empty strings. Resources without a usable LCID suffix, ambiguous language variants and duplicate keys
get diagnostics and stay unresolved instead of overwriting values.

The host picks the resource for the page's LCID. If that language has none, it may use the exported website default
language and records `PCF_RESOURCE_LANGUAGE_FALLBACK` with `nativeQualified: false`: a local policy, not the native
organization-base-language fallback. Otherwise strings stay unresolved; the host never picks the first file or English
implicitly and never merges languages. `resources.getString` returns the key when no string matches, as
[documented](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/resources/getstring).

## Runtime debugging

In the browser console, `__paqviloPcf.openDebugger()` opens a dialog to pick an instance, view parameters, outputs and
lifecycle calls, and apply JSON parameter values (dates as ISO strings). Edits call the component's real `updateView`
and sync bound native inputs; output-only properties and datasets are not editable. The same operations are
`__paqviloPcf.inspect(instanceId)` and `__paqviloPcf.updateParameters(instanceId, values)`. Snapshots are bounded and
omit functions. Validation finishes before values apply; a later component or input failure is recorded in
`lastParameterUpdate`, and failure and removal records keep the original error and teardown calls.

## Limits

- Native list and subgrid PCF hosting is not implemented; diagnostics keep the native grid fallback.
- Virtual (React) controls and declared platform libraries are refused with `PCF_VIRTUAL_UNSUPPORTED`: the Power Pages
  host supplies no platform libraries.
- Dataset aliases, aggregates, advanced operators and navigation without an exported portal binding are limited or
  unsupported. SDK file and image APIs and writable `EntityRecord` APIs are not supplied.
- Diagnostics name missing manifests, resources, mappings and unsupported property bindings. Compare important
  behavior with an authorized live portal; see [platform resources](platform-resources.md) and
  [coverage](../../docs/coverage.md).
