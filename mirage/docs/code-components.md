# PCF code components

Mirage loads declared code, styles and strings from exported Solution control manifests. Inspect connects component references to their manifests, resources, native FormXml bindings and literal dataset sources.

## Page components

Use the exported schema name in a `codecomponent` tag. A GUID reference requires an explicit `observed.codeComponents` mapping to that schema name. Component names and dataset bindings chosen dynamically remain unresolved in static Inspect until evidence identifies them.

Dataset hosting uses an explicit Liquid tag binding. For a standard dataset control, bind the manifest's exact dataset argument to an exported view ID/name or table logical name:

```liquid
{% codecomponent name:'vendor.Controls.RecordGrid', Records:'exported-view-id' %}
```

Replace the component, `Records` argument and view ID with values from your exports. Use a view ID when names are ambiguous. This is Mirage's explicit local dataset binding contract; the corresponding native Liquid dataset configuration must be observed separately. The manifest alone does not identify the portal table or view.

Dataset adapters expose exported columns and local Web API records, paging, supported sorting/filtering, selection and refresh. Reads and Web API CRUD retain local identity, field restrictions and table permissions.

## Native form fields

Native PCF hosting requires portal attribute metadata with code-component style `756150001`, an exported desktop FormXml custom-control binding, and the corresponding manifest/resources. A model-driven form default alone does not enable a portal component.

The native bridge accepts supported single-field bindings, keeps the original form input and validators, and synchronizes component output with native save and script updates. Inspect shows FormXml, the bound column, attribute metadata, selected form factor and enablement evidence. Validate your component's output type and save result in your project scenario.

Native type groups use the exported FormXml parameter type when available. An unresolved group containing incompatible types produces a diagnostic instead of choosing the first declaration. Bound parameter attributes carry available source column names, labels, required level, length, numeric bounds, precision and its source, format, date behavior, targets, options and defaults. Unavailable metadata is omitted. Date outputs preserve the native form's seven fractional digits and its date/time behavior. These source-backed attributes do not by themselves establish identical native Power Pages context values or formatting.

## Manifest feature declarations

Import retains each `uses-feature` declaration's attributes and source order. The [Power Pages component contract](https://learn.microsoft.com/en-us/power-pages/configure/component-framework#unsupported-code-components-in-power-pages) excludes required feature declarations. Mirage reports `PCF_HOST_UNSUPPORTED` with reason `PCF_FEATURE_DECLARATIONS_UNSUPPORTED` and the individual declarations before emitting a mount or loading their bundles. XML Boolean values `true` and `1` are required; `false` and `0` are optional. Missing names or missing/invalid Boolean attributes receive `PCF_FEATURE_DECLARATION_INVALID`, a local diagnostic for malformed declarations.

Declaration eligibility is separate from local API availability. An optional `WebAPI` declaration retains the local Web API facade. Optional Device or Utility declarations can mount, with those unsupported APIs absent; undeclared controls retain existing host behavior. Diagnostics identify known facade availability and leave unknown features unqualified. A required `WebAPI` declaration is still ineligible under the documented portal contract. These checks do not claim that local diagnostic HTML, status or wording matches an observed native error. Source-qualified native captures remain necessary for that comparison.

## Runtime debugging

In the browser console, `__paqviloPcf.openDebugger()` opens a dialog for selecting an instance, viewing parameters, outputs and lifecycle calls, and applying JSON parameter values. The dialog appears only when explicitly opened. Parameter edits call the component's real `updateView` and synchronize bound native inputs. Dates accept ISO strings. Output-only properties and datasets are not editable parameter fields.

The same operations are available through `__paqviloPcf.inspect(instanceId)` and `__paqviloPcf.updateParameters(instanceId, values)`. Snapshots are bounded, omit functions and avoid invoking nested accessors. Typed validation finishes before applying values; a later component or native-input failure can occur after values were applied, and `lastParameterUpdate` records that phase. Failure and removal records retain the original error and actual teardown calls.

## Localized resources

Import keeps each declared RESX resource, its manifest attributes, declaration order and data nodes separately. The documented `filename.LCID.resx` suffix identifies its language; `version`, `order` and any additional attributes are retained without treating a newer version or a culture attribute as a language-selection override. String values retain their whitespace and empty values. Resources without a usable LCID suffix and ambiguous language variants receive diagnostics.

The local host selects a resource for the page's LCID, resolving a known language code when necessary. If that language has no resource, it can use the exported website default language and records `PCF_RESOURCE_LANGUAGE_FALLBACK` with `nativeQualified: false`. This is a local source policy: it does not establish the native portal's organization-base-language fallback. Without a matching language or an exported default, the host leaves strings unresolved rather than choosing the first file or English implicitly. An existing selected-language resource is not merged with another language for missing keys.

The [portal-supported `resources.getString` contract](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/resources/getstring) returns the key when no matching string exists. Empty translations remain empty, including property display labels. Duplicate keys or language variants remain unresolved with diagnostics instead of silently overwriting values. Actual native locale selection and fallback still require source-qualified portal observations; the [localization sample](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/sample-controls/localization-api-control) establishes the LCID filename convention but lists model-driven and canvas availability.

## Limits

The host supports standard controls. Native list/subgrid PCF hosting is not implemented; diagnostics retain the native grid fallback. React/virtual controls and declared platform libraries are unsupported. Dataset aliases, aggregates, advanced operators and navigation without an exported portal binding remain limited or unsupported. SDK file/image APIs and writable EntityRecord APIs are not supplied by this host.

Diagnostics identify missing manifests, resources, mappings and unsupported property bindings. Use an explicit project extension where needed, then compare important behavior with your authorized live portal. See [platform resources](platform-resources.md), [forms and lists](forms-lists-parity.md) and [coverage](../../docs/coverage.md).
