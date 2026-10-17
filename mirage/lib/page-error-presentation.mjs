import { randomUUID } from "node:crypto";

const TITLE = "We're sorry, but something went wrong (500)";
const HEADING = "We're sorry, but something went wrong. Please try again, and if this persists, contact the website administrator.";
const BOUNDARY = "A potentially dangerous Request.QueryString value was detected from the client";
const escape = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

/**
 * A site's selected, evidenced error structure. No request values, native opaque
 * identifiers, scripts, stylesheet bytes or unobserved exceptions are replayed.
 * This deliberately does not claim complete hosted error-document parity.
 */
export function observedPageErrorResponse({ method, error, observed } = {}) {
  if (observed?.pageErrorPresentation !== "generic-error" || method !== "GET" ||
      error?.code !== "PAGE_QUERY_REQUEST_VALIDATION" ||
      (error.status ?? error.statusCode) !== 500) return null;
  const id = randomUUID();
  return {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: `<!doctype html><html><head><title>${escape(TITLE)}</title></head><body><h1>${escape(HEADING)}</h1><h1>Error ID: [${id}]</h1><div>${escape(BOUNDARY)}</div></body></html>`,
  };
}
