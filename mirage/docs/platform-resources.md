# Platform resources

Uncaptured platform styles are placeholders with toolkit-authored structural form rules. Doctor, Mirage status and administration report the provider; entity-form pages emit `PLATFORM_STYLES_PLACEHOLDER`. Capture the shell to reproduce deployed styles:

```sh
paqvilo mirage capture-shell --config ./paqvilo.config.yml --site my-site --env dev --path /
# Use an explicitly prepared loopback browser for a signed-in page:
paqvilo mirage capture-shell --config ./paqvilo.config.yml --site my-site --cdp http://127.0.0.1:9222 --path /
```

Without `--cdp`, capture owns an anonymous temporary browser using the configured channel and removes its profile afterward. `--all` selects every environment of one site and cannot combine with `--env`. Caution environments, external paths and non-loopback CDP are refused. A matching running runtime receives captures through its CSRF-protected admin API with disconnect cleanup; mismatched runtimes and existing live connections are refused. Otherwise capture closes a temporary local simulator after saving the site's state/cache. Reference reads are explicit and authorize no live writes.

Capture records date/origin and lists missing directly referenced head stylesheets. Direct script/style failures remain incomplete. CSS dependencies can themselves return native HTTP errors (obsolete font/image URLs): these retain their observed status as `NATIVE_ASSET_HTTP` and `nativeOriginFailed: true`, but do not make an otherwise complete capture incomplete. Timeouts, unsafe resources and unverified failures remain failures. No credentials, inline page data or bearer tokens are saved.

Mirage serves local equivalents of required platform clients, styles and resources in their page-kind order. Compatibility modules cover form/grid controls, Bootstrap plugins, date formatting, accessibility, portal objects and service endpoints. Third-party packages and fonts retain their upstream licenses.

Local equivalents are derived from reusable platform contracts. Caching a signed-in reference asset is a separate explicit operation, with provenance and diagnostics. Missing deployment-specific resources stay visible. Never commit cached live bundles, cookies or capture data to the toolkit.

Inspect resource order, failed requests and runtime errors in local browser evidence. A source web file can differ from a managed/deployed platform resource; choose the behavior through exported settings or a per-site observation with evidence. Version and source fingerprints help distinguish implementation changes from cached-state reuse.
