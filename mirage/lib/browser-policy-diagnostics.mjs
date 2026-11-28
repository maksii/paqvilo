import { createHash } from 'node:crypto';

const unloadViolation = 'Permissions policy violation: unload is not allowed in this document.';
const protocolSource = 'violation';
const maxProofAgeMs = 30 * 24 * 60 * 60 * 1000;
const sha256 = /^[\da-f]{64}$/;
const maxAssetBytes = 8 * 1024 * 1024;
const maxTracked = 10000;
const maxDiagnostics = 128;
const maxCaptureLength = 2048;
const maxPolicyHeaderLength = 16384;

const allowedOrigin = (origin) => {
  try {
    const url = new URL(origin);
    return (
      url.origin === origin &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
};

const credentialFreeUrl = (value) => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
};

const inOrigin = (value, origin) => {
  const url = credentialFreeUrl(value);
  return url?.origin === origin ? url : null;
};

const cleanPath = (value, origin) => {
  if (typeof value !== 'string' || !value.startsWith('/')) return false;
  const url = inOrigin(origin + value, origin);
  return url?.pathname === value && !url.search && !url.hash;
};

const capturePath = (value, origin) =>
  cleanPath(value, origin) && value.length <= maxCaptureLength && !value.startsWith('//');

function captureMappings(entries, referenceOrigin, localOrigin = referenceOrigin) {
  if (!Array.isArray(entries) || entries.length > maxDiagnostics) return null;
  const references = new Map();
  const localPaths = new Set();
  for (const entry of entries) {
    const { referenceUrl, localPath, sha256: digest } = entry ?? {};
    const url = credentialFreeUrl(referenceUrl);
    if (
      !url ||
      !allowedOrigin(url.origin) ||
      url.origin === referenceOrigin ||
      url.origin === localOrigin ||
      referenceUrl.length > maxCaptureLength ||
      referenceUrl !== url.origin + url.pathname ||
      !capturePath(url.pathname, url.origin) ||
      !capturePath(localPath, localOrigin) ||
      typeof digest !== 'string' ||
      !sha256.test(digest) ||
      references.has(referenceUrl) ||
      localPaths.has(localPath)
    )
      return null;
    references.set(referenceUrl, { localPath, sha256: digest });
    localPaths.add(localPath);
  }
  return { references, localPaths };
}

function assetForAddress(address, origin, references) {
  const url = credentialFreeUrl(address);
  if (!url) return null;
  if (url.origin === origin) return { path: url.pathname };
  const captured = references.get(url.origin + url.pathname);
  return captured ? { origin: url.origin, path: url.pathname, sha256: captured.sha256 } : null;
}

const browserBuild = ({ product, revision }) => ({ product, revision });
const frameKind = ({ parentId }) => (parentId ? 'child-frame' : 'top-level');
const documentKey = (id, loaderId) => JSON.stringify([id, loaderId]);

const policyKey = '[a-z*][a-z0-9_.*-]*';
const policyString = String.raw`"(?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\["\\])*"`;
const policyToken = String.raw`[a-zA-Z*][a-zA-Z0-9!#$%&'*+.^_\x60|~:/-]*`;
const policyNumber = String.raw`-?\d{1,12}\.\d{1,3}|-?\d{1,15}`;
const policyBytes = ':(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?:';
const policyBareItem = String.raw`(?:${policyString}|${policyToken}|${policyNumber}|${policyBytes}|\?[01])`;
const policyParameters = `(?:; *${policyKey}(?:=${policyBareItem})?)*`;
const policyItem = policyBareItem + policyParameters;
const policyInnerList = String.raw`\( *(?:${policyItem}(?: +${policyItem})* *)?\)${policyParameters}`;
const policyMember = new RegExp(`^${policyKey}(?:=(?:${policyItem}|${policyInnerList})|${policyParameters})$`);

// A policy is a Structured Field dictionary. Commas in quoted members and
// parenthesized lists never start a new directive.
function policyMembers(value) {
  const members = [];
  let start = 0,
    inList = false;
  for (const token of value.matchAll(/"(?:[^"\\\r\n]|\\["\\])*"|\r\n|[()",\r\n]/g)) {
    const [part] = token;
    if (part === '"' || (part === '(' && inList) || (part === ')' && !inList)) return [];
    if (part === '(' || part === ')') inList = part === '(';
    if (!inList && [',', '\r\n', '\r', '\n'].includes(part)) {
      members.push(value.slice(start, token.index).trim());
      start = token.index + part.length;
    }
  }
  if (inList) return [];
  members.push(value.slice(start).trim());
  return members;
}

function unloadHeaderDigest(headers, origin) {
  const header = Object.entries(headers ?? {})
    .filter(([name, value]) => name.toLowerCase() === 'permissions-policy' && typeof value === 'string')
    .map(([, value]) => value)
    .join(',');
  if (!header || header.length > maxPolicyHeaderLength || /[^\t\r\n -~]/.test(header)) return undefined;
  const members = policyMembers(header);
  if (!members.every((member) => policyMember.test(member))) return undefined;
  const unload = members.filter((value) => /^unload(?:[=;]|$)/.test(value));
  if (unload.length !== 1) return undefined;
  const allowlist = /^unload[ \t]*=[ \t]*("[^"]*"|\([^\r\n]*\))[ \t]*(?:;.*)?$/.exec(unload[0])?.[1];
  if (!allowlist) return undefined;
  // The tracked document and locator have the same origin. An allowlist
  // containing self, a wildcard or that origin does not verify a denial.
  const items = allowlist.startsWith('(') ? allowlist.slice(1, -1).trim() : allowlist;
  if (items && !/^"[^"]*"(?: +"[^"]*")*$/.test(items)) return undefined;
  const document = new URL(origin);
  const allowedOrigins = new Set();
  for (const [, value] of items.matchAll(/"([^"]*)"/g)) {
    const url = credentialFreeUrl(value);
    if (!url || value.includes('*') || !/^https?:$/.test(url.protocol) || url.href !== url.origin + '/')
      return undefined;
    if (
      url.origin === origin ||
      (url.protocol === 'http:' && document.protocol === 'https:' && url.hostname === document.hostname)
    )
      return undefined;
    allowedOrigins.add(url.origin);
  }
  return createHash('sha256')
    .update(JSON.stringify([...allowedOrigins].sort()))
    .digest('hex');
}

function policyFrame(frame, locator, frames) {
  if (locator?.blockReason !== 'Header') return null;
  for (let node = frame; node; node = frames.get(node.parentId)) if (node.id === locator.frameId) return node;
  return null;
}

function storeScriptRecord(requests, { type, frameId, loaderId, requestId, request, redirectResponse }, resolveAsset) {
  const previous = requests.get(requestId);
  if (redirectResponse && previous) previous.redirected = true;
  if (type === 'Script' && request.method === 'GET' && resolveAsset(request.url))
    requests.set(requestId, { frameId, loaderId, requestId, url: request.url, redirected: Boolean(redirectResponse) });
}

function observeExecution(scripts, script, frames, resolveAsset) {
  const { frameId, isDefault } = script.executionContextAuxData ?? {};
  const frame = frames.get(frameId);
  const asset = resolveAsset(script.url);
  if (
    frame &&
    isDefault &&
    script.embedderName === script.url &&
    asset &&
    !script.isLiveEdit &&
    !script.hasSourceURL &&
    script.startLine === 0 &&
    script.startColumn === 0 &&
    sha256.test(script.hash ?? '')
  )
    scripts.set(script.scriptId, { frame, url: script.url, sha256: script.hash, asset });
}

async function verifiedAsset(cdp, script, requests) {
  const matching = [...requests.values()].filter(
    (row) =>
      row.frameId === script.frame.id &&
      row.loaderId === script.frame.loaderId &&
      row.url === script.url &&
      !row.redirected &&
      row.status === 200 &&
      row.finished &&
      !row.failed,
  );
  if (matching.length !== 1) return null;
  const { body, base64Encoded } = await cdp.send('Network.getResponseBody', { requestId: matching[0].requestId });
  const bytes = Buffer.from(body, base64Encoded ? 'base64' : 'utf8');
  if (!bytes.length || bytes.length > maxAssetBytes) return null;
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== script.sha256 || (script.asset.sha256 && digest !== script.asset.sha256)) return null;
  return { ...script.asset, sha256: digest };
}

