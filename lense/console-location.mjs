// Playwright uses zero for a missing Chromium console line as well as line one.
// Browser diagnostics have no console arguments; preserve real script locations.
export function consoleLocation(message, documentUrl) {
  const location = message.location();
  const supplied = location.url && (location.lineNumber > 0 || (message.args?.().length ?? 0) > 0 || location.url !== documentUrl);
  return { url: location.url || documentUrl,
    line: supplied && Number.isInteger(location.lineNumber) ? location.lineNumber + 1 : undefined,
    column: supplied && Number.isInteger(location.columnNumber) ? location.columnNumber + 1 : undefined };
}
