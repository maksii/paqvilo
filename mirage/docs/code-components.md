# PCF code components on Power Pages

Mirage hosts PCF code components where Power Pages hosts them: a page `codecomponent` Liquid tag, a basic or
multistep form field (also in modal forms), a list and a form subgrid (one-to-many and many-to-many). It loads the code,
styles and strings that the exported control manifests declare, gives each control the `context` of the Power Pages
host and reads and saves data through the same services the portal uses. The Lense panel's **Inspect** view
([Lense](../../docs/lense.md)) connects each component reference on the page to its manifest, resources, native FormXml
binding and dataset sources; `paqvilo mirage inspect` does not list components. Model-driven hosting is described in
[PCF inputs and limits](model-driven-customizations.md#pcf-inputs-and-limits); both hosts use the same admission rule
(`pcfAdmission` in `mirage/lib/model-driven/pcf-runtime.mjs`), with a Power Pages option for platform libraries.

## Control sources

The catalogue reads, in order, the `Controls` folder (any letter case) of each unpacked Solution, only the control
folders a YAML solution's `solutioncomponents.yml` lists, the `Controls` entries of a Solution ZIP, then the
`pcf.sources` build outputs. A later control supersedes an earlier one of the same name, so a local build replaces the
exported control. An unpacked control is named by its `ControlManifest.xml.data.xml` `Name`; a ZIP control by the
`CustomControl` declaration of its `customizations.xml`. A ZIP that cannot be read reports `PCF_ARCHIVE_UNREADABLE`.

A control whose identity cannot be read reports `PCF_IDENTITY_UNRESOLVED` and withdraws only the earlier controls it
could supersede, those of its folder name or its manifest `namespace.constructor` (`PCF_IDENTITY_SHADOWED` names
each); unrelated controls stay. A render of a refused or withdrawn control names the import diagnostic.

### Build output sources

A pcf-scripts build writes each control to `out/controls/<Control>/` (`pcfconfig.json` `outDir`, the `.pcfproj`
`OutputPath`) without `ControlManifest.xml.data.xml`, so it does not name its control. `pcf.sources` names it as
`pac solution` and `pac pcf push` import it: the publisher prefix, an underscore and `namespace.constructor`
(Microsoft Learn's tag example `abc_SampleNamespace.MapControl`). Each source sets `path` (the controls folder, a
project folder holding `out/controls`, or the `.pcfproj`) and either `publisherPrefix` (2 to 8 letters or digits,
starting with a letter, not `mscrm`) or `solution`, the solution project (`.cdsproj` folder or `Solution.xml`) whose
`Publisher/CustomizationPrefix` packages the controls:

```yaml
pcf:
  sources:
    - path: ./components/invented-editor/invented-editor.pcfproj
      solution: ./components/invented-solution
  maxResourceBytes: 16777216
```

A source without a build yet reports `PCF_BUILD_OUTPUT_MISSING` and is watched until it has one; a source whose prefix
cannot be read reports `PCF_BUILD_SOURCE_INVALID`. A `.pcfproj` `OutputPath` that leaves the project folder is refused
(`PCF_BUILD_SOURCE_OUTSIDE`); name such a folder as the source `path` instead. A build folder whose manifest cannot be
read yet (a rebuild in progress) withdraws the earlier controls it could replace: those of its folder name or
constructor, else every earlier control of its publisher prefix.

### Served files

Only manifest-declared `code`, `css`, `resx`, `img` and `html` resources inside the control folder are served, each
with its content type (images and fonts by extension), plus the source maps, images and fonts a declared bundle or
style refers to by a relative URL inside the same folder, on the Power Pages, canvas and model-driven hosts. A
reference with a backslash, a colon (drive or scheme), a leading slash or one that leaves the folder is never looked
up. A resource above `pcf.maxResourceBytes` (8 MiB by default) refuses the control with `PCF_IMPORT_FAILED`, reason
`PCF_RESOURCE_TOO_LARGE`. Other `<resources>` children report `PCF_RESOURCE_KIND_UNSUPPORTED`.

A `dependency` resource is imported as declared (`type`, `name`, `order`, `load-type`) and reported at render as
`PCF_DEPENDENCY_NOT_LOADED`. Like Power Pages, the page loads no dependency, and `context.utils.loadDependency`
rejects with `undefined`. Enum `<value>` elements are imported as the property's values; `version`, `api-version`,
keys, `property-dependencies`, `common-property` and `external-service-usage` are kept as exported.

### Reload

A change inside a build output, or to a bundle, style or resource of a Solution control, reloads only the code
components (`SOURCES_RELOADED` with `scope: code-components`) and replaces their previous findings; open pages reload
as after any source change. A changed Solution `ControlManifest.xml` or `.data.xml` takes the full source reload.

## Platform libraries

Every Power Pages page with a code component has `window.React` and `window.ReactDOM` 16.14.0 and
`window.FluentUIReact` (Fluent UI v8, `@fluentui/react` 8.122.8, listed in `window.__packages__`), whether or not its
controls declare a platform library, and mounts standard controls that declare React as well as virtual controls.
Mirage supplies these libraries from the project's own files and downloads nothing: list the UMD builds of `react`,
`react-dom` and `@fluentui/react` at those versions in `pcf.platformLibraries`, named `<Library>@<version>.js` as
`modelDriven.clientSources` names them for the model-driven host.

```yaml
pcf:
  platformLibraries:
    - ./platform/React@16.14.0.js
    - ./platform/ReactDOM@16.14.0.js
    - ./platform/FluentUIReact@8.122.8.js
```

- The page loads them once, React, ReactDOM and Fluent UI in that order, before the first bundle (also on form field
  hosts). When the files do not set `window.__packages__`, Mirage sets it to `{ "@fluentui/react": ["<version>"] }`.
- A virtual control's returned element is rendered with ReactDOM into its container.
- One file serves every control: a control that declares another version of a supplied library mounts with the
  supplied file (`PCF_PLATFORM_LIBRARY_VERSION`, info).
- A list that lacks one of the three files or names another version reports `PCF_PLATFORM_LIBRARY_LIVE_SET` (info). A
  second file of one library reports `PCF_PLATFORM_LIBRARY_DUPLICATE` and only the first is served; a file that cannot
  be served (missing, or larger than 8 MiB) reports `PCF_PLATFORM_LIBRARY_INVALID`.
- A control that declares a library the project does not supply is refused before any bundle loads:
  `PCF_PLATFORM_LIBRARY_UNSUPPORTED` for a standard control, `PCF_VIRTUAL_UNSUPPORTED` for a virtual one, each naming
  the files to add.

## Manifest feature declarations

Import keeps each `uses-feature` declaration's attributes and order. Power Pages
[excludes required feature declarations](https://learn.microsoft.com/en-us/power-pages/configure/component-framework#unsupported-code-components-in-power-pages):
such a component reports `PCF_HOST_UNSUPPORTED` with reason `PCF_FEATURE_DECLARATIONS_UNSUPPORTED` and the
declarations, before any mount or bundle load. `required` is `true`/`1` or `false`/`0`; a missing name or invalid
Boolean marks the declaration `PCF_FEATURE_DECLARATION_INVALID`, a required one
`PCF_PORTAL_REQUIRED_FEATURE_UNSUPPORTED`. Every eligible control gets the same `context`, whatever it declares. A
control with a `control-type` other than `standard` or `virtual` is refused with reason `PCF_CONTROL_TYPE_UNSUPPORTED`.

## Page components

### Naming the control

Name the control unquoted in a `codecomponent` Liquid tag: its exported schema name (`name:pub_Namespace.Control`) or
its customcontrol GUID (`name:<guid>`, braced or without hyphens too, mapped to a schema name by an
`observed.codeComponents` entry). The tag key `name` takes any letter case; the name is always literal, never a
variable, even when a variable of that name exists.

As on Power Pages, these tags render nothing and end the rest of the template where they stand: the page copy and its
layout stop after the content before the tag, and the page continues after the layout (header and footer render
separately).

| Tag                                                                   | Diagnostic                     |
| --------------------------------------------------------------------- | ------------------------------ |
| A quoted name or GUID (`name:'pub_Namespace.Control'`)                | `PCF_LIQUID_NAME_QUOTED`       |
| A name the sources do not hold, or of a control the import refused    | `PCF_LIQUID_CONTROL_NOT_FOUND` |
| A tag without a name value                                            | `PCF_LIQUID_CONTROL_NOT_FOUND` |
| A second tag of a control the same template renders (neither renders) | `PCF_LIQUID_DUPLICATE_CONTROL` |

Two tags of one control in a template therefore render no host: the template ends where the first of them stands. A
`Pages.*` name that the sources do not hold (`Pages.CardGallery`) is a control the environment provides: Mirage shows
an alert in its place and the template continues.

### Arguments

Arguments reach the control only when their name equals a manifest input or bound property name, letter case
included; others are ignored (`PCF_ARGUMENT_IGNORED`, which names a property that differs only in case). The server
writes each accepted value into the host span's `pcf-controlcontext` `ControlProperties`, and the control receives it
as the parameter's `raw` value:

| Property type                                 | Written as                                                                      | Dropped (`PCF_ARGUMENT_DROPPED`)                        |
| --------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| SingleLine, Multiple, Enum, OptionSet         | the text (an undeclared Enum value too); a list of strings as `System.String[]` | nil                                                     |
| Whole                                         | the integer (`42`, `'42'`), within the 32-bit range                             | text that is no integer (`'abc'`, `'1.5'`)              |
| Decimal                                       | -                                                                               | always                                                  |
| FP, Currency                                  | the number as text (`"1.25"`)                                                   | text that is no plain decimal number (`'1e3'`, `'abc'`) |
| TwoOptions                                    | `true` for `true`/`'true'`; Mirage also writes `false` for `false`/`'false'`    | anything else (`1`, `'maybe'`)                          |
| DateAndTime.DateOnly, DateAndTime.DateAndTime | the wall-clock text `YYYY-MM-DDTHH:mm:ss`, a `Z` or offset dropped              | other spellings                                         |

The server reads numbers with the page culture. On a de-DE page `.` is a group separator, so `decimalValue:12.5` is
written as `125` (not dropped), `floatValue:1.25` as `"125"` and `moneyValue:99.99` as `"9999"`; other types are
unchanged. Mirage reads FP, Currency and Decimal arguments with the separators of the page language from `Intl`; a
language with `.` as its decimal separator keeps the en-US rules in the table (observed for en-US and de-DE only).

A required input without an argument or default is written as `""` and the control renders
(`PCF_REQUIRED_PROPERTY_MISSING`, info). A Liquid-hosted control is never disabled (`IsDisabled` false). An output of
the wrong type for its property is refused and recorded in the debugger's `refusedOutputs`.

### Host markup

The host markup has the Power Pages structure, with a fresh id per render: a `<id>_Container` span with the bundle
script (`/_pcfwebresource/<id>?<stamp>`), the `PcfControlConfig_<id>` span (`data-pcf-control`, `pcf-controlcontext`)
and the `<id>_ControlView` div the control renders into. Mirage's `/_pcfwebresource/<id>` ids are derived from the
local files, because an export does not carry the portal's web resource ids. `data-pcf-control` keeps the top-level
keys, the resource entries (code `0`, styles `1`, strings `2`) and the manifest identity and properties; the
formatting, localized string and property type entries are not written. Mirage's host script is loaded before the
container and its mount script follows it.

## Native form fields

A basic or multistep form field (also in a modal form) hosts a component when its portal attribute metadata has the
code-component style `756150001`, the exported desktop FormXml binds a custom control to the column and the sources
hold that control. A model-driven form default alone does not enable it. A style without a desktop binding keeps the
native control and reports `PCF_NATIVE_BINDING_UNSUPPORTED`.

### Column types

The host admits the column types Power Pages admits: Boolean, DateTime, Decimal, Double, Integer, Memo, Money,
Picklist, String, BigInt, Status, State and MultiSelectPicklist. Any other column (Lookup, Customer, Owner, PartyList,
File and Image) keeps its native control, and the form shows the Power Pages summary after its validation summary,
"Couldn't load one or more code components on this form.", with an entry such as
`Lookup data type used by Account (tst_account) is not supported for use with code components in portals.` and a
Learn more link (`PCF_NATIVE_BINDING_UNSUPPORTED`, reason `PCF_NATIVE_TYPE_UNSUPPORTED`).

### Bindings

- A type-group property takes the first type of its group, whatever the column type and the exported FormXml type. A
  property type of another family than the column (a number type on a text column) mounts, gets `NaN` and the error
  "Value is not a valid number", and reports `PCF_NATIVE_TYPE_MISMATCH` (warning). An empty type group refuses the
  control (`PCF_HOST_UNSUPPORTED`, reason `PCF_NATIVE_TYPE_AMBIGUOUS`).
- A FormXml binding of an `input` property mounts the control without a dynamic property: that input and the
  manifest's bound properties get no value (the bound properties carry the column's attributes), and the field posts
  nothing, so a save keeps the column.
- A FormXml binding of a property to another column is not honoured: that property gets no value
  (`PCF_NATIVE_BINDING_UNSUPPORTED`, reason `PCF_NATIVE_OTHER_COLUMN_BINDING`, warning).
- Static FormXml inputs are converted by the server: text and Enum values stay strings, Whole, Decimal, FP and
  Currency values become numbers, and Two Options takes only `true` or `false`. A value that does not convert (a Two
  Options `1`) refuses the whole control: the native control stays and the summary entry reads
  `Couldn't load code component for <label> (<column>) because of an unknown problem.` An input without a static
  value is `raw` null, or `NaN` with "Value is not a valid number" for a number type; the manifest `default-value` is
  not applied.

### Value and save

A mounted field renders no native control: the host element `PcfControl_<FormXml control id>` holds the
`<column>_Container` span and the `<column>_ControlView` div, followed by a hidden input named like the native input
that holds the column value as JSON.

| Column                           | Hidden input value                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| Text, multiline text             | the JSON string                                                                      |
| Whole number, float              | the number                                                                           |
| Decimal, currency                | the number with the stored scale of ten digits (`1234.5000000000`), every digit kept |
| Two Options                      | `true` or `false`                                                                    |
| Choice, status, status reason    | `{"Value":1}` (an output writes the option object with its label and colour)         |
| Choices                          | an array of option objects                                                           |
| Date only, time zone independent | the wall clock without a zone (`2026-03-15T00:00:00`)                                |
| User local date and time         | the UTC instant (`2026-03-15T14:05:09Z`)                                             |
| Empty column                     | `""`                                                                                 |

The control's `raw` value comes from that JSON: an empty column is `""` for text, `0` for numbers, `false` for Two
Options, `null` for choices and `undefined` for dates, and a status (`statecode`) column is `null`. A date without a
zone is read as the browser's local wall clock, a date with one as an instant. `formatted` is the plain number text
(currency the number itself), the option labels (choices each followed by `;`) or `dd/MM/yyyy[ HH:mm:ss]` in the
browser's time zone, and `null` without a value. `attributes` carry the column's logical name, options, maximum length
and `RequiredLevel` 0; `security` reports the column security the form applies.

Both save transports (the postback and the JSON form transport) hand the hidden input to one decoder, which posts what
the native control would post:

- `""` clears the column; the text `null` or text that is not JSON fails the save with HTTP 500
  (`FormFieldValueMalformed`) and saves nothing.
- A choice saves the `Value` of its option object, choices their joined values, numbers their posted digits (exact for
  decimal, currency and whole numbers). A value of the wrong type stays as posted, so the column's own validation
  refuses it ("must be a valid integer value").
- A user-local value saves its instant; a time-zone-independent value the UTC clock of the posted instant.
- A date-only value saves the UTC calendar date of the posted instant. The host posts the output's ISO instant, so east
  of UTC an output of local midnight saves the previous day, as on Power Pages.
- A posted value for a component field the form does not render is refused (403 `FormFieldNotBound`).

### Timing and script changes

`notifyOutputChanged` returns at once. The host calls `getOutputs` in a later task, writes the output into the hidden
input without a change event, marks the form dirty and then calls `updateView` with `updatedProperties` `[]`; notifies
before that task share one `getOutputs` call. An output of the wrong type is written as it is.

A page script reaches the control only by changing the hidden input's value and raising `change` (a jQuery
`.trigger('change')` counts): the host re-reads the JSON and calls `updateView` with `[]`. Disabling or hiding the
field and native validators do not reach the control. `mode.isControlDisabled` is true on a read-only form and for a
status or status reason column. The mount waits for `DOMContentLoaded` when the hidden input is not parsed yet.

