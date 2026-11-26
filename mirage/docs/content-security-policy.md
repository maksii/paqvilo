# Content Security Policy

Mirage sends the policies a site's settings define on its local responses: `HTTP/Content-Security-Policy` (enforced)
and `HTTP/Content-Security-Policy-Report-Only`, as Power Pages does
([Manage your site's Content Security Policy](https://learn.microsoft.com/power-pages/security/manage-content-security-policy)).
A site without these settings gets no site policy, unless it records the platform default described below. The
optional loopback confinement policy (`confinePortalPages`, [configuration](../../docs/configuration.md)) is a separate
header that Mirage adds on its own. HSTS and CORS are described in [HTTP transport and CORS](http-headers.md).

## Platform default policy

Learn says that sites created after November 10, 2025 have CSP enabled by default with this policy:

```text
script-src 'self' content.powerapps.com content.powerapps.us content.appsplatform.us content.powerapps.cn 'nonce';
style-src 'unsafe-inline' https:;
```

The export does not show the default: a site created after that date has no `HTTP/Content-Security-Policy` row, and a
PAC export carries no website creation date. A site that sends the default records it as an observation:

```yaml
observed:
  defaultContentSecurityPolicy: platform
  evidence: <where the header was observed>
```

Mirage then sends the documented policy, with the two directives joined by one space, while the site has no
`HTTP/Content-Security-Policy` setting. The nonce, handler hash and loopback rules below apply to it as to a configured
policy, and the info diagnostic `PORTAL_HTTP_CSP_PLATFORM_DEFAULT` reports it. An exported setting wins, and an empty
value disables CSP, because Learn says to clear the value rather than delete the setting. Setting
`HTTP/Content-Security-Policy/Enabled` to `false` disables it too. The default is `none`, which sends nothing. Learn documents the policy text, but
not the exact header text that Power Pages sends. A hosted root without an exported policy setting sent a nonce policy
in every probe of the private-site CORS check, which did not record the full header text.

## Script nonces

When a policy contains the documented `'nonce'` placeholder, every page response gets a fresh nonce (128 random bits).
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
treated online. Mirage chooses the safe treatment, so the browser blocks these scripts locally and the page reports
`PORTAL_CSP_NONCE_WITHHELD` with the number of scripts and handlers left without the nonce. Authored external scripts
(`<script src>`) get no nonce. Their host must be listed in `script-src`, as Learn's troubleshooting section says.
Scripts that run JavaScript creates at run time cannot get the nonce. Learn documents the same limit.

Inline event handlers on proved elements are allowed through hashes. Learn says that Power Pages secures handlers
through automatic hash generation. Mirage adds `'unsafe-hashes'` and one `'sha256-…'` source per handler to the
directive that holds the placeholder (`script-src`, `script-src-attr` or `default-src`). The exact header text that
Power Pages sends is not documented.

The search page and a custom error page (`observed.pageErrorPresentation`) prove none of their scripts. They still carry
the policy, so a script in them stays blocked and is reported. Responses without scripts, such as Web API answers,
files and the anti-forgery fragment, carry no nonce policy. A nonce source other than the placeholder, such as a fixed
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
