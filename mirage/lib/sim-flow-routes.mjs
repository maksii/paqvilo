// /_sim/api flow run administration: run history, waits and the answer to a wait (an approval response, the end of a
// delay or webhook wait). The answer schedules the host's resumeRun(runId, outcome) on the run store's scheduler.
// Run payloads come from the run store views: no trigger input and no secure outputs (they are never journalled). Every
// body still passes redactSecrets, because ordinary connector outputs (response headers, echoed tokens) are journalled.
// It also starts runs on demand (POST /flow-runs, POST /flow-triggers/<flowId> for an HTTP Request trigger) and lists the
// trigger hosts (GET /flow-triggers, flow-triggers.mjs). It serves the signed callback URL of an HTTP Request trigger
// (POST /flow-triggers/<flowId>/callback-url answers it; any method on /flow-triggers/<flowId>/triggers/<name>/paths/invoke
// runs the flow when its sig is valid, else 401) and the OAuth sign-in of a project connection
// (GET /connections lists them, POST /connections/<id>/authorize, GET /connections/<id>/authorization). Every other POST needs the simulator CSRF token;
// the callback URL is authorised by its signature instead.
// Mounted by the host: `const flowRoutes = createFlowRoutes({ api, csrf, resumeRun })`, then
// `if (await flowRoutes(req, res, url)) return;` before the generic runtime admin router.
import { redactSecrets } from './sim-messaging-routes.mjs';
import { inspectFlowTrigger, runTrackedFlow, triggerPrincipal, validateFlowInput } from './flow-runtime.mjs';
import { flowTriggersOf, flowCallbackUrl, verifyFlowCallback } from './flow-triggers.mjs';
import { runOwned } from './dataverse-transaction-context.mjs';
import { isExactNumeric, parseExactJson, stringifyExactJson } from './exact-numeric.mjs';
import { recordHttpError, statusFromHttp } from './trace-store.mjs';
import { setTraceHeaders } from './trace-hosts.mjs';

const MAX_BODY = 64 * 1024;
const PREFIX = /^\/(?:_sim|__sim)\/api(?=\/|$)/;
/** The /_sim/api prefixes this router answers (status `routes`). */
export const routes = Object.freeze(['/flow-runs', '/flow-waits', '/flow-triggers', '/connections']);
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });

function send(res, status, value, headers = {}) {
  res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(stringifyExactJson(redactSecrets(value)));
}
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY) throw failure(413, 'PayloadTooLarge', 'The request body is too large.');
    chunks.push(bytes);
  }
  if (!size) return {};
  let value;
  try {
    value = parseExactJson(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    throw failure(400, 'InvalidRequest', 'The request body must be JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || isExactNumeric(value))
    throw failure(400, 'InvalidRequest', 'The request body must be a JSON object.');
  return value;
}
// One on-demand tracked run of a flow whose local choice is its exported definition. kinds: the trigger kinds accepted.
async function startRun(api, processId, input, { kinds, trigger }) {
  const runs = api.flowRuns,
    flow = typeof runs.flowOf === 'function' ? runs.flowOf(processId) : null;
  if (!flow?.definition) throw failure(404, 'FlowNotFound', 'No exported cloud flow has this id.');
  if (flow.mode !== 'exported')
    throw failure(
      409,
      'FlowNotExecutable',
      `The flow's local choice is ${flow.mode}; choose its exported definition to start it.`,
    );
  const inspected = inspectFlowTrigger(flow.definition, { connectors: flow.connectors });
  if (!inspected.supported || !kinds.includes(inspected.kind))
    throw failure(
      400,
      'FlowTriggerUnsupported',
      `This route starts ${kinds.join(', ')} flows; this flow's trigger is ${inspected.kind}${inspected.supported ? '' : ' (' + inspected.errors.join(' ') + ')'}.`,
    );
  if (!input || typeof input !== 'object' || Array.isArray(input) || isExactNumeric(input))
    throw failure(400, 'InvalidRequest', 'The flow input must be a JSON object.');
  const store = api.store,
    transact = (fn) => store.transact(fn, { cloneResult: false });
  let runId = null;
  const result = await runTrackedFlow({
    runs,
    processId,
    name: flow.name ?? null,
    trigger,
    definition: flow.definition,
    input,
    store,
    onRun: (id) => {
      runId = id;
    },
    serviceProfile:
      flow.serviceProfile ?? triggerPrincipal(flow.connectors, flow.definition, flow.connectionReferences),
    steps: flow.steps,
    connectors: flow.connectors,
    connectionReferences: flow.connectionReferences,
    secrets: flow.secrets,
    context: { background: true },
    diagnostic: api.diagnostic ?? (() => {}),
    // The run owns the change slot (runOwned): a custom API it calls joins the run's transaction instead of queueing behind it.
    wrap: (fn) => (typeof api.change === 'function' ? api.change(() => runOwned(() => transact(fn))) : transact(fn)),
  }).catch((error) => {
    throw Object.assign(error, { runId });
  });
  return { result, runId: result?.runId ?? runId, kind: inspected.kind };
}
const segment = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw failure(400, 'InvalidRequest', 'Invalid identifier encoding.');
  }
};