### Read-only forms, hidden fields and quick views

- A read-only form mounts the component without the dirty-state handler and with a read-only container; outputs still reach
  the hidden input, and the form has no submit. Rich text, status and status reason fields render their native
  read-only control there (`PCF_NATIVE_BINDING_UNSUPPORTED`, reason `PCF_NATIVE_READ_ONLY_FIELD`).
- A hidden field with an admitted component renders neither a cell nor an input, so the form posts no value for it
  (reason `PCF_NATIVE_HIDDEN_FIELD`).
- Quick views and multistep reference forms host no component; the native control renders (reason
  `PCF_NATIVE_REFERENCE_FORM`).

Each of these findings is reported once per loaded sources, not on every render.

### `$pages` on a component field

The [`$pages` client API](https://learn.microsoft.com/en-us/power-pages/configure/client-api) treats a component field
as a generic control: `getValue` and `setValue` throw `Method not implemented.`, `getType` returns `undefined`,
`getVisible` returns true, `getDisabled` returns false and `setDisabled` changes nothing the control sees.

## Lists and subgrids

A list opts in with its code component setting and its table's desktop grid control; a form subgrid opts in through
its portal metadata (code-component style) and an exported desktop FormXml dataset binding with one data-set and only
static inputs besides it. The host binds the first view of the list or the subgrid's view; a list with several views
gets no view selector. Map, calendar and user-, account- or website-filtered lists, a view absent from the sources, a
binding for another table or view and a refused control keep the ordinary grid below an alert
(`PCF_NATIVE_DATASET_UNSUPPORTED`).

### Data transport

Rows come from the same grid services as the native grid, `entity-grid-data.json` for a list and
`entity-subgrid-data.json` for a subgrid, with a grid configuration signed for the dataset host. The grid service's
table permissions and column security apply, and no Web API site setting gates the component. Each request posts the
signed configuration, `sortExpression` (one column, `<column> ASC|DESC`), `search` `""`, `page`, `pageSize`,
`pcfFilter` (the dataset filter as a FetchXML `<filter>`, `""` without one), `timezoneOffset` and `entityName`; a
subgrid adds `entityId`, the parent record. A subgrid scopes its rows to the parent record through its one-to-many
relationship or the intersect table of a many-to-many relationship.

### Columns and values

`columns` lists the property-set columns first (`name` null, `displayName` and `alias` the property-set name,
`dataType` its type, `order` -1), then the view layout cells with `name`, `displayName`, `dataType`, `alias`, `order`
(from 1), `visualSizeFactor` 1 and the column's AttributeMetadata under `attributes`. A cell of a view link-entity
(`alias.column`) resolves through that link's exported table and is named "<column label> (<table label>)"; a cell
without an exported definition is left out (`PCF_DATASET_COLUMN_SKIPPED`). `dataType` follows the attribute type: float
is `Decimal`, money `Money`, multiline text `SingleLine.Text`, lookup, customer, owner, party list and multi-select
columns keep their lower-case type names, text and whole-number formats give the narrower type
(`SingleLine.Email`, `Whole.Duration`) and a date-format column `DateAndTime.DateOnly`.

A record's `getValue` returns a choice as its value text, choices as numbers, money as its amount, a date as a `Date`
and a lookup as `{ etn, id: { guid }, name }`. `getFormattedValue` returns the service's formatted text for choices,
money and date-only values, `String(value)` for numbers and Booleans, and a date and time in the browser's time zone
(a time-zone-independent value as if its wall time were UTC). `getNamedReference()` returns
`{ etn: <entity set>, id, name: <table logical name> }`; `isValid()` is true.

### Paging, sorting, filtering and selection

- Paging: `pageSize` and `hasNextPage` come from the service's answer, `totalResultCount` from its item count.
  `loadNextPage()` loads the next page and keeps `firstPageNumber`, `loadNextPage(true)` and `loadExactPage(n)` move
  both page numbers, `loadPreviousPage()` requests the current page again, and `reset()`, `refresh()`, `setPageSize`
  and filter changes return to page 1.
- Sorting starts as the table's primary name ascending. A change of `sorting` posts its first ascending or descending
  column on the next load.
- `filtering.getFilter()` is `undefined` until set and `null` after `clearFilter()`. Conditions may name any exported
  column of the view's table or of a view link-entity's table, also one the view does not show; a column the visitor
  reads masked is refused (400) and a column the table lacks answers HTTP 500 `{"InternalServerError":500,...}`. Every
  ConditionOperator with a FetchXML operator is sent with its value form (none, one, a list or a pair); 45, 49, 50, 89
  and -1 throw because they have none. Filters take at most 500 conditions, 16 levels and 64 KiB.
- One `updateView` runs per completed load, none when a load starts. Its `updatedProperties` is
  `['dataset', <reason>, 'records']`, the reason `Items` for the first load, then `sortorder`, `filter`, `page` or
  `linking`.
- `setSelectedRecordIds` keeps only records of the current page (ids set before the first load are kept until it
  prunes them), a reload prunes the selection, and selection runs no `updateView`.
- `linking.addLinkedEntity` and `addColumn(name, entityAlias)` validate against the exported tables, but neither is sent
  to the service: an added column stays empty unless the view has it. `getLinkedEntities()` lists only added links.
- `openDatasetItem` returns `undefined` and does not navigate. `newRecord()` rejects with a TypeError.
  `getDataSetCapabilities()` returns the Power Pages capabilities object.

### Writes, refusals and failures

- A list record's `setValue(name, value)` resolves and keeps the change (`getChanges()` holds it JSON-encoded);
  `save()` posts `{ Id, EntityName, Attributes: [{ Name, Value }] }` to `entity-grid-update-entity` and resolves with
  the record, which stays dirty. Only the bound view's own layout columns of the bound table are writable, with JSON
  primitive values inside the column's limits; lookups, state, status, owner, system, file, image and calculated
  columns are refused, and the record must be in the visitor's bound view with the table permission to write it.
- A subgrid record's `setValue` throws a TypeError and `save()` does nothing.
- A visitor without read permission gets the service's `{ "AccessDenied": true }`: the data set stays loading with no
  records, no error, `totalResultCount` -1 and no `updateView`.
- A Quick Find view as the bound view, or a filter the service cannot evaluate, answers HTTP 500: the data set stays
  loading, keeps its previous records and runs no `updateView`.

### Several data sets and property-sets

A list or subgrid binds its view to one data set (the subgrid's FormXml data-set, else the first) and gives the others
an empty data set that posts the same grid without a sort or search and shows no rows; data sets load in declaration
order, and a data set other than the first prefixes its `updatedProperties` with its name (`second_dataset`). Each data
set brings `<dataset>_Selected` (Object) and `<dataset>_SelectedItems` (DataSet) parameters, and each `property-set`
a String parameter with `raw` null, before the data set itself.

### Datasets in the Liquid tag

The Power Pages Liquid tag binds no data set. With the default `pcf.liquidDatasetBinding: none`, a Liquid-hosted data
set has no view and no rows: `getViewId()` and `getTitle()` throw a TypeError, `getTargetEntityType()` is `undefined`,
`columns` holds only the property-set columns and the first load ends with `error` true (`PCF_LIQUID_DATASET_UNBOUND`,
info).

`pcf.liquidDatasetBinding: view` is a local-only binding for working on a dataset control on a page: bind the
manifest's exact dataset argument to an exported view ID or name, or a table logical name (prefer a view ID when names
are ambiguous). Rows are read through the portal Web API as the visitor, with the view's FetchXML, columns and order
(`PCF_LIQUID_DATASET_LOCAL`, warning; `PCF_DATASET_WEBAPI_REQUIRED` names a table or column the Web API settings do not
serve). Its records are read-only (`setValue` throws, `save()` rejects) and `openDatasetItem` throws.

```liquid
{% codecomponent name:vendor_Controls.RecordGrid Records:'exported-view-id' %}
```

## Host context

The `context` follows the Power Pages host on every host kind: the same namespaces and members, including `device`,
`utils`, `client`, `factory`, `page` and `events`. The field and Liquid hosts add the `labelForPrefix` and
`deviceSizeMode` parameters around the manifest properties. Members that Power Pages declares without an
implementation behave the same way locally:

- `navigation`: every member except `openErrorDialog` throws `PCFNonImplementedError` with the message
  `<member>: Method not implemented.`; `openErrorDialog` resolves with its options and shows nothing.
- `device`: the capture, barcode and location methods, `openARViewer`, `getMessageReceiver` and `getDeclaredFeatures`
  throw `PCFNonImplementedError`; `pickFile` returns a promise that never settles.
- `utils`: `lookupObjects`, `getFormId`, `getResourceString` and `hasEntityPrivilege` throw `PCFNonImplementedError`;
  `getEntitiesMetadata` and `loadDependency` reject with `undefined`; `isFeatureEnabled` returns false.
- `client`: `isNetworkAvailable` throws, `getClientInfo` and `getEnvironmentEndpoint` throw "API not supported",
  `getFormFactor()` returns 1 while `formFactor` is 2, and `getClientState()` returns null.
- `mode`: `allocatedWidth` and `allocatedHeight` stay -1; `trackContainerResize(true)` schedules one `updateView` with
  `layout` the first time; `setFullScreen(true)` throws a TypeError; `setControlState` saves and returns true. A field
  or subgrid reports its form record in `contextInfo` and `page`; a Liquid tag or list reports none.
- `userSettings` reports no user: `userId` and `userName` null and `securityRoles` empty.
- On a page in another language `userSettings.languageId` is the page LCID (1031 on de-DE), but
  `numberFormattingInfo`, `dateFormattingInfo` and the `formatting` results stay en-US. Only two results follow the
  page language: `formatLanguage` returns a website language's English name on an English page and the LCID as text
  otherwise (`"1033"` on de-DE), and `formatUserDateTimeToUTC` writes the page culture's short date (`15.03.2026`,
  `NaN.NaN.NaN` with behaviour 1). Both were observed on de-DE only; Mirage takes other cultures' date order and
  separators from the browser's `Intl` data.
