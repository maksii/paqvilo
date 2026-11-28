import { createHash } from 'node:crypto';

const unloadViolation = 'Permissions policy violation: unload is not allowed in this document.';
const protocolSource = 'violation';
const maxProofAgeMs = 30 * 24 * 60 * 60 * 1000;
const sha256 = /^[\da-f]{64}$/;
const maxAssetBytes = 8 * 1024 * 1024;
const maxTracked = 10000;
const maxDiagnostics = 128;

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

const inOrigin = (value, origin) => {
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
};

const browserBuild = ({ product, revision }) => ({ product, revision });
const frameKind = ({ parentId }) => (parentId ? 'child-frame' : 'top-level');

function frameContext(frame, locator, frames) {
  if (locator?.blockReason !== 'Header') return null;
  for (let node = frame; node; node = frames.get(node.parentId))
    if (node.id === locator.frameId) return { path: node.path, kind: frameKind(node) };
  return null;
}

function storeScriptRecord(requests, { type, frameId, loaderId, requestId, request, redirectResponse }, origin) {
  if (type === 'Script' && request.method === 'GET' && inOrigin(request.url, origin))
    requests.set(requestId, { frameId, loaderId, requestId, url: request.url, redirected: Boolean(redirectResponse) });
}

function observeExecution(scripts, script, frames, origin) {
  const { frameId, isDefault } = script.executionContextAuxData ?? {};
  const frame = frames.get(frameId);
  if (
    frame &&
    isDefault &&
    script.embedderName === script.url &&
    inOrigin(script.url, origin) &&
    !script.isLiveEdit &&
    !script.hasSourceURL &&
    script.startLine === 0 &&
    script.startColumn === 0 &&
    sha256.test(script.hash ?? '')
  )
    scripts.set(script.scriptId, { frame, url: script.url, sha256: script.hash });
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
  return digest === script.sha256 ? { path: new URL(script.url).pathname, sha256: digest } : null;
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
  const policy = frameContext(script.frame, unload?.locator, frames);
  if (!policy) return null;
  return {
    feature: 'unload',
    source: entry.source,
    text: entry.text,
    line: entry.lineNumber,
    observedAt: new Date(entry.timestamp).toISOString(),
    asset,
    document: { path: script.frame.path, kind: frameKind(script.frame) },
    policy,
  };
}

/**
 * Observe a caller-owned Chromium or Edge page before navigation. Only page/asset paths and
 * verified diagnostic evidence are returned. The observer never navigates, intercepts or writes.
 */
export async function observeBrowserPolicyDiagnostics(page, { origin }) {
  if (!allowedOrigin(origin))
    throw new Error('Browser policy diagnostics need a credential-free HTTPS or loopback origin.');
  const cdp = await page.context().newCDPSession(page);
  const frames = new Map(),
    scripts = new Map(),
    requests = new Map(),
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
        frames.set(frame.id, { id: frame.id, parentId: frame.parentId, loaderId: frame.loaderId, path: url.pathname });
    }),
  );
  cdp.on('Page.frameDetached', ({ frameId }) => frames.delete(frameId));
  cdp.on(
    'Network.requestWillBeSent',
    bounded(requests, (event) => storeScriptRecord(requests, event, origin)),
  );
  cdp.on('Network.responseReceived', ({ requestId, response }) => {
    const row = requests.get(requestId);
    if (row && response.url === row.url) row.status = response.status;
  });
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
    bounded(scripts, (script) => observeExecution(scripts, script, frames, origin)),
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
        const diagnostics = (await Promise.all(proofs)).filter(Boolean);
        return { version: 1, origin, browser, observedAt: new Date().toISOString(), overflow, diagnostics };
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

const cleanPath = (value, origin) => {
  const url = inOrigin(origin + value, origin);
  return Boolean(url && url.pathname === value && !url.search && !url.hash && value.startsWith('/'));
};

function validDiagnostic(proof, origin) {
  return (
    proof?.feature === 'unload' &&
    proof.source === protocolSource &&
    proof.text === unloadViolation &&
    Number.isSafeInteger(proof.line) &&
    proof.line >= 0 &&
    sha256.test(proof.asset?.sha256 ?? '') &&
    cleanPath(proof.asset.path, origin) &&
    [proof.document, proof.policy].every(
      (context) => cleanPath(context?.path, origin) && ['top-level', 'child-frame'].includes(context.kind),
    )
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

const proofKey = ({ feature, source, text, line, asset, document, policy }) =>
  JSON.stringify([
    feature,
    source,
    text,
    line,
    asset.path,
    asset.sha256,
    document.kind,
    document.path,
    policy.kind,
    policy.path,
  ]);
const consoleKey = (path, line) => JSON.stringify([path, line]);

/** Relate Playwright's raw console errors to independently proven CDP violation events. */
export function compareBrowserPolicyDiagnostics(messages, local, { referenceOrigin, report } = {}) {
  const expected = new Set();
  const proof = [];
  const valid = validReference(referenceOrigin, report, local);
  if (!valid || local.overflow) return { valid: false, expected, proof };
  const witnesses = new Map(report.diagnostics.map((diagnostic) => [proofKey(diagnostic), diagnostic.observedAt]));
  const candidates = new Map();
  for (const message of messages) {
    if (message.argumentCount !== 0 || message.text !== unloadViolation) continue;
    const asset = inOrigin(message.url, local.origin);
    if (!asset) continue;
    const key = consoleKey(asset.pathname, message.line);
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(message);
  }
  for (const [key, group] of candidates) {
    const observations = local.diagnostics.filter((item) => consoleKey(item.asset.path, item.line) === key);
    // Playwright supplies no frame id: if same-location errors span multiple documents, every
    // occurrence must have a qualifying CDP event and reference witness before any can pass.
    if (observations.length !== group.length || observations.some((item) => !witnesses.has(proofKey(item)))) continue;
    for (const message of group) expected.add(message);
    for (const observed of observations)
      proof.push({
        classification: 'observed-browser-policy-diagnostic',
        local: observed,
        reference: { origin: referenceOrigin, observedAt: witnesses.get(proofKey(observed)), browser: local.browser },
      });
  }
  return { valid, expected, proof };
}