// The span error of an answer of 400 or more: its { error: { code, message } } envelope, else the status.
const answerError = (value, status) => ({
  code: typeof value?.error?.code === 'string' ? value.error.code : 'Http' + status,
  message: typeof value?.error?.message === 'string' ? value.error.message : `The flow answered status ${status}.`,
});
// The http root of a run-starting request (D-R3-28): an HTTP Request trigger's route or signed callback URL, or an on-demand
// POST /flow-runs. It joins the caller's trace (X-Trace-Id, X-Sim-Parent-Trace), names the serving host, and its actor is the
// simulator administrator (CSRF-authorised routes) or an anonymous caller (a signed callback URL); the flow-run is its child.
function flowRoot(traces, req, url, { origin, route, signed }) {
  const where = typeof origin === 'function' ? origin() : origin;
  return traces.start({
    kind: 'http',
    name: `${req.method} ${url.pathname}`,
    module: 'flows',
    operation: req.method,
    actor: signed ? { kind: 'anonymous', id: null, name: 'caller' } : { kind: 'system', id: null, name: 'simulator' },
    session: { visitorId: null, sessionKey: null },
    origin: { host: where?.host ?? 'sim', portal: where?.portal ?? null, preset: where?.preset ?? null },
    attributes: { route, method: req.method, ...(signed ? { signed: true } : {}) },
    ...traces.fromHeaders(req.headers),
  });
}

/** createFlowRoutes({ api, csrf, resumeRun, origin }) -> (req, res, url) => Promise<boolean>. api.flowRuns is the run store
 * (flow-runs.mjs); api.providers.connectors.approvals answers approval responses. origin: the serving host's
 * { host, portal, preset } (or a function answering it) for the http roots of run-starting requests; default host 'sim'. */
