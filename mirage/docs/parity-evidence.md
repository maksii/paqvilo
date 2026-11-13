# Reference parity evidence

A parity run compares a local runtime with an explicitly selected, authorized reference environment through the intended signed-in browser. It is separate from source bootstrap and local testing. Keep plans, business routes, expected persona access and reference fixtures in your portal project.

```sh
paqvilo mirage parity-suite --config <catalogue> --site <site> --env <env> --cdp http://127.0.0.1:<debug-port> --out .paqvilo/parity
```

Start the browser with a free debug port and confirm that port in the Lense agent status. Reference operations are read-only: plans and route guards reject writes and forbidden actions. You still need authorization to navigate and read the selected environment. Bearer tokens and credentials are never stored, and query values are redacted in reports.

While the signed-in reference driver holds an open tab of its own, every new tab or popup in that browser starts under its control and waits until the driver releases it. Pages opened by its tabs, and popups opened by those pages in turn, are held read-only; every other tab or popup is released at once and is not inspected. Control ends when the driver closes or its last tab closes.

A page is settled once its own requests and the requests of its cross-site frames, at any depth, have finished; frame requests still in flight are listed in `pendingRequests`. Two browser limits apply while a debugging client is attached. A message that a cross-site frame posts to its parent within a few milliseconds of loading can be lost while the reference driver holds a popup of that page at start, which it must do to refuse the popup's writes: a widget that waits for the frame's ready message can then stay in its loading state in the capture. And if another debugging client, for example an open DevTools window or a Playwright session on the same browser, resumes a cross-site frame before the reference driver has started tracking it, requests that frame started before that moment are not counted, so the capture can be reported settled while they still load. Writes from frames are refused in every case.

## Reading a report

Reports separate passes, expected differences, skipped or incomplete observations, source or deployment differences and runtime gaps. Each records the persona and session, source baseline, runtime fingerprint, reference context and diagnostics. A deployed commit cannot be inferred from a run. A source inventory, a successful import, a sign-in page or a local screenshot is not parity coverage. Cite the project's retained comparison when you claim a specific behaviour matches live.

## Query comparisons

A recorded-query comparison needs three independent observations: the authored request, the XML Liquid produced, and the query the backend plug-in received. Compare query structure and results, keeping duplicate rows and error codes. Declare every GUID, timestamp, alias or formatting normalization; a normalized match is not byte equality. A missing backend capture during a failed request is incomplete evidence, not an empty query.

## Permission coverage

Role-mask coverage is finite only for an exact permission graph, actor memberships, environment settings and platform version. A local exhaustive mask test checks the local evaluator; it says nothing about native masks you did not record. The [company example comparison toolkit](../../examples/company-operations/portal-harness/README.md) replays privately retained captures and reports equal, different and unqualified cases separately. Keep raw captures and reports under the project's ignored `.paqvilo/`.

For component-level comparisons of native forms and lists, see the [native component baseline](../../docs/baseline.md).