async function proveViolation(cdp, entry, { scripts, requests, frames }) {
  const call = entry.stackTrace?.callFrames[0];
  const script = scripts.get(call?.scriptId);
  if (!script || call.url !== script.url || entry.url !== script.url || frames.get(script.frame.id) !== script.frame)
    return null;
  const [asset, permissions] = await Promise.all([
    verifiedAsset(cdp, script, requests),
    cdp.send('Page.getPermissionsPolicyState', { frameId: script.frame.id }),
  ]);
  if (!asset || frames.get(script.frame.id) !== script.frame) return null;
  const unload = permissions.states.find((state) => state.feature === 'unload' && !state.allowed);
  const policy = policyFrame(script.frame, unload?.locator, frames);
  if (!policy) return null;
  return {
    feature: 'unload',
    source: entry.source,
    text: entry.text,
    line: entry.lineNumber,
    observedAt: new Date(entry.timestamp).toISOString(),
    asset,
    document: { path: script.frame.path, kind: frameKind(script.frame) },
    policyDocument: policy,
  };
}

function diagnosticWithReceivedPolicy({ policyDocument, ...proof }, documentResponses, extraPolicies) {
  const { id, loaderId, url, path } = policyDocument;
  const response = documentResponses.get(documentKey(id, loaderId));
  const raw = extraPolicies.get(response?.requestId);
  const headerSha256 = response?.url === url && raw?.status === response.status ? raw.headerSha256 : undefined;
  // Chromium can report a Header locator for its default unload policy. Require
  // the wire directive in that document's received response for mapped assets.
  if (proof.asset.origin && !headerSha256) return null;
  return { ...proof, policy: { path, kind: frameKind(policyDocument), ...(headerSha256 && { headerSha256 }) } };
}

