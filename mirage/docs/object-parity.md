# Configuration objects

How Mirage treats exported Power Pages configuration records (redirects, page templates, web templates, web files and their children), and the `observed` settings that reproduce a deployment's response details the export cannot express.

## Import rules

- **Record status.** Enhanced component XML keeps the record's lifecycle `statuscode` in the component envelope. Content fields stay independent: a redirect's content `statuscode` is its HTTP status, while the envelope status is the record lifecycle. Legacy sources without the envelope derive status from state.
- **Page template type.** An explicit page-template Type selects Rewrite or Web Template even when both references are populated. Rewrite uses the ASP.NET layout and its page copy; the Web Template header/footer switch applies only to web-template responses. Resource inspection leaves an unselected web template out of the include chain.
- **Rewrite targets.** A populated portal route is not a physical ASP.NET rewrite target and answers a route-handler error. Other `.aspx` layouts are not rendered.
- **Children and associations.** Automatic language children, component envelopes, binary attachments and role associations are imported as their own records. A successful association request alone does not make an effective relationship or permission.

## Response observations

These settings go in the site's `observed` block with `observed.evidence` naming where you observed the behaviour. Omitting a setting keeps the default.

| Setting | Default | Observed behaviour |
| --- | --- | --- |
| `redirect301: "temporary"` | `"configured"` | Redirect records configured as 301 answer 302. Canonical slash redirects, source values and other status codes are unchanged. |
| `webTemplateResponseNewline: "crlf"` | `"none"` | No-header web-template responses (including plain text and JSON) end with an appended CRLF; authored endings are not trimmed. |
| `webFileMimeCharset: "source"` | `"utf8"` | Web files keep the attachment MIME type instead of gaining a UTF-8 charset. |
| `siteMarkerRedirect: "null-reference"` | `"resolve"` | Marker-only redirect records answer 500 with the captured exception message. A populated URL or page target still wins. The body is a local diagnostic, not the hosted error-page shell. |

## Comparing with a live site

Lense applies eligible local source patches in its dedicated live browser; configuration records can still require deployment, so check applied resources, unmatched patches and deployment diagnostics after refresh. Mirage runs its own identity and data, so match the observed roles before comparing permission outcomes.

When comparing responses, record a redirect's first HTTP response separately from the followed navigation, and compare decoded bytes, MIME type, disposition, selected headers and error messages independently. Table permissions, column permissions and page permissions use different transports and authorization modes, so compare each separately. See [reference parity evidence](parity-evidence.md), [Liquid](liquid-parity.md) and [Dataverse](dataverse-parity.md).
