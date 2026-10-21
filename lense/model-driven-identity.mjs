const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Request identity belongs to one owned app tab, never to the browser profile.
 * No identity or request values are included in inspector/agent snapshots.
 */
export function createModelDrivenIdentity({ origin, page }) {
  let objectId, closed = false;
  return {
    get active() { return Boolean(objectId); },
    start(value) { if (closed || !GUID.test(value)) return false; objectId = value.toLowerCase(); return true; },
    stop() { objectId = undefined; },
    close() { objectId = undefined; closed = true; },
    prepare(route) {
      if (closed || page.isClosed()) return;
      try {
        const request = route.request(), url = new URL(request.url());
        // A same-document SPA event also emits framenavigated. Retire identity
        // on an actual main-document request rather than that ambiguous event.
        if (request.isNavigationRequest?.() && !request.frame()?.parentFrame?.()) { objectId = undefined; return; }
        if (!objectId) return;
        if (new URL(page.url()).origin !== origin || request.frame()?.page() !== page || url.origin !== origin || !/^\/api\/data\/v\d+\.\d+\//i.test(url.pathname)) return;
        // Never replace an explicit caller selected by native/custom code.
        const headers = request.headers();
        if (Object.keys(headers).some(name => ['callerobjectid', 'mscrmcallerid'].includes(name.toLowerCase()))) return;
        route.setRequestHeader('CallerObjectId', objectId);
      } catch { /* Closed/foreign requests retain their native identity. */ }
    },
  };
}

/** Explicit Start preflight; private labels are delivered in the browser only.
 * Only the Boolean acknowledgement is allowed to cross back to the controller.
 */
export async function verifyModelDrivenIdentity({ origin, token, objectId, requestId }) {
  const host = document.getElementById('paqvilo-model-inspector');
  const sessionLive = () => location.origin === origin && host?.isConnected && host.__paqModelActions?.token === token && !window.__paqviloRetiredModelInspectors?.includes(token);
  const live = () => sessionLive() && host.__paqModelIdentityRequest === requestId;
  const receive = result => { if (live()) host.__paqModelActions.receive(requestId, result); };
  if (!sessionLive() || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(objectId ?? '')) return false;
  Object.defineProperty(host, '__paqModelIdentityRequest', { configurable: true, writable: true, value: requestId });
  const controller = new AbortController(); let timeout;
  try {
    const context = window.Xrm?.Utility?.getGlobalContext(), privileges = await Promise.race([context?.userSettings?.getSecurityRolePrivilegesInfo?.(), new Promise((_resolve, reject) => { timeout = setTimeout(() => { controller.abort(); reject(Error('Native identity verification did not finish within 10 seconds.')); }, 10000); })]);
    if (!live()) return false;
    if (!Object.values(privileges ?? {}).some(privilege => privilege.privilegeName === 'prvActOnBehalfOfAnotherUser')) throw Error('The signed-in user does not expose the Act on Behalf of Another User privilege.');
    if (new URL(context.getClientUrl()).origin !== origin) throw Error('The native environment changed.');
    const version = /^(\d+)\.(\d+)(?:\.|$)/.exec(context.getVersion());
    if (!version) throw Error('The native API version is unavailable.');
    const url = new URL(`/api/data/v${version[1]}.${version[2]}/systemusers`, origin);
    url.search = new URLSearchParams({ '$select': 'azureactivedirectoryobjectid,fullname', '$filter': `azureactivedirectoryobjectid eq ${objectId} and isdisabled eq false and applicationid eq null`, '$top': '2' }).toString();
    const response = await fetch(url, { credentials: 'same-origin', redirect: 'error', signal: controller.signal, headers: { accept: 'application/json' } });
    if (!live()) return false;
    if (!response.ok) throw Error(`User eligibility read failed (HTTP ${response.status}).`);
    const text = await response.text();
    if (text.length > 128 * 1024) throw Error('The user eligibility response exceeds its read limit.');
    const body = JSON.parse(text);
    if (!live()) return false;
    const user = body.value?.length === 1 && body.value[0];
    if (!user || user.azureactivedirectoryobjectid?.toLowerCase() !== objectId.toLowerCase()) throw Error('Select one enabled Dataverse user with a Microsoft Entra object ID.');
    Object.defineProperty(host, '__paqModelIdentityLabel', { configurable: true, writable: true, value: String(user.fullname ?? 'Selected user').slice(0, 300) });
    return true;
  } catch (error) { receive({ status: 'error', title: 'Identity unchanged', message: String(error?.message ?? error).slice(0, 2000) }); return false; }
  finally { clearTimeout(timeout); }
}

export function modelDrivenIdentityResult({ origin, token, requestId, active }) {
  const host = document.getElementById('paqvilo-model-inspector');
  if (location.origin !== origin || host?.__paqModelActions?.token !== token || window.__paqviloRetiredModelInspectors?.includes(token)) return false;
  if (active && host.__paqModelIdentityRequest !== requestId) return false;
  host.__paqModelActions.receive(requestId, { status: 'ok', title: active ? 'Request identity active' : 'Request identity stopped', message: active ? 'This Lense app tab’s Dataverse Web API requests now use the selected user, subject to server permissions. Already loaded data keeps its previous visibility until you refresh it.' : 'Future requests use their native identity. Requests already sent cannot be recalled.', identity: { active, ...(active ? { label: host.__paqModelIdentityLabel ?? 'Selected user' } : {}) } });
  if (!active) { delete host.__paqModelIdentityLabel; delete host.__paqModelIdentityRequest; }
  return true;
}
