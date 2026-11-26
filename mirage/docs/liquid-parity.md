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
  route is not a physical rewrite target and answers a route-handler error. An unimplemented `.aspx` layout produces
  `REWRITE_LAYOUT_UNSUPPORTED` and falls back to page copy.
  The breadcrumb above a rewrite layout's title is the portal's own control, not the site's Breadcrumbs web template:
  one linked item per page of the path, hidden pages included, each with its whole title and no `title` attribute,
  written with the AntiXSS encoder, with the Bootstrap 5 item classes when `Site/BootstrapV5Enabled` is true. It is
  proven by the `page-layout` replay surface (`mirage/test/parity/cases/page-layout`) for `FullPage.aspx`,
  `WebForm.aspx` and `WebFormNoValidation.aspx`.
- **Children and associations.** Language children, component envelopes, binary attachments and role associations are
  imported as their own records. A successful association request alone does not create an effective relationship or
  permission.

## Pages and web links

Liquid `page.id` uses the exported language-content identity when there is one; host navigation keeps the root page
identity. Compare like authentication contexts: a synthetic signed-in persona gives the local authentication class,
not equal contact IDs or business data.

An explicit published language in the URL wins over `ContextLanguageCode`, then the signed-in contact's preferred
language, then the site default. Local requests that select a published language set the session language cookie.
The selected page variant supplies its template, form/list bindings and publishing state. The default document shell
uses its `adx_meta_description` or `mspp_meta_description` when an authored head snippet has no meta description.
Exported `robots.txt` and `sitemap.xml` web files follow ordinary web-file routing.