- `resources.getResource` calls its failure callback at once and loads nothing; `getString` returns the key when no
  string matches.
- `events.<name>()` of a manifest `<event>` raises a `paqvilo:pcf-event` DOM event on the container and returns null.

`context.webAPI` reads and writes through the portal Web API with the visitor's table permissions. Each request names
its table in the `pcf-entity-logical-name` header, and the page fetches its anti-forgery token once. `retrieveRecord`
without options sends nothing and returns `undefined`, and `deleteRecord` resolves with a null id. Every rejected call
rejects with `undefined`, as on Power Pages, so a control cannot read the reason: Mirage keeps it (operation, table,
message, error code and HTTP status) in `__paqviloPcf.inspect(instanceId)[0].webApiErrors` and writes a console
warning. A `WebAPI` control on sources without any imported table mapping reports `PCF_WEBAPI_MAPPING_MISSING`.

`utils.getEntityMetadata(table, columns)` reads `/_api/EntityDefinitions(LogicalName='<table>')` with the requested
columns in `$expand` and the `pcf-entity-logical-name` header, as the Power Pages host does; a request without that
header gets 404 "Resource not found for the segment EntityMetadata.". Its `Attributes` is a collection with `get`,
`getByIndex`, `forEach` and `getLength`. Mirage also requires a signed-in contact and a table in the exported Solution
metadata, and answers only the request shape the host sends; a refusal under these local rules records
`PCF_ENTITY_DEFINITIONS_LOCAL_ACCESS`.

