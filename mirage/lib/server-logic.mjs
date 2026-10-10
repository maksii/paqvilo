import { randomUUID } from "node:crypto";

/**
 * Server logic (powerpagecomponent type 35, adx_serverlogic) is imported with its web roles and
 * code file (lib/importer.mjs serverLogics). Execution requires an explicit trusted pack
 * registration (lib/exported-operations.mjs). Calls are never forwarded to a live site.
 *
 * Unregistered calls to /_api/serverlogics/<name> receive this fallback:
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
    ? `Server logic "${record.name}" has no active local handler. Register it in a trusted project pack or configure a local mock response. Calls are not forwarded to a live site.`
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
