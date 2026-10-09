import { randomUUID } from "node:crypto";

/**
 * Server logic (powerpagecomponent type 35, adx_serverlogic) is imported with its web roles and
 * code file (lib/importer.mjs serverLogics) but never run: the Mirage has no server-logic
 * runtime (no sandbox for the code, no Server.Connector.Dataverse, HttpClient or CloudFlow), and
 * it never forwards these calls to a live site, because server code can change data on any verb.
 *
 * Every call to /_api/serverlogics/<name> (Learn, "Server logic API URL" and "Supported HTTP
 * methods": GET, POST, PUT, PATCH and DELETE) receives this documented answer instead:
 *
 * - 501 when the export has a server logic record with that name (case-insensitive), 404 when
 *   it has none;
 * - the response envelope of server logic calls, camelCase as Microsoft's samples receive it
 *   ({ requestId, success, serverLogicName, data, error }; ecosystem review
 *   docs/runtime-evidence.md, server logic), with success false, data null
 *   and error { code, message };
 * - an x-sim-route: server-logic-unsupported header.
 *
 * A /_sim endpoint configured for the same path (Endpoints) answers instead, so a page can be
 * exercised with a mocked server logic response.
 */
const SERVER_LOGIC_PATH = /^\/_api\/serverlogics\/([^/]+)\/?$/i;

/** The server logic name a request path calls, or null. */
export function serverLogicName(pathname) {
  const match = SERVER_LOGIC_PATH.exec(String(pathname ?? ""));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** { status, headers, body, diagnostic } of the unsupported answer for a server logic call. */
export function serverLogicUnsupported(portal, name, method = "GET") {
  const record = (portal?.serverLogics ?? []).find((item) => String(item.name ?? "").toLowerCase() === String(name).toLowerCase()) ?? null;
  const status = record ? 501 : 404;
  const code = record ? "ServerLogicNotSupportedLocally" : "ServerLogicNotFound";
  const message = record
    ? `Server logic "${record.name}" is not run by the Mirage (no local server-logic runtime), and calls are not forwarded to a live site. Mock the response with a /_sim endpoint for this path if a page needs one.`
    : `The export has no server logic named "${name}".`;
  return {
    status,
    headers: { "x-sim-route": "server-logic-unsupported", "cache-control": "no-store" },
    body: { requestId: randomUUID(), success: false, serverLogicName: record?.name ?? name, data: null, error: { code, message } },
    diagnostic: {
      code: record ? "SERVER_LOGIC_UNSUPPORTED" : "SERVER_LOGIC_NOT_FOUND",
      name: record?.name ?? name,
      method: String(method).toUpperCase(),
      message,
    },
  };
}
