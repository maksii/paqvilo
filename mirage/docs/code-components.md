# PCF code components

Mirage loads declared code, styles and strings from exported Solution control manifests. Inspect connects component references to their manifests, resources, native FormXml bindings and literal dataset sources.

## Page components

Use the exported schema name in a `codecomponent` tag. A GUID reference requires an explicit `observed.codeComponents` mapping to that schema name. Component names and dataset bindings chosen dynamically remain unresolved in static Inspect until evidence identifies them.

Dataset hosting uses an explicit Liquid tag binding. For a standard dataset control, bind the manifest's exact dataset argument to an exported view ID/name or table logical name:

```liquid
{% codecomponent name:'vendor.Controls.RecordGrid', Records:'exported-view-id' %}
```

Replace the component, `Records` argument and view ID with values from your exports. Use a view ID when names are ambiguous. The manifest alone does not identify the portal table or view.

Dataset adapters expose exported columns and local Web API records, paging, supported sorting/filtering, selection and refresh. Reads and Web API CRUD retain local identity, field restrictions and table permissions.

## Native form fields

Native PCF hosting requires portal attribute metadata with code-component style `756150001`, an exported desktop FormXml custom-control binding, and the corresponding manifest/resources. A model-driven form default alone does not enable a portal component.

The native bridge accepts supported single-field bindings, keeps the original form input and validators, and synchronizes component output with native save and script updates. Inspect shows FormXml, the bound column, attribute metadata, selected form factor and enablement evidence. Validate your component's output type and save result in your project scenario.

## Limits

The host supports standard controls. Native list/subgrid PCF hosting is not implemented; diagnostics retain the native grid fallback. React/virtual controls and declared platform libraries are unsupported. Dataset aliases, aggregates, advanced operators and navigation without an exported portal binding remain limited or unsupported. SDK file/image APIs and writable EntityRecord APIs are not supplied by this host.

Diagnostics identify missing manifests, resources, mappings and unsupported property bindings. Use an explicit project extension where needed, then compare important behavior with your authorized live portal. See [platform resources](platform-resources.md), [forms and lists](forms-lists-parity.md) and [coverage](../../docs/coverage.md).
