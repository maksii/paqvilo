import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { LiveBridge, validateLivePath } from './lib/live.mjs';
import { createPortalSession } from './testing/sessions.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
const loopback = host => ['127.0.0.1', 'localhost', '[::1]'].includes(host);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fieldAt = (value, selector) => selector.split('.').reduce((current, key) => current !== null && typeof current === 'object' && Object.hasOwn(current, key) ? current[key] : undefined, value);
const visitorSignature = session => hash({ signedIn: session.signedIn, contactId: session.contactId, roles: session.roles, roleSource: session.roleSource });
function validateContractOptions(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) throw new Error('Each reference contract must be an object.');
  for (const option of ['statusOnly', 'unordered']) if (contract[option] !== undefined && typeof contract[option] !== 'boolean') throw new Error(`Contract ${option} must be a boolean.`);
  if (contract.collection !== undefined && typeof contract.collection !== 'string') throw new Error('Contract collection must be a string selector.');
  if (contract.fields !== undefined && (!Array.isArray(contract.fields) || Array.from(contract.fields).some(key => typeof key !== 'string'))) throw new Error('Contract fields must be strings.');
  if (contract.kind !== undefined && !['json', 'text'].includes(contract.kind)) throw new Error('Contract kind must be json or text.');
}

/** Explicit projection prevents volatile annotations from masking useful record parity. */
export function normalizeContract(body, contract) {
  validateContractOptions(contract);
  if (contract.statusOnly) return null;
  if (contract.kind === 'text') return String(body).replace(/\r\n/g, '\n');
  const parsed = typeof body === 'string' ? JSON.parse(body) : body;
  const collection = contract.collection ? fieldAt(parsed, contract.collection) : parsed;
  if (collection === undefined) throw new Error('The response lacks the configured collection.');
  const project = row => {
    if (!contract.fields?.length) return canonical(row);
    return Object.fromEntries(contract.fields.map(key => {
      const value = fieldAt(row, key);
      if (value === undefined) throw new Error('The response lacks a configured field.');
      return [key, canonical(value)];
    }));
  };
  if (!Array.isArray(collection)) return project(collection);
  const records = collection.map(project);
  return contract.unordered === true ? records.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : records;
}

