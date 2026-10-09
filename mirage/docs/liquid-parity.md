# Liquid rendering

Mirage implements Power Pages/DotLiquid-shaped parsing and rendering: platform tags and filters, portal objects, snippets/settings, page/template relationships, FetchXML result drops, permissions, errors and whitespace behavior. Shopify Liquid is not the parity target. Source inventories identify constructs and diagnostics expose unsupported or uncertain behavior.

Use `paqvilo mirage liquid-inventory --portal <export> --json` to inventory constructs and `render-sweep --site <site> --persona all --out .paqvilo/sweep` to exercise local pages. The inventory is static coverage; the sweep is local rendering coverage. Neither establishes live parity. Record reference comparisons with a project-owned golden suite.

Filters and native adapters derive from reusable platform contracts. Deployment-specific observations belong to the project's evidence and `observed` settings. A local fallback for an unsupported service is a diagnostic, not proof the service behaves identically online. See [conformance](liquid-conformance.md) and [parity evidence](parity-evidence.md).