export function createFlowRoutes({ api, csrf, resumeRun = api?.resumeRun ?? null, origin = null }) {
  return async (req, res, url) => {
    const prefix = PREFIX.exec(url.pathname);
    if (!prefix) return false;
    const relative = url.pathname.slice(prefix[0].length);
    const runsRoute = /^\/flow-runs(?:\/([^/]+))?$/.exec(relative),
      waitsRoute = /^\/flow-waits(?:\/([^/]+))?$/.exec(relative);
    const triggersRoute = /^\/flow-triggers(?:\/([^/]+))?$/.exec(relative);
    const invokeRoute = /^\/flow-triggers\/([^/]+)\/triggers\/([^/]+)\/paths\/invoke$/.exec(relative),
      callbackRoute = /^\/flow-triggers\/([^/]+)\/callback-url$/.exec(relative);
    const connectionRoute = /^\/connections(?:\/([^/]+)\/(authorize|authorization))?$/.exec(relative);
    if (!runsRoute && !waitsRoute && !triggersRoute && !invokeRoute && !callbackRoute && !connectionRoute) return false;
    // Run-starting requests open an http root (flowRoot); every other route is administration and opens none.
    const route = invokeRoute
        ? 'flow-callback'
        : req.method === 'POST' && triggersRoute?.[1]
          ? 'flow-trigger'
          : req.method === 'POST' && runsRoute && !runsRoute[1]
            ? 'flow-run'
            : null,
      traces = route && api?.store?.traces?.enabled ? api.store.traces : null,
      span = traces ? flowRoot(traces, req, url, { origin, route, signed: route === 'flow-callback' }) : null;
    if (span) {
      setTraceHeaders(res, span);
      res.on('close', () => {
        const status = res.writableFinished ? res.statusCode : 499;
        span.end({ status: statusFromHttp(status), attributes: { statusCode: status } });
      });
    }
    // Every answer of 400 or more records its error code and message on the root (D-R3-4).
    const reply = (status, value, headers) => {
      if (span && status >= 400) recordHttpError(span, status, answerError(value, status));
      send(res, status, value, headers);
    };
    const serve = async () => {
      try {
        // The callback URL of an HTTP Request trigger: its signature authorises the call (no CSRF token), its method and
        // schema are the trigger's (https://learn.microsoft.com/azure/connectors/connectors-native-reqres).
        // The native status codes of a wrong method (405) and an invalid signature (401) are guesses.
        if (invokeRoute) {
          const runs = api?.flowRuns;
          if (!runs) throw failure(501, 'FlowRunsNotConfigured', 'This runtime has no flow run store.');
          const processId = segment(invokeRoute[1]),
            triggerName = segment(invokeRoute[2]),
            flow = runs.flowOf?.(processId);
          const name = flow?.definition ? Object.keys(flow.definition.triggers ?? {})[0] : null;
          if (
            !flow?.definition ||
            name !== triggerName ||
            !(await verifyFlowCallback({
              store: api.store,
              vault: runs.vault,
              processId,
              triggerName,
              query: url.searchParams,
            }))
          )
            throw failure(
              401,
              'DirectApiInvalidAuthorizationSignature',
              'The callback URL signature is not valid for this flow trigger.',
            );
          const inspected = inspectFlowTrigger(flow.definition, { connectors: flow.connectors });
          if (inspected.kind !== 'http')
            throw failure(400, 'FlowTriggerUnsupported', 'This flow has no HTTP Request trigger.');
          if (inspected.method && req.method !== inspected.method)
            throw failure(405, 'MethodNotAllowed', `The trigger accepts ${inspected.method} requests only.`);
          const input = await body(req);
          try {
            validateFlowInput(input, flow.definition.triggers[name].inputs?.schema ?? {});
          } catch (error) {
            throw failure(400, 'InvalidRequest', error.message);
          }
          const { result, runId } = await startRun(api, processId, input, { kinds: ['http'], trigger: 'Http' });
          if (Number.isInteger(result?.status))
            reply(
              result.status,
              result.body ?? null,
              Object.fromEntries(
                Object.entries(result.headers ?? {}).filter(
                  ([key]) => /^(?:content-type|x-.*)$/i.test(key) && !/^(?:x-sim|x-trace-id$)/i.test(key),
                ),
              ),
            );
          else reply(202, { runId, status: result?.status ?? null });
          return true;
        }
        const token = csrf();
        if (req.method !== 'GET' && (!token || req.headers['x-sim-csrf'] !== token))
          throw failure(403, 'Forbidden', 'Missing simulator CSRF token.');
        // OAuth authorization code sign-in of a project connection (connector-runtime.mjs oauth): the answer names the
        // authorization URL to open; the loopback redirect completes the sign-in. No token is ever answered.
        if (connectionRoute) {
          const oauth = api?.providers?.connectors?.oauth;
          if (!oauth) throw failure(501, 'ConnectorsNotConfigured', 'This runtime has no connector runtime.');
          if (!connectionRoute[1]) {
            if (req.method !== 'GET') throw failure(405, 'MethodNotAllowed', 'Unsupported connection operation.');
            reply(200, oauth.list());
            return true;
          }
          const id = segment(connectionRoute[1]);
          if (connectionRoute[2] === 'authorization' && req.method === 'GET') {
            reply(200, oauth.status(id));
            return true;
          }
          if (connectionRoute[2] === 'authorize' && req.method === 'POST') {
            const started = await oauth.authorize(id);
            started.completion.then(
              (done) => api.diagnostic?.({ code: 'CONNECTION_SIGNED_IN', connectionId: done.connectionId }),
              (error) =>
                api.diagnostic?.({
                  code: 'CONNECTION_SIGN_IN_FAILED',
                  connectionId: id,
                  error: { code: error.code ?? 'ConnectionUnauthorized', message: error.message },
                }),
            );
            reply(202, {
              connectionId: id,
              authorizeUrl: started.authorizeUrl,
              redirectUri: started.redirectUri,
              expiresAt: started.expiresAt,
            });
            return true;
          }
          throw failure(405, 'MethodNotAllowed', 'Unsupported connection operation.');
        }
        const runs = api?.flowRuns;
        if (!runs) throw failure(501, 'FlowRunsNotConfigured', 'This runtime has no flow run store.');
        if (callbackRoute && req.method === 'POST') {
          const processId = segment(callbackRoute[1]),
            flow = runs.flowOf?.(processId);
          if (!flow?.definition) throw failure(404, 'FlowNotFound', 'No exported cloud flow has this id.');
          const inspected = inspectFlowTrigger(flow.definition, { connectors: flow.connectors });
          if (inspected.kind !== 'http')
            throw failure(400, 'FlowTriggerUnsupported', 'Only an HTTP Request trigger has a callback URL.');
          reply(
            200,
            await flowCallbackUrl({
              store: api.store,
              vault: runs.vault,
              processId,
              triggerName: Object.keys(flow.definition.triggers)[0],
              origin: `http://${req.headers.host}`,
              method: inspected.method,
            }),
          );
          return true;
        }
        if (triggersRoute && req.method === 'GET' && !triggersRoute[1]) {
          const triggers = flowTriggersOf(api.store);
          if (!triggers) throw failure(501, 'FlowTriggersNotConfigured', 'This runtime hosts no flow triggers.');
          reply(200, triggers.triggers());
          return true;
        }
        // An HTTP Request trigger: the body is the trigger body; the flow's Response answers, else 202 (the native 202 body is a guess).
        if (triggersRoute && req.method === 'POST' && triggersRoute[1]) {
          const { result, runId } = await startRun(api, segment(triggersRoute[1]), await body(req), {
            kinds: ['http'],
            trigger: 'Http',
          });
          // Only content-type and x-* headers reach the simulator origin (never x-sim*, the root's x-trace-id, cookies, redirects or CSP).
          if (Number.isInteger(result?.status))
            reply(
              result.status,
              result.body ?? null,
              Object.fromEntries(
                Object.entries(result.headers ?? {}).filter(
                  ([name]) => /^(?:content-type|x-.*)$/i.test(name) && !/^(?:x-sim|x-trace-id$)/i.test(name),
                ),
              ),
            );
          else reply(202, { runId, status: result?.status ?? null });
          return true;
        }
        // On-demand start of a manual, HTTP Request, Recurrence or pack connector-trigger flow: { processId, input }.
        if (runsRoute && req.method === 'POST' && !runsRoute[1]) {
          const input = await body(req);
          if (typeof input.processId !== 'string' || !input.processId)
            throw failure(400, 'InvalidRequest', 'A flow run needs processId.');
          const { result, runId } = await startRun(api, input.processId, input.input ?? {}, {
            kinds: ['manual', 'http', 'recurrence', 'connector'],
            trigger: 'Manual',
          });
          if (result?.status === 'Skipped') {
            reply(202, { runId: null, status: 'Skipped', reason: result.reason });
            return true;
          }
          reply(201, {
            ...(runs.get(runId) ? { ...runs.get(runId), journal: undefined } : { runId }),
            ...(Number.isInteger(result?.status)
              ? { response: { status: result.status, body: result.body ?? null } }
              : {}),
          });
          return true;
        }
        if (runsRoute && req.method === 'GET') {
          if (!runsRoute[1]) {
            reply(
              200,
              runs.list({
                processId: url.searchParams.get('processId') || undefined,
                status: url.searchParams.get('status') || undefined,
              }),
            );
            return true;
          }
          const run = runs.get(segment(runsRoute[1]));
          if (!run) throw failure(404, 'FlowRunNotFound', 'The flow run does not exist.');
          reply(200, run);
          return true;
        }
        if (waitsRoute && req.method === 'GET' && !waitsRoute[1]) {
          reply(200, runs.waits({ state: url.searchParams.get('state') || undefined }));
          return true;
        }
        if (waitsRoute && req.method === 'POST' && waitsRoute[1]) {
          if (typeof resumeRun !== 'function')
            throw failure(501, 'FlowResumeNotWired', 'This runtime does not resume waiting flow runs.');
          const id = segment(waitsRoute[1]),
            input = await body(req);
          const wait = runs.waits().find((w) => w.id === id);
          if (!wait) throw failure(404, 'FlowWaitNotFound', 'No waiting flow run has this wait.');
          // A parent waiting on its child flow run resumes when that run completes (flow-runs.mjs), never from an answer here.
          if (wait.kind === 'child')
            throw failure(
              409,
              'FlowWaitOwnedByChild',
              'This run waits on its child flow run ' + wait.id + ' and resumes when that run completes.',
            );
          let outputs;
          if (wait.kind === 'approval') {
            const approvals = api.providers?.connectors?.approvals;
            if (!approvals) throw failure(501, 'ApprovalsNotConfigured', 'This runtime has no approvals provider.');
            outputs = await approvals.respond(id, {
              outcome: input.outcome,
              responder: input.responder,
              comments: input.comments,
            });
          } else outputs = input.outputs ?? {};
          const outcome = { status: 'Succeeded', outputs };
          const scheduled = runs
            .scheduler()
            .schedule(() => resumeRun(wait.runId, outcome), 0, { name: 'flow-run-resume' });
          if (scheduled === null) throw failure(503, 'SchedulerClosed', 'The runtime is closing.');
          reply(202, {
            runId: wait.runId,
            waitId: id,
            kind: wait.kind,
            scheduled: true,
            ...(wait.kind === 'approval' ? { outcome: outputs.body?.outcome ?? null } : {}),
          });
          return true;
        }
        throw failure(405, 'MethodNotAllowed', 'Unsupported flow run operation.');
      } catch (error) {
        reply(error.status ?? 500, {
          error: {
            code: error.code ?? 'InternalError',
            message: error.status ? error.message : 'The flow run request failed.',
          },
          ...(error.runId ? { runId: error.runId } : {}),
        });
        return true;
      }
    };
    return span ? traces.run(span, serve) : serve();
  };
}