## Localized resources

Import keeps each declared RESX resource, its attributes, order and data nodes. The documented `filename.LCID.resx`
suffix gives its language; `version`, `order` and other attributes never override language selection. Values keep
whitespace and empty strings. Resources without a usable LCID suffix, ambiguous language variants
(`PCF_RESOURCE_LANGUAGE_AMBIGUOUS`), entries without a name (`PCF_RESOURCE_KEY_UNRESOLVED`) and duplicate keys
(`PCF_RESOURCE_KEY_AMBIGUOUS`) get diagnostics and stay unresolved instead of overwriting values.

The host picks one language per control: the page's LCID when any of its RESX resources has it, else the exported
website default language, recorded once as `PCF_RESOURCE_LANGUAGE_FALLBACK` with `nativeQualified: false` (Mirage's
choice, not the platform's organization-base-language fallback). Every resource group then uses that language; a
group without it reports `PCF_RESOURCE_LANGUAGE_UNRESOLVED` and contributes no strings, so groups never mix languages.
The host never picks the first file or English implicitly. `resources.getString` returns the key when no string
matches, as [documented](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/resources/getstring).

## Diagnostics

Import and sources:

- `PCF_IMPORT_FAILED`: a control cannot be imported (its manifest or a declared resource is missing, unreadable or too
  large, reason `PCF_RESOURCE_TOO_LARGE`, or it declares no code resource); the control is refused.
- `PCF_IDENTITY_UNRESOLVED`: a control folder has no readable name.
- `PCF_IDENTITY_SHADOWED`: an earlier control is withdrawn by a later folder without a readable name.
- `PCF_ARCHIVE_UNREADABLE`: a Solution ZIP cannot be read.
- `PCF_RESOURCE_KIND_UNSUPPORTED`: the manifest declares a `<resources>` child no host reads.
- `PCF_BUILD_OUTPUT_MISSING`: a `pcf.sources` entry has no build output yet.
- `PCF_BUILD_SOURCE_INVALID`: a `pcf.sources` entry cannot name its controls (no valid publisher prefix).
- `PCF_BUILD_SOURCE_OUTSIDE`: a `.pcfproj` `OutputPath` leaves its project folder.
- `PCF_PLATFORM_LIBRARY_INVALID`, `PCF_PLATFORM_LIBRARY_DUPLICATE`: a `pcf.platformLibraries` file cannot be served
  or names a library twice.
- `PCF_PLATFORM_LIBRARY_LIVE_SET`: the files differ from the React, ReactDOM and Fluent UI set Power Pages provides.
- `PCF_RESOURCE_LANGUAGE_FALLBACK`, `PCF_RESOURCE_LANGUAGE_UNRESOLVED`, `PCF_RESOURCE_LANGUAGE_AMBIGUOUS`,
  `PCF_RESOURCE_KEY_AMBIGUOUS`, `PCF_RESOURCE_KEY_UNRESOLVED`: [localized resources](#localized-resources).

Rendering a control:

- `PCF_HOST_UNSUPPORTED`: the host refuses the control; `reason` is `PCF_FEATURE_DECLARATIONS_UNSUPPORTED`,
  `PCF_CONTROL_TYPE_UNSUPPORTED`, `PCF_PLATFORM_LIBRARY_UNSUPPORTED`, `PCF_VIRTUAL_UNSUPPORTED`,
  `PCF_NATIVE_TYPE_UNSUPPORTED`, `PCF_NATIVE_TYPE_AMBIGUOUS` or `PCF_NATIVE_STATIC_UNCONVERTIBLE`.
- `PCF_PLATFORM_LIBRARY_VERSION`: the control declares another version of a supplied library.
- `PCF_DEPENDENCY_NOT_LOADED`: the control declares a dependency, which the page does not load.
- `PCF_REQUIRED_PROPERTY_MISSING`: a required input has no tag argument or default.
- `PCF_WEBAPI_MAPPING_MISSING`: a `WebAPI` control renders while no table has an imported Web API mapping.
- `PCF_ARGUMENT_IGNORED`, `PCF_ARGUMENT_DROPPED`: a tag argument names no property, or its value has no
  `ControlProperties` form.
- `PCF_LIQUID_NAME_QUOTED`, `PCF_LIQUID_CONTROL_NOT_FOUND`, `PCF_LIQUID_DUPLICATE_CONTROL`: a tag that renders nothing
  and ends its template.
- `PCF_LIQUID_DATASET_UNBOUND`, `PCF_LIQUID_DATASET_LOCAL`: a Liquid-hosted data set without a binding, or with the
  local view binding.
- `PCF_DATASET_WEBAPI_REQUIRED`: the local view binding reads a table or column the Web API settings do not serve.
- `PCF_DATASET_COLUMN_SKIPPED`: a view cell without an exported column is left out.
- `PCF_NATIVE_TYPE_MISMATCH`: a field property type does not match the column or the exported FormXml type.

Forms and grids:

- `PCF_NATIVE_BINDING_UNSUPPORTED`: a form field keeps its native control, or a binding is not honoured; `reason`
  is `PCF_NATIVE_TYPE_UNSUPPORTED`, `PCF_NATIVE_OTHER_COLUMN_BINDING`, `PCF_NATIVE_READ_ONLY_FIELD`,
  `PCF_NATIVE_HIDDEN_FIELD` or `PCF_NATIVE_REFERENCE_FORM`, or the message names a missing binding or source.
- `PCF_NATIVE_DATASET_UNSUPPORTED`: a list or subgrid keeps the ordinary grid.
- `PCF_ENTITY_DEFINITIONS_LOCAL_ACCESS`: `getEntityMetadata` was refused under Mirage's local access rule.

The source graph's `portal:pcf/<control>` row lists every refusal reason of a Solution control, with the
`pcf.platformLibraries` the runtime serves, and `PCF_DEPENDENCY_NOT_LOADED`. `paqvilo lense audit` reports the tags of
an export against the same catalogue ([Lense](../../docs/lense.md)).

## Runtime debugging

In the browser console, `__paqviloPcf.openDebugger()` opens a dialog to pick an instance, view parameters, outputs and
lifecycle calls, and apply JSON parameter values (dates as ISO strings). Edits call the component's real `updateView`
and write a bound value into the field's hidden input; output-only properties and datasets are not editable. The same
operations are `__paqviloPcf.inspect(instanceId)` and `__paqviloPcf.updateParameters(instanceId, values)`. Snapshots are
bounded and omit functions. Validation finishes before values apply; a later component or input failure is recorded in
`lastParameterUpdate`, and failure and removal records keep the original error and teardown calls.

A snapshot also holds `webApiErrors` (the reasons of rejected `context.webAPI` calls), `hostCalls` (calls to members
Mirage answers with a placeholder value or no effect), `refusedOutputs` (outputs a Liquid or grid host refused for
their type) and the dataset load outcomes in `lifecycle`. A bundle that does not register its constructor fails with
a hint to build it in production mode: a confined page's script policy refuses a development build that loads its
modules with `eval`.

## Limits

- Mirage loads platform libraries only from the project's files; a project without `pcf.platformLibraries` cannot
  mount React or virtual controls.
- Controls the environment provides and no export holds (`Pages.*`) show an alert instead of rendering.
- The field host's `data-pcf-control` is an empty manifest shell and the field loads its bundle through Mirage's host
  script, not from a `/_pcfwebresource/` address.
- A data set has no `delete`, `getRelatedDataSet`, `newDataSet`, `cloneDataSet`, `saveMultipleRecords`, `getCommands`,
  grouping, aggregation or `getCellImageInfo` members, and a record has no `getFormattedPrimaryName`.
- Compare important behaviour with an authorized live portal; see [platform resources](platform-resources.md) and
  [coverage](../../docs/coverage.md).
