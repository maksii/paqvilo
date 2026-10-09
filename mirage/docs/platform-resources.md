# Platform resources

Mirage serves local equivalents of required platform clients, styles and resources in their page-kind order. Compatibility modules cover form/grid controls, Bootstrap plugins, date formatting, accessibility, portal objects and service endpoints. Third-party packages and fonts retain their upstream licenses.

Local equivalents are derived from reusable platform contracts. Caching a signed-in reference asset is a separate explicit operation, with provenance and diagnostics. Missing deployment-specific resources stay visible. Never commit cached live bundles, cookies or capture data to the toolkit.

Inspect resource order, failed requests and runtime errors in local browser evidence. A source web file can differ from a managed/deployed platform resource; choose the behavior through exported settings or a per-site observation with evidence. Version and source fingerprints help distinguish implementation changes from cached-state reuse.
