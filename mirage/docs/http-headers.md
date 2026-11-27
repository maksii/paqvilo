# HTTP transport and CORS

Power Pages answers on HTTPS behind its edge, and Mirage answers on http loopback. This page describes how Mirage
handles the headers that belong to that difference: `Strict-Transport-Security` and the CORS headers of the
`HTTP/Access-Control-*` site settings. The edge controls in front of the site (IP restrictions and WAF custom rules,
modelled from observations, and what stays out) are described at the end, with the Lense report that reads them on the
live site.

## Strict-Transport-Security

Learn's Advanced settings page says that the HSTS header of a site cannot be modified. The hosted front end sends it on
every response, and the CORS check of a hosted root observed it in every probe. An exported
`HTTP/Strict-Transport-Security` setting is therefore not sent. It is reported as `PORTAL_HTTP_HSTS_UNSUPPORTED`.

A site records the header that it sends as an observation:

```yaml
observed:
  strictTransportSecurity: max-age=31536000; includeSubDomains; preload
  evidence: <where the header was observed>
```

The value must follow RFC 6797: one `max-age`, plus `includeSubDomains` and `preload` if the site sends them. The value
above is the one hosted sites sent on every response in hosted session F5. Mirage sends it on every response of its
http loopback listener: pages, redirects, errors, web files and Web API answers.

Browsers ignore this header on loopback. RFC 6797 section 8.1 says that a user agent must ignore the header when it
arrives over a transport that is not secure, and Chromium and Firefox store HSTS only from a valid TLS connection. The
header is there so that header comparisons with the live site (Lense, parity captures) see the same value. Mirage never
sends it over TLS. HSTS is keyed by host, not by port, so a browser that stored it for `localhost` would force every
other local server on that host to HTTPS until `max-age` expires. The response headers helper sends the observed value
only when its transport is the http loopback listener (`loopback`, the default).

## CORS settings

Learn's HTTP headers page lists the CORS settings: `HTTP/Access-Control-Allow-Origin`, `-Allow-Methods`,
`-Allow-Headers`, `-Allow-Credentials`, `-Expose-Headers` and `-Max-Age`.

Hosted sites send each of these settings with its value as written, as a fixed header on every response (hosted
session F5, two runs). The header does not depend on the request's `Origin` (none, the allowed origin or another one),
on the method (`GET`, `HEAD`, `POST`, `OPTIONS`), on the route or on the status (200, 302, 404). The platform does
not echo the request's origin and sends no `Vary: Origin`. An `OPTIONS` request gets no preflight answer: the route
answers it as it answers any request, for example `/_services/about` with 200 and its body, `/_layout/tokenhtml` with
404 and a page of a private site with the sign-in redirect. A site without these settings sends no such header.

Mirage sends the settings the same way on every response of the portal listener that its origin boundary admits:
each value as written, with no origin logic and no `Vary: Origin`. It has no preflight answer either: an `OPTIONS`
request reaches its route, and the anti-forgery fragment answers `HEAD`, `POST` and `OPTIONS` with an empty 404, as
online. The boundary itself is unchanged. The local runtime
refuses a request from another origin (403, without any site header), so a page on another origin cannot read the
loopback runtime, whatever the settings allow. A site with CORS settings and no `corsPages` observation reports the
warning `PORTAL_HTTP_CORS_LOOPBACK_BOUNDARY` with the setting names. `HTTP/Access-Control-Allow-Origin: *` with
`HTTP/Access-Control-Allow-Credentials: true` is never sent as a pair: the Fetch standard refuses it and Learn's
security best practices say not to combine them, and no hosted site was captured with it. Mirage sends the origin
without the credentials header and reports `PORTAL_HTTP_CORS_WILDCARD_CREDENTIALS`.

The cross-origin answer of a public site was not captured (F5 captured private sites, where every cross-origin request
fails at the sign-in redirect). Mirage therefore refuses cross-origin requests by default and admits only the authored
pages a public site was observed sharing:

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
`website-header-footer`, `page-not-found`, `wildcard-credentials`, and so on). Same-origin requests to these pages
are rendered as usual, with the settings as fixed headers as above.

A hosted capture of a positive cross-origin answer for an authored public page is still open, so the answer above is a
local profile. A value that a header cannot carry (a line break, a control character or a character outside Latin-1,
such as `€`) is not sent, for any `HTTP/*` setting, and `PORTAL_HTTP_HEADER_INVALID` names the setting.

## Edge controls

The hosted edge applies these controls before a request reaches the site. They are not in the export:

| Control                       | Local runtime                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| Site visibility               | `observed.siteVisibility`: the private-site banner, and admission with `privateSiteContactIds`    |
| IP restrictions               | `observed.ipRestrictions`: a visitor address outside the allow list gets the hosted 403 page      |
| WAF custom rules, rate limits | `observed.firewall`: a local model of the rules; an undecidable rule fails closed                 |
| WAF managed rule sets         | Not emulated: the rule content and anomaly thresholds are not published.                          |
| HSTS on an HTTPS loopback     | Not emulated: HSTS is keyed by host, so it would pin `localhost` to HTTPS for every local server. |
| TLS versions and ciphers      | Not applicable: the listener is plain http.                                                       |

`readPowerPagesEdge` from `paqvilo/dataverse` reads these controls on a live site with read-only PAC commands, and its
`local` section names the observation and the value that models each one. See
[Lense](../../docs/lense.md#edge-controls-of-the-live-site).

```yaml
observed:
  ipRestrictions: [203.0.113.7/32, 2001:db8::/32]
  firewall:
    mode: Prevention
    customRules:
      - name: BlockPrivateArea
        priority: 10
        action: Block
        matchConditions:
          - { matchVariable: RequestUri, operator: StartsWith, values: [/private] }
  evidence: <where the allow list and the rules were read>
```

### IP restrictions

`ipRestrictions` lists the allowed addresses and CIDR ranges (`{ ipAddress, type }` entries are accepted as well), or
takes `{ allowed, withheld }` as `readPowerPagesEdge` reports it in `local.ipRestrictions.value`: `withheld` counts the
rows the read could not report. A list without rows restricts nothing. With withheld rows, a visitor address that the
known entries do not admit might be on one of them: Mirage refuses it, failing closed, logs why and reports
`PORTAL_EDGE_IP_RESTRICTION_WITHHELD`. Hosted
session F5 recorded the hosted behaviour twice: with an allow list that does not hold the caller, every path answers
403 with the Azure "Web App - Unavailable" page, `content-type: text/html`, an `x-ms-forbidden-ip` header naming the
caller and no site header. Mirage answers the same way, with a shortened page of the same title and text, on every
method, before any site header, sign-in, cookie or cross-origin page answer (`observed.corsPages`). The visitor address
is the loopback connection's (`127.0.0.1` or `::1`), so a recorded list without a loopback entry refuses every portal
request, as a visitor outside the list is refused online; `PORTAL_EDGE_IP_RESTRICTION` says so (a warning). The
custom rules below run at the same point. Both apply to the portal-facing simulator routes as well (native form posts
under `/_sim/forms/`, the local sign-in page, the scripts portal pages load); only the administration surface (the
`/_sim/` console, its assets and the admin API) is outside them and stays reachable.

### WAF custom rules

`firewall.customRules` takes the rules as `readPowerPagesEdge` reports them in `firewall.customRules.rules`, or in the
Power Platform API's shape (`matchValue` for `values`): `name`, `priority`, `enabledState`, `action` (`Allow`, `Block`,
`Log`), `ruleType` (`MatchRule`, `RateLimitRule` with `rateLimitThreshold` and `rateLimitDurationInMinutes`, 1 to 5)
and `matchConditions` (`matchVariable`, `operator` `Contains`, `EndsWith`, `Equals`, `GeoMatch` or `StartsWith`,
`negateCondition`, `selector`, `transforms`, `values`). `mode` is the policy mode, `Prevention` or `Detection`.

Hosted enforcement of a custom rule was not observed (in session F5 the firewall never reached `Created`), so the
evaluation is a local model of Azure Front Door's custom rules, reported as `PORTAL_EDGE_FIREWALL_LOCAL_MODEL`: enabled
rules run in priority order, the conditions of a rule must all match and any value of a condition matches; `Allow`
admits the request without the later rules, `Block` answers 403 before the site, `Log` writes a `request` log line with
`kind: edge` and goes on, and a rate-limit rule acts once one client address sent more than its threshold in its window.
In `Detection` mode a `Block` rule is logged, not enforced. `RemoteAddr` and `SocketAddr` are the connection's address
(`Equals` matches an address or a range that holds it), `RequestUri` is the path and query string, and `QueryString`,
`RequestHeader` and `Cookies` (by `selector`) and `RequestMethod` are read from the request.

Where the local runtime cannot know the answer, the rule fails closed: a `Block` rule acts and an `Allow` rule does not,
and the log line names the reason. That is the case for a `GeoMatch` condition (no geolocation of a local address),
values the read withheld (`values: null`: Lense reports only the count for headers, cookies, query strings and bodies),
`PostArgs` and `RequestBody` of a request that has a body (the local gate does not read it before the site), and a
comparison whose result depends on letter case. `PORTAL_EDGE_FIREWALL_RULE_UNDECIDED` lists the rules with conditions
that can never be decided, and `PORTAL_EDGE_FIREWALL_MODE_UNRECORDED` warns that a rule set without `mode` is enforced.
The hosted block response was not observed; Mirage answers 403 with a short "The request is blocked." page. The managed
rule set stays out: exact parity would need its tuned rule content and anomaly thresholds, which are not published.
