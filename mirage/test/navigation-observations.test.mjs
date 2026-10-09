import test from "node:test";
import assert from "node:assert/strict";
import { classifyNavigationObservations } from "../lib/navigation-observations.mjs";
const url =
  "http://127.0.0.1:8787/fetchchangerequestactivities?id=change&type=getProducts";
const fixture = () => ({
  origin: "http://127.0.0.1:8787",
  failedRequests: [
    {
      method: "GET",
      url,
      error: "net::ERR_ABORTED",
      startedAt: 1000,
      at: 1600,
    },
  ],
  calls: [{ method: "GET", url, status: 200, at: 1700 }],
  sourceAborts: [
    {
      method: "GET",
      url,
      at: 1500,
      stack:
        "at De (http://127.0.0.1:8787/scripts/datatables.min.js:30:400)\nat reloadCRActivityTable (http://127.0.0.1:8787/productUI_ChangeRequestDetail.js:1471:48)",
    },
  ],
  failedResponses: [],
  consoleErrors: [],
});
test("authored cancellation classification needs an observed matching source stack and subsequent successful replacement", () => {
  assert.equal(
    classifyNavigationObservations(fixture()).sourceSupersededReads.length,
    1,
  );
  for (const modify of [
    (r) => (r.sourceAborts = []),
    (r) => (r.calls[0].status = 500),
    (r) => (r.calls[0].at = 1400),
    (r) => (r.sourceAborts[0].at = 500),
    (r) => (r.sourceAborts[0].stack = "at unrelatedAction"),
    (r) => (r.failedRequests[0].method = "POST"),
    // The only successful later read is for another record.
    (r) => (r.calls[0].url = url.replace("getProducts", "other")),
    // A cross-origin read is never reconciled.
    (r) => {
      r.failedRequests[0].url = r.sourceAborts[0].url = r.calls[0].url = "http://elsewhere.invalid/fetchchangerequestactivities?type=getProducts";
    },
  ]) {
    const report = fixture();
    modify(report);
    assert.equal(
      classifyNavigationObservations(report).unexpectedFailedRequests.length,
      1,
    );
  }
  const duplicate = fixture();
  duplicate.failedRequests.push({ ...duplicate.failedRequests[0] });
  assert.equal(
    classifyNavigationObservations(duplicate).unexpectedFailedRequests.length,
    1,
  );
});
test("authored DataTables polling of any fetch page is superseded by its redirected replacement read", () => {
  const report = fixture();
  const other = "http://127.0.0.1:8787/fetchapplicationactivities?id=app";
  // The page observes the abort slightly before the harness records the request start.
  report.failedRequests = [{ method: "GET", url: other, error: "net::ERR_ABORTED", startedAt: 1502, at: 1600 }];
  report.sourceAborts = [{ method: "GET", url: other, at: 1500, stack: "Error: Authored XHR abort\nat Object.abort (http://127.0.0.1:8787/scripts/jquery.min.js:2:82791)\nat De (http://127.0.0.1:8787/scripts/datatables.min.js:30:48604)" }];
  // The slash-less fetch page answers with a redirect; the replacement completes on the trailing-slash URL.
  report.calls = [
    { method: "GET", url: other, status: 301, at: 1650 },
    { method: "GET", url: "http://127.0.0.1:8787/fetchapplicationactivities/?id=app", status: 200, at: 1700 },
  ];
  const classified = classifyNavigationObservations(report);
  assert.equal(classified.sourceSupersededReads.length, 1);
  assert.equal(classified.sourceSupersededReads[0].classification, "observed-authored-datatables-reload");
  assert.equal(classified.unexpectedFailedRequests.length, 0);
});
test("only resolved exported page-role denials can classify matching document403 and exact console resource URL", () => {
  const report = fixture(),
    url = report.origin + "/epi-list/";
  report.failedResponses = [{ method: "GET", url, status: 403 }];
  report.consoleErrors = [
    {
      message:
        "Failed to load resource: the server responded with a status of 403 (Forbidden)",
      location: url,
    },
    {
      message:
        "Failed to load resource: the server responded with a status of 403 (Forbidden)",
      location: report.origin + "/other-resource",
    },
  ];
  const pages = [
    {
      url: "/epi-list/",
      access: {
        allowed: false,
        code: "PAGE_ACCESS_DENIED",
        ruleIds: ["exported-rule"],
        diagnostics: [],
      },
    },
  ];
  let result = classifyNavigationObservations(report, pages);
  assert.equal(result.expectedAccessDenials.length, 1);
  assert.equal(result.unexpectedConsoleErrors.length, 1);
  pages[0].access.code = "PAGE_RULE_UNRESOLVED";
  result = classifyNavigationObservations(report, pages);
  assert.equal(result.unexpectedFailedResponses.length, 1);
  assert.equal(result.unexpectedConsoleErrors.length, 2);
});

test("A blocked read of another origin is hosted content, not a failure; blocked writes stay unexpected", () => {
  const origin = "http://127.0.0.1:8080";
  const report = {
    origin,
    failedRequests: [
      { method: "GET", url: "https://reports.example.test/view?r=token", error: "net::ERR_FAILED", startedAt: 1, at: 2 },
      { method: "GET", url: origin + "/missing/", error: "net::ERR_FAILED", startedAt: 3, at: 4 },
    ],
    blockedRequests: [
      { method: "GET", url: "https://reports.example.test/view?r=token", reason: "External requests are outside the local navigation validation." },
      { method: "POST", url: "https://collector.example.test/track", reason: "External requests are outside the local navigation validation." },
    ],
    failedResponses: [],
    consoleErrors: [],
    sourceAborts: [],
    calls: [],
  };
  const classified = classifyNavigationObservations(report);
  assert.deepEqual(classified.hostedRequests.map((item) => [item.url, item.classification]), [["https://reports.example.test/view?r=token", "hosted-external-read"]]);
  assert.deepEqual(classified.unexpectedFailedRequests.map((item) => item.url), [origin + "/missing/"]);
  assert.deepEqual(classified.unexpectedBlockedRequests.map((item) => item.method), ["POST"]);
});