/** Compare only explicit GET contracts using the browser's existing identity. */
export async function compareReferenceContracts({ localUrl, origin, cdpUrl, contracts, outputDir, bridge: suppliedBridge, localSession, localVisitor }) {
  const local = new URL(localUrl);
  if (local.protocol !== 'http:' || !loopback(local.hostname) || local.username || local.password || local.pathname !== '/' || local.search || local.hash) throw new Error('Local URL must be an HTTP loopback origin.');
  const reference = new URL(origin);
  if (reference.protocol !== 'https:' || reference.username || reference.password || reference.pathname !== '/' || reference.search || reference.hash) throw new Error('Reference URL must be a credential-free HTTPS origin.');
  if (!Array.isArray(contracts) || !contracts.length || contracts.length > 100) throw new Error('Supply 1–100 explicit read contracts.');
  const ids = new Set();
  for (const contract of contracts) {
    validateContractOptions(contract);
    if (typeof contract.id !== 'string' || !contract.id.trim() || contract.id.length > 160 || ids.has(contract.id)) throw new Error('Contracts require unique string IDs of 1–160 characters.');
    ids.add(contract.id);
    validateLivePath(contract.path);
    if (contract.method !== undefined && contract.method !== 'GET') throw new Error('Reference parity accepts only GET reads.');
    if (contract.expectedStatus !== undefined && (!Number.isInteger(contract.expectedStatus) || contract.expectedStatus < 100 || contract.expectedStatus > 599)) throw new Error('Expected HTTP status is invalid.');
    if (contract.expectedCount !== undefined && (!Number.isInteger(contract.expectedCount) || contract.expectedCount < 0)) throw new Error('Expected count must be a nonnegative integer.');
    if (contract.statusOnly && (contract.fields || contract.collection || contract.expectedCount !== undefined)) throw new Error('Status-only contracts cannot assert response data.');
    if (contract.prefer !== undefined && !/^odata\.maxpagesize=[1-9]\d{0,5}$/i.test(contract.prefer)) throw new Error('Only an explicit odata.maxpagesize preference is supported.');
  }
  if (!outputDir) throw new Error('Supply an ignored evidence output directory.');
  if (localSession !== undefined && localVisitor !== undefined) throw new Error('Supply either localSession or localVisitor, not both.');
  if (localSession !== undefined && (!localSession || localSession.origin !== local.origin || typeof localSession.request !== 'function' || typeof localSession.session !== 'function')) throw new Error('Local session must be a portal visitor for the selected loopback origin.');
  const readState = async () => {
    const response = await fetch(local.origin + '/__sim/api/state', { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Local runtime state is unavailable.');
    const state = await response.json();
    if (state.config?.mode !== 'local' || state.config?.pageMode !== 'local' || state.config?.endpoints?.some(endpoint => endpoint.mode === 'live')) throw new Error('Parity requires exclusively local providers.');
    return state;
  };
  const before = await readState();
  let visitor = localSession, ownedVisitor = false, visitorIdentity, visitorOptions;
  if (localVisitor !== undefined) {
    if (!localVisitor || typeof localVisitor !== 'object' || Array.isArray(localVisitor) || Object.keys(localVisitor).some(key => !['contactId', 'roles', 'configuredPersona'].includes(key)) || localVisitor.configuredPersona !== undefined && typeof localVisitor.configuredPersona !== 'boolean') throw new Error('Local visitor requires contactId, optional roles, or configuredPersona: true.');
    let { contactId, roles } = localVisitor;
    if (localVisitor.configuredPersona) {
      const configured = before.config?.identity;
      contactId ??= configured?.contactId ?? configured?.id;
      if (roles === undefined && (configured?.roleSource ?? 'override') === 'override') roles = configured?.roles;
    }
    if (typeof contactId !== 'string' || !contactId.trim()) throw new Error('Local authenticated visitor requires an existing contactId; no configured persona is available.');
    visitorOptions = { contactId, roles };
  }
  const stateSignature = state => hash({ source: state.status?.sourceFingerprint, implementation: state.status?.implementationFingerprint, revision: state.status?.revision, config: { ...state.config, live: undefined }, data: state.data, tableCounts: state.status?.tableCounts });
  const bridge = suppliedBridge ?? new LiveBridge({ origin: reference.origin, allowWrites: false });
  const report = { version: 1, time: new Date().toISOString(), passed: false, localOrigin: local.origin, referenceOrigin: reference.origin, sourceFingerprint: before.status?.sourceFingerprint, implementationFingerprint: before.status?.implementationFingerprint, identityFingerprint: hash(before.config?.identity), planFingerprint: hash(contracts), contracts: [] };
  try {
    if (!visitor) {
      // Every comparison uses one cookie-isolated, origin-confined transport.
      // Establish anonymous identity explicitly even with ordinary session scope:
      // a later configured-scope change must never grant this visitor access.
      visitor = await createPortalSession({ origin: local.origin, ...visitorOptions });
      ownedVisitor = true;
      if (!visitorOptions) await visitor.signOut();
    }
    try { visitorIdentity = await visitor.session(); }
    catch { throw new Error('Local visitor session is unavailable; create an open portal session for this runtime.'); }
    if (typeof visitorIdentity?.signedIn !== 'boolean' || localVisitor && !visitorIdentity.signedIn || !localSession && !localVisitor && visitorIdentity.signedIn) throw new Error('Local visitor did not establish the requested session.');
    report.localVisitor = { signedIn: visitorIdentity.signedIn, identityFingerprint: visitorSignature(visitorIdentity) };
    if (!suppliedBridge) await bridge.connect(cdpUrl);
    for (const contract of contracts) {
      const result = { id: contract.id, path: contract.path.split('?')[0], kind: contract.kind ?? 'json', fields: contract.fields, expectedCount: contract.expectedCount, statusOnly: contract.statusOnly === true, passed: false };
      try {
        const native = await bridge.request(contract.path, { method: 'GET', prefer: contract.prefer });
        // A portal visitor owns its cookies and local-only controls. Neither is
        // accepted from a plan or copied to the reference browser/evidence.
        const response = await visitor.request(contract.path, { method: 'GET', headers: contract.prefer ? { Prefer: contract.prefer } : {} });
        const body = await response.text();
        result.referenceStatus = native.status; result.localStatus = response.status;
        const expectedStatus = contract.expectedStatus ?? 200;
        if (native.status !== expectedStatus || response.status !== expectedStatus) throw new Error('HTTP status differs from the contract.');
        const nativeBody = Buffer.isBuffer(native.body) ? native.body.toString('utf8') : native.body;
        const a = normalizeContract(nativeBody, contract), b = normalizeContract(body, contract);
        result.referenceDigest = hash(a); result.localDigest = hash(b);
        result.referenceCount = Array.isArray(a) ? a.length : undefined;
        result.localCount = Array.isArray(b) ? b.length : undefined;
        if (contract.expectedCount !== undefined && (result.referenceCount !== contract.expectedCount || result.localCount !== contract.expectedCount)) throw new Error('Result count differs from the contract.');
        result.passed = result.referenceDigest === result.localDigest;
        if (!result.passed) result.error = 'Projected response differs.';
      } catch (cause) {
        // Bodies, query strings and browser tokens are never emitted in the report.
        result.error = ['The response lacks the configured collection.', 'The response lacks a configured field.', 'HTTP status differs from the contract.', 'Result count differs from the contract.'].includes(cause.message) ? cause.message : 'Reference comparison failed; inspect the connected browser and explicit contract.';
      }
      report.contracts.push(result);
    }
    report.stateUnchanged = stateSignature(before) === stateSignature(await readState());
    report.localVisitor.unchanged = visitorSignature(visitorIdentity) === visitorSignature(await visitor.session());
    report.passed = report.stateUnchanged && report.localVisitor.unchanged !== false && report.contracts.every(contract => contract.passed);
  } finally {
    try { if (!suppliedBridge) await bridge.close(); }
    finally { if (ownedVisitor) visitor.close(); }
  }
  await fs.mkdir(outputDir, { recursive: true });
  report.report = path.resolve(outputDir, 'reference-parity.json');
  await fs.writeFile(report.report, JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { local: { type: 'string' }, origin: { type: 'string' }, cdp: { type: 'string' }, plan: { type: 'string' }, output: { type: 'string' }, 'local-contact': { type: 'string' }, 'local-role': { type: 'string', multiple: true }, 'local-configured-persona': { type: 'boolean' } } });
    const localVisitor = values['local-contact'] !== undefined || values['local-role'] !== undefined || values['local-configured-persona'] ? { contactId: values['local-contact'], roles: values['local-role'], configuredPersona: values['local-configured-persona'] } : undefined;
    const report = await compareReferenceContracts({ localUrl: values.local, origin: values.origin, cdpUrl: values.cdp, contracts: JSON.parse(await fs.readFile(values.plan, 'utf8')), outputDir: values.output, localVisitor });
    console.log(JSON.stringify(report, null, 2)); process.exitCode = report.passed ? 0 : 1;
  } catch (cause) { console.error(cause.message); process.exitCode = 1; }
}
