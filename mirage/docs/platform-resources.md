# Platform resources

Uncaptured platform styles are placeholders with toolkit-authored structural form rules. Doctor, Mirage status and administration report the provider; entity-form pages emit `PLATFORM_STYLES_PLACEHOLDER`. Capture the shell to reproduce deployed styles:

```sh
paqvilo mirage capture-shell --config ./paqvilo.config.yml --site my-site --env dev --path /
# Use an explicitly prepared loopback browser for a signed-in page:
paqvilo mirage capture-shell --config ./paqvilo.config.yml --site my-site --cdp http://127.0.0.1:9222 --path /
```

Without `--cdp`, capture owns an anonymous temporary browser using the configured channel and removes its profile afterward. `--all` selects all sites with a configured Mirage port (or just `--site` when supplied), once per state file, and cannot combine with `--env`. It uses each safe default environment, or the environment already used by a matching runtime. Caution environments and other environments sharing that state are listed as skipped. Caution environments, external paths and non-loopback CDP are refused. A matching running runtime receives captures through its CSRF-protected admin API with disconnect cleanup; mismatched runtimes and existing live connections are refused. Otherwise capture closes a temporary local simulator after saving the site's state/cache. Reference reads are explicit and authorize no live writes.

Capture records date/origin and lists missing directly referenced head stylesheets. Confirmed native HTTP errors retain their status as `NATIVE_ASSET_HTTP`; a native stylesheet answered with a non-CSS content type is `NATIVE_ASSET_CONTENT_TYPE`. Both carry `nativeOriginFailed: true`, remain visible and do not block application or completeness. Unusable native head references are omitted from the applied profile, and their response bodies are not cached. Literal percent-encoded quotes in CSS URLs are requested unchanged, so a native 404 is distinguishable from a path-validation failure. Timeouts, unsafe resources and unverified failures remain failures. No credentials, inline page data or bearer tokens are saved.

Mirage serves local equivalents of required platform clients, styles and resources in their page-kind order. Compatibility modules cover form/grid controls, Bootstrap plugins, date formatting, accessibility, portal objects and service endpoints. Third-party packages and fonts retain their upstream licenses.

Local equivalents are derived from reusable platform contracts. Caching a signed-in reference asset is a separate explicit operation, with provenance and diagnostics. Missing deployment-specific resources stay visible. Never commit cached live bundles, cookies or capture data to the toolkit.

Inspect resource order, failed requests and runtime errors in local browser evidence. A source web file can differ from a managed/deployed platform resource; choose the behavior through exported settings or a per-site observation with evidence. Version and source fingerprints help distinguish implementation changes from cached-state reuse.

Incomplete captures print the full JSON report, including applied state, captured resources,
failure codes/paths and diagnostics, and exit one. Fully captured platform styles can be
applied while optional external resources remain missing; check both `applied` and `complete`.
External jQuery references and external font/image references in exported CSS are observed
external dependencies. Capture neither fetches their bytes nor proves load success. Exported
templates/styles keep controlling those references; they appear as diagnostics. Missing required
local/platform styles or unsafe credential-bearing references still block shell application.

The toolkit-authored fallback includes full-width, borderless modal frames with a 700px
height, matching the structural rule in Microsoft's [public preform stylesheet](https://content.powerapps.com/resource/powerappsportal/dist/preform.bundle-b72a6ea21d.css).
Quick view documents use the same platform styles, and their frames follow lookup changes.
Captured styles replace these fallbacks.

Modal and quick-view documents also include exported root styles and native container wrappers.
Captured stylesheet links take precedence over duplicate exported links. Local head additions
apply to both document types. Clearing a quick view blanks its frame and removes it from the tab order.

Authorized native observations confirmed presentation markup in authored field, section and
subgrid labels. These labels preserve sanitized markup by default; scripts, event handlers
and inline styles are removed. Record values remain encoded. An evidenced site may select
`mirage.observed: { subgridLabelMarkup: encoded, evidence: "your observation receipt" }`.

Captured preform bundles for Bootstrap 3 and 5 that assign the global jQuery library satisfy
the shell requirement. The profile records its provider path, origin and byte hash in `jquery`.
Exported providers also qualify. When the connected browser already has the target page open,
passive inspection can emit `SHELL_JQUERY_OBSERVED` with its loaded version. Without an observed
provider, `SHELL_JQUERY_MISSING` blocks application; captured stylesheet bytes alone do not
prove script execution. External jQuery references remain separately identified diagnostics.

Every failure has a `blocking` flag. Blocking failures appear first in JSON and in the
CLI's human summary (stderr; use `--json` to suppress that summary). Excluded resources expose
only their host and reason, such as credentials, unsupported scheme or disallowed origin.
