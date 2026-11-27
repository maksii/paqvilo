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
| `liquidServiceTags`             | `dotliquid`  | `observed`: captured errors or empty output for absent form, list, view and server-logic records and unavailable search, and the chart tag's markup (its data service: [charts](#charts)); no successful service execution                                                                                                                           |
| `liquidMissingData`             | `diagnostic` | `empty`: captured empty FetchXML and nil entity for an unmapped root table; known-table query, permission, linked-table and infrastructure failures stay intact                                                                                                                                                                                      |
| `liquidEditableMetadata`        | `minimal`    | `observed`: source-derived CMS metadata URLs for the current page with the captured working flag; no authoring endpoints. Without the setting the metadata still renders for a signed-in user whose web role is on an exported website access permission (`adx_websiteaccess`)                                                                       |
| `redirect301`                   | `configured` | `temporary`: redirect records configured as 301 answer 302; canonical slash redirects and other codes are unchanged                                                                                                                                                                                                                                  |
| `webTemplateResponseNewline`    | `none`       | `crlf`: no-header web template responses (including text and JSON) end with an appended CRLF                                                                                                                                                                                                                                                         |
| `webFileMimeCharset`            | `utf8`       | `source`: web files keep the attachment MIME type without an added UTF-8 charset                                                                                                                                                                                                                                                                     |
| `siteMarkerRedirect`            | `resolve`    | `null-reference`: marker-only redirect records answer 500 with the captured exception message (a URL or page target still wins); the body is a local diagnostic                                                                                                                                                                                      |
| `pageErrorPresentation`         | `diagnostic` | `generic-error`: see [error pages](#error-pages)                                                                                                                                                                                                                                                                                                     |
| `customErrors`                  | `enabled`    | `disabled`: the error page's `RTGE01` server log entry names the exception (admin center **Disable custom errors**); see [error pages](#error-pages)                                                                                                                                                                                                 |

## Configuration records

- **Record status.** Enhanced component XML keeps the record's lifecycle `statuscode` in the component envelope;
  content fields are independent (a redirect's content `statuscode` is its HTTP status). Legacy sources without the
  envelope derive status from state.
- **Page template type.** An explicit Type selects Rewrite or Web Template even when both references are set. Rewrite
  uses the ASP.NET layout and its page copy; the web template header/footer switch applies only to web template
  responses, and resource inspection leaves an unselected web template out of the include chain. A populated portal
  route is not a physical rewrite target and answers a route-handler error. On the enhanced data model (hosted session
  F3, two runs) `Page.aspx` and `Listing.aspx` answer 500 (`REWRITE_LAYOUT_TABLE_MISSING`: the model has no
  `adx_webpage` table), an `.aspx` page the runtime does not ship (`Home.aspx`, a missing file) answers the
  route-handler 500, and `Search.aspx` renders the header and footer around its content region as captured on a
  second site (identical bodies in both runs): `div#content-container` and `div#content` holding a native controls
  root, a script hiding `body > section.page_section` (it gets the page nonce like other platform scripts), the
  `pages-native-container` with `pages-search-summary` and its two raw attributes (`show-search-suggestions` false,
  `enable-streaming` true), and an empty `#searchErrorMessage`; there is no page heading, page copy or server form.
  No local script defines `pages-search-summary`, so the summary control stays empty locally.
  On the standard data model an unimplemented `.aspx` layout produces `REWRITE_LAYOUT_UNSUPPORTED` and falls back to
  page copy, and `Page.aspx` and `Listing.aspx` render their layouts; only the enhanced model was captured.
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
Exported `robots.txt` and `sitemap.xml` web files follow ordinary web-file routing. Without an exported
`robots.txt`, a site observed as private (`siteVisibility: private`) answers `/robots.txt` in any letter case and with
any query as hosted session F3 captured it: 200 `text/plain`, `private, max-age=3600`, an inline disposition and the 26
bytes `User-agent: *\r\nDisallow: /`. A public site's platform body was not capturable, so a public or unobserved site
keeps the Page Not Found answer. An exported page, code-site route, redirect or canonical match at `/robots.txt`
answers first. `/sitemap.xml` without an exported file is Page Not Found (404) on every site.

`page.parent` passes the same access check as the page: under a draft parent a published child renders for an
anonymous visitor with an empty `page.parent`, and an administrator who may preview unpublished content gets the
parent (hosted session F3). `page.breadcrumbs` leaves out an ancestor the visitor may not read, with the same check;
that is inferred (F3 captured `page.parent` only) and fails closed.

Header and footer output caching follows `Header/OutputCache/Enabled` and `Footer/OutputCache/Enabled` (literally
`true`; the site template ships `True`, an upgraded site without the settings renders every request). Hosted session F3
(two runs) observed one copy shared by every anonymous visitor whatever the path or query, a copy per signed-in
contact, an expiry 5:00 to 5:23 after the render that filled it that requests do not extend, `{% substitution %}`
rendered on every request, a Liquid error kept in the cached copy, and a template write visible after 10 to 25
seconds. Mirage keeps one copy per website, language and visitor (a contact with its web roles) for a fixed 5 minutes
from its render. A changed template source or source revision replaces the copy at once, and so does a change of the
contact's web roles (the hosted timing after a role removal differed between the two runs, so it is not modelled). A
cached copy is rendered again from the inputs of the request that filled it (page, URL, visitor, language and time):
request values outside `{% substitution %}` stay those of that request and every substitution block reads the current
request; data the template reads is read again. A cached copy whose template reads a request-dependent value outside
`{% substitution %}` (the reads `paqvilo analyze` reports as `PP-CACHE-001`, `website.sign_in_url` and its returnUrl
included) reports `OUTPUT_CACHE_REQUEST_VALUE` (warning) each time it is served, naming the reads.
[Output caching](https://learn.microsoft.com/power-pages/configure/enable-header-footer-output-caching).

A shortcut takes the first set target in the documented order: external URL, web page, survey, web file, event, forum.
The enhanced `mspp_shortcut` table has only the external URL, web page and web file columns. A standard export whose
shortcut selects a survey, event or forum reports `SHORTCUT_TARGET_UNSUPPORTED` with the target kind and ID. The shortcut
then has no URL, and a lower-priority web file does not take its place. Mirage does not host those targets.
[Shortcuts](https://learn.microsoft.com/power-pages/configure/place-child-nodes#manage-shortcuts) ·
[mspp_shortcut](https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/mspp_shortcut).

Authored `.webmanifest` files in an export use `application/manifest+json` when the source does not specify a media
type; a compiled code site serves them as `application/octet-stream`, as described below. Mirage preserves the authored manifest link and file bytes. The `PWAFeature` site
setting adds what hosted session F3 captured: `{"status":"enable"}` (Studio's **Enable PWA**) puts
`<link rel="manifest" href="/PWAManifest.json">` in the head and registers `/js/sw.js?languageCode=/&version=v<id>` at
the end of the body, and `/js/sw.js` answers `application/x-javascript` with `Service-Worker-Allowed: /`;
`{"status":"disable"}`, as the site template ships it, adds the script that unregisters every service worker of the
origin. The hosted worker is Microsoft's 12,282-byte Workbox 5.1.2 build, which Mirage does not ship: the local worker
registers with the same URL, scope and headers and handles no request, so nothing is cached and no offline page is
served. The registration's version is a stable ID of the website and the language code is the captured single-language
`/`. On the hosted site the registration itself failed ("ServiceWorker script evaluation failed"). [Web App Manifest specification](https://www.w3.org/TR/appmanifest/) ·
[Power Pages SPA guide](https://learn.microsoft.com/en-us/power-pages/configure/create-code-sites).

An exported `CodeSite/Enabled` setting of `true` sets the browser's `isSpaSite` flag, including on a PAC download
without the original project. With a readable compiled landing page from `powerpages.config.json`, Mirage serves the
local build as hosted sites serve it after `pac pages upload-code-site` (hosted session F5, four runs):

- The upload stores the landing page as the Home page copy. The root renders the Home page through the page pipeline,
  so the landing document sits inside the Home copy, with the portal scripts, the anti-forgery holder and the client
  context (`isSpaSite` `"True"`).
- An application route renders the site's Page Not Found page (the Home page when the site has none) with HTTP 200.
  The landing document takes the place of the page template's output, after the anti-forgery holder. Application
  routes are paths with no page, web file or build file, with or without a trailing slash, in any case and with a query
  string, whose extension is not a static file type (`/route.with.dot` and `/main.html` without such a file are
  routes).
- A missing file of a static file type (`.js`, `.css`, `.png`, `.json`, `.wasm` and the other types in
  `lib/code-site.mjs`) answers 404 with the platform's plain Page Not Found document. Online, some of these requests
  got an 86-byte body without a content type instead.
- Every build folder is a web page under its parent folder's page, with the Home page's template and an empty copy:
  `/assets` redirects to `/assets/`, which renders that page without the app.
- Build files, the landing page's own address and other HTML files are raw web files: no portal shell and no client
  context. Paths are case-insensitive.
- Every file is `inline` with its file name. `.js` and `.css` are `charset=utf-8` types; `.js`, `.css`, `.svg`,
  `.png`, `.ico` and `.woff2` (`application/font-woff2`) are `public, max-age=3600` with an ETag; `.json`, `.map`
  and `.txt` (both `text/plain`), `.wasm` and `.webmanifest` (both `application/octet-stream`) are
  `private, max-age=3600` without one. An HTML file is `text/html; charset=utf-8` with `no-cache, no-store,
must-revalidate`. A request that spells a path in another case gets the file with private caching and no ETag.
  `.js`, `.css`, `.json`, `.map`, `.txt` and HTML are gzip-compressed for a client that accepts it. Other types keep
  the headers of ordinary web files. `webFileCaching: revalidate` switches the caching to `no-cache`, as for other web
  files.
- `WebAssembly.instantiateStreaming` fails with a `TypeError` on the `application/octet-stream` type, as it does
  online.
- Mirage adds no `<base>` element: a relative asset URL in the landing page resolves against the route, as it does
  online, so builds use root-relative asset URLs.

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

For users granted **Manage Web Link Sets**, `set.editable` is true on accessible sets, so the authored navigation
renders its editing branch for an eligible persona. The no-key `{% editable set %}` tag writes nothing, also for an
administrator (hosted session F3).

`{% editable %}` wrappers follow hosted session F3 (two runs). The wrapper's class value is attribute-encoded
(`xrm-editable-html&#32;xrm-attribute`), `tag:` names both nested elements, and a content snippet carries the lowercase
`data-languagecontext` with the request language's name. A visitor with the editing right adds only `data-encoded` and
`data-liquid` (from `escape:` and `liquid:`), and a missing snippet with a default also gets `data-default` and the
language context, the attributes in ordinal order; `page.editable` and `snippets.editable` follow the same rights. The
rights come from the export and fail closed: a content snippet needs **Manage Content Snippets** website access, a web
page a Grant Change page access rule on the page or an ancestor; **Preview Unpublished Entities** alone edits nothing.
F3 observed an administrator holding both, so which right each object reads is inferred from the classic portal's
permissions. An exported snippet named `editable` keeps its value in `snippets.editable`. No CMS service URLs, file
browser links or editor scripts are written; `observed.liquidEditableMetadata: observed` still adds a site's captured
current-page metadata. The legacy CMS services answer as hosted: `/_services/cms` and
`/_services/portal/<website>/__templates/...` are Page Not Found, and `/_services/portal/<website>/elFinder/connector`
is a server exception ("The CMS inline editor file browser has been deprecated."). The `liquid-render` replay suite
`power-pages-hosted-f3-editable` holds the missing-snippet case.
[Editable tag contract](https://learn.microsoft.com/en-us/power-pages/configure/liquid/dataverse-liquid-tags#editable) ·
[Website access permissions](https://learn.microsoft.com/en-us/power-pages/security/website-access-permission).

## Search

`{% searchindex %}` runs portal search (`mirage/lib/portal-search.mjs`).

- `Search/Enabled` false returns no results (`PORTAL_SEARCH_DISABLED`). A table is indexed when it has a view named by
  `Search/IndexQueryName` (default "Portal Search"); the view's filters apply and its first column is the title. Tables
  outside the default set also need `Search/EnableAdditionalEntities`.
- Rows come from the same secured view query as lists, so table permissions filter them. Knowledge articles must be
  published and not internal (both added to the view's FetchXML); a missing `isinternal` counts as not internal.
- Web pages are not filtered by table permissions: a page result needs the visitor to pass the page's web page access
  control rules and its ancestors', as a request for the page does, so a Restrict Read page is found only by its
  roles. A hosted site found web pages for anonymous visitors without an `adx_webpage` table permission.
- A web page in a non-visible publishing state is left out for a visitor who cannot preview unpublished content (its
  default-language content page's state decides, as page access reads it), and Dataverse search reports
  `PORTAL_SEARCH_UNPUBLISHED_PAGES_EXCLUDED`. A hosted site with Dataverse search lists such pages, with their title
  and indexed text, to every visitor, anonymous ones included; `observed.searchUnpublishedPages: listed` reproduces
  that for a site observed doing it.
- With `KnowledgeManagement/ContentAccessLevel/Enabled` true on an enhanced data model site, a hosted Customer
  Self-Service site returned no knowledge article through `knowledge.articles` or the `fetchxml` tag for any visitor
  (anonymous, signed in, with levels through roles, the contact or both), `entities.knowledgearticle[id]` still returned
  every article, and the Knowledge Article page answered 500: its server log entry RTDV01 says the entity
  `adx_webrolecontentaccesslevel` is not in the MetadataCache. The feature reads that standard-model table, which the
  enhanced model does not have, so which levels would grant is not observable there. Mirage does the same, and also
  shows no article in search (not observed: search was off on that site): `knowledge.articles`, `fetchxml` over
  `knowledgearticle` and search return none (`KNOWLEDGE_CONTENT_ACCESS_ENHANCED`), `entities` returns none either and
  reports `KNOWLEDGE_CONTENT_ACCESS_ENTITIES_UNFILTERED` (with `observed.knowledgeEntitiesContentAccess: unfiltered`
  it returns every article the table permissions admit, as the hosted site did), and the page the
  `Knowledge Article` site marker names answers 500 (`KNOWLEDGE_CONTENT_ACCESS_TABLE_MISSING`, with the RTDV01 entry on
  the generic error page when the site's error presentation is observed). Do not rely on the setting to hide articles
  read through `entities` on a hosted enhanced site: grant table permissions only to the visitors who may read them.
- On the standard data model, with `KnowledgeManagement/ContentAccessLevel/Enabled` true (default false), search
  results, totals, record-type facet counts, search summary sources, `knowledge.articles` and
  `entities.knowledgearticle` keep only the articles
  that share a content access level with
  the visitor (`mirage/lib/content-access-levels.mjs`). Levels come from the visitor's web roles (the Default level
  reaches visitors through the Anonymous Users and Authenticated Users roles), contact, parent contact and account. The
  `adx_contentaccesslevel` N:N relationships are read from the Solution metadata, and the links from local data. Only
  active levels, contacts, accounts and web roles grant. Without a level-to-article relationship every article is hidden
  (`KNOWLEDGE_CONTENT_ACCESS_UNRESOLVED`). With live data the same rule runs over the visitor's contact, parent contact and
  account, their levels and the articles of those levels, read through the live data path; when that read fails (for
  example the live Web API does not expose the level tables to the visitor), every article is hidden and
  `KNOWLEDGE_CONTENT_ACCESS_LIVE_HIDDEN` is reported once. Local model, not documented and not observed (the hosted
  site of session F3 used the enhanced model): an article needs any one of its levels, and an article with no level is
  hidden. `entities`, the `fetchxml` tag and the Knowledge Article page's "Article Unavailable" response are not
  filtered. Levels and their links come from data only: a new article carries no level and a Default level linked to no
  web role reaches no visitor, as a hosted site creates and installs them.
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
  at most 2,000,000 steps (candidate positions times phrase words) per column.
- With Dataverse search (the default), a plain word or a phrase word matches the indexed words that share its stem
  (`mirage/lib/search-stemmer.mjs`: the Porter stemmer, with a British `-ogue` stem folded to `-og`). Hosted search
  was observed finding both pages for `lantern`, `lanterns`, `lantern AND lanterns`, `lantern*` and `"lantern"`,
  `running` for `run`, `catalogue` for `catalog`, and nothing for `runner`; the stemmer gives those results. Hosted
  search runs its own language analysis, so other word forms can match differently there. Wildcard, prefix and fuzzy
  words match the indexed words unstemmed, the `_logicalname` keyword is never stemmed, and legacy Lucene .NET search
  (`Search/EnableDataverseSearch` false) keeps exact words. `Search/Stemmer` is not read.
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

## Charts

`{% chart id: '<chart id>' viewid: '<view id>' %}` with `liquidServiceTags: observed` writes the platform's chart
markup, a `div.crm-chart` naming the chart, the view, the language and the chart service. The platform chart script
(on a page whose captured platform shell loads it) draws it from
`GET /_services/visualizations/get-chart-builder?chartId=&viewId=`, which Mirage answers from the exported system
chart (`Entities/<table>/Visualizations/`) and view (`mirage/lib/portal-chart-builder.mjs`), with the keys of the hosted
answer:

- `FetchXml` is the chart's aggregate fetch with the view's root filters added, written as the platform writes it (two
  spaces, CRLF, ` />`); `OuterQuery.Query` is the chart's own fetch. A view's `link-entity` filters are not added.
- `DataJson` is `for(;;);` and the aggregate rows the visitor may read: `RowId`, `RowType` (the table's object type
  code), each column alias with its text and `<alias>_Value` with its value; a measure's text has two decimals. `Data`
  holds the same rows as platform entity records.
- `Query`, `ChartDefinition.Fetch` and `ChartDefinition.DataDescription` are the merged fetch as the platform's query
  object. Its mapped values are the captured ones and the `fetch.xsd` orders they belong to (aggregates `count`,
  `countcolumn`, `sum`, `avg`, `min`, `max`; filters `and`, `or`; condition `eq`); another operator is null and
  reported as `PORTAL_CHART_QUERY_MODEL_PARTIAL`.
- `AttributeMetadata`, `EntityMetadata` and `ChartDefinition.PrimaryEntityMetadata` come from the Solution metadata,
  the last one as Mirage's RetrieveEntity metadata of the table; `ViewDefinition` is the exported view.
  `ResourceManagerStringOverrides` (en-US) and the constant flags of `AttributeMetadata` are copied as captured.
- Without a table permission that grants read the answer is `{"ChartDefinition":"","EntityPermissionDenied":true}`,
  and the chart script shows "You don't have the appropriate permissions." An unknown chart or view answers 404
  `PORTAL_CHART_NOT_FOUND`.

## Error pages

`pageErrorPresentation: generic-error` replaces the simulator diagnostic for every HTTP 500 server exception of a GET
page request with the page hosted session F3 (two runs) captured for each one: a rewrite layout or route handler
failure, a page-query rejection (with `observed.requestValidation: aspnet-query`), a site-marker redirect's null
reference, the legacy CMS file browser and a failed page render. The page has the generic title and a dialog with the
heading, `Error ID # [<id>]` (a fresh local UUID) and the UTC time; no exception text is shown. Before the dialog a
script hands the server log to the Power Pages DevTools extension (`updateDevToolRuntime`), also for anonymous
visitors: `RTSS09` when `HTTP/X-Content-Type-Options` is not `nosniff`, `RTDV01` with the Dataverse message for a
Dataverse error, then `RTGE01` "Error occurred : ", which names the exception only with `observed.customErrors:
disabled` (the admin center's **Disable custom errors**). The hosted log's Dataverse request timings (`RTPMDV`), its
telemetry scripts and stylesheet are not produced. An exported `Portal Generic Error` snippet replaces the heading inside
the same dialog, after the same server log: Mirage chooses the localized snippet, honors its Text or HTML type and skips
Liquid. F3 had no such snippet, so its place in the dialog is inferred; an earlier site's capture showed the snippet
with `Error ID: [<id>]`, date and portal ID lines, which the F3 dialog replaces. Other methods, statuses and API responses retain their normal response; without the
setting the simulator diagnostic names the exception.
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
