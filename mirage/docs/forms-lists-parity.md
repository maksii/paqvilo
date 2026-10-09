# Forms and lists

Mirage builds native basic/multistep forms, lists, lookups, subgrids and notes from exported portal configuration and Solution form/view metadata. Standard/enhanced record fields normalize into a common model. Missing managed metadata is reported and may use an explicit local fallback; it is not inferred from a customer name.

The client adapters provide platform-shaped form events, validators, date/picklist controls, lookup dialogs, grids, paging, actions, notes/attachments and session-sensitive requests. Permissions are checked through the local data layer. Generated form fields and unsupported controls retain diagnostics for inspection.

Project tests should assert their own rendered labels, relationships, native actions and backend results using an explicitly registered dataset. Core tests exercise invented minimal forms and loopback requests. A business flow passing locally establishes that simulation scenario only; compare reference DOM/network behavior before calling it platform parity.
