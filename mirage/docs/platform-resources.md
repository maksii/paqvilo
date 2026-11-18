# Platform resources

Mirage serves local equivalents of the platform clients, styles and resources a page kind needs, in their page-kind
order: compatibility modules for form and grid controls, Bootstrap plugins, date formatting, accessibility, portal
objects and service endpoints. They derive from reusable platform contracts; third-party packages and fonts keep their
upstream licenses. Capturing a signed-in reference's assets is a separate, explicit operation.

## Fallback styles

Until you capture a site's shell, toolkit-authored structural rules stand in for platform styles. The icon symbols and
banner layout are partial and reported as `local-platform-partial`; they do not reproduce native fonts or every
platform style, and PCF styles remain a placeholder. Doctor, Mirage status and administration name the provider, and
entity-form pages keep their style diagnostics. Captured styles replace every fallback, and exported column widths and
styles still control the authored layout. None of this establishes visual parity with a deployed site.

- **Modals and quick views.** Full-width, borderless frames 700px high, taken from the structural rule of the public
  preform stylesheet. Both documents include exported root styles, native container wrappers and local head
  additions; captured stylesheet links win over duplicate exported links. Quick view frames follow lookup changes, and
  clearing one blanks its frame and removes it from the tab order.
- **Forms.** Fields stack below 768px, read-only values stay borderless, and top and side multistep progress layouts
  work with Bootstrap 3 and 5.
- **Calendar.** Month, week and year layouts of the platform client's markup, including event spans, date badges and
  narrow viewports. A captured native calendar stylesheet wins; the fallback does not repair invalid event data.
- **Label markup.** Mirage keeps sanitized presentation markup in authored field, section and subgrid labels (scripts,
  event handlers and inline styles removed; record values stay encoded), a local model of how Power Pages renders them.
  A site observed to encode subgrid labels sets
  `mirage.observed: { subgridLabelMarkup: encoded, evidence: "<where you observed it>" }`.
- **Bootstrap stylesheet.** A `Head/Bootstrap` content snippet wins. Otherwise the layout links the site's
  `bootstrap.min.css` web file when the home page has one, else the platform's `/css/bootstrap.min.css`. A site
  observed to differ sets `observed.bootstrapStylesheet: platform | web-file` with evidence.
- **CRM MDL2 font.** `AssetCache.capturePublicAlias()` can supply the observed CRM MDL2 font URLs from Microsoft's
  public WOFF asset after verifying its family, PostScript name and glyph coverage. A `.woff2` target served this way
  still sends the WOFF bytes as `font/woff` with the source format recorded. Captured native bytes win; ordinary font
  requests never fetch a fallback.

## Capture the shell

```sh
paqvilo mirage capture-shell --config ./paqvilo.config.yml --site my-site --env dev --path /
# A signed-in page through an explicitly prepared loopback browser:
paqvilo mirage capture-shell --config ./paqvilo.config.yml --site my-site --cdp http://127.0.0.1:9222 --path /
```

- **Browser.** Without `--cdp`, capture launches an anonymous headless browser on the configured channel with a
  temporary profile and removes the profile afterwards. On Windows it disables Edge's implicit sign-in
  (`msImplicitSignin`), which otherwise signs even a fresh profile into the operating-system account ([implicit sign-in
  policy](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/implicitsigninenabled)). A private site
  therefore needs `--cdp`: anonymously, its sign-in redirect fails the capture with `Local runtime request failed (401):
The connected browser must complete portal sign-in.` Non-loopback CDP (`CDP must be a loopback URL without
credentials, path or query`), external paths and caution environments are refused; a `caution` environment stops with
  `Shell capture refuses caution environments` before anything is read, with or without `--cdp`. When nothing answers
  at `--cdp`, capture fails with `Could not connect to the loopback browser debugging endpoint`.
- **Several sites.** `--all` (not combinable with `--env`) captures every site with a configured Mirage port, or only
  `--site`, once per state file, using each safe default environment or the one a matching runtime already uses; other
  environments sharing that state are listed as skipped. A site's failure keeps its sanitized message, HTTP status and
  cause code while the others continue.
- **Runtime.** A matching running runtime receives the capture through its CSRF-protected admin API; mismatched
  runtimes and existing live connections are refused. Otherwise capture runs a temporary local simulator and closes it
  after saving the site's state and cache. Disconnect is attempted after success, timeout and failure; a failed
  cleanup is reported as `disconnectFailed` without replacing the capture's cause.
- **Time.** Capture waits without a client deadline and prints progress every 15 seconds. `--timeout <ms>` stops
  waiting (`0` disables it) but does not guarantee server cancellation.
