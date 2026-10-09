# Sources and bootstrap

The importer accepts standard portal exports, enhanced unpacked component XML and short-key `.powerpages-site` code-site exports. It uses record types and IDs, exported page/template relationships, languages, settings, snippets, forms/lists, permissions and web-file metadata. Ambiguous or incomplete inputs produce diagnostics; `serve` rejects sources with no recognized pages.

Solution roots contribute table/entity-set identities, columns, relationships, views, system forms, choices, environment variables and permission relationships. Roots are a set layered in dependency order; explicit ordering is an opt-in and doctor reports disagreement. Source caches are keyed by physical file properties and implementation fingerprints; local state and source provenance remain distinct.

Bootstrap preserves configuration but creates no real business records. `data scaffold` uses metadata to generate deterministic rows; external packs supply project behavior. Watch reload refreshes changed configuration and metadata without overwriting authoritative local state. State writes use the integrity protocol described in [state integrity](state-write-integrity.md).

Project files declare portals, Solutions, reference origins and explicit pack modules. Site-specific `observed` settings with evidence supply behavior that cannot be exported, such as a deployment-specific login path or response header. Do not use customer names as runtime selectors. Inspect `inspect`, `bootstrap-report` and `portal-matrix` JSON for imported components, unresolved tables/fields and missing sources.
