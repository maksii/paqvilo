import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseCookies } from './auth-session.mjs';
import { DataError } from './data-error.mjs';
import { uuidV5 } from './dataverse-security.mjs';

const unavailable = () => new DataError('The selected staff user is unavailable or disabled.', 401, 'StaffPrincipalUnavailable');
const GUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

/** A local staff persona is independent of Power Pages contact sign-in. The
 * signed, process-local cookie stores only a user id; roles are resolved anew
 * on every request. Absence retains explicit local administration compatibility. */
export function createStaffSessions({ organization, port = () => '', secret = randomBytes(32) }) {
  const core = () => typeof organization === 'function' ? organization() : organization;
  const name = () => `paqvilo-mirage-staff${port() ? `-${port()}` : ''}`;
  const sign = value => createHmac('sha256', secret).update(value).digest('base64url');
  const selected = req => {
    const runtime = core();
    if (!runtime) throw new DataError('The organization runtime is unavailable.', 503, 'OrganizationUnavailable');
    const raw = parseCookies(req.headers?.cookie)[name()];
    if (raw === undefined) return { principalId: uuidV5(runtime.organizationId, 'systemuser:SYSTEM'), kind: 'local-admin' };
    const [id, signature, extra] = raw.split('.');
    if (extra !== undefined || !GUID.test(id ?? '') || typeof signature !== 'string') throw unavailable();
    const actual = Buffer.from(signature), expected = Buffer.from(sign(id));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw unavailable();
    const user = runtime.principals.byId(id);
    if (!user || user.isdisabled === true || user.applicationid || user.accessmode === 4) throw unavailable();
    return { principalId: user.systemuserid, kind: 'staff' };
  };
  const cookie = id => `${name()}=${id ? `${id}.${sign(id)}` : ''}; Path=/; HttpOnly; SameSite=Lax${id ? '' : '; Max-Age=0'}`;
  const describe = req => {
    const runtime = core(), current = selected(req), user = runtime.principals.byId(current.principalId);
    const users = runtime.store.tableRows('systemuser').filter(row => row.isdisabled !== true && !row.applicationid && row.accessmode !== 4 && row.systemuserid !== uuidV5(runtime.organizationId, 'systemuser:SYSTEM'))
      .map(row => ({ id: row.systemuserid, name: row.fullname ?? row.domainname ?? row.systemuserid, roles: runtime.principals.roles(row).map(role => role.name) }));
    return { current: { ...current, id: current.principalId, name: current.kind === 'local-admin' ? 'Local administrator' : user.fullname ?? user.domainname,
      roles: runtime.principals.roles(user).map(role => role.name), privilegeCount: runtime.principals.privileges(user).size },
      users, default: { kind: 'local-admin', name: 'Local administrator' } };
  };
  return { resolve: selected, describe, cookie, select(req, id) {
    if (!GUID.test(id ?? '')) throw unavailable();
    const header = cookie(id.toLowerCase());
    selected({ headers: { cookie: header.split(';')[0] } });
    return header;
  } };
}

export function createStaffSessionHandler({ sessions, csrf, json, readBody }) {
  return async (req, res, url) => {
    if (!/^\/(?:_sim|__sim)\/api\/dataverse\/session\/?$/.test(url.pathname)) return false;
    try {
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) throw new DataError('Method not allowed.', 405, 'MethodNotAllowed');
      if (req.method !== 'GET' && req.headers['x-sim-csrf'] !== csrf()) throw new DataError('Missing simulator CSRF token.', 403, 'CsrfRequired');
      if (req.method === 'POST') {
        const body = await readBody(req);
        const header = sessions.select(req, body?.userId ?? body?.principalId);
        res.setHeader('set-cookie', header);
        json(res, 200, sessions.describe({ headers: { cookie: header.split(';')[0] } }));
      } else if (req.method === 'DELETE') {
        res.setHeader('set-cookie', sessions.cookie(null));
        json(res, 200, sessions.describe({ headers: {} }));
      } else json(res, 200, sessions.describe(req));
    } catch (error) { json(res, error.status ?? 500, { error: { message: error.message, code: error.code ?? 'StaffSessionError' } }); }
    return true;
  };
}
