# Content Security Policy

Mirage sends the policies a site's settings define on its local responses: `HTTP/Content-Security-Policy` (enforced)
and `HTTP/Content-Security-Policy-Report-Only`, as Power Pages does
([Manage your site's Content Security Policy](https://learn.microsoft.com/power-pages/security/manage-content-security-policy)).
A site without these settings gets no site policy, unless it records the platform default described below. The
optional loopback confinement policy (`confinePortalPages`, [configuration](../../docs/configuration.md)) is a separate
header that Mirage adds on its own. HSTS and CORS are described in [HTTP transport and CORS](http-headers.md).

## Platform default policy

Learn says that sites created after November 10, 2025 have CSP enabled by default. Hosted sites without an
`HTTP/Content-Security-Policy` setting send this header (hosted sessions F5 and F3, two runs each):

```text
script-src 'self' test.content.powerapps.com content.powerapps.com content.powerapps.us content.appsplatform.us content.powerapps.cn  'unsafe-eval' 'nonce-<base64>' 'sha256-YpBM7xPJQJfSSthwTVGpeXpUbzvd1XmAqvdlDUvm/QM=' 'unsafe-hashes' 'inject-hashes'; style-src 'unsafe-inline' https:;
```

The text differs from the policy that Learn prints: it adds `test.content.powerapps.com`, `'unsafe-eval'`, a fixed
hash and `'unsafe-hashes'`, and it has two spaces before `'unsafe-eval'`. Every response carries it: pages,
redirects, error pages, the anti-forgery fragment, `/_services/about` and web files. Each response has its own nonce
of 256 bits. On a rendered portal page, `'inject-hashes'` is replaced by the hashes of the page's inline event handlers,
each followed by a space, with one more space after them. Web files, redirects, error pages, `robots.txt`, stylesheets,
workers and manifests keep the literal `'inject-hashes'`.

The header is Learn's policy (with `test.content.powerapps.com`) whose `'nonce'` placeholder the platform expands. A
site's own `HTTP/Content-Security-Policy` with `'nonce'` expands the same way (hosted session F3, one run): the setting
`script-src 'self' 'nonce' content.powerapps.com; object-src 'none'` is sent as
`script-src 'self'  'unsafe-eval' 'nonce-<base64>' 'sha256-YpBM7xPJQJfSSthwTVGpeXpUbzvd1XmAqvdlDUvm/QM=' 'unsafe-hashes' 'inject-hashes' content.powerapps.com; object-src 'none'`,
with the page's handler hashes in place of `'inject-hashes'` on rendered pages, and on every response. Mirage expands
the first placeholder of the enforced policy's script directive (`script-src`, `script-src-attr` or `default-src`)
this way. Another placeholder gets the nonce alone. Hosted pages list the handler hashes in two groups, the platform shell's and then the page's own, each
followed by one more space; Mirage groups them the same way, by who wrote the handler.

The export does not show the default: a site created after that date has no `HTTP/Content-Security-Policy` row, and a
PAC export carries no website creation date. A site that sends the default records it as an observation:

```yaml
observed:
  defaultContentSecurityPolicy: platform
  evidence: <where the header was observed>
```

Mirage then sends that text while the site has no `HTTP/Content-Security-Policy` setting, and the info diagnostic
`PORTAL_HTTP_CSP_PLATFORM_DEFAULT` reports it:

- A page response whose scripts Mirage decided gets the response's nonce, and its proved inline event handlers' hashes
  in place of `'inject-hashes'` (the script nonce rules below).
- Redirects, web files, a code site's build files, the anti-forgery fragment and every other response that is not an
  HTML document get a fresh nonce that no script carries, with the literal `'inject-hashes'`. A site's own nonce
  policy reaches these responses the same way. A raw HTML web file gets
  it too, so its inline scripts are blocked as they are online.
- A document that Mirage composes without deciding its scripts' nonces keeps the omission described below.

An exported setting wins, and an empty value disables CSP, because Learn says to clear the value rather than delete
the setting. Setting `HTTP/Content-Security-Policy/Enabled` to `false` disables it too. The default is `none`, which
sends nothing.

## Script nonces

When a policy contains the documented `'nonce'` placeholder, every page response gets a fresh nonce (256 random bits,
as long as hosted nonces).
The nonce replaces the placeholder in both headers and is added as `nonce="…"` to the scripts the response proves:

- scripts in the exported source: web templates, content snippets (Head/Bottom included), page copy and the custom
  JavaScript of pages, forms and lists. Inline scripts that interpolate Liquid values keep the nonce, but the
  `<script>` start tag and the end tag must be source text.
- scripts the platform writes: the page shell and its bundles, the WebForms form, forms, lists, code components and
  the documents Mirage builds outside the page layout (modal form, quick view).
- Mirage's own scripts: its runtime, the pages client API, `/__sim-static/` adapters, local head scripts and frame
  readiness. Power Pages has its own equivalents of these.

Render provenance decides which writer produced a script. A script element that a data value wrote gets no nonce, for
example a record field printed without `| escape`. The same applies to a script tag with Liquid inside the tag. A
script outside the HTML namespace, such as a script that a record's `<svg>` puts into an SVG context, keeps the nonce
only when its writer also wrote all of its content. The browser decodes character references in such a script, so a
value printed with `| escape` or `| json` could end a string literal that the source opened. A script inside `select`,
`option`, `optgroup`, `datalist` or `selectedcontent` gets the same rule. The HTML parser that Mirage uses still reads
select content with the earlier parsing rules and ignores an `<svg>` there. A current browser (Chromium 158) inserts
the `<svg>`, so a record that prints `<select><svg>` turns the authored script after it into an SVG script. In the
HTML namespace a script's content is raw text, where `&quot;` stays as written, so an authored script there that
interpolates a value with `| escape` keeps its nonce.

An inline event handler gets a hash only when its own start tag writes it. The parser moves the attributes of a later
`<html>` or `<body>` tag, which a record value can print, onto the document's first such tag. Mirage withholds the hash
from those handlers even when the first tag is source text.

Mirage marks its scripts positively. Every attribute that Mirage adds to a start tag goes directly after the tag name:
the nonce, the binding stamps and its own markers. In that position the attribute always starts a new attribute, even
in a tag like `<script x=>`, where text added before the `>` would become the value of `x`. Mirage adds its own scripts
after the rendered scripts are decided, and each of them carries an attribute name that is random for the response.
When the response is finished, only the scripts with that attribute and the scripts decided as proved carry the nonce.
Any other script stays without it, whatever wrote it. Mirage removes the attribute before it sends the response. Mirage
puts its scripts and the anti-forgery holder at the source locations of the document's real head and body tags. It never
uses the first text that looks like such a tag, which a record value in an attribute can contain. Learn
says that Power Pages injects the nonce into Liquid output after rendering, and it does not say how such data is
treated online. Hosted sites give the nonce to every script element of a rendered page, also one written from a
record field, a snippet or a string built in Liquid, and an authored external script, and they hash every inline
handler, also one a record writes (hosted session F3, two runs). By default Mirage keeps the safe treatment: the browser
blocks these scripts locally and the page reports `PORTAL_CSP_NONCE_WITHHELD` with the number of scripts and handlers
left without the nonce, and a message that states the hosted behaviour. Authored external scripts (`<script src>`) get
no nonce by default. Their host must be listed in `script-src`, as Learn's troubleshooting section says. A site that
relies on the hosted behaviour records it as an observation:

```yaml
observed:
  scriptNonceScope: every-script
  evidence: <where the scripts were observed running>
```

Every script element whose start tag can carry the attribute then gets the nonce, and every inline handler its hash,
as online: data-written script markup then runs locally too, as it does on the hosted site.
Scripts that run JavaScript creates at run time cannot get the nonce. Learn documents the same limit.

Inline event handlers on proved elements are allowed through hashes. Learn says that Power Pages secures handlers
through automatic hash generation. In the platform default policy the hashes take the place of `'inject-hashes'`, as
hosted pages send them. A site's own enforced policy gets them the same way. In the report-only policy, whose hosted text is not observed,
Mirage adds `'unsafe-hashes'` and one `'sha256-…'` source per handler to the directive that holds the placeholder.

The search page and a custom error page (`observed.pageErrorPresentation`) prove none of their scripts. They still carry
the policy, so a script in them stays blocked and is reported. Responses without scripts, such as Web API answers, files and the anti-forgery fragment,
carry the enforced nonce policy with a fresh nonce, as described above; a report-only nonce policy is omitted there. A nonce source other than the placeholder, such as a fixed
`'nonce-value'` or a malformed one, has no documented meaning. Mirage omits that policy and reports
`PORTAL_HTTP_CSP_NONCE_UNSUPPORTED`.

## Loopback transport

The hosted site is served over HTTPS, so an `https:` scheme source matches the site's own origin there. Mirage listens
on http loopback, which `https:` does not match. In each directive of the site's policies that has an `https:` source
and no `'self'`, Mirage adds `'self'` to its local responses. `'self'` is the loopback origin, which stands in for the
hosted HTTPS origin. Nothing else in the policy changes. The confinement policy is never adapted. For example, the
documented `style-src 'unsafe-inline' https:` is sent locally as `style-src 'unsafe-inline' https: 'self'`, so the
site's own stylesheets load as they do online. The adaptation is reported once with the info diagnostic
`PORTAL_HTTP_CSP_LOOPBACK_TRANSPORT`, which lists the settings and directives it changed.
