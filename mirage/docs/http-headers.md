# HTTP transport and CORS

Power Pages answers on HTTPS behind its edge, and Mirage answers on http loopback. This page describes how Mirage
handles the headers that belong to that difference: `Strict-Transport-Security` and the CORS headers of the
`HTTP/Access-Control-*` site settings. The edge controls that Mirage does not emulate are listed at the end, with the
Lense report that reads them on the live site.

## Strict-Transport-Security

Learn's Advanced settings page says that the HSTS header of a site cannot be modified. The hosted front end sends it on
every response, and the CORS check of a hosted root observed it in every probe. An exported
`HTTP/Strict-Transport-Security` setting is therefore not sent. It is reported as `PORTAL_HTTP_HSTS_UNSUPPORTED`.

A site records the header that it sends as an observation:

```yaml
observed:
  strictTransportSecurity: max-age=31536000; includeSubDomains
  evidence: <where the header was observed>
```

The value must follow RFC 6797: one `max-age`, plus `includeSubDomains` and `preload` if the site sends them. Mirage
sends it on page, web file and Web API responses of its http loopback listener.

Browsers ignore this header on loopback. RFC 6797 section 8.1 says that a user agent must ignore the header when it
arrives over a transport that is not secure, and Chromium and Firefox store HSTS only from a valid TLS connection. The
header is there so that header comparisons with the live site (Lense, parity captures) see the same value. Mirage never
sends it over TLS. HSTS is keyed by host, not by port, so a browser that stored it for `localhost` would force every
other local server on that host to HTTPS until `max-age` expires. The response headers helper sends the observed value
only when its transport is the http loopback listener (`loopback`, the default).

## CORS for authored pages

Learn's HTTP headers page lists the CORS settings: `HTTP/Access-Control-Allow-Origin`, `-Allow-Methods`,
`-Allow-Headers`, `-Allow-Credentials`, `-Expose-Headers` and `-Max-Age`. Learn's Azure AD B2C recipe sets two of them
and publishes an authored page that the B2C origin loads across origins.

The export does not show which responses the platform gives these headers. A spare site had the three settings
applied to its private root: across 42 probes, with the settings, after the documented Clear config and after the
restore, the root sent no `Access-Control-*` header to the allowed origin, to another origin or to any preflight. So
Mirage refuses cross-origin requests (403, no CORS header) unless a site records the authored pages that it was
observed to share:

```yaml
observed:
  corsPages:
    - /identity-layout/
  siteVisibility: public
  evidence: <where the cross-origin answer was observed>
```

`corsPages` needs `siteVisibility: public` in the same observation, because a private site cannot be read across
origins. Each entry is a page path that ends in `/`, and the root is not allowed. A listed page is shared only when
all of these hold:

- It is one exported page. Its page template renders a web template with the website header and footer turned off,
  as in the B2C recipe.
- The web template source contains no Liquid. The page renderer writes the toolkit's request tokens into a page, so
  Mirage never renders a page for another origin. The answer is the literal web template source.
- The anonymous visitor may read the page (page permissions and publishing state).
- The runtime is in local mode and does not gate the site as private (`privateSiteContactIds`).

A request is answered only when it comes from an allowed origin and carries no credentials:

- `Origin` is one serialized origin. `null`, a list of origins and an origin with a path are refused.
- `HTTP/Access-Control-Allow-Origin` holds one or more exact origins, separated by commas or spaces, or `*` alone.
  Mirage returns the request's origin only when it is listed. For `*` it returns `*`, never the request's origin.
  `*` together with `HTTP/Access-Control-Allow-Credentials: true` is refused for every request, as the Fetch standard
  and Learn's security best practices require.
- The request carries no `Cookie` and no `Authorization`, and no query string.
- A preflight (`OPTIONS` with `Access-Control-Request-Method`) asks for `GET` or `HEAD`. The method must be listed in
  `-Allow-Methods` when that setting exists, and every requested header must be listed in `-Allow-Headers`. A
  preflight that asks for private or local network access is refused. The answer is 204 with the origin, the granted
  methods, the requested headers, `-Max-Age` when it is a number, `Access-Control-Allow-Credentials: true` when it is
  configured for an exact origin, and `Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers`.
- `GET` and `HEAD` answer 200 with the literal source, `text/html; charset=utf-8`, `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, `Vary: Origin`, the origin and the `-Expose-Headers` names. The answer sets no
  cookie, and it carries no other site header.

Everything else keeps the ordinary cross-origin refusal. A refusal of a listed page reports `PORTAL_HTTP_CORS_REFUSED`
with the path and the reason. The info diagnostic `PORTAL_HTTP_CORS_PAGES` lists the shared pages.
`PORTAL_HTTP_CORS_PAGE_REFUSED` lists each listed page that cannot be shared, with its reason (`liquid`,
`website-header-footer`, `page-not-found`, `wildcard-credentials`, and so on). A site with CORS settings and no
`corsPages` keeps `PORTAL_HTTP_CORS_UNSUPPORTED`. Same-origin requests to these pages are rendered as usual and carry
no CORS header.

A hosted capture of a positive answer for an authored public page is still open, so the header set above is a local
profile. A browser that enforces Local Network Access may also ask the user before a public origin can read a
loopback page; that prompt is outside Mirage.

## Edge controls that Mirage does not emulate

The hosted edge applies these controls before a request reaches the site. They are not in the export, and Mirage does
not apply them:

| Control                       | Local runtime                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| Site visibility               | `observed.siteVisibility`: the private-site banner, and admission with `privateSiteContactIds` |
| IP restrictions               | Not emulated: every loopback request comes from the local machine.                             |
| WAF custom rules, rate limits | Not emulated: Mirage filters and limits no request.                                            |
| WAF managed rule sets         | Not emulated: the rule content and anomaly thresholds are not published.                       |
| TLS versions and ciphers      | Not applicable: the listener is plain http.                                                    |

`readPowerPagesEdge` from `paqvilo/dataverse` reads these controls on a live site with read-only PAC commands. See
[Lense](../../docs/lense.md#edge-controls-of-the-live-site).
