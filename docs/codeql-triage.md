# CodeQL baseline review

This review covers all 115 alerts from JavaScript/TypeScript analysis 1928618620 at `ffbdefb5f1ba9ab94f25b7d223d41391d1929975`. Each original source-to-sink path was inspected. The machine-readable [ledger](../.github/security/codeql-triage.json) retains the exact original locations, rule ids, decisions, evidence and validation references. Query coverage and severities remain unchanged; tests and samples remain scanned.

A **fix** includes confirmed security/quality issues and explicit hardening found during review. It does not imply every grouped analyzer warning was exploitable. A **false-positive** dismissal requires the stated constraint at the actual sink; being local or being a test alone is insufficient. Fixes remain open on main until merged and scanned there. Branch/PR CodeQL and full CI results must be verified separately before declaring this work complete.

## Behavior and trust boundaries

Lense previews sources in a dedicated browser; Mirage renders exported sources and invented/project data on loopback. Neither turns authored HTML/JavaScript, explicitly registered packs or owner-writable configuration into untrusted executable sandboxes. Browser writes and live reference reads still require the existing authorization. These fixes do not authorize deployment, live data changes or synchronizing portal sources. No live portal or private project acceptance runner was used.

`html_safe_escape` now uses a pinned maintained parser-based sanitizer with a safe-formatting allowlist. Script/foreign-content elements, executable URI schemes, unsafe inline styles and non-allowlisted attributes are intentionally removed; safe formatting, relative/HTTP(S)/FTP/mail/tel links, images, table structure and allowlisted text formatting styles remain. Sanitized HTML serialization may normalize malformed markup and void-tag spacing. `strip_html` remains the DotLiquid text transform; use `escape` for literal HTML text or `html_safe_escape` for untrusted formatted HTML. No regex tag stripper is treated as a security sanitizer.

Guarded file reads use the same descriptor for size/identity checks and bounded bytes, then reject changes in version or pathname. A file changing while a preview starts can be retried through the existing reconciliation path. No new size cap was added to previously uncapped export assets. This strengthens file-identity handling; it is not a sandbox against a malicious process with the same filesystem privileges.

The sample PCF keeps its init/update/output/destroy lifecycle, now displaying formatted values as text. Its checked-in bundle is rebuilt in production mode with the existing compiler and lint checks. Native CSV exports neutralize formula-like text; ordinary signed numeric values retain their representation.

## Validation

New regressions cover malformed/encoded/foreign HTML payloads, safe formatting, bounded adversarial XML/filename parsing, legacy filename equivalence, prototype-sensitive cookies and selected fields, generated JS quoting, hostile host classification, spreadsheet cells, swapped/growing files, admin deep-link injection, allowed/blocked link schemes, confined modal frames, and the actual rebuilt PCF lifecycle. Existing startup/concurrent-save regressions now intercept descriptor reads and still exercise changes during prefetch. Full `npm run validate`, installed-package smoke, dependency audits/signatures and hosted CI/CodeQL are required.

## Alert ledger

### [1](https://github.com/maksii/paqvilo/security/code-scanning/1) — fix

