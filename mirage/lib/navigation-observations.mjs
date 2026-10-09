/** A portal page redirects its slash-less path to the trailing-slash page, so the
 * replacement read may complete under the redirected URL. */
function comparableUrl(value) {
  try {
    const url = new URL(value);
    return url.origin + url.pathname.replace(/\/$/, "") + url.search;
  } catch {
    return null;
  }
}

/** Retain raw failures; recognize only observed authored cancellations with a successful replacement read. */
export function classifyNavigationObservations(report, pages = []) {
  const used = new Set();
  const sourceSupersededReads = [];
  for (const [failureIndex, failure] of report.failedRequests.entries()) {
    if (failure.method !== "GET" || failure.error !== "net::ERR_ABORTED")
      continue;
    let target;
    try {
      target = new URL(failure.url);
    } catch {
      continue;
    }
    if (report.origin && target.origin !== new URL(report.origin).origin) continue;
    // Authored DataTables reload and polling (ajax.reload) abort the read in
    // flight from the DataTables script and issue it again.
    const index = (report.sourceAborts ?? []).findIndex(
      (abort, i) =>
        !used.has(i) &&
        abort.method === "GET" &&
        abort.url === failure.url &&
        // Page and harness clocks observe the same read a few milliseconds apart.
        abort.at >= failure.startedAt - 250 &&
        abort.at <= failure.at + 1000 &&
        /\/datatables(?:\.min)?\.js:\d+:\d+/i.test(abort.stack ?? ""),
    );
    if (index < 0) continue;
    const abort = report.sourceAborts[index];
    const replacement = report.calls.find(
      (call) =>
        call.method === "GET" &&
        comparableUrl(call.url) === comparableUrl(failure.url) &&
        call.status === 200 &&
        call.at >= abort.at &&
        call.at <= abort.at + 10000,
    );
    if (!replacement) continue;
    used.add(index);
    sourceSupersededReads.push({
      failureIndex,
      observation: abort,
      replacement,
      classification: "observed-authored-datatables-reload",
    });
  }
  const expectedAccessDenials = report.failedResponses
    .filter((failure) => {
      if (failure.method !== "GET" || failure.status !== 403) return false;
      return pages.some((page) => {
        const access = page.access;
        return (
          access?.allowed === false &&
          access.code === "PAGE_ACCESS_DENIED" &&
          access.ruleIds?.length &&
          !(access.diagnostics ?? []).some(
            (item) => item.code !== "PAGE_ROLE_ASSOCIATIONS_UNRESOLVED",
          ) &&
          new URL(page.url, report.origin).pathname ===
            new URL(failure.url).pathname
        );
      });
    })
    .map((failure) => ({
      ...failure,
      classification: "exported-page-role-denial",
      access: pages.find(
        (page) =>
          new URL(page.url, report.origin).pathname ===
          new URL(failure.url).pathname,
      ).access,
    }));
  // The runner blocks other origins as outside local navigation validation; a blocked read of
  // another origin loads hosted content (an embedded report, analytics) and is reported as
  // hosted, not as a failure. Blocked writes and simulator administration stay unexpected.
  const external = (value) => {
    try {
      return Boolean(report.origin) && new URL(value).origin !== new URL(report.origin).origin;
    } catch {
      return false;
    }
  };
  const blockedHosted = (request) =>
    request.method === "GET" &&
    external(request.url) &&
    (report.blockedRequests ?? []).some((blocked) => blocked.method === "GET" && comparableUrl(blocked.url) === comparableUrl(request.url));
  const hostedRequests = report.failedRequests
    .map((request, failureIndex) => ({ request, failureIndex }))
    .filter(({ request }) => blockedHosted(request))
    .map(({ request, failureIndex }) => ({ ...request, failureIndex, classification: "hosted-external-read" }));
  const expectedDenialConsole = report.consoleErrors.filter(
    (item) =>
      /server responded with a status of 403/.test(item.message) &&
      expectedAccessDenials.some((denial) => denial.url === item.location),
  );
  return {
    sourceSupersededReads,
    expectedAccessDenials,
    expectedDenialConsole,
    hostedRequests,
    unexpectedFailedRequests: report.failedRequests.filter(
      (request, index) =>
        !request.simulatorEventStream &&
        !sourceSupersededReads.some((item) => item.failureIndex === index) &&
        !hostedRequests.some((item) => item.failureIndex === index),
    ),
    unexpectedBlockedRequests: (report.blockedRequests ?? []).filter(
      (blocked) => !(blocked.method === "GET" && external(blocked.url)),
    ),
    unexpectedFailedResponses: report.failedResponses.filter(
      (failure) =>
        !expectedAccessDenials.some(
          (item) =>
            item.url === failure.url &&
            item.method === failure.method &&
            item.status === failure.status,
        ),
    ),
    unexpectedConsoleErrors: report.consoleErrors.filter(
      (item) => !expectedDenialConsole.includes(item),
    ),
  };
}
