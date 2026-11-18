# Liquid and portal rendering

Mirage parses and renders Liquid with Power Pages' DotLiquid-based engine as its target, not Shopify Liquid: platform
tags and filters, portal objects, snippets and settings, page and template relationships, FetchXML result drops,
permissions, errors and whitespace. Only the cases recorded in the `liquid-render` replay surface
(`mirage/test/parity/cases/liquid-render`, see [test kinds](../../docs/test-kinds.md#replay-cases)) are proven against
native Power Pages output; other behaviour is a model of DotLiquid, the Adxstudio Liquid layer and Microsoft's
documentation. Where a deployment is known to differ from the DotLiquid default, a site can select the observed
behaviour with [`observed` settings](#site-observations). A local fallback for an unsupported service is a diagnostic,
not proof that the service behaves the same online.

## Check sources

```sh
paqvilo mirage liquid-inventory --portal <export> --json
paqvilo mirage render-sweep --site <site> --persona all --out .paqvilo/sweep
paqvilo mirage inspect --source <export> --json
```

- `liquid-inventory` lists Liquid constructs and diagnostics in the export (static coverage). `--include-inactive`
  also scans inactive records; `--sources` adds a per-source list (`sourceList`) with each source's tag and output
  counts.
- `render-sweep` renders the local pages for each persona (local rendering coverage). With `--site`, only an HTTPS
  environment URL is passed to the runtime as the site's live origin; a loopback `http` environment URL is not.
- `inspect` (or `--project`) reports `liquidSyntax`: syntax diagnostics for active templates, page HTML, JavaScript and
  CSS, snippets, basic form and list JavaScript and advanced form step JavaScript, including language variants.
  `templateCount`/`parsePassed` count templates; `sourceCount`/`sourceParsePassed` count nonempty source fields. It
  does not run scripts or prove include resolution, data coverage or browser behaviour.

None of these establishes live parity; compare with a reference as described in
[reference parity evidence](parity-evidence.md).

## Filters and HTML

`strip_html` keeps the DotLiquid text-transform contract and is not a sanitizer. Use `escape` to show untrusted text,
or `html_safe_escape` to keep safe formatting in untrusted HTML: it parses against an explicit tag, attribute, style
and URI-scheme allowlist, removes executable markup and unsafe styles, and may normalize malformed markup and void-tag
spacing.

## Site observations

Set these in the site's `observed` block together with `observed.evidence` naming where you observed the behaviour.
Omitting a setting keeps the default.

| Setting                         | Default      | Observed value and behaviour                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `liquidEscapeOnce`              | `dotliquid`  | `passthrough`: `escape_once` returns its input unchanged                                                                                                                                                                                                                                                                                             |
| `liquidStripHtmlScriptText`     | `remove`     | `preserve`: `strip_html` keeps script element text                                                                                                                                                                                                                                                                                                   |
| `liquidDecimalStringMultiply`   | `dotliquid`  | `convert`: string inputs, including string site settings, are converted before multiplying by a decimal                                                                                                                                                                                                                                              |
| `liquidTimesDispatch`           | `dotliquid`  | `observed`: captured `times` errors for an integer input with a string operand and for string-array inputs; a decimal input converts a numeric string operand                                                                                                                                                                                        |
| `liquidFilterErrors`            | `dotliquid`  | `observed`: captured overload, array batch/order and arithmetic error messages; floating-point division by zero keeps its numeric type                                                                                                                                                                                                               |
| `liquidFilterRegistration`      | `dotliquid`  | `observed`: captured filter registration and currency signature; unknown filters still pass through                                                                                                                                                                                                                                                  |
| `liquidHtmlVoidSerialization`   | `dotliquid`  | `html`: parser-based void-element serialization for sanitized HTML and generated line breaks                                                                                                                                                                                                                                                         |
| `liquidHtmlSafeInput`           | `excluded`   | `observed`: sanitized `input` elements keep `type`, `value` and `disabled`; executable attributes and unsafe schemes stay excluded                                                                                                                                                                                                                   |
| `liquidPathAndQueryFragment`    | `uri`        | `query`: captured fragment handling by `path_and_query`                                                                                                                                                                                                                                                                                              |
| `liquidRelativeQueryResolution` | `preserve`   | `root`: relative `add_query`/`remove_query` paths resolve from the site root and drop their fragment                                                                                                                                                                                                                                                 |
| `liquidRuntimeCompatibility`    | `dotliquid`  | `observed`: string-array bounds errors, blank comparison and assignment, nil string-filter input, unsupported increment/decrement and for/else, parenthesized conditions, multiline parse errors, request-entry lookup restrictions, HTML-encoded request/params aliases; iterating `request.params` yields no key/value pairs (direct lookup works) |
| `liquidObjectCompatibility`     | `dotliquid`  | `observed`: captured object member visibility and drop types; identity data and dynamic backend metadata errors are not synthesized                                                                                                                                                                                                                  |
| `liquidServiceTags`             | `dotliquid`  | `observed`: captured errors or empty output for absent form, list, view and server-logic records and unavailable search, and source-derived chart placeholders; no successful service execution or chart data                                                                                                                                        |
| `liquidMissingData`             | `diagnostic` | `empty`: captured empty FetchXML and nil entity for an unmapped root table; known-table query, permission, linked-table and infrastructure failures stay intact                                                                                                                                                                                      |
| `liquidEditableMetadata`        | `minimal`    | `observed`: source-derived CMS metadata URLs for the current page with the captured working flag; no authoring endpoints. Without the setting the metadata still renders for a signed-in user whose web role is on an exported website access permission (`adx_websiteaccess`)                                                                       |
| `redirect301`                   | `configured` | `temporary`: redirect records configured as 301 answer 302; canonical slash redirects and other codes are unchanged                                                                                                                                                                                                                                  |
| `webTemplateResponseNewline`    | `none`       | `crlf`: no-header web template responses (including text and JSON) end with an appended CRLF                                                                                                                                                                                                                                                         |
| `webFileMimeCharset`            | `utf8`       | `source`: web files keep the attachment MIME type without an added UTF-8 charset                                                                                                                                                                                                                                                                     |
| `siteMarkerRedirect`            | `resolve`    | `null-reference`: marker-only redirect records answer 500 with the captured exception message (a URL or page target still wins); the body is a local diagnostic                                                                                                                                                                                      |
| `pageErrorPresentation`         | `diagnostic` | `generic-error`: see [error pages](#error-pages)                                                                                                                                                                                                                                                                                                     |

## Configuration records

- **Record status.** Enhanced component XML keeps the record's lifecycle `statuscode` in the component envelope;
  content fields are independent (a redirect's content `statuscode` is its HTTP status). Legacy sources without the
  envelope derive status from state.
- **Page template type.** An explicit Type selects Rewrite or Web Template even when both references are set. Rewrite
  uses the ASP.NET layout and its page copy; the web template header/footer switch applies only to web template
  responses, and resource inspection leaves an unselected web template out of the include chain. A populated portal
  route is not a physical rewrite target and answers a route-handler error; other `.aspx` layouts are not rendered.
- **Children and associations.** Language children, component envelopes, binary attachments and role associations are
  imported as their own records. A successful association request alone does not create an effective relationship or
  permission.

## Pages and web links

Liquid `page.id` uses the exported language-content identity when there is one; host navigation keeps the root page
identity. Compare like authentication contexts: a synthetic signed-in persona gives the local authentication class,
not equal contact IDs or business data.

Web link sets keep their exported title, copy and logical attributes by name or ID; standard exports can supply copy in
a separate file, and localized titles use the import LCID. `is_sitemap_ancestor` follows the linked page's place in the
current page's ancestor chain, so sibling routes sharing a URL prefix are not ancestors. See Microsoft's
[web links](https://learn.microsoft.com/en-us/power-pages/configure/manage-web-links) and
[Liquid objects](https://learn.microsoft.com/en-us/power-pages/configure/liquid/liquid-objects).

## Search

`{% searchindex %}` runs portal search (`mirage/lib/portal-search.mjs`).

- `Search/Enabled` false returns no results (`PORTAL_SEARCH_DISABLED`). A table is indexed when it has a view named by
  `Search/IndexQueryName` (default "Portal Search"); the view's filters apply and its first column is the title. Tables
  outside the default set also need `Search/EnableAdditionalEntities`.
- Rows come from the same secured view query as lists, so table permissions filter them. Knowledge articles must be
  published and not internal (both added to the view's FetchXML); a missing `isinternal` counts as not internal.
- Each result has `entity`, `fragment`, `id`, `logical_name`, `number`, `score`, `title` and `url`. The URL comes from
  the site marker `<logicalname>_SearchResultPage` (`Case` for incident, `Knowledge Article` for knowledgearticle) with
  `?id=`, and is empty without a marker. The fragment is the first matching value, cut at 200 characters, with each
  matching word in `<em>` and escaped segment by segment.
- Parameters read: `query`, `filter` (`+column:value` and `-column:value` only; others answer 501
  `PORTAL_SEARCH_FILTER_UNSUPPORTED`), `logical_names`, `page` and `page_size` (default 10, at most 1000). Every page of
  each indexed view is read, so `approximate_total_hits` counts the matching rows the visitor may read.
- Matching is token matching (any term, `term*` prefixes; the score is the number of matched terms), not Dataverse
  relevance search: Lucene operators, fuzzy and proximity are ignored, and `Search/Query` weights are not applied
  (`PORTAL_SEARCH_QUERY_WEIGHTS_IGNORED`).
- With no indexed table, or Dataverse search off for the organization, search returns no results and
  `PORTAL_SEARCH_UNAVAILABLE`; with `liquidServiceTags: observed` it renders the observed Liquid error. When the export
  has no `/search/` page, the host serves a default one ([local portal routes](operations.md#local-portal-routes)).

## Error pages

`pageErrorPresentation: generic-error` replaces the simulator diagnostic for an HTTP 500 `PAGE_QUERY_REQUEST_VALIDATION`
GET page-query rejection (raised only with `observed.requestValidation: aspnet-query`, which rejects dangerous decoded
query values before Liquid runs) with the generic title and heading, a fresh local Error ID in square brackets and the
fixed rejection message. Other errors, methods and API responses are unchanged. It does not reproduce native CSS,
scripts, opaque identifiers or exact HTML, and custom `Portal Generic Error` snippets are not used (on the platform,
Liquid in that snippet is not evaluated; [error
log](https://learn.microsoft.com/en-us/power-pages/admin/view-portal-error-log)).

## Golden-liquid conformance

`paqvilo mirage liquid-conformance` runs a [golden-liquid](https://github.com/jg-rp/golden-liquid) suite file through
the renderer and classifies each case that differs from the Shopify Liquid expectation. The suite is not bundled:
download the version pinned in `mirage/lib/liquid-conformance-rules.json`.

```sh
paqvilo mirage liquid-conformance --suite <golden_liquid.json> --markdown --out .paqvilo/liquid-conformance.md
```

Options: `--rules FILE` (default `mirage/lib/liquid-conformance-rules.json`), `--json` or `--markdown` (default: a
plain-text summary; passing both is a usage error), `--out FILE` (default standard output; never the suite or rules
file; its parent folder is created), `--timeout MS` (per case, default 5000). The report is informational: the command
exits 0 when cases differ and exits 2 only for invalid options or when the suite, rules or output file cannot be read
or written.

A rules file has `suite` (the pinned source), `reasons` (key → evidence text) and `rules`, each
`{ match: { name } | { tag }, category, reason, dotliquid? }`: a name rule wins over a tag rule, `reason` is a key of
`reasons` or literal text, and `dotliquid` records the reference output per DotLiquid build (`master`, `2.0.385`,
`2.0.64`), as `{ output }` or `{ error }`.

| Category               | Meaning                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `platform-unsupported` | A tag, filter or syntax that DotLiquid and Power Pages do not provide                                      |
| `dotliquid-divergence` | Mirage renders what DotLiquid (or the filter Power Pages registers over it) renders, unlike Shopify Liquid |
| `engine-gap`           | Mirage differs from DotLiquid; a differing case without a rule lands here too                              |

Name rules that match no differing case are listed as stale (`staleRules`), split into rules whose case now passes
(`passingRules`) and rules whose case is absent from the suite (`missingRules`); an unused tag rule is not reported. The
default rules compare the public suite with DotLiquid, not with a live site. Each case runs with its own data and
partials, empty portal settings and objects, and an invalid case passes when any Liquid error is raised. For portal
context or exact error text, write a renderer test or record a reference comparison; reduce an engine issue to a
synthetic test in `mirage/test/`.