- **Rich text.** Rich-text schema discovery is cycle-safe and bounded to 20,000 objects or 100,000 properties;
  `RICHTEXT_SCHEMA_TRUNCATED` leaves the remaining fields unverified without blocking. `--no-rich-text` skips rich-text
  capture.
- **Safety.** No credentials, inline page data or bearer tokens are saved. Excluded resources show only their host and
  reason (credentials, unsupported scheme, disallowed origin). Never commit cached live bundles, cookies or capture data
  to the toolkit.

## Read the result

Capture prints a JSON report with one `reports` entry per captured site and the `skipped` environments. Each entry
holds the applied shell profile (its `platformStyles` record the capture date, origin and missing directly referenced
head stylesheets), captured resources, failure codes and paths, diagnostics, and `applied`, `ready` and `complete`.
Blocking failures come first (in JSON and in the human summary on stderr, which `--json` suppresses).

- Exit zero means every selected shell is `applied` and `ready` without blocking failures. `complete` is stricter and
  informational; `--strict` requires it. An empty selection is not a success.
- A confirmed native HTTP error (`NATIVE_ASSET_HTTP`) or a stylesheet served with a non-CSS content type
  (`NATIVE_ASSET_CONTENT_TYPE`) carries `nativeOriginFailed: true` and does not block; the unusable reference is left
  out of the applied profile and its body is not cached. Literal percent-encoded quotes in CSS URLs are requested
  unchanged, so a native 404 is distinguishable from a path-validation failure. Timeouts, unsafe resources and other
  failures stay failures.
- External jQuery, font and image references in exported CSS are recorded as external dependencies: capture neither
  fetches nor proves them. Missing required local or platform styles and credential-bearing references block
  application.
- jQuery: a captured Bootstrap 3 or 5 preform bundle that assigns the global jQuery, or an exported provider, satisfies
  the shell; the profile records its path, origin and hash in `jquery`. With the target page already open in the
  connected browser, passive inspection can add `SHELL_JQUERY_OBSERVED`. Without an observed provider,
  `SHELL_JQUERY_MISSING` blocks application; stylesheet bytes alone do not prove script execution.

## Single observations

Two narrower read-only captures use the same connected browser (`--cdp`, required) on a `--site`/`--env` whose origin is
HTTPS, and print a JSON report; exit 1 when the capture fails. Both refuse `--preset`, and both stop with "Could not
connect to the loopback browser debugging endpoint" when nothing answers at `--cdp`. The state file keeps the
reference origin it was created with; a capture whose origin differs stops with `<command>: the state file <file>
routes live requests to <saved origin>, not <origin>; pass --state with a state file for this portal.`

- `mirage capture-stylesheets --stylesheet <path>` (repeatable, 1–32 paths; more stop with `capture-stylesheets
accepts one to 32 --stylesheet paths.` before the runtime starts) records the native bytes of an exported
  static `.css` web file. Each path must map to exactly one exported stylesheet, without query or fragment, and the
  native response must be HTTP 200 with a CSS content type; failures use `OBSERVED_STYLESHEET_*` codes.
- `mirage capture-snippet-composition --path <page> --parent-snippet <name> --child-snippet <name>` records how the
  native page composes two exported content snippets. Both snippets must be static (no Liquid); the parent has one
  root element, and the child is one `<button>` with an `id` that the native page renders as the last element of that
  root. A missing or Liquid snippet fails with `SNIPPET_COMPOSITION_INVALID` before the page is read. The page must
  answer HTTP 200 HTML (at most 5 MB) and contain exactly one matching composition; a sign-in redirect stops with
  `LIVE_BRIDGE` (`The connected browser must complete portal sign-in.`), a served sign-in page with
  `Composition observation reached the portal sign-in page; choose the page that shows both snippets.`, any other
  status with `Composition observation requires an HTTP 200 HTML page.` On success the report's `profile` names both
  snippets, their source hashes, the origin and the page, `observation.provider` is `native-page-html` (or
  `native-browser-dom` when the composition appeared only in the connected browser, see below) and
  `applied: true` means the profile was saved to the site's state; page HTML is not stored. A pair whose child is not such a button fails with
  `SNIPPET_COMPOSITION_INVALID`, for example `Observed action must be an existing exported button.` When the served HTML
  holds no match, capture opens the page in the connected browser (GET and HEAD only) and waits up to 10 seconds for
  the child under the parent root; without it, the capture fails with `SNIPPET_COMPOSITION_INVALID`
  (`The page did not render the parent snippet with the exported action within 10 seconds; …`), followed by the
  reasons the served HTML did not match.

A source web file can differ from a managed or deployed platform resource: choose the behaviour through exported
settings or a per-site observation with evidence, and use version and source fingerprints to tell implementation
changes from cached state.
