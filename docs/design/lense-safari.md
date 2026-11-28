# Lense browser compatibility

The audit starts at [PR #69](https://github.com/maksii/paqvilo/pull/69). Lense's live overlay runs in Edge, Chrome
and Chromium. Firefox and Safari can render Lense's UI and rewritten HTML. A live overlay also needs browser
transport for the original portal response, session identity and source inspection.

## Rendering

On macOS with the repository's Node and npm versions, run the following from the toolkit checkout.

```sh
npm ci
node node_modules/playwright-core/cli.js install webkit firefox
npm run test:lense:webkit
npm run test:lense:firefox
```

Both suites use the same synthetic loopback cases as Chromium for Power Pages and model-driven panel chrome,
viewport resizing, the X-ray toolbar and cards, the setup UI, and execution of rewritten HTML. The Chromium lane
also checks DevTools source-map reporting and exercises the shipped overlay transport. Both macOS rendering jobs
contribute to the CI gate for Lense changes. Playwright ships patched WebKit and Firefox builds.
[Playwright browser support](https://playwright.dev/docs/browsers)

At widths of 320 and 390 CSS pixels, the X-ray highlight selector collapsed and **Exit** moved out of the viewport
in **Using the page** mode. The narrow toolbar puts the mode message on a second row so both controls fit. Native
Safari 27.2 and Firefox 161 kept the panel geometry and styles under hostile page CSS. In a 320px iframe, the
selector and **Exit** fit and a WebDriver pointer action activated **Exit**. Native Safari also executed synthetic
rewritten HTML with parser recovery, ordered source-map script execution and a relative dynamic import.

WebKit also exposed a Setup ordering bug. A deferred pointer release from a Refresh click could clear the next
press and let the refresh replace a stage link before its click landed. Setup now associates each deferred
release with its own press. A controlled regression exercises that ordering in Chromium, WebKit and Firefox.

## Native WebDriver BiDi results

The native probe launches Firefox in a temporary profile and Safari in a WebDriver window. It visits invented
loopback pages and reports observed behavior separately from whether a command acknowledges registration.

```sh
npm run probe:lense:bidi
npm run probe:lense:firefox-transport
```

Safari requires **Allow remote automation and external agents** in Safari's Developer settings. The probe needs both
`webSocketUrl` and Safari's `safari:experimentalWebSocketUrl` capability on the tested version. To run only Firefox,
use `node --test --test-name-pattern=Firefox test-browser/bidi/native-capabilities.test.mjs`. On macOS the probe
opens the installed Firefox app. Set `LENSE_FIREFOX_BINARY` for a different installed desktop binary.
[Apple WebDriver setup](https://developer.apple.com/documentation/safari-developer-tools/macos-enabling-webdriver)

The following results are from Firefox 161 and Safari 27.2 on November 28, 2026.

| Lense requirement                                                 | Firefox 161                                                                                                                                                                                                                                                                    | Safari 27.2                                                                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Substitute a local asset at request time                          | `beforeRequestSent` and `provideResponse` served the synthetic asset with zero upstream requests.                                                                                                                                                                              | `network.addIntercept` returned `unknown command`.                                                                                              |
| Inspect and change the same native portal response before it runs | `responseStarted` paused the original multipart document. `getData` did not return while it was paused, then returned the original bytes after continuation. `provideResponse` rejected a body at the response phase. Continuing preserved one upstream POST and both cookies. | `network.addIntercept`, `getData` and `provideResponse` returned `unknown command`.                                                             |
| Install logic before page code and get a message from its realm   | The page observed the marker from `script.addPreloadScript` before its first script. `script.message` delivered a channel message from the expected context.                                                                                                                   | Safari acknowledged registration and subscription. The page did not observe the marker and the channel delivered no message on this navigation. |
| Inspect closed shadow content                                     | `script.evaluate` with `includeShadowTree: 'all'` serialized the invented closed-root text.                                                                                                                                                                                    | The closed-root text was absent from the result.                                                                                                |

Firefox's vendor debugger listed the fixture's loaded external script by URL and returned its exact source. That
probe covers one script in one context. It leaves per-script identity, inline sources and execution attribution
to qualify against the Chromium debugger contract.
[Firefox debugger extensions](https://firefox-source-docs.mozilla.org/remote/webdriver-bidi/Extensions.html#debugging-module)

In Chromium, [Lense interception](../../lense/intercept.mjs) relies on the ability to read and fulfill the same
paused response. This preserves the browser's native request, including authenticated POSTs and file uploads.
WebDriver BiDi currently defines body collection around response completion. Firefox also explicitly rejects
body replacement at the response stage. Waiting for completion before reading the bytes gives the original
document to the page. Both a readable paused body and a way to supply its replacement are required.
[WebDriver BiDi network specification](https://w3c.github.io/webdriver-bidi/#module-network),
[W3C response-stream proposal](https://github.com/w3c/webdriver-bidi/issues/958),
[Firefox response-body replacement issue](https://bugzilla.mozilla.org/show_bug.cgi?id=1901055),
[WebKit BiDi network tracker](https://bugs.webkit.org/show_bug.cgi?id=281936)

## Firefox response-filter proof

A temporary Firefox WebExtension used `webRequest.filterResponseData` to send the original document bytes to a
loopback Node process. The process applied Lense's existing `HtmlRewriter` and returned the rewritten bytes. A
following portal script observed the new value on its first run. The browser sent one upstream multipart POST
with its original binary upload and boundary. A subsequent request received both cookies, including the HttpOnly
one. The bridge received no cookies or authorization headers. An oversized body and a failed rewrite both fell back
to the original. The same route on a different origin went through untouched. This is a transport qualification
fixture in a temporary profile. [Firefox response filtering](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/filterResponseData)

The redirect case sent the multipart POST once, followed the native 303 as a GET with both redirect cookies, and
rewrote the GET response before the destination's first script ran. The bridge saw the destination body once.

## Requirements for equivalent live support

1. Preserve the existing overlay logic. Qualify a browser transport against the same request-stage and native
   response-stage contract before adapting the [overlay session](../../lense/session.mjs). Include first
   navigation, popups, frames, redirects, ordered duplicate headers, cookies, compressed or cached responses, and
   exactly one upstream write for each form submission. Keep over-limit, aborted or unhandled requests moving
   without replay. Check reload with an unsaved draft and browser cleanup after transport loss.
2. For Firefox, combine native browser control with an origin-scoped response filter as the next integration step.
   Qualify its origin and tab ownership, fail-open behavior, authentication, CSP and cache semantics, service
   workers, and bridge lifecycle before exposing it in `lense dev`. Firefox's demonstrated BiDi preload and
   closed-root serialization can inform the adapter for [page bindings](../../lense/owned-page-binding.mjs)
   and [Inspect](../../lense/dom-pierce.mjs).
3. For Safari, first establish request-stage interception and same-response body access and replacement in a
   public, usable transport. Re-run the native probe as Safari and WebDriver BiDi evolve. Safari MCP can observe
   network requests and its Web Inspector can apply Local Overrides while open. Safari WebExtensions offer
   request redirects and header rules. The documented surfaces currently lack an API to transform the actual
   paused response body in the interactive loop. Test interactive sign-in separately. Safari WebDriver uses
   isolated automation windows with a glass pane over normal user interactions.
   [Safari MCP tool list](https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/),
   [Web Inspector Local Overrides](https://webkit.org/web-inspector/local-overrides/),
   [Safari extension compatibility](https://developer.apple.com/documentation/safariservices/assessing-your-safari-web-extension-s-browser-compatibility),
   [Safari WebDriver session behavior](https://developer.apple.com/documentation/webkit/about-webdriver-for-safari)

   A custom-scheme WebKit view changes the document origin and cannot register an HTTPS scheme handler. An HTTPS
   interception proxy would require certificate trust and handle authenticated traffic outside the browser. Each
   would change the Lense deployment or identity model.
   [WebKit scheme handlers](https://developer.apple.com/documentation/webkit/wkwebviewconfiguration/seturlschemehandler%28_%3Aforurlscheme%3A%29?language=objc)

4. Qualify the remaining browser services independently. These include profile selection and reuse, dialogs and
   downloads, [source provenance](../../lense/inspection-provenance-transport.mjs), [bounded HTTP error evidence](../../lense/http-errors.mjs),
   and [agent actions](../../lense/agent-server.mjs) such as origin-filtered navigation, screenshots and
   cancellation. The script channel and closed-root probes cover specific primitives. Source attribution still
   needs script identity, content and execution evidence comparable to the current DevTools debugger events.
   Run the full Power Pages and model-driven sign-in and edit workflow against authorized references once the
   loopback contracts pass. This work targets desktop browsers. iOS and iPadOS require separate qualification.