Rule: `js/polynomial-redos`; original [`mirage/lib/fetchxml-engine.mjs:151`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/fetchxml-engine.mjs#L151).

Unanchored XML token/attribute regexes can retry across overlapping malformed input received through FetchXML requests. Replaced token matching with a forward-only quote-aware scanner and sticky attribute parsing; unterminated input now fails explicitly. XML entity/declaration and depth behavior remains guarded.

Validation: mirage/test/security-regressions.test.mjs; mirage/test/fetchxml-limits.test.mjs; mirage/test/fetchxml-parity.test.mjs.

### [2](https://github.com/maksii/paqvilo/security/code-scanning/2) — fix

Rule: `js/polynomial-redos`; original [`mirage/lib/fetchxml-engine.mjs:161`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/fetchxml-engine.mjs#L161).

Unanchored XML token/attribute regexes can retry across overlapping malformed input received through FetchXML requests. Replaced token matching with a forward-only quote-aware scanner and sticky attribute parsing; unterminated input now fails explicitly. XML entity/declaration and depth behavior remains guarded.

Validation: mirage/test/security-regressions.test.mjs; mirage/test/fetchxml-limits.test.mjs; mirage/test/fetchxml-parity.test.mjs.

### [3](https://github.com/maksii/paqvilo/security/code-scanning/3) — fix

Rule: `js/polynomial-redos`; original [`mirage/lib/fetchxml-engine.mjs:164`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/fetchxml-engine.mjs#L164).

Unanchored XML token/attribute regexes can retry across overlapping malformed input received through FetchXML requests. Replaced token matching with a forward-only quote-aware scanner and sticky attribute parsing; unterminated input now fails explicitly. XML entity/declaration and depth behavior remains guarded.

Validation: mirage/test/security-regressions.test.mjs; mirage/test/fetchxml-limits.test.mjs; mirage/test/fetchxml-parity.test.mjs.

### [4](https://github.com/maksii/paqvilo/security/code-scanning/4) — fix

Rule: `js/polynomial-redos`; original [`mirage/lib/odata-feeds.mjs:113`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/odata-feeds.mjs#L113).

The sticky OData tokenizer combines whitespace and numeric matching with a trailing boundary check. Whitespace is now consumed separately and the boundary is checked after maximal numeric matching, avoiding repeated numeric alternatives without accepting invalid trailing syntax.

Validation: mirage/test/odata-parity.test.mjs; full validation.

### [5](https://github.com/maksii/paqvilo/security/code-scanning/5) — fix

Rule: `js/polynomial-redos`; original [`mirage/lib/platform.mjs:278`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/platform.mjs#L278).

An unterminated <head prefix can cause the unanchored [^>]* expression to repeatedly scan the rest of the document. Restricting the tag body to [^<>]* with a head word boundary keeps matching linear and avoids treating <header> as <head>.

Validation: mirage/test/portal-client-object.test.mjs; mirage/test-browser/platform-shell.test.mjs.

### [6](https://github.com/maksii/paqvilo/security/code-scanning/6) — fix

Rule: `js/polynomial-redos`; original [`mirage/lib/platform.mjs:279`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/platform.mjs#L279).

An unterminated <head prefix can cause the unanchored [^>]* expression to repeatedly scan the rest of the document. Restricting the tag body to [^<>]* with a head word boundary keeps matching linear and avoids treating <header> as <head>.

Validation: mirage/test/portal-client-object.test.mjs; mirage/test-browser/platform-shell.test.mjs.

### [7](https://github.com/maksii/paqvilo/security/code-scanning/7) — fix

Rule: `js/polynomial-redos`; original [`mirage/lib/source-dependencies.mjs:141`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/source-dependencies.mjs#L141).

Numeric filename alternatives contain dots inside a repeated dot-separated group, allowing exponential backtracking and repeated matching of .min. Replaced the core-library expressions with deterministic basename scanners retaining the .test interface. Query text cannot impersonate a filename.

Validation: mirage/test/security-regressions.test.mjs: bounded subprocess and legacy short-input differential cases; mirage/test/runtime-compatibility.test.mjs.

### [8](https://github.com/maksii/paqvilo/security/code-scanning/8) — fix

Rule: `js/polynomial-redos`; original [`mirage/lib/source-dependencies.mjs:166`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/source-dependencies.mjs#L166).

Numeric filename alternatives contain dots inside a repeated dot-separated group, allowing exponential backtracking and repeated matching of .min. Replaced the core-library expressions with deterministic basename scanners retaining the .test interface. Query text cannot impersonate a filename.

Validation: mirage/test/security-regressions.test.mjs: bounded subprocess and legacy short-input differential cases; mirage/test/runtime-compatibility.test.mjs.

### [9](https://github.com/maksii/paqvilo/security/code-scanning/9) — fix

Rule: `js/polynomial-redos`; original [`mirage/server.mjs:3098`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/server.mjs#L3098).

Adapter header extraction splits an ambiguous path/name regex into one maximal path match followed by basename and suffix operations. This preserves adapter names while eliminating repeated repartition of long dash/dot filenames.

Validation: mirage/test-browser/local-compatibility.test.mjs; full browser validation.

### [10](https://github.com/maksii/paqvilo/security/code-scanning/10) — fix

Rule: `js/redos`; original [`mirage/lib/source-dependencies.mjs:20`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/source-dependencies.mjs#L20).

Numeric filename alternatives contain dots inside a repeated dot-separated group, allowing exponential backtracking and repeated matching of .min. Replaced the core-library expressions with deterministic basename scanners retaining the .test interface. Query text cannot impersonate a filename.

Validation: mirage/test/security-regressions.test.mjs: bounded subprocess and legacy short-input differential cases; mirage/test/runtime-compatibility.test.mjs.

### [11](https://github.com/maksii/paqvilo/security/code-scanning/11) — fix

Rule: `js/redos`; original [`mirage/lib/source-dependencies.mjs:24`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/source-dependencies.mjs#L24).

Numeric filename alternatives contain dots inside a repeated dot-separated group, allowing exponential backtracking and repeated matching of .min. Replaced the core-library expressions with deterministic basename scanners retaining the .test interface. Query text cannot impersonate a filename.

Validation: mirage/test/security-regressions.test.mjs: bounded subprocess and legacy short-input differential cases; mirage/test/runtime-compatibility.test.mjs.

### [12](https://github.com/maksii/paqvilo/security/code-scanning/12) — fix

Rule: `js/identity-replacement`; original [`mirage/parity-suite.mjs:340`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/parity-suite.mjs#L340).

The final GUID URL replacement is an identity operation with no normalization effect. Removed it without changing URL output.

Validation: mirage/test/parity-suite.test.mjs.

### [13](https://github.com/maksii/paqvilo/security/code-scanning/13) — fix

Rule: `js/xss`; original [`mirage/admin/app.mjs:1546`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/admin/app.mjs#L1546).

The traced view name is allowlisted at initial load and hashchange, but review found a separate real injection in the same rendering path: audit kind values from the deep link were inserted into option HTML without escaping. Escape both option attributes and text; replace object renderer dispatch with Map and restrict audit-filter writes to own keys.

Validation: mirage/test-browser/admin-audit.test.mjs: hostile kind deep link and invalid prototype hash; existing admin browser tests.

### [14](https://github.com/maksii/paqvilo/security/code-scanning/14) — fix

Rule: `js/xss-through-dom`; original [`examples/project/components/pcf-field-control/ExampleLinearInput/index.ts:42`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/examples/project/components/pcf-field-control/ExampleLinearInput/index.ts#L42).

The flagged range-input value is constrained by the browser, but adjacent init/updateView paths wrote externally formatted PCF values through innerHTML. All three label writes now use textContent. Rebuilt the checked-in sample bundle from TypeScript with the existing PCF tooling in production mode, including its license sidecar.

Validation: mirage/test-browser/security-compatibility.test.mjs: real built sample init/update/input/getOutputs/destroy with hostile formatted values; PCF production compiler and ESLint.

### [15](https://github.com/maksii/paqvilo/security/code-scanning/15) — fix

Rule: `js/xss-through-dom`; original [`mirage/lib/crmentityformview-compat.js:268`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/crmentityformview-compat.js#L268).

Readonly URL values reached href without a scheme gate. Resolve URLs and permit the supported HTTP(S), FTP(S), OneNote, tel and mailto protocols; executable javascript/data schemes remain visible as non-link inputs. Target=_blank links also receive noopener/noreferrer.

Validation: mirage/test-browser/security-compatibility.test.mjs: executable, newline, data, relative, FTP and email URLs; native form browser tests.

### [16](https://github.com/maksii/paqvilo/security/code-scanning/16) — fix

Rule: `js/xss-through-dom`; original [`mirage/lib/entity-grid-compat.js:515`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/entity-grid-compat.js#L515).

Modal frame src could accept an executable URL from action/DOM metadata. Resolve the address and require HTTP(S) plus the current origin before opening the frame; real local forms still load.

Validation: mirage/test-browser/security-compatibility.test.mjs; mirage/test-browser/solution-form.test.mjs; mirage/test-browser/grid-action-menu.test.mjs.

### [17](https://github.com/maksii/paqvilo/security/code-scanning/17) — false-positive

Rule: `js/xss-through-dom`; original [`mirage/lib/richtext-actions.mjs:92`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/richtext-actions.mjs#L92).

richtext-actions parses the hidden JSON string into a detached DOMParser document and reads body.textContent.includes(text). No node or markup from that document is inserted into the active page, so this path cannot execute script or handlers. This is a text assertion helper, not a sanitizer. Detached parsing can fetch resources; that separate browser behavior is not an XSS dismissal rationale.

Validation: mirage/lib/richtext-actions.mjs: waitForRichText; mirage/test-browser/richtext-form.test.mjs; DOMParser specification/MDN.

### [18](https://github.com/maksii/paqvilo/security/code-scanning/18) — false-positive

Rule: `js/xss-through-dom`; original [`mirage/test-browser/local-compatibility.test.mjs:179`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/test-browser/local-compatibility.test.mjs#L179).

The exact DOMParser sink reads textContent solely to compare the invented editor value "Compatibility formatted text" in a browser assertion. The detached tree is never adopted into the live DOM and scripts cannot execute through this path.

Validation: mirage/test-browser/local-compatibility.test.mjs: rich-text assertion; DOMParser inert-document semantics.

### [19](https://github.com/maksii/paqvilo/security/code-scanning/19) — fix

Rule: `js/unsafe-jquery-plugin`; original [`mirage/lib/jquery-blockui-compat.js:120`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/jquery-blockui-compat.js#L120).

The reported plugin $() call handles an existing node/jQuery object, not a string. Make that contract explicit with typeof message !== string before passing it to $(). The separate append(message) API intentionally accepts trusted authored HTML like blockUI; it is not an untrusted-text sanitizer.

Validation: mirage/test-browser/platform-app-equivalents.test.mjs; mirage/test-browser/local-compatibility.test.mjs; full browser validation.

### [20](https://github.com/maksii/paqvilo/security/code-scanning/20) — false-positive

Rule: `js/bad-tag-filter`; original [`lense/html-rewriter.mjs:147`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/lense/html-rewriter.mjs#L147).

rawEnd is a script raw-text lexer, not an HTML comment sanitizer. HTML script escaped-dash-dash and double-escaped-dash-dash states end on > after --; --!> follows the script escaped state transitions and is not the normal HTML comment-close transition. The normal comment lexer separately supports malformed comment endings. Adding --!> here would change browser script boundaries.

Validation: lense/html-rewriter.mjs: rawEnd/readTag; test/rewrite-safety.test.mjs: HTML malformed-comment recovery and script comment/double-escape cases; WHATWG script tokenizer states.

### [21](https://github.com/maksii/paqvilo/security/code-scanning/21) — false-positive

Rule: `js/bad-tag-filter`; original [`mirage/lib/liquid-filters.mjs:692`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/liquid-filters.mjs#L692).

strip_html implements the DotLiquid/Power Pages text-transform contract. Its replacement result is returned as a string; it is not the html_safe_escape security filter and promises no HTML sanitization. Preserve its parity behavior and document using escape for literal text or html_safe_escape for formatted untrusted HTML. No query coverage is removed.

Validation: mirage/test/liquid-portal-parity.test.mjs: strip_html parity; mirage/docs/liquid-parity.md; DotLiquid StandardFilters.StripHtml.

### [22](https://github.com/maksii/paqvilo/security/code-scanning/22) — false-positive

Rule: `js/bad-tag-filter`; original [`mirage/lib/shell-capture.mjs:97`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/shell-capture.mjs#L97).

signInDocument removes comment/script/style ranges only from a temporary head string used to extract a title and decide whether reference capture is a sign-in page. It returns a boolean, and never serves the replacement string as HTML. Imperfect range classification does not create an HTML execution sink.

Validation: mirage/lib/shell-capture.mjs: signInDocument; mirage/test/shell-capture.test.mjs and capture tests; reviewed boolean return and all callers.

### [23](https://github.com/maksii/paqvilo/security/code-scanning/23) — false-positive

Rule: `js/bad-tag-filter`; original [`mirage/test/header-notification-capture.test.mjs:134`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/test/header-notification-capture.test.mjs#L134).

The regular expression is assert.doesNotMatch for a fixed malicious literal whose HTML-escaped representation is asserted immediately beforehand. It neither removes tags nor outputs HTML. Upper-case SCRIPT is irrelevant to this exact lower-case test input.

Validation: mirage/test/header-notification-capture.test.mjs: literal notification escaping regression.

### [24](https://github.com/maksii/paqvilo/security/code-scanning/24) — false-positive

Rule: `js/bad-tag-filter`; original [`mirage/webapi-inventory.mjs:603`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/webapi-inventory.mjs#L603).

The script-range regex only assigns original source offsets to classify literal FetchXML as Web API, metadata or Liquid include input. It never sanitizes/re-emits HTML. Returned XML goes to the non-resolving FetchXML planner, not browser execution.

Validation: mirage/webapi-inventory.mjs: collect fetchSources; mirage/test/webapi-inventory-wrappers.test.mjs.

### [25](https://github.com/maksii/paqvilo/security/code-scanning/25) — false-positive

Rule: `js/bad-tag-filter`; original [`test/reporting.test.mjs:30`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/test/reporting.test.mjs#L30).

assert.doesNotMatch checks exact <img>/<script>/<div> literals supplied by the synthetic test, after assertions for numeric HTML entities in the markdown output. It is an assertion, not a case-insensitive sanitizer.

Validation: test/reporting.test.mjs: mapping markdown escaping test.

### [26](https://github.com/maksii/paqvilo/security/code-scanning/26) — false-positive

Rule: `js/incomplete-multi-character-sanitization`; original [`lense/audit-json.mjs:29`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/lense/audit-json.mjs#L29).

inspectComponentJson removes XML comment/CDATA spans only for counting paired content elements against componentContentSpan. The temporary string is not emitted; the result is parsed JSON plus inventory diagnostics. It cannot become injected HTML.

Validation: lense/audit-json.mjs: inspectComponentJson; test/audit-json.test.mjs and resource inventory regressions.

### [27](https://github.com/maksii/paqvilo/security/code-scanning/27) — false-positive

Rule: `js/incomplete-multi-character-sanitization`; original [`mirage/lib/form-service.mjs:584`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/form-service.mjs#L584).

The replacement feeds empty(...), a required-field boolean predicate. It is not stored or rendered as sanitized HTML. The actual rich-text value follows the existing native form contract. A malformed comment may affect emptiness classification but cannot execute through this sink.

Validation: mirage/lib/form-service.mjs: requiredEmpty; native/rich-text form validation tests.

### [28](https://github.com/maksii/paqvilo/security/code-scanning/28) — fix

Rule: `js/incomplete-multi-character-sanitization`; original [`mirage/lib/liquid-filters.mjs:538`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/liquid-filters.mjs#L538).

html_safe_escape was a real security sanitizer implemented as successive regex deletions. Nested malformed tags, encoded/control-character URLs and foreign-content markup could bypass it. Use pinned maintained sanitize-html 2.18.0 with explicit safe tags, attributes and URI schemes. No unsafe-tag or URL regex is used as the sanitizer.

Validation: mirage/test/security-regressions.test.mjs: parser-based payload inspection and stable sanitization; Liquid parity tests; new dependency audits/signatures and package smoke.

### [29](https://github.com/maksii/paqvilo/security/code-scanning/29) — fix

Rule: `js/incomplete-multi-character-sanitization`; original [`mirage/lib/liquid-filters.mjs:538`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/liquid-filters.mjs#L538).

html_safe_escape was a real security sanitizer implemented as successive regex deletions. Nested malformed tags, encoded/control-character URLs and foreign-content markup could bypass it. Use pinned maintained sanitize-html 2.18.0 with explicit safe tags, attributes and URI schemes. No unsafe-tag or URL regex is used as the sanitizer.

Validation: mirage/test/security-regressions.test.mjs: parser-based payload inspection and stable sanitization; Liquid parity tests; new dependency audits/signatures and package smoke.

### [30](https://github.com/maksii/paqvilo/security/code-scanning/30) — fix

Rule: `js/incomplete-multi-character-sanitization`; original [`mirage/lib/liquid-filters.mjs:538`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/liquid-filters.mjs#L538).

html_safe_escape was a real security sanitizer implemented as successive regex deletions. Nested malformed tags, encoded/control-character URLs and foreign-content markup could bypass it. Use pinned maintained sanitize-html 2.18.0 with explicit safe tags, attributes and URI schemes. No unsafe-tag or URL regex is used as the sanitizer.

Validation: mirage/test/security-regressions.test.mjs: parser-based payload inspection and stable sanitization; Liquid parity tests; new dependency audits/signatures and package smoke.

### [31](https://github.com/maksii/paqvilo/security/code-scanning/31) — false-positive

Rule: `js/incomplete-multi-character-sanitization`; original [`mirage/lib/liquid-filters.mjs:692`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/liquid-filters.mjs#L692).

strip_html implements the DotLiquid/Power Pages text-transform contract. Its replacement result is returned as a string; it is not the html_safe_escape security filter and promises no HTML sanitization. Preserve its parity behavior and document using escape for literal text or html_safe_escape for formatted untrusted HTML. No query coverage is removed.

Validation: mirage/test/liquid-portal-parity.test.mjs: strip_html parity; mirage/docs/liquid-parity.md; DotLiquid StandardFilters.StripHtml.

### [32](https://github.com/maksii/paqvilo/security/code-scanning/32) — false-positive

Rule: `js/incomplete-multi-character-sanitization`; original [`mirage/lib/native-services.mjs:1991`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/native-services.mjs#L1991).

The flagged replacement strips label markup before csvCell and serves text/csv with an explicit CSV download format. It cannot create an HTML element sink. Review additionally found spreadsheet-formula interpretation in csvCell; that is fixed independently by prefixing formula-like text while retaining ordinary signed numbers.

Validation: mirage/lib/native-services.mjs: download-as-csv/excel; mirage/lib/csv.mjs; mirage/test/security-regressions.test.mjs: spreadsheet formula regression.

### [33](https://github.com/maksii/paqvilo/security/code-scanning/33) — false-positive

Rule: `js/incomplete-multi-character-sanitization`; original [`mirage/lib/shell-capture.mjs:94`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/shell-capture.mjs#L94).

signInDocument removes comment/script/style ranges only from a temporary head string used to extract a title and decide whether reference capture is a sign-in page. It returns a boolean, and never serves the replacement string as HTML. Imperfect range classification does not create an HTML execution sink.

Validation: mirage/lib/shell-capture.mjs: signInDocument; mirage/test/shell-capture.test.mjs and capture tests; reviewed boolean return and all callers.

### [34](https://github.com/maksii/paqvilo/security/code-scanning/34) — false-positive

Rule: `js/incomplete-multi-character-sanitization`; original [`mirage/lib/shell-capture.mjs:94`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/shell-capture.mjs#L94).

signInDocument removes comment/script/style ranges only from a temporary head string used to extract a title and decide whether reference capture is a sign-in page. It returns a boolean, and never serves the replacement string as HTML. Imperfect range classification does not create an HTML execution sink.

Validation: mirage/lib/shell-capture.mjs: signInDocument; mirage/test/shell-capture.test.mjs and capture tests; reviewed boolean return and all callers.

### [35](https://github.com/maksii/paqvilo/security/code-scanning/35) — false-positive

Rule: `js/incomplete-multi-character-sanitization`; original [`mirage/lib/shell-capture.mjs:94`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/shell-capture.mjs#L94).

signInDocument removes comment/script/style ranges only from a temporary head string used to extract a title and decide whether reference capture is a sign-in page. It returns a boolean, and never serves the replacement string as HTML. Imperfect range classification does not create an HTML execution sink.

Validation: mirage/lib/shell-capture.mjs: signInDocument; mirage/test/shell-capture.test.mjs and capture tests; reviewed boolean return and all callers.

### [36](https://github.com/maksii/paqvilo/security/code-scanning/36) — false-positive

Rule: `js/incomplete-multi-character-sanitization`; original [`mirage/lib/platform.mjs:549`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/platform.mjs#L549).

plainText is used for modal title/aria-label attributes, and both call sites pass its result to attr(), which HTML-encodes ampersand, angle brackets and both quotes. The unescaped title/body slots are authored native markup. A residual <script from plainText is encoded at the actual attribute sink.

Validation: mirage/lib/platform.mjs: plainText/nativeModal/attr/escape; platform native-modal browser regressions.

### [37](https://github.com/maksii/paqvilo/security/code-scanning/37) — false-positive

Rule: `js/incomplete-multi-character-sanitization`; original [`mirage/lib/sign-in-flow.mjs:594`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/sign-in-flow.mjs#L594).

registrationDisabledMessage constructs a plain error string, then passes it via SignInProblem to renderSignIn. The render path calls the sign-in page error renderer that escapes the error text; it does not insert the temporary stripped string as trusted HTML.

Validation: mirage/lib/sign-in-flow.mjs: registrationDisabledMessage/fail; mirage/server.mjs: renderSignIn; sign-in page error escaping and sign-in tests.

### [38](https://github.com/maksii/paqvilo/security/code-scanning/38) — false-positive

Rule: `js/incomplete-multi-character-sanitization`; original [`mirage/query-inventory.mjs:15`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/query-inventory.mjs#L15).

inventoryBlock drops comments solely to count literal FetchXML entities/links and produce numeric coverage summaries. No replacement result is served as HTML; dynamic/unsupported queries are reported separately.

Validation: mirage/query-inventory.mjs: inventoryBlock; mirage/test/query-inventory.test.mjs.

### [39](https://github.com/maksii/paqvilo/security/code-scanning/39) — false-positive

Rule: `js/incomplete-multi-character-sanitization`; original [`mirage/query-inventory.mjs:60`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/query-inventory.mjs#L60).

inventoryPortalTemplates removes source comments before collecting template names, file paths and query coverage counts. This analysis does not render the replacement string into a browser.

Validation: mirage/query-inventory.mjs: inventoryPortalTemplates; query-inventory tests.

### [40](https://github.com/maksii/paqvilo/security/code-scanning/40) — false-positive

Rule: `js/incomplete-multi-character-sanitization`; original [`mirage/webapi-inventory.mjs:257`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/webapi-inventory.mjs#L257).

concreteFetch removes Liquid/comment syntax to make an approximate query for static inventory. The result is fed to the XML query parser for diagnostics/coverage, never to an HTML sink, and unresolved substitutions are marked dynamic.

Validation: mirage/webapi-inventory.mjs: concreteFetch; mirage/test/webapi-inventory-wrappers.test.mjs.

### [41](https://github.com/maksii/paqvilo/security/code-scanning/41) — fix

Rule: `js/double-escaping`; original [`mirage/parity-suite.mjs:409`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/parity-suite.mjs#L409).

Source-corpus entity replacements could decode &amp;lt; twice and overstate source-derived reveal matches. Decode the supported entities in one replacement pass so each input entity is decoded once, preserving ordinary encoded source text.

Validation: mirage/test/parity-suite.test.mjs; loadSourceCorpus entity regression in security-regressions.

### [42](https://github.com/maksii/paqvilo/security/code-scanning/42) — fix

Rule: `js/incomplete-sanitization`; original [`mirage/lib/footer-capture.mjs:197`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/footer-capture.mjs#L197).

Footer class names are already restricted by registerShellConventions to ASCII CSS identifiers, excluding regex metacharacters. Use a complete regex-escape nevertheless so future extensions cannot widen that implicit assumption.

Validation: mirage/lib/extensions.mjs: registerShellConventions; footer capture tests; full validation.

### [43](https://github.com/maksii/paqvilo/security/code-scanning/43) — fix

Rule: `js/incomplete-sanitization`; original [`mirage/portal-matrix.mjs:1565`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/portal-matrix.mjs#L1565).

Backslash-plus-pipe markdown escaping is ambiguous when input already contains backslashes. Encode backslash, pipe, HTML delimiters, backticks and brackets as numeric entities for table cells and normalize newlines; ordinary text stays readable.

Validation: mirage/test/portal-matrix.test.mjs; report cell escaping regression.

### [44](https://github.com/maksii/paqvilo/security/code-scanning/44) — false-positive

Rule: `js/bad-code-sanitization`; original [`mirage/lib/portal-client-object.mjs:86`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/portal-client-object.mjs#L86).

The specifically reported improperly-sanitized value is JSON.stringify(PORTAL_OBJECT_KEYS), a frozen constant array of fixed names. Dynamic values are separately JSON.stringify-encoded and < is escaped before inline script embedding. JSON strings/arrays are complete JS literals, not raw source fragments.

Validation: mirage/lib/portal-client-object.mjs; mirage/test/portal-client-object.test.mjs; security-regressions hostile code-construction VM test.

### [45](https://github.com/maksii/paqvilo/security/code-scanning/45) — false-positive

Rule: `js/bad-code-sanitization`; original [`mirage/parity-suite.mjs:1425`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/parity-suite.mjs#L1425).

loadingProbe embeds JSON.stringify(LOADING_SELECTORS), a module constant array, as a JS array literal. It has no request, portal or user-derived code fragment. The expression is evaluated by browser automation rather than interpolated in an HTML script element.

Validation: mirage/parity-suite.mjs: LOADING_SELECTORS/loadingProbe; parity suite tests.

### [46](https://github.com/maksii/paqvilo/security/code-scanning/46) — false-positive

Rule: `js/bad-code-sanitization`; original [`mirage/parity-suite.mjs:2632`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/parity-suite.mjs#L2632).

discover.selector is inserted only as JSON.stringify(selector), a complete quoted JS string literal passed to querySelector. Quotes, backslashes, newlines and closing-script text remain data in the evaluated expression; there is no HTML embedding.

Validation: mirage/test/security-regressions.test.mjs: actual discoverTarget generated expression in VM with hostile selector.

### [47](https://github.com/maksii/paqvilo/security/code-scanning/47) — false-positive

Rule: `js/bad-code-sanitization`; original [`mirage/parity-suite.mjs:2632`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/parity-suite.mjs#L2632).

discover.attribute is inserted only as JSON.stringify(attribute), a complete quoted JS string literal passed to getAttribute. The browser expression is not HTML and cannot be terminated by </script>; no raw attribute code is interpolated.

Validation: mirage/test/security-regressions.test.mjs: actual discoverTarget expression with hostile attribute.

### [48](https://github.com/maksii/paqvilo/security/code-scanning/48) — false-positive

Rule: `js/bad-code-sanitization`; original [`mirage/parity-suite.mjs:3178`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/parity-suite.mjs#L3178).

derivePersona uses JSON.stringify for the configured selector inside a browser expression. The selector stays data and may only affect which DOM node is read; script metacharacters cannot create a statement.

Validation: mirage/test/security-regressions.test.mjs: actual derivePersona generated expression executed with hostile selector.

### [49](https://github.com/maksii/paqvilo/security/code-scanning/49) — false-positive

Rule: `js/bad-code-sanitization`; original [`mirage/test/preset-registry.test.mjs:36`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/test/preset-registry.test.mjs#L36).

writePack generates executable pack code deliberately in an owned temporary fixture directory. Its ids/names/matchNames are fixed synthetic literals supplied by this test file and JSON.stringify-encoded. The presets argument is deliberate trusted source code from test literals, not any remote or user input. Packs are explicitly trusted modules by contract.

Validation: mirage/test/preset-registry.test.mjs: all writePack callers and temporary fixture cleanup.

### [50](https://github.com/maksii/paqvilo/security/code-scanning/50) — fix

Rule: `js/unvalidated-dynamic-method-call`; original [`mirage/admin/app.mjs:1547`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/admin/app.mjs#L1547).

The view name was already checked against the constant views array on every assignment, so inherited names were unreachable. Map dispatch now additionally removes inherited-property lookup, preserving all allowed view handlers.

Validation: mirage/test-browser/admin-audit.test.mjs; existing admin-navigation/admin-workspace tests.

### [51](https://github.com/maksii/paqvilo/security/code-scanning/51) — false-positive

Rule: `js/client-side-request-forgery`; original [`examples/project/portal/web-files/demo-workspace.js:33`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/examples/project/portal/web-files/demo-workspace.js#L33).

api constructs a URL and rejects origin !== location.origin or pathname outside /_api/ before fetch. Query-controlled table/record selectors cannot select an external origin or non-API route. Mutations also require canWrite and the same-origin verification token. This is the deliberate portal API interface, not unconstrained request forgery.

Validation: examples/project/portal/web-files/demo-workspace.js: api; installed demo browser/API tests.

### [52](https://github.com/maksii/paqvilo/security/code-scanning/52) — false-positive

Rule: `js/client-side-request-forgery`; original [`examples/project/solution/powerpagecomponents/b4700000-0000-4000-8000-ebf51cf84c1e/filecontent/demo-workspace.js:33`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/examples/project/solution/powerpagecomponents/b4700000-0000-4000-8000-ebf51cf84c1e/filecontent/demo-workspace.js#L33).

The enhanced export contains the identical api guard: parsed URL must have the current origin and /_api/ prefix before fetch; write access and verification-token checks remain. This is the second exported representation of the same constrained demo API.

Validation: examples/project/solution/powerpagecomponents/b4700000-0000-4000-8000-ebf51cf84c1e/filecontent/demo-workspace.js: api; installed demo tests.

### [53](https://github.com/maksii/paqvilo/security/code-scanning/53) — fix

Rule: `js/file-system-race`; original [`lense/commands/agent.mjs:22`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/lense/commands/agent.mjs#L22).

Discovery stat and path-based read were separate, allowing growth or replacement after the 64 KiB check. Open/validate/read one bounded descriptor; reject size, identity/version and path changes, then validate the schema and loopback endpoint before use. Never print the token.

Validation: test/local-file.test.mjs: growth/replacement/bounds; agent command/server regressions.

### [54](https://github.com/maksii/paqvilo/security/code-scanning/54) — false-positive

Rule: `js/file-system-race`; original [`lense/commands/use.mjs:36`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/lense/commands/use.mjs#L36).

The exists checks select an explicitly configured owner-writable .env versus its example and format the created/updated notice. They are not a privilege or confinement gate. The CLI performs a user-requested write to that exact trusted config path without elevated privileges; an attacker controlling that directory already controls the config/catalogue. Concurrent owner edits remain a coordination concern, not this CWE security boundary.

Validation: lense/commands/use.mjs: run/rememberSelection; test CLI/config selection regressions; repository local-source trust boundary.

### [55](https://github.com/maksii/paqvilo/security/code-scanning/55) — false-positive

Rule: `js/file-system-race`; original [`lense/file-cache.mjs:51`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/lense/file-cache.mjs#L51).

The pre-read stat is a freshness/cache-key check, not an authorization gate. The cache reads selected local source bytes with caller privileges and stats again after reading; it stores bytes only if the complete identity/size/mtime/ctime stamp remains equal. Concurrent saves cannot leave a stale cached version. Source confinement is handled by the resolver before this cache.

Validation: lense/file-cache.mjs: FileBodyCache.read; test/file-cache.test.mjs and resolver confinement tests.

### [56](https://github.com/maksii/paqvilo/security/code-scanning/56) — false-positive

Rule: `js/file-system-race`; original [`lense/commands/mirage.mjs:551`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/lense/commands/mirage.mjs#L551).

The related check is the startup fs.open(log, a) for the owned child log, not a permission decision. A later read retrieves diagnostic text only after that child exits, from its ignored runtime work directory, without executing it or accessing a privileged file. The existing process lifecycle owns and closes the log descriptor.

Validation: lense/commands/mirage.mjs: owned startup log and failure path; Mirage lifecycle tests.

### [57](https://github.com/maksii/paqvilo/security/code-scanning/57) — fix

Rule: `js/file-system-race`; original [`lense/html-rewriter.mjs:574`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/lense/html-rewriter.mjs#L574).

Async source prefetch checked realpath/regular-file and later read by filename. The descriptor helper now checks the opened identity, bounds growth and validates path/version afterward. Existing outer source-stamp revalidation and synchronous retry behavior remain; race tests now interpose descriptor reads.

Validation: test/local-file.test.mjs; test/rewrite-safety.test.mjs; test/session.test.mjs concurrent-save regressions.

### [58](https://github.com/maksii/paqvilo/security/code-scanning/58) — fix

Rule: `js/file-system-race`; original [`lense/panel.mjs:761`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/lense/panel.mjs#L761).

The line search size gate previously preceded a separate path read. It now reads one stable descriptor bounded by the existing 16 MiB limit and safely returns no line on unstable input.

Validation: test/local-file.test.mjs; panel/source inspection tests.

### [59](https://github.com/maksii/paqvilo/security/code-scanning/59) — fix

Rule: `js/file-system-race`; original [`lense/panel.mjs:1000`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/lense/panel.mjs#L1000).

The panel comparison size check preceded a separate path read. Its non-inline branch now uses a stable descriptor bounded by the existing MAX_DIFF_BYTES limit; inline sourceText retains its source-aware decoding behavior.

Validation: test/local-file.test.mjs; panel diff tests; browser panel regressions.

### [60](https://github.com/maksii/paqvilo/security/code-scanning/60) — fix

Rule: `js/file-system-race`; original [`lense/source-inspection.mjs:339`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/lense/source-inspection.mjs#L339).

Inspection asset realpath/size checks preceded filename reads. Keep the original export-root and 1 MiB constraints on the descriptor itself and reject changes during reading.

Validation: test/local-file.test.mjs; test/source-inspection.test.mjs.

### [61](https://github.com/maksii/paqvilo/security/code-scanning/61) — fix

Rule: `js/file-system-race`; original [`mirage/lib/code-components.mjs:25`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/code-components.mjs#L25).

PCF manifests and paired metadata were checked for source-root containment/1 MiB size before separate path reads. Read each through a confined bounded descriptor, so swapped/growing files cannot bypass those checks.

Validation: test/local-file.test.mjs; mirage/test/code-components.test.mjs; mirage/test-browser/code-components.test.mjs.

### [62](https://github.com/maksii/paqvilo/security/code-scanning/62) — fix

Rule: `js/file-system-race`; original [`mirage/lib/code-components.mjs:30`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/code-components.mjs#L30).

PCF manifests and paired metadata were checked for source-root containment/1 MiB size before separate path reads. Read each through a confined bounded descriptor, so swapped/growing files cannot bypass those checks.

Validation: test/local-file.test.mjs; mirage/test/code-components.test.mjs; mirage/test-browser/code-components.test.mjs.

### [63](https://github.com/maksii/paqvilo/security/code-scanning/63) — fix

Rule: `js/file-system-race`; original [`mirage/lib/code-components.mjs:44`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/code-components.mjs#L44).

Declared PCF resources had root/8 MiB checks before independent hash and RESX reads. Read one confined stable buffer once and reuse it for both hashing and RESX parsing; resource registration and declared-path restrictions remain.

Validation: test/local-file.test.mjs; mirage/test/code-components.test.mjs; native PCF browser tests.

### [64](https://github.com/maksii/paqvilo/security/code-scanning/64) — fix

Rule: `js/file-system-race`; original [`mirage/lib/code-components.mjs:48`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/code-components.mjs#L48).

Declared PCF resources had root/8 MiB checks before independent hash and RESX reads. Read one confined stable buffer once and reuse it for both hashing and RESX parsing; resource registration and declared-path restrictions remain.

Validation: test/local-file.test.mjs; mirage/test/code-components.test.mjs; native PCF browser tests.

### [65](https://github.com/maksii/paqvilo/security/code-scanning/65) — fix

Rule: `js/file-system-race`; original [`mirage/lib/exported-operations.mjs:39`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/exported-operations.mjs#L39).

Exported server-logic code had imported-realpath and 1 MiB checks before a separate read. Use a descriptor with the same directory and limit; worker CPU/lifetime limits and operation permission checks stay intact.

Validation: test/local-file.test.mjs; exported operations tests.

### [66](https://github.com/maksii/paqvilo/security/code-scanning/66) — fix

Rule: `js/file-system-race`; original [`mirage/lib/exported-operations.mjs:111`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/exported-operations.mjs#L111).

Workflow metadata and JSON had paired-path/1 MiB checks before path reads. Use confined stable descriptors for both while preserving the paired WorkflowId requirement.

Validation: test/local-file.test.mjs; operation catalogue/exported workflow tests.

### [67](https://github.com/maksii/paqvilo/security/code-scanning/67) — false-positive

Rule: `js/file-system-race`; original [`mirage/lib/data.mjs:807`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/data.mjs#L807).

The related check is exclusive creation of the save lock with wx/0600. The flagged read verifies the fresh random owner token before cleanup, and no other cooperating save may acquire that lock while it exists. No stale lock is inferred/deleted and state updates use wx temporary files plus digest conflict checks and rename. Another owner-level process maliciously replacing the lock already controls the state file; no privilege boundary is crossed.

Validation: mirage/lib/data.mjs: save; state persistence/conflict/lock regressions in mirage/test/data.test.mjs.

### [68](https://github.com/maksii/paqvilo/security/code-scanning/68) — fix

Rule: `js/file-system-race`; original [`mirage/lib/operation-catalogue.mjs:26`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/operation-catalogue.mjs#L26).

Enhanced operation components had root/1 MiB checks before filename reads. The descriptor now enforces those constraints and identity stability before XML/JSON parsing.

Validation: test/local-file.test.mjs; operation-catalogue tests.

### [69](https://github.com/maksii/paqvilo/security/code-scanning/69) — false-positive

Rule: `js/file-system-race`; original [`mirage/lib/page-resources.mjs:411`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/page-resources.mjs#L411).

The stat is exclusively a display-name cache timestamp/size key. The data read from selected Solution XML becomes a string label that is escaped at render sinks; it does not grant file permission, execute code or write data. A concurrent edit may make a label cache stale until the next changed stamp, not cross a security gate.

Validation: mirage/lib/page-resources.mjs: tableDisplayName; page-resource display metadata/render regressions.

### [70](https://github.com/maksii/paqvilo/security/code-scanning/70) — fix

Rule: `js/file-system-race`; original [`mirage/parity-suite.mjs:403`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/parity-suite.mjs#L403).

The reveal-policy corpus size gate preceded a filename read. Read one descriptor with the existing maxFileBytes limit and sourceDir confinement to prevent raced/growing input from bypassing the reveal source selection.

Validation: test/local-file.test.mjs; source corpus regression; parity suite tests.

### [71](https://github.com/maksii/paqvilo/security/code-scanning/71) — fix

Rule: `js/file-system-race`; original [`mirage/server.mjs:2682`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/server.mjs#L2682).

Serving a declared PCF asset checked its canonical path/8 MiB size before a separate filename read. Enforce asset.root and the same size on a stable descriptor; undeclared resources remain 404 and GET/HEAD rules stay unchanged.

Validation: mirage/test-browser/code-components.test.mjs; security compatibility and local-file regressions.

### [72](https://github.com/maksii/paqvilo/security/code-scanning/72) — fix

Rule: `js/file-system-race`; original [`mirage/server.mjs:3018`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/server.mjs#L3018).

Serving an exported web asset used realpath root checks and a later filename read. Read the same canonical asset through a root-confined stable descriptor. Retain original uncapped asset sizes rather than imposing a new limit on existing exports.

Validation: mirage browser asset/native tests; test/local-file.test.mjs; installed package smoke.

### [73](https://github.com/maksii/paqvilo/security/code-scanning/73) — false-positive

Rule: `js/file-system-race`; original [`test/source-edit.test.mjs:27`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/test/source-edit.test.mjs#L27).

The test stats a temporary source file to assert editSource makes zero writes when its transform returns unchanged bytes, then reads the same owned fixture to compare bytes. The stat is not a security decision and the file is not attacker-shared; this is a deliberate regression for byte-preserving source edits.

Validation: test/source-edit.test.mjs: fixture ownership, unchanged write count and timestamp assertions.

### [74](https://github.com/maksii/paqvilo/security/code-scanning/74) — fix

Rule: `js/remote-property-injection`; original [`mirage/lib/auth-session.mjs:27`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/auth-session.mjs#L27).

Cookie names wrote into a plain object, invoking the inherited __proto__ setter rather than storing an own cookie entry. Build in a null-prototype dictionary and return Object.fromEntries to preserve the ordinary public object shape and first-occurrence behavior.

Validation: mirage/test/security-regressions.test.mjs: __proto__/constructor/toString/duplicates; mirage/test/auth-session.test.mjs.

### [75](https://github.com/maksii/paqvilo/security/code-scanning/75) — false-positive

Rule: `js/remote-property-injection`; original [`mirage/admin/app.mjs:250`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/admin/app.mjs#L250).

applyRoute iterates Object.keys(auditFilters), a constant own-key filter dictionary. URLSearchParams supplies only values, never the property names written. The unrelated DOM change handler now separately checks Object.hasOwn and option rendering escapes values; no remote key reaches this assignment.

Validation: mirage/admin/app.mjs: auditFilters/applyRoute; mirage/test-browser/admin-audit.test.mjs.

### [76](https://github.com/maksii/paqvilo/security/code-scanning/76) — fix

Rule: `js/remote-property-injection`; original [`mirage/lib/data.mjs:1508`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/data.mjs#L1508).

Alias keys already must start with @ and cannot equal __proto__/constructor/prototype. Use a null-prototype alias dictionary as explicit hardening without changing alias values or query semantics.

Validation: mirage OData/data alias regressions; full validation.

### [77](https://github.com/maksii/paqvilo/security/code-scanning/77) — fix

Rule: `js/remote-property-injection`; original [`mirage/lib/data.mjs:2876`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/data.mjs#L2876).

Selecting a __proto__ own field from an imported row wrote via the ordinary object setter and could alter the projected result prototype. Define an enumerable writable own data property instead, preserving ordinary result object shape and selected field values.

Validation: mirage/test/security-regressions.test.mjs: own __proto__ selected column and unaffected name; data/OData projections.

### [78](https://github.com/maksii/paqvilo/security/code-scanning/78) — false-positive

Rule: `js/remote-property-injection`; original [`mirage/lib/data.mjs:2880`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/data.mjs#L2880).

The property name is a validated selected lookup key plus the nonempty constant @OData.Community.Display.V1.FormattedValue suffix. It cannot equal __proto__, constructor or prototype, and the assignment stores a string annotation on a fresh query-result object. The unsuffixed setter path is separately fixed.

Validation: mirage/lib/data.mjs: project/formattedAnnotation; data and OData lookup annotation regressions.

### [79](https://github.com/maksii/paqvilo/security/code-scanning/79) — false-positive

Rule: `js/remote-property-injection`; original [`mirage/lib/data.mjs:2882`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/data.mjs#L2882).

The selected lookup key is suffixed with the nonempty constant @Microsoft.Dynamics.CRM.lookuplogicalname before assignment. That key cannot invoke any prototype setter; only the fresh row result receives a logical-name annotation. The unsuffixed selected field now uses an own data property.

Validation: mirage/lib/data.mjs: project/lookupAnnotation; data and OData lookup annotation regressions.

### [80](https://github.com/maksii/paqvilo/security/code-scanning/80) — false-positive

Rule: `js/remote-property-injection`; original [`mirage/lib/odata-query.mjs:726`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/lib/odata-query.mjs#L726).

parseExpand rejects every option key except the literal allowlist $select/$filter/$orderby/$top/$expand before writing options[key]. None is a prototype-sensitive key. Untrusted input only supplies option values after a validated key.

Validation: mirage/lib/odata-query.mjs: parseExpand allowlist; mirage OData nested expand regressions.

### [81](https://github.com/maksii/paqvilo/security/code-scanning/81) — false-positive

Rule: `js/file-access-to-http`; original [`lense/commands/agent.mjs:50`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/lense/commands/agent.mjs#L50).

The file supplies only the owned agent discovery endpoint. readDiscovery requires HTTP, literal 127.0.0.1, a port, no userinfo, root path and no query/hash; agentRequest restricts /v1/ routes and sets redirect:error. The request cannot exfiltrate to a remote origin through this path.

Validation: lense/commands/agent.mjs: readDiscovery/agentRequest; test/agent-client.test.mjs and agent-server tests.

### [82](https://github.com/maksii/paqvilo/security/code-scanning/82) — false-positive

Rule: `js/file-access-to-http`; original [`lense/commands/agent.mjs:52`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/lense/commands/agent.mjs#L52).

The token is intentionally loaded from the owned ignored discovery file and sent as Authorization only to its validated literal-loopback agent. Endpoint validation and redirect:error prevent forwarding the token to another host. This is the explicit authentication protocol, not accidental file-data disclosure.

Validation: lense/commands/agent.mjs: discovery schema and agentRequest headers; token isolation/redirect rejection regressions.

### [83](https://github.com/maksii/paqvilo/security/code-scanning/83) — false-positive

Rule: `js/file-access-to-http`; original [`mirage/reference-parity.mjs:71`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/reference-parity.mjs#L71).

The plan file contributes a contract.path checked by validateLivePath and a fixed loopback local.origin. compareReferenceContracts accepts GET reads only, uses redirect:manual locally, and the live side uses the separately configured signed-in browser bridge. Sending the explicitly selected query path is the requested contract comparison.

Validation: mirage/reference-parity.mjs: contract validation/local URL checks; mirage/test/reference-parity.test.mjs.

### [84](https://github.com/maksii/paqvilo/security/code-scanning/84) — false-positive

Rule: `js/file-access-to-http`; original [`mirage/reference-parity.mjs:71`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/reference-parity.mjs#L71).

The plan contributes the Prefer value, restricted to ^odata.maxpagesize=[1-9]digits before use; the destination is the validated loopback origin and redirects are manual. No file body or credentials are forwarded to arbitrary hosts.

Validation: mirage/reference-parity.mjs: Prefer validation and loopback fetch; reference-parity regressions.

### [85](https://github.com/maksii/paqvilo/security/code-scanning/85) — false-positive

Rule: `js/file-access-to-http`; original [`mirage/parity-suite.mjs:1534`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/parity-suite.mjs#L1534).

The tainted plan contributes mocked response/status parameters to the explicitly attached browser CDP WebSocket. Both the configured debugging endpoint and returned socket hostname are validated as loopback; JSON CDP commands drive the owned observation tab. This is deliberate local browser control rather than outbound disclosure.

Validation: mirage/parity-suite.mjs: openToolkitDriver endpoint/socket checks and send; parity driver tests.

### [86](https://github.com/maksii/paqvilo/security/code-scanning/86) — false-positive

Rule: `js/file-access-to-http`; original [`mirage/parity-suite.mjs:2135`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/parity-suite.mjs#L2135).

The plan contributes contactId/roles used to mirror a persona into the local simulator session. createIdentityController restricts the destination hostname to loopback, uses the fixed /__sim/api/session/sign-in route and retrieves the local CSRF token. The request is the explicit synthetic session setup protocol.

Validation: mirage/parity-suite.mjs: createIdentityController; persona mirroring/isolation regressions.

### [87](https://github.com/maksii/paqvilo/security/code-scanning/87) — false-positive

Rule: `js/file-access-to-http`; original [`mirage/test-browser/parity.test.mjs:436`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/test-browser/parity.test.mjs#L436).

The file contains only the port reported by an owned spawned loopback fixture. The request hostname and route are literal http://127.0.0.1:<port>/section/list, and the test inspects the invented local output; no arbitrary file body or real data is sent.

Validation: mirage/test-browser/parity.test.mjs: owned fixture readiness file and teardown.

### [88](https://github.com/maksii/paqvilo/security/code-scanning/88) — false-positive

Rule: `js/file-access-to-http`; original [`test/agent-server.test.mjs:38`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/test/agent-server.test.mjs#L38).

The source is a discovery JSON written by the owned synthetic agent fixture under its temporary work directory. This test deliberately sends that fixture token to its loopback API to exercise authentication, state or lifecycle behavior. It does not load a private discovery file or a remote URL; server/browser cleanup is registered by the test.

Validation: test/agent-server.test.mjs: fixture construction, agent discovery and cleanup.

### [89](https://github.com/maksii/paqvilo/security/code-scanning/89) — false-positive

Rule: `js/file-access-to-http`; original [`test/agent-server.test.mjs:118`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/test/agent-server.test.mjs#L118).

The source is a discovery JSON written by the owned synthetic agent fixture under its temporary work directory. This test deliberately sends that fixture token to its loopback API to exercise authentication, state or lifecycle behavior. It does not load a private discovery file or a remote URL; server/browser cleanup is registered by the test.

Validation: test/agent-server.test.mjs: fixture construction, agent discovery and cleanup.

### [90](https://github.com/maksii/paqvilo/security/code-scanning/90) — false-positive

Rule: `js/file-access-to-http`; original [`test-browser/agent-lifecycle.test.mjs:40`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/test-browser/agent-lifecycle.test.mjs#L40).

The source is a discovery JSON written by the owned synthetic agent fixture under its temporary work directory. This test deliberately sends that fixture token to its loopback API to exercise authentication, state or lifecycle behavior. It does not load a private discovery file or a remote URL; server/browser cleanup is registered by the test.

Validation: test-browser/agent-lifecycle.test.mjs: fixture construction, agent discovery and cleanup.

### [91](https://github.com/maksii/paqvilo/security/code-scanning/91) — false-positive

Rule: `js/file-access-to-http`; original [`test-browser/agent-server.test.mjs:55`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/test-browser/agent-server.test.mjs#L55).

The source is a discovery JSON written by the owned synthetic agent fixture under its temporary work directory. This test deliberately sends that fixture token to its loopback API to exercise authentication, state or lifecycle behavior. It does not load a private discovery file or a remote URL; server/browser cleanup is registered by the test.

Validation: test-browser/agent-server.test.mjs: fixture construction, agent discovery and cleanup.

### [92](https://github.com/maksii/paqvilo/security/code-scanning/92) — false-positive

Rule: `js/file-access-to-http`; original [`test-browser/multi-portal.test.mjs:226`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/test-browser/multi-portal.test.mjs#L226).

The discovery file is generated by the test's owned runtime/child for invented alpha/beta loopback portals; the tested operation is GET /v1/pages and configured-origin confinement. The endpoint/token are the intended local authentication protocol. Both discovery cleanup and fixture GET-only traffic are asserted. Duplicate findings separately trace endpoint and header data, not separate exfiltration destinations.

Validation: test-browser/multi-portal.test.mjs: synthetic HTTP servers, owned child/runtime, origin/token isolation and cleanup assertions.

### [93](https://github.com/maksii/paqvilo/security/code-scanning/93) — false-positive

Rule: `js/file-access-to-http`; original [`test-browser/multi-portal.test.mjs:226`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/test-browser/multi-portal.test.mjs#L226).

The discovery file is generated by the test's owned runtime/child for invented alpha/beta loopback portals; the tested operation is GET /v1/pages and configured-origin confinement. The endpoint/token are the intended local authentication protocol. Both discovery cleanup and fixture GET-only traffic are asserted. Duplicate findings separately trace endpoint and header data, not separate exfiltration destinations.

Validation: test-browser/multi-portal.test.mjs: synthetic HTTP servers, owned child/runtime, origin/token isolation and cleanup assertions.

### [94](https://github.com/maksii/paqvilo/security/code-scanning/94) — false-positive

Rule: `js/file-access-to-http`; original [`test-browser/multi-portal.test.mjs:229`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/test-browser/multi-portal.test.mjs#L229).

The discovery file is generated by the test's owned runtime/child for invented alpha/beta loopback portals; the tested operation is GET /v1/session and browser-scope assertions. The endpoint/token are the intended local authentication protocol. Both discovery cleanup and fixture GET-only traffic are asserted. Duplicate findings separately trace endpoint and header data, not separate exfiltration destinations.

Validation: test-browser/multi-portal.test.mjs: synthetic HTTP servers, owned child/runtime, origin/token isolation and cleanup assertions.

### [95](https://github.com/maksii/paqvilo/security/code-scanning/95) — false-positive

Rule: `js/file-access-to-http`; original [`test-browser/multi-portal.test.mjs:229`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/test-browser/multi-portal.test.mjs#L229).

The discovery file is generated by the test's owned runtime/child for invented alpha/beta loopback portals; the tested operation is GET /v1/session and browser-scope assertions. The endpoint/token are the intended local authentication protocol. Both discovery cleanup and fixture GET-only traffic are asserted. Duplicate findings separately trace endpoint and header data, not separate exfiltration destinations.

Validation: test-browser/multi-portal.test.mjs: synthetic HTTP servers, owned child/runtime, origin/token isolation and cleanup assertions.

### [96](https://github.com/maksii/paqvilo/security/code-scanning/96) — false-positive

Rule: `js/file-access-to-http`; original [`test-browser/multi-portal.test.mjs:234`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/test-browser/multi-portal.test.mjs#L234).

The discovery file is generated by the test's owned runtime/child for invented alpha/beta loopback portals; the tested operation is cross-session token rejection (401). The endpoint/token are the intended local authentication protocol. Both discovery cleanup and fixture GET-only traffic are asserted. Duplicate findings separately trace endpoint and header data, not separate exfiltration destinations.

Validation: test-browser/multi-portal.test.mjs: synthetic HTTP servers, owned child/runtime, origin/token isolation and cleanup assertions.

### [97](https://github.com/maksii/paqvilo/security/code-scanning/97) — false-positive

Rule: `js/file-access-to-http`; original [`test-browser/multi-portal.test.mjs:234`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/test-browser/multi-portal.test.mjs#L234).

The discovery file is generated by the test's owned runtime/child for invented alpha/beta loopback portals; the tested operation is cross-session token rejection (401). The endpoint/token are the intended local authentication protocol. Both discovery cleanup and fixture GET-only traffic are asserted. Duplicate findings separately trace endpoint and header data, not separate exfiltration destinations.

Validation: test-browser/multi-portal.test.mjs: synthetic HTTP servers, owned child/runtime, origin/token isolation and cleanup assertions.

### [98](https://github.com/maksii/paqvilo/security/code-scanning/98) — false-positive

Rule: `js/file-access-to-http`; original [`test-browser/multi-portal.test.mjs:245`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/test-browser/multi-portal.test.mjs#L245).

The discovery file is generated by the test's owned runtime/child for invented alpha/beta loopback portals; the tested operation is rejection after the owned API listener closes. The endpoint/token are the intended local authentication protocol. Both discovery cleanup and fixture GET-only traffic are asserted. Duplicate findings separately trace endpoint and header data, not separate exfiltration destinations.

Validation: test-browser/multi-portal.test.mjs: synthetic HTTP servers, owned child/runtime, origin/token isolation and cleanup assertions.

### [99](https://github.com/maksii/paqvilo/security/code-scanning/99) — false-positive

Rule: `js/file-access-to-http`; original [`test-browser/multi-portal.test.mjs:245`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/test-browser/multi-portal.test.mjs#L245).

The discovery file is generated by the test's owned runtime/child for invented alpha/beta loopback portals; the tested operation is rejection after the owned API listener closes. The endpoint/token are the intended local authentication protocol. Both discovery cleanup and fixture GET-only traffic are asserted. Duplicate findings separately trace endpoint and header data, not separate exfiltration destinations.

Validation: test-browser/multi-portal.test.mjs: synthetic HTTP servers, owned child/runtime, origin/token isolation and cleanup assertions.

### [100](https://github.com/maksii/paqvilo/security/code-scanning/100) — false-positive

Rule: `js/file-access-to-http`; original [`test-browser/multi-portal.test.mjs:380`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/test-browser/multi-portal.test.mjs#L380).

The discovery file is generated by the test's owned runtime/child for invented alpha/beta loopback portals; the tested operation is GET /v1/pages for the second owned portal. The endpoint/token are the intended local authentication protocol. Both discovery cleanup and fixture GET-only traffic are asserted. Duplicate findings separately trace endpoint and header data, not separate exfiltration destinations.

Validation: test-browser/multi-portal.test.mjs: synthetic HTTP servers, owned child/runtime, origin/token isolation and cleanup assertions.

### [101](https://github.com/maksii/paqvilo/security/code-scanning/101) — false-positive

Rule: `js/file-access-to-http`; original [`test-browser/multi-portal.test.mjs:380`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/test-browser/multi-portal.test.mjs#L380).

The discovery file is generated by the test's owned runtime/child for invented alpha/beta loopback portals; the tested operation is GET /v1/pages for the second owned portal. The endpoint/token are the intended local authentication protocol. Both discovery cleanup and fixture GET-only traffic are asserted. Duplicate findings separately trace endpoint and header data, not separate exfiltration destinations.

Validation: test-browser/multi-portal.test.mjs: synthetic HTTP servers, owned child/runtime, origin/token isolation and cleanup assertions.

### [102](https://github.com/maksii/paqvilo/security/code-scanning/102) — false-positive

Rule: `js/file-access-to-http`; original [`test-browser/multi-portal.test.mjs:384`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/test-browser/multi-portal.test.mjs#L384).

The discovery file is generated by the test's owned runtime/child for invented alpha/beta loopback portals; the tested operation is GET /v1/pages/<id>/state for local resource coverage. The endpoint/token are the intended local authentication protocol. Both discovery cleanup and fixture GET-only traffic are asserted. Duplicate findings separately trace endpoint and header data, not separate exfiltration destinations.

Validation: test-browser/multi-portal.test.mjs: synthetic HTTP servers, owned child/runtime, origin/token isolation and cleanup assertions.

### [103](https://github.com/maksii/paqvilo/security/code-scanning/103) — false-positive

Rule: `js/file-access-to-http`; original [`test-browser/multi-portal.test.mjs:384`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/test-browser/multi-portal.test.mjs#L384).

The discovery file is generated by the test's owned runtime/child for invented alpha/beta loopback portals; the tested operation is GET /v1/pages/<id>/state for local resource coverage. The endpoint/token are the intended local authentication protocol. Both discovery cleanup and fixture GET-only traffic are asserted. Duplicate findings separately trace endpoint and header data, not separate exfiltration destinations.

Validation: test-browser/multi-portal.test.mjs: synthetic HTTP servers, owned child/runtime, origin/token isolation and cleanup assertions.

### [104](https://github.com/maksii/paqvilo/security/code-scanning/104) — false-positive

Rule: `js/file-access-to-http`; original [`test-browser/multi-portal.test.mjs:388`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/test-browser/multi-portal.test.mjs#L388).

The discovery file is generated by the test's owned runtime/child for invented alpha/beta loopback portals; the tested operation is GET /v1/session for catalogue browser-scope verification. The endpoint/token are the intended local authentication protocol. Both discovery cleanup and fixture GET-only traffic are asserted. Duplicate findings separately trace endpoint and header data, not separate exfiltration destinations.

Validation: test-browser/multi-portal.test.mjs: synthetic HTTP servers, owned child/runtime, origin/token isolation and cleanup assertions.

### [105](https://github.com/maksii/paqvilo/security/code-scanning/105) — false-positive

Rule: `js/file-access-to-http`; original [`test-browser/multi-portal.test.mjs:388`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/test-browser/multi-portal.test.mjs#L388).

The discovery file is generated by the test's owned runtime/child for invented alpha/beta loopback portals; the tested operation is GET /v1/session for catalogue browser-scope verification. The endpoint/token are the intended local authentication protocol. Both discovery cleanup and fixture GET-only traffic are asserted. Duplicate findings separately trace endpoint and header data, not separate exfiltration destinations.

Validation: test-browser/multi-portal.test.mjs: synthetic HTTP servers, owned child/runtime, origin/token isolation and cleanup assertions.

### [106](https://github.com/maksii/paqvilo/security/code-scanning/106) — false-positive

Rule: `js/http-to-file-access`; original [`mirage/acceptance.mjs:969`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/acceptance.mjs#L969).

Only JSON audit response contents are tainted. The write destination is the caller-selected outputDir plus a fixed numbered -request-audit.json name, not a remote-controlled filename; JSON serialization makes response text data in an explicit evidence artifact. No remote response is evaluated or installed.

Validation: mirage/acceptance.mjs: auditFile/writeFile; loopback acceptance regressions and redacted evidence contract.

### [107](https://github.com/maksii/paqvilo/security/code-scanning/107) — false-positive

Rule: `js/http-to-file-access`; original [`mirage/acceptance.mjs:1014`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/acceptance.mjs#L1014).

Remote observations are serialized into the requested outputDir/report.json evidence file. Network fields cannot choose the path or cause execution; browsers/proxy are closed before report writing. This is the explicit acceptance report feature, not an unsolicited file write.

Validation: mirage/acceptance.mjs: outputDir/report/finally; acceptance report/cleanup tests.

### [108](https://github.com/maksii/paqvilo/security/code-scanning/108) — false-positive

Rule: `js/http-to-file-access`; original [`mirage/cli.mjs:474`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/cli.mjs#L474).

mirage render --output explicitly fetches its just-created local simulator, rejects target.origin changes and redirects, and saves the resulting HTML to path.resolve(args.output). The HTTP response controls bytes only, never the path or execution. This is the user-requested exported render artifact.

Validation: mirage/cli.mjs: render branch; CLI render/output regressions.

### [109](https://github.com/maksii/paqvilo/security/code-scanning/109) — false-positive

Rule: `js/http-to-file-access`; original [`mirage/reference-parity.mjs:95`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/reference-parity.mjs#L95).

The taint path carries local source/implementation fingerprint fields into JSON.stringify(report). The destination is caller-chosen outputDir/reference-parity.json, with no response-derived path. The report stores projected hashes/counts/status, not executable code.

Validation: mirage/reference-parity.mjs: fixed report path, normalization/hash projection; reference-parity tests.

### [110](https://github.com/maksii/paqvilo/security/code-scanning/110) — false-positive

Rule: `js/http-to-file-access`; original [`mirage/parity-suite.mjs:3280`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/parity-suite.mjs#L3280).

Local simulator fingerprints and redacted observations are saved as JSON data in the caller-selected outDir/report.json. The path is not derived from response data and no saved content is executed. This is the explicit parity evidence output.

Validation: mirage/parity-suite.mjs: runParitySuite/localState/redaction/report path; parity suite and redactor regressions.

### [111](https://github.com/maksii/paqvilo/security/code-scanning/111) — false-positive

Rule: `js/http-to-file-access`; original [`mirage/parity-suite.mjs:3281`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/parity-suite.mjs#L3281).

summary.md is an explicit human-readable parity report under caller-selected outDir. Network state/fingerprint values influence report text only; response data cannot select another destination or executable module. This alert models intentional evidence persistence, not arbitrary path control.

Validation: mirage/parity-suite.mjs: runParitySuite/summaryMarkdown/redactor; parity report tests.

### [112](https://github.com/maksii/paqvilo/security/code-scanning/112) — false-positive

Rule: `js/http-to-file-access`; original [`mirage/verify.mjs:645`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/verify.mjs#L645).

verify serializes collected observations into outputDir/report.json in its finally block after owned pages/browser cleanup. The HTTP response contributes diagnostic data, not the report filename, filesystem location or any executed source.

Validation: mirage/verify.mjs: artifacts.report/writeFile; verification evidence and cleanup regressions.

### [113](https://github.com/maksii/paqvilo/security/code-scanning/113) — fix

Rule: `js/regex/missing-regexp-anchor`; original [`mirage/parity-suite.mjs:2522`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/parity-suite.mjs#L2522).

Hosted-resource classification matched host text anywhere in a URL, so a foreign host path could be excluded from meaningful shell comparisons. Parse actual HTTP(S) URLs, reject userinfo, and compare hostname equality/subdomain suffix. Preserve the separate local library filename classifier.

Validation: mirage/test/security-regressions.test.mjs: hostile path/userinfo/suffix URLs; mirage/test/parity-suite.test.mjs shell resource comparisons.

### [114](https://github.com/maksii/paqvilo/security/code-scanning/114) — fix

Rule: `js/regex/missing-regexp-anchor`; original [`mirage/webapi-inventory.mjs:107`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/webapi-inventory.mjs#L107).

This is a MIME-type inventory classifier, not a URL/host allowlist. Split the anchored image/* prefix check from deliberate font/binary subtype searches to express the original precedence clearly while preserving SVG inventory and legacy application/font variants.

Validation: mirage/test/webapi-inventory-wrappers.test.mjs; full validation.

### [115](https://github.com/maksii/paqvilo/security/code-scanning/115) — false-positive

Rule: `js/missing-origin-check`; original [`mirage/test-browser/solution-form.test.mjs:317`](https://github.com/maksii/paqvilo/blob/ffbdefb5f1ba9ab94f25b7d223d41391d1929975/mirage/test-browser/solution-form.test.mjs#L317).

The handler records every message into a temporary test-page array solely to assert native modal postback communication. It never authorizes an action, inserts markup or executes received data. The actual entity-grid runtime message handler separately checks event.origin === location.origin and data === Success before refreshing grids.

Validation: mirage/test-browser/solution-form.test.mjs: passive message assertion; mirage/lib/entity-grid-compat.js: actual modal completion origin gate.

## References

- [CodeQL filesystem-race guidance](https://codeql.github.com/codeql-query-help/javascript/js-file-system-race/).
- [CodeQL file-data network query](https://codeql.github.com/codeql-query-help/javascript/js-file-access-to-http/).
- [GitHub alert resolution and dismissal evidence](https://docs.github.com/en/code-security/how-tos/manage-security-alerts/manage-code-scanning-alerts/resolve-alerts).
- [Maintained sanitize-html package documentation](https://github.com/apostrophecms/apostrophe/tree/main/packages/sanitize-html).
- [DOMParser inert document and adoption boundary](https://developer.mozilla.org/en-US/docs/Web/API/DOMParser/parseFromString).
- [WHATWG script tokenizer](https://html.spec.whatwg.org/multipage/parsing.html#script-data-escaped-dash-dash-state).
- [DotLiquid standard filters](https://github.com/dotliquid/dotliquid/blob/master/src/DotLiquid/StandardFilters.cs).