A shortcut takes the first set target in the documented order: external URL, web page, survey, web file, event, forum.
The enhanced `mspp_shortcut` table has only the external URL, web page and web file columns. A standard export whose
shortcut selects a survey, event or forum reports `SHORTCUT_TARGET_UNSUPPORTED` with the target kind and ID. The shortcut
then has no URL, and a lower-priority web file does not take its place. Mirage does not host those targets.
[Shortcuts](https://learn.microsoft.com/power-pages/configure/place-child-nodes#manage-shortcuts) ·
[mspp_shortcut](https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/mspp_shortcut).

Authored `.webmanifest` files in an export or compiled code site use `application/manifest+json` when the source
does not specify a media type. Mirage preserves the authored manifest link and file bytes. Template-site PWA setup,
generated shell links and worker-managed offline pages remain open. [Web App Manifest specification](https://www.w3.org/TR/appmanifest/) ·
[Power Pages SPA guide](https://learn.microsoft.com/en-us/power-pages/configure/create-code-sites).

An exported `CodeSite/Enabled` setting of `true` sets the browser's `isSpaSite` flag, including on a PAC download
without the original project. Mirage needs a readable compiled landing page from `powerpages.config.json` to serve
the SPA entry and fall back to it on client routes. The observed download contains the HTML and its assets, but no
explicit landing path or fallback rules.

The classic `adxPreviewUnpublishedEntities` cookie controls publishing preview for signed-in visitors with the exported
**Preview Unpublished Entities** website right. Preview defaults to enabled for an eligible visitor when the cookie is
absent. `false` and other values that cannot be read as `true` disable it. The
[local toggle](sim-administration.md#publishing-preview-toggle) sets or clears the cookie for an eligible browser. The
same request preference governs exported page and web-file access, filtered navigation to that content and Liquid ads.
A web file available only with preview uses `private, no-store`. See [publishing states](https://learn.microsoft.com/en-us/power-pages/configure/publishing-states)
and [classic preview permission](https://github.com/Adoxio/xRM-Portals-Community-Edition/blob/868decd55a6f/Framework/Adxstudio.Xrm/Web/Security/PreviewPermission.cs#L35-L94).

Web templates with Functional manifests still use ordinary Liquid `include` parameters. The manifest itself produces
no markup. A malformed manifest reports `WEB_TEMPLATE_MANIFEST_INVALID` without suppressing the template's body. Each
parameter is the value of its expression in the including template, so `count: 4`, `flag: false` or `items: list`
reach the component as a number, a Boolean or an array; the design studio passes strings, which the component converts
with filters such as `integer`.

Web link sets keep their exported title, copy and logical attributes by name or ID; standard exports can supply copy in
a separate file, and localized titles use the import LCID. Each set and link honors its own exported publishing state.
`Disable Page Validation` skips the target page check only. A name matches the first active set before its state is
checked, while a different readable set with the same name is still reachable by its ID. `is_sitemap_ancestor` follows
the linked page's place in the current page's ancestor chain. [Web links](https://learn.microsoft.com/en-us/power-pages/configure/manage-web-links) ·
[Liquid objects](https://learn.microsoft.com/en-us/power-pages/configure/liquid/liquid-objects) ·
[Classic publishing state source](https://github.com/Adoxio/xRM-Portals-Community-Edition/blob/868decd55a6f/Framework/Adxstudio.Xrm/Cms/PublishingStateAccessProvider.cs#L52-L87).

For users granted **Manage Web Link Sets**, `set.editable` is true on accessible sets. The no-key `{% editable set %}`
tag emits hidden local metadata with the set ID and display label. This lets the authored navigation render its editing
branch for an eligible persona. Front-side CMS controls, service links and operations need a separate implementation.
[Editable tag contract](https://learn.microsoft.com/en-us/power-pages/configure/liquid/dataverse-liquid-tags#editable) ·
[Website access permissions](https://learn.microsoft.com/en-us/power-pages/security/website-access-permission).

## Search

`{% searchindex %}` runs portal search (`mirage/lib/portal-search.mjs`).

- `Search/Enabled` false returns no results (`PORTAL_SEARCH_DISABLED`). A table is indexed when it has a view named by
  `Search/IndexQueryName` (default "Portal Search"); the view's filters apply and its first column is the title. Tables
  outside the default set also need `Search/EnableAdditionalEntities`.
- Rows come from the same secured view query as lists, so table permissions filter them. Knowledge articles must be
  published and not internal (both added to the view's FetchXML); a missing `isinternal` counts as not internal.
- With `KnowledgeManagement/ContentAccessLevel/Enabled` true (default false), search results, totals, record-type facet
  counts, search summary sources and `knowledge.articles` keep only the articles that share a content access level with
  the visitor (`mirage/lib/content-access-levels.mjs`). Levels come from the visitor's web roles (the Default level
  reaches visitors through the Anonymous Users and Authenticated Users roles), contact, parent contact and account. The
  `adx_contentaccesslevel` N:N relationships are read from the Solution metadata, and the links from local data. Only
  active levels, contacts, accounts and web roles grant. Without a level-to-article relationship every article is hidden
  (`KNOWLEDGE_CONTENT_ACCESS_UNRESOLVED`). With live data the same rule runs over the visitor's contact, parent contact and
  account, their levels and the articles of those levels, read through the live data path; when that read fails (for
  example the live Web API does not expose the level tables to the visitor), every article is hidden and
  `KNOWLEDGE_CONTENT_ACCESS_LIVE_HIDDEN` is reported once. Local model, not
  documented: an article needs any one of its levels, and an article with no level is hidden. `entities`, the
  `fetchxml` tag and the Knowledge Article page's "Article Unavailable" response are not filtered.
  [Content access levels](https://learn.microsoft.com/en-us/power-pages/templates/dynamics-365-apps/manage-knowledge-articles-content-levels).
- Each result has `entity`, `fragment`, `id`, `logical_name`, `number`, `score`, `title` and `url`. The URL comes from
  the site marker `<logicalname>_SearchResultPage` (`Case` for incident, `Knowledge Article` for knowledgearticle) with
  `?id=`, and is empty without a marker. The fragment is the first matching value, cut at 200 characters, with each
  matching word in `<em>` and escaped segment by segment.
- Parameters read: `query`, `filter` (`+column:value` and `-column:value` only; others answer 501
  `PORTAL_SEARCH_FILTER_UNSUPPORTED`), `logical_names`, `page` and `page_size` (default 10, at most 1000). Every page of
  each indexed view is read, so `approximate_total_hits` counts the matching rows the visitor may read.
- The local scan accepts ordinary terms, quoted phrases, `*` and `?` within terms, Boolean clauses and groups,
  positive `^` boosts, proximity `"a b"~N` and fuzzy `term~` / `term~N`. The Liquid tag treats a query as plain text
  when this parser detects malformed syntax (for example `term~1.5`); the default search page answers 400
  `PORTAL_SEARCH_QUERY_INVALID`. The local length and group-depth limits still apply, and a proximity phrase may take
  at most 2,000,000 steps (candidate positions times phrase words) per column. Stemming is not modelled
  (`Search/Stemmer` is not read, so `lantern` does not match `lanterns`).
- Results are ordered by a local relevance model (`mirage/lib/portal-search-rank.mjs`) built from the factors the
  [search overview](https://learn.microsoft.com/en-us/power-pages/configure/search/overview#global-search) documents:
  the number of query words matched, their proximity, and the amount of text they are found in, with `^` boosts
  (below 1 too). A word scores in its best column, more by its count and less by the column's length; a fuzzy
  expansion counts half as much as an exact word; a wildcard or prefix word ignores its count; a sloppy phrase
  counts less for each position move it needs; matched words close together in one column add a bonus. Equal scores
  are ordered by title, then id (hosted ties are random). Not modelled: inverse document frequency and other index
  statistics, the hosted analysers and field weights, synonyms and natural-language interpretation. The `score`
  field is the local score, and a search whose results have different scores reports `PORTAL_SEARCH_RANKING_LOCAL`.
  - Proximity: the phrase words must fit within `N` position moves in one column (the Lucene sloppy phrase rule, so
    reversed words need `~2`). `"a b"~` is an exact phrase. A slop may precede a boost (`"a b"~3^2`).
  - Fuzzy, Dataverse search (the default): `N` is an edit distance, 2 when omitted and at most 2, with an adjacent
    transposition counting once; a value below 1 is a similarity converted to edits as the Lucene parser does, and a
    fractional value of 1 or more is a syntax error. Legacy Lucene .NET search (`Search/EnableDataverseSearch` false):
    `N` is a minimum similarity below 1 (default 0.5), kept when `1 - distance / shorter length` exceeds it; 1 or more
    is a syntax error. A wildcard term ignores `~`. Fuzzy matches are highlighted in fragments. Not modelled: the
    50-term expansion limit. [Lucene query syntax](https://lucene.apache.org/core/old_versioned_docs/versions/2_9_1/queryparsersyntax.html) ·
    [Dataverse search query syntax](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/search/query#parameters).
- `Search/Query` applies to the default search page only, never to the Liquid tag. `@Query` stands for the visitor
  query, parsed on its own (visitor text never changes the template's structure). The template supports the same
  syntax plus fields: `_logicalname:` (the table logical name as one keyword, so `-_logicalname:adx_webfile~0.9`
  excludes that table), `_title:` (the first indexed column) and any indexed column by logical name, each before a
  term, phrase or group. Membership: required and prohibited clauses, and one optional clause when none is required.
  Rank: the matched clauses add their scores with their boosts, an `@Query` clause scoring the visitor query over
  its field, so the default `_title:(@Query)` weighs a title match again and `_logicalname:adx_webpage~0.9^0.2` adds
  0.2 for web pages (`PORTAL_SEARCH_QUERY_WEIGHTS_LOCAL`).
  An invalid template is reported (`PORTAL_SEARCH_QUERY_TEMPLATE_INVALID`) and the visitor query runs alone.
- `Search/Filters` (`Label:logical,names;...`) adds a `logicalNames` drop-down to the default search page. An option
  shows the plural display name of its first table from the Solution metadata, else its label; the first option is
  the `Search/Default/FilterText` snippet (default All). A selected option restricts results like the record-type
  facet. Without the setting the page has no drop-down. The documented default value is not applied: Learn shows two
  different defaults.
- With `Search/IndexNotesAttachments` and `KnowledgeManagement/DisplayNotes` both true (both must be set: Learn gives
  conflicting defaults for `DisplayNotes`), the notes of the knowledge articles the visitor may find are searched as
  results with `logical_name` `annotation` and a `parent` (the article's id, title and url); group them with
  `Search/RecordTypeFacetsEntities` (`Downloads:annotation`). Only notes the visitor's annotation read returns, with
  the `KnowledgeManagement/NotesFilter` prefix (default `*WEB*`, removed from the indexed text) and outside another
  contact's private marker, are searched; subject, note text, file name and a text-typed body (`text/*`, JSON, XML, at
  most 1 MiB) are indexed when column security lets the visitor read them. Binary bodies are skipped
  (`PORTAL_SEARCH_ATTACHMENT_NOT_INDEXED`). The body of a cloud attachment note (an Azure file Web API `.azure.txt`
  note, or a form attachment stored in cloud storage) is a placeholder `{ Name, Type, Size, Url }` that names the
  file's storage key, so Mirage never indexes it; its subject, note text and file name are (Mirage-own). The Liquid tag
  and the default search page read a body inline on the note row or from the annotations storage route, as the
  visitor. A direct `portalSearch` caller without a body reader
  searches only inline bodies and reports `PORTAL_SEARCH_ATTACHMENT_BODY_UNAVAILABLE` for the others. A note with a
  file links to `/_entity/annotation/<id>/<website id>`, one without to its article. Web file notes are not searched:
  [Search within knowledge article attachment content](https://learn.microsoft.com/en-us/power-pages/configure/search/file-attachment)
  says they are not searchable, although the overview says otherwise.
- The default local page supports readable record-type counts and filters with `Search/FacetedView` and
  `Search/RecordTypeFacetsEntities`. Modified date, product and rating facets remain unsupported. The Liquid
  `searchindex` results contain no facets.
- With no indexed table, or Dataverse search off for the organization (`isexternalsearchindexenabled` false), search
  returns no results and `PORTAL_SEARCH_UNAVAILABLE`; with `liquidServiceTags: observed` it renders the observed Liquid
  error. An export that selects legacy search (`Search/EnableDataverseSearch` false) still searches local data when
  the organization's index is off, because the local scan needs no index; with live data or live pages it does not.
  When the export has no `/search/` page, the default local page keeps the selected language, query and record type
  while paging. See [local portal routes](operations.md#local-portal-routes).

## Error pages

`pageErrorPresentation: generic-error` replaces the simulator diagnostic for an HTTP 500 `PAGE_QUERY_REQUEST_VALIDATION`
GET page-query rejection (raised only with `observed.requestValidation: aspnet-query`, which rejects dangerous decoded
query values before Liquid runs) with the generic title and heading, a fresh local Error ID in square brackets and the
fixed rejection message. An exported `Portal Generic Error` snippet can replace that message in this mode. Mirage
chooses the localized snippet, honors its Text or HTML type, skips Liquid, and adds the local error ID, time and portal
record ID. Other errors, methods and API responses retain their normal response. The presentation models this error
class and leaves native styling and detailed ASP.NET exception output outside the local contract.
[Power Pages error log](https://learn.microsoft.com/en-us/power-pages/admin/view-portal-error-log).

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