/**
 * Observe a caller-owned Chromium or Edge page before navigation. Only page/asset paths and
 * verified diagnostic evidence are returned. The observer never navigates, intercepts or writes.
 */
export async function observeBrowserPolicyDiagnostics(page, { origin, capturedAssets = [] }) {
  if (!allowedOrigin(origin))
    throw new Error('Browser policy diagnostics need a credential-free HTTPS or loopback origin.');
  const captures = captureMappings(capturedAssets, origin);
  if (!captures) throw new Error('Invalid captured assets for browser policy diagnostics.');
  const resolveAsset = (address) => assetForAddress(address, origin, captures.references);
  const cdp = await page.context().newCDPSession(page);
  const frames = new Map(),
    scripts = new Map(),
    requests = new Map(),
    documentResponses = new Map(),
    extraPolicies = new Map(),
    proofs = [];
  let overflow = false;
  const bounded = (collection, handler) => (event) => {
    if ((collection.size ?? collection.length) >= (collection === proofs ? maxDiagnostics : maxTracked))
      overflow = true;
    if (!overflow) handler(event);
  };
  cdp.on(
    'Page.frameNavigated',
    bounded(frames, ({ frame }) => {
      const url = inOrigin(frame.url, origin);
      if (!url) frames.delete(frame.id);
      else
        frames.set(frame.id, {
          id: frame.id,
          parentId: frame.parentId,
          loaderId: frame.loaderId,
          url: frame.url,
          path: url.pathname,
        });
    }),
  );
  cdp.on('Page.frameDetached', ({ frameId }) => frames.delete(frameId));
  cdp.on(
    'Network.requestWillBeSent',
    bounded(requests, (event) => storeScriptRecord(requests, event, resolveAsset)),
  );
  const recordDocumentResponse = bounded(documentResponses, ({ frameId, loaderId, requestId, response }) => {
    const key = documentKey(frameId, loaderId);
    documentResponses.set(
      key,
      documentResponses.has(key) ? null : { requestId, status: response.status, url: response.url },
    );
  });
  cdp.on('Network.responseReceived', ({ requestId, response, frameId, loaderId, type, hasExtraInfo }) => {
    const row = requests.get(requestId);
    if (row && response.url === row.url) row.status = response.status;
    if (
      type === 'Document' &&
      hasExtraInfo &&
      frameId &&
      loaderId &&
      response.status >= 200 &&
      response.status < 300 &&
      inOrigin(response.url, origin)
    )
      recordDocumentResponse({ frameId, loaderId, requestId, response });
  });
  cdp.on(
    'Network.responseReceivedExtraInfo',
    bounded(extraPolicies, ({ requestId, statusCode, headers }) => {
      // Redirect hops reuse request IDs. Only a single raw successful response
      // can corroborate the final document's status and browser loader.
      if (statusCode < 200 || statusCode >= 300) return;
      extraPolicies.set(
        requestId,
        extraPolicies.has(requestId) ? null : { status: statusCode, headerSha256: unloadHeaderDigest(headers, origin) },
      );
    }),
  );
  cdp.on('Network.loadingFinished', ({ requestId }) => {
    const row = requests.get(requestId);
    if (row) row.finished = true;
  });
  cdp.on('Network.loadingFailed', ({ requestId }) => {
    const row = requests.get(requestId);
    if (row) row.failed = true;
  });
  cdp.on(
    'Debugger.scriptParsed',
    bounded(scripts, (script) => observeExecution(scripts, script, frames, resolveAsset)),
  );
  cdp.on('Log.entryAdded', ({ entry }) => {
    if (entry.source !== protocolSource || entry.level !== 'error' || entry.text !== unloadViolation) return;
    bounded(proofs, () => proofs.push(proveViolation(cdp, entry, { scripts, requests, frames }).catch(() => null)))();
  });
  const dispose = () => cdp.detach().catch(() => {});
  try {
    const browser = browserBuild(await cdp.send('Browser.getVersion'));
    await cdp.send('Page.enable');
    await cdp.send('Network.enable', { maxResourceBufferSize: maxAssetBytes, maxTotalBufferSize: maxAssetBytes * 4 });
    await cdp.send('Debugger.enable');
    await cdp.send('Log.enable');
    return {
      async report() {
        const diagnostics = (await Promise.all(proofs))
          .filter(Boolean)
          .map((proof) => diagnosticWithReceivedPolicy(proof, documentResponses, extraPolicies))
          .filter(Boolean);
        return { version: 1, origin, browser, observedAt: new Date().toISOString(), overflow, diagnostics };
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function validDiagnostic(proof, origin) {
  return (
    proof?.feature === 'unload' &&
    proof.source === protocolSource &&
    proof.text === unloadViolation &&
    Number.isSafeInteger(proof.line) &&
    proof.line >= 0 &&
    typeof proof.asset?.sha256 === 'string' &&
    sha256.test(proof.asset.sha256) &&
    (proof.asset.origin === undefined || allowedOrigin(proof.asset.origin)) &&
    cleanPath(proof.asset.path, proof.asset.origin ?? origin) &&
    [proof.document, proof.policy].every(
      (context) => cleanPath(context?.path, origin) && ['top-level', 'child-frame'].includes(context.kind),
    ) &&
    (proof.policy.headerSha256 === undefined ||
      (typeof proof.policy.headerSha256 === 'string' && sha256.test(proof.policy.headerSha256)))
  );
}

function validReference(referenceOrigin, report, local) {
  const fresh = (time) => {
    const age = Date.now() - Date.parse(time);
    return age >= 0 && age <= maxProofAgeMs;
  };
  return (
    allowedOrigin(referenceOrigin) &&
    referenceOrigin !== local.origin &&
    report?.version === 1 &&
    report.origin === referenceOrigin &&
    report.overflow === false &&
    fresh(report.observedAt) &&
    report.browser?.product === local.browser.product &&
    report.browser?.revision === local.browser.revision &&
    Array.isArray(report.diagnostics) &&
    report.diagnostics.length > 0 &&
    report.diagnostics.length <= maxDiagnostics &&
    report.diagnostics.every(
      (diagnostic) => validDiagnostic(diagnostic, referenceOrigin) && fresh(diagnostic.observedAt),
    )
  );
}

const proofKey = (
  { feature, source, text, line, asset, document, policy },
  assetPath = asset.path,
  headerSha256 = policy.headerSha256,
) =>
  JSON.stringify([
    feature,
    source,
    text,
    line,
    assetPath,
    asset.sha256,
    document.kind,
    document.path,
    policy.kind,
    policy.path,
    headerSha256,
  ]);
const consoleKey = (path, line) => JSON.stringify([path, line]);

function referenceWitnesses(diagnostics, captures) {
  const witnesses = new Map();
  for (const diagnostic of diagnostics) {
    const { asset, observedAt, policy } = diagnostic;
    if (asset.origin === undefined) {
      if (!captures.localPaths.has(asset.path)) witnesses.set(proofKey(diagnostic, asset.path, null), { observedAt });
      continue;
    }
    const mapping = captures.references.get(asset.origin + asset.path);
    if (!mapping || mapping.sha256 !== asset.sha256 || !policy.headerSha256) return null;
    witnesses.set(proofKey(diagnostic, mapping.localPath), {
      observedAt,
      asset: { origin: asset.origin, path: asset.path, sha256: asset.sha256 },
      policy: { kind: policy.kind, path: policy.path, headerSha256: policy.headerSha256 },
    });
  }
  return witnesses;
}

function policyConsoleMessages(messages, origin) {
  const candidates = new Map();
  for (const message of messages) {
    if (message.argumentCount !== 0 || message.text !== unloadViolation) continue;
    const asset = inOrigin(message.url, origin);
    if (!asset) continue;
    const key = consoleKey(asset.pathname, message.line);
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(message);
  }
  return candidates;
}

/** Relate Playwright's raw console errors to independently proven CDP violation events. */
export function compareBrowserPolicyDiagnostics(
  messages,
  local,
  { referenceOrigin, report, capturedAssets = [] } = {},
) {
  const expected = new Set();
  const proof = [];
  const captures = captureMappings(capturedAssets, referenceOrigin, local.origin);
  if (!captures || !validReference(referenceOrigin, report, local) || local.overflow)
    return { valid: false, expected, proof };
  const witnesses = referenceWitnesses(report.diagnostics, captures);
  if (!witnesses) return { valid: false, expected, proof };
  const witnessFor = (observed) =>
    witnesses.get(
      captures.localPaths.has(observed.asset.path) ? proofKey(observed) : proofKey(observed, observed.asset.path, null),
    );
  for (const [key, group] of policyConsoleMessages(messages, local.origin)) {
    const observations = local.diagnostics.filter((item) => consoleKey(item.asset.path, item.line) === key);
    // Playwright supplies no frame id: if same-location errors span multiple documents, every
    // occurrence must have a qualifying CDP event and reference witness before any can pass.
    if (observations.length !== group.length || observations.some((item) => !witnessFor(item))) continue;
    for (const message of group) expected.add(message);
    for (const observed of observations)
      proof.push({
        classification: 'observed-browser-policy-diagnostic',
        local: observed,
        reference: { origin: referenceOrigin, ...witnessFor(observed), browser: local.browser },
      });
  }
  return { valid: true, expected, proof };
}
