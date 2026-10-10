# Forms and lists

Mirage builds native basic/multistep forms, lists, lookups, subgrids and notes from exported portal configuration and Solution form/view metadata. Standard/enhanced record fields normalize into a common model. Missing managed metadata is reported and may use an explicit local fallback; it is not inferred from a customer name.

The client adapters provide platform-shaped form events, validators, date/picklist controls, lookup dialogs, grids, paging, actions, notes/attachments and session-sensitive requests. Permissions are checked through the local data layer. Generated form fields and unsupported controls retain diagnostics for inspection.

Native subgrid quick-find visibility follows its exported FormXml flag. Native PCF fields require explicit portal attribute enablement and a supported desktop binding. Native list/subgrid PCF hosting retains diagnostics and the native grid fallback; dataset hosting uses explicit Liquid table/view bindings. See [code components](code-components.md) for the host and save boundary, and [coverage](../../docs/coverage.md) for remaining limits.

When a form redirects after saving, configure its appended record-ID parameter explicitly. Mirage preserves the exported redirect name and query settings; it does not supply a missing `id` name. Check the resulting page and saved record, not only the successful submit response. See [basic form success settings](https://learn.microsoft.com/en-us/power-pages/configure/basic-forms#on-success-settings).

Project tests should assert their own rendered labels, relationships, native actions and backend results using an explicitly registered dataset. Core tests exercise invented minimal forms and loopback requests. A business flow passing locally establishes that simulation scenario only; compare reference DOM/network behavior before calling it platform parity.
