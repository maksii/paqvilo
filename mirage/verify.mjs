import fs from 'node:fs/promises';
import pathModule from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const loopback = (hostname) => ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
const safeUrl = (value) => {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return String(value).split(/[?#]/)[0];
  }
};
const safeMessage = (value) =>
  String(value)
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, (url) => safeUrl(url))
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(
      /\b(password|(?:access|id|refresh)[_-]?token|client[_-]?secret|authorization|cookie|credential)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]',
    );
const signInPath = (url) => /\/(?:signin|login|account\/login|authorize|oauth2)(?:[/?]|$)/i.test(url.pathname);
const routeUrl = (base, route) => {
  if (!route?.startsWith('/') || route.startsWith('//') || route.includes('\\'))
    throw new Error('Verification path must be portal-relative.');
  const target = new URL(route, base);
  if (target.origin !== new URL(base).origin) throw new Error('Verification path escaped its origin.');
  return target;
};

function semanticDocument({ localOrigin, liveOrigin }) {
  const normalize = (value) => value.replaceAll(localOrigin, '@portal').replaceAll(liveOrigin, '@portal');
  const sensitiveName =
    /(?:password|(?:access|id|refresh)[_-]?token|client[_-]?secret|authorization|cookie|credential|nonce|verificationtoken)/i;
  const attribute = (node, attr) => {
    if (sensitiveName.test(attr.name) || (attr.name === 'value' && sensitiveName.test(node.getAttribute('name') || '')))
      return '@redacted';
    if (['href', 'src', 'action', 'formaction', 'data-src'].includes(attr.name)) {
      try {
        const url = new URL(attr.value, location.origin);
        let changed = false;
        for (const [key] of url.searchParams)
          if (sensitiveName.test(key) || /^(?:code|sig|signature|secret|token)$/i.test(key)) {
            url.searchParams.set(key, '@redacted');
            changed = true;
          }
        if (changed)
          return normalize(/^https?:\/\//i.test(attr.value) ? url.href : url.pathname + url.search + url.hash);
      } catch {
        /* Non-URL attributes retain their semantic value. */
      }
    }
    return normalize(attr.value);
  };
  const visit = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      return text ? { text: normalize(text) } : null;
    }
    if (
      node.nodeType !== Node.ELEMENT_NODE ||
      ['SCRIPT', 'STYLE', 'LINK', 'META'].includes(node.tagName) ||
      // The toolkit dev panel host is injected into overlaid portal tabs only.
      node.id === 'paqvilo-panel'
    )
      return null;
    const attrs = Object.fromEntries(
      [...node.attributes]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((attr) => [attr.name, attribute(node, attr)]),
    );
    return {
      tag: node.tagName.toLowerCase(),
      attrs,
      children: [...node.childNodes].map(visit).filter(Boolean),
    };
  };
  return visit(document.body);
}

function validateParityInputs({
  localUrl,
  origin,
  cdpUrl,
  path,
  outputDir,
  viewport,
  readinessTimeout,
  allowLoopbackLive,
  sessionStorageSeeds,
  requiredSelectors,
}) {
  if (!validReadinessTimeout(readinessTimeout)) throw new Error('readinessTimeout must be a positive finite number.');
  const local = new URL(localUrl);
  const live = new URL(origin);
  const cdp = new URL(cdpUrl);
  if (!validLocalOrigin(local))
    throw new Error('Local simulator URL must be an HTTP loopback origin without credentials.');
  if (!validLiveOrigin(live, allowLoopbackLive))
    throw new Error('Live portal must be an HTTPS origin without credentials or a path.');
  if (!validLiveHost(live, allowLoopbackLive))
    throw new Error('Loopback test verification accepts only loopback live origins.');
  if (!validCdpOrigin(cdp)) throw new Error('Browser debugging endpoint must be loopback without credentials.');
  if (!outputDir) throw new Error('An ignored evidence output directory is required.');
  if (!validSessionStorageSeeds(sessionStorageSeeds))
    throw new Error('Session storage seeds must be a small string map.');
  if (!validRequiredSelectors(requiredSelectors))
    throw new Error('Required readiness selectors must be a short string array.');
  if (!validViewport(viewport)) throw new Error('Invalid verification viewport.');
  return {
    local,
    live,
    cdp,
    localTarget: routeUrl(local.origin, path),
    liveTarget: routeUrl(live.origin, path),
    outputDir: pathModule.resolve(outputDir),
  };
}

function validReadinessTimeout(timeout) {
  return Number.isFinite(timeout) && timeout > 0;
}

function validLocalOrigin(local) {
  return loopback(local.hostname) && local.protocol === 'http:' && !local.username && !local.password;
}

function validLiveOrigin(live, allowLoopbackLive) {
  return (
    !live.username &&
    !live.password &&
    (allowLoopbackLive || live.protocol === 'https:') &&
    live.pathname === '/' &&
    !live.search &&
    !live.hash
  );
}

function validLiveHost(live, allowLoopbackLive) {
  return !allowLoopbackLive || loopback(live.hostname);
}

function validCdpOrigin(cdp) {
  return loopback(cdp.hostname) && ['http:', 'ws:'].includes(cdp.protocol) && !cdp.username && !cdp.password;
}

function validSessionStorageSeeds(seeds) {
  return Boolean(
    seeds &&
    typeof seeds === 'object' &&
    !Array.isArray(seeds) &&
    !Object.entries(seeds).some(
      ([key, value]) => !key || key.length > 256 || typeof value !== 'string' || value.length > 4096,
    ),
  );
}

function validRequiredSelectors(selectors) {
  return Boolean(
    Array.isArray(selectors) &&
    !selectors.some((selector) => typeof selector !== 'string' || !selector.trim() || selector.length > 512),
  );
}

function validViewport(viewport) {
  return (
    Number.isInteger(viewport.width) &&
    Number.isInteger(viewport.height) &&
    viewport.width >= 320 &&
    viewport.height >= 240
  );
}

function observePage(page, observation) {
  const pending = new Map();
  page.on('request', (request) =>
    pending.set(request, {
      method: request.method(),
      url: safeUrl(request.url()),
    }),
  );
  const settleRequest = (request) => pending.delete(request);
  page.on('requestfinished', settleRequest);
  page.on('requestfailed', settleRequest);
  page.on('console', (message) => {
    if (message.type() === 'error') observation.consoleErrors.push(safeMessage(message.text()));
  });
  page.on('pageerror', (error) => observation.pageErrors.push(safeMessage(error.message)));
  page.on('requestfailed', (request) =>
    observation.failedRequests.push({
      method: request.method(),
      url: safeUrl(request.url()),
      error: safeMessage(request.failure()?.errorText),
    }),
  );
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (/\.(?:m?js|css|woff2?|ttf|otf|eot|png|jpe?g|svg|webp|gif|ico)(?:$|\/)/i.test(url.pathname)) {
      if (observation.resourceResponses.length < 500)
        observation.resourceResponses.push({
          method: response.request().method(),
          url: safeUrl(response.url()),
          status: response.status(),
          mimeType: response.headers()['content-type'] ?? '',
        });
      else observation.resourceResponsesTruncated = true;
    }
    if (response.status() >= 400)
      observation.failedResponses.push({
        status: response.status(),
        url: safeUrl(response.url()),
      });
  });
  return pending;
}

function routeReadOnlyPage(page, observation) {
  return page.route('**/*', (route) => {
    const request = route.request();
    if (!['GET', 'HEAD'].includes(request.method())) {
      observation.blockedWrites.push({ method: request.method(), url: safeUrl(request.url()) });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
}

function requiredSelectorFailures(page, requiredSelectors, readinessTimeout) {
  return Promise.all(
    requiredSelectors.map(async (selector) => ({
      selector,
      visible: await page
        .locator(selector)
        .first()
        .waitFor({ state: 'visible', timeout: readinessTimeout })
        .then(() => true)
        .catch(() => false),
    })),
  );
}

function isPersistentConnection(request, label, localOrigin) {
  if (label !== 'local' || request.method !== 'GET') return false;
  try {
    const url = new URL(request.url);
    return url.origin === localOrigin && url.pathname === '/__sim/events';
  } catch {
    return false;
  }
}

function formShapeOf(page) {
  return page.evaluate(() => {
    const labelFor = (control) => {
      const labels = [...(control.labels ?? [])]
        .map((label) => label.textContent.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      return [...new Set(labels)];
    };
    return {
      forms: [...document.forms].map((form) => ({
        id: form.id,
        name: form.getAttribute('name'),
        method: (form.getAttribute('method') || 'get').toLowerCase(),
        action: new URL(form.getAttribute('action') || location.href, location.href).pathname,
        classes: [...form.classList].sort(/* NOSONAR: preserve default string coercion */),
      })),
      controls: [...document.querySelectorAll('input,select,textarea,button')].map((control) => ({
        tag: control.tagName.toLowerCase(),
        type: control.getAttribute('type') || null,
        id: control.id || null,
        name: control.getAttribute('name'),
        required: control.required === true,
        disabled: control.disabled === true,
        readOnly: control.readOnly === true,
        labels: labelFor(control),
      })),
    };
  });
}

async function capturePage(label, target, options) {
  const {
    context,
    viewport,
    result,
    localOrigin,
    sessionStorageSeeds,
    requiredSelectors,
    readinessTimeout,
    settleMs,
    timeout,
    outputDir,
    liveOrigin,
  } = options;
  const page = await context.newPage();
  options.pages.push(page);
  await page.setViewportSize(viewport);
  const observation = {
    requestedUrl: safeUrl(target.href),
    finalUrl: null,
    status: null,
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    failedResponses: [],
    resourceResponses: [],
    resourceResponsesTruncated: false,
    blockedWrites: [],
    readinessFailures: [],
    pendingRequests: [],
    persistentConnections: [],
  };
  result[label] = observation;
  const pending = observePage(page, observation);
  await routeReadOnlyPage(page, observation);
  if (Object.keys(sessionStorageSeeds).length)
    await page.addInitScript((entries) => {
      for (const [key, value] of entries) sessionStorage.setItem(key, value);
    }, Object.entries(sessionStorageSeeds));
  let response;
  try {
    response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout });
    observation.status = response?.status() ?? null;
    await page.locator('body').waitFor({ state: 'visible', timeout });
    const selectorResults = await requiredSelectorFailures(page, requiredSelectors, readinessTimeout);
    observation.readinessFailures.push(
      ...selectorResults
        .filter((item) => !item.visible)
        .map((item) => `Required visible selector missing: ${item.selector}`),
    );
    const fonts = await page
      .waitForFunction(() => !document.fonts || document.fonts.status === 'loaded', undefined, {
        timeout: readinessTimeout,
      })
      .then(() => true)
      .catch(() => false);
    observation.fontsReady = fonts;
    if (!fonts) observation.readinessFailures.push('Document fonts did not settle within the bounded wait.');
    try {
      await page.waitForLoadState('networkidle', { timeout: readinessTimeout });
      observation.networkIdleReached = true;
    } catch {
      observation.networkIdleReached = false;
    }
    if (settleMs > 0) await page.waitForTimeout(Math.min(settleMs, 2000));
  } catch (error) {
    observation.navigationError = safeMessage(error.message);
  }
  const outstanding = [...pending.values()];
  observation.persistentConnections = outstanding.filter((request) =>
    isPersistentConnection(request, label, localOrigin),
  );
  observation.pendingRequests = outstanding.filter((request) => !observation.persistentConnections.includes(request));
  observation.quiescent = observation.pendingRequests.length === 0;
  observation.finalUrl = safeUrl(page.url());
  const final = new URL(page.url());
  observation.signIn = signInPath(final) || (await page.locator('input[type=password]:visible').count()) > 0;
  observation.originChanged = final.origin !== target.origin;
  observation.title = safeMessage(await page.title());
  observation.formShape = await formShapeOf(page);
  observation.formShapeSha256 = sha(JSON.stringify(observation.formShape));
  const bodyText = await page
    .locator('body')
    .innerText()
    .catch(() => '');
  observation.blockedPage =
    /(?:access denied|permission denied|you (?:do not|don.t) have permission|portal rendering needs attention|sign in to (?:continue|your account))/i.test(
      bodyText,
    );
  observation.emptyPage =
    !bodyText.trim() && (await page.locator('body img,body canvas,body svg,body iframe').count()) === 0;
  const semantic = await page.evaluate(semanticDocument, { localOrigin, liveOrigin });
  const semanticText = JSON.stringify(semantic, null, 2);
  observation.semanticDomSha256 = sha(semanticText);
  observation.htmlSha256 = sha(await page.content());
  const shot = pathModule.join(outputDir, `${label}.png`);
  const screenshot =
    observation.fontsReady === false
      ? await renderedScreenshot(page, shot)
      : await page.screenshot({
          path: shot,
          fullPage: true,
          animations: 'disabled',
          caret: 'hide',
          style: '#paqvilo-panel{visibility:hidden !important}',
          timeout,
        });
  await fs.writeFile(pathModule.join(outputDir, `${label}.dom.json`), semanticText);
  result.artifacts[`${label}Screenshot`] = pathModule.join(outputDir, `${label}.png`);
  result.artifacts[`${label}Dom`] = pathModule.join(outputDir, `${label}.dom.json`);
  return screenshot;
}

function recordInitialSimulatorState(result, simulatorState) {
  result.simulator = {
    mode: simulatorState.config?.mode,
    pageMode: simulatorState.config?.pageMode,
    sourceDir: simulatorState.status?.sourceDir,
    revision: simulatorState.status?.revision,
    sourceFingerprint: simulatorState.status?.sourceFingerprint,
    implementationFingerprint: simulatorState.status?.implementationFingerprint,
    stateSha256: sha(JSON.stringify({ config: simulatorState.config, data: simulatorState.data })),
  };
  if (!result.simulator.implementationFingerprint)
    result.differences.push(
      'Simulator implementation fingerprint is unavailable; current runtime parity cannot be established.',
    );
  if (!result.simulator.sourceFingerprint)
    result.differences.push(
      'Simulator source fingerprint is unavailable; current source parity cannot be established.',
    );
  if (result.simulator.pageMode !== 'local')
    result.differences.push(
      'Local page rendering is required; live page passthrough cannot establish local renderer parity.',
    );
}

function compareScreenshots(result, livePng, localPng) {
  const live = PNG.sync.read(livePng);
  const local = PNG.sync.read(localPng);
  if (live.width !== local.width || live.height !== local.height)
    result.differences.push(
      `Screenshot dimensions differ: live ${live.width}×${live.height}, local ${local.width}×${local.height}.`,
    );
  const width = Math.max(live.width, local.width);
  const height = Math.max(live.height, local.height);
  const pad = (image) => {
    if (image.width === width && image.height === height) return image;
    const padded = new PNG({ width, height });
    padded.data.fill(255);
    PNG.bitblt(image, padded, 0, 0, image.width, image.height, 0, 0);
    return padded;
  };
  const diff = new PNG({ width, height });
  const differentPixels = pixelmatch(pad(live).data, pad(local).data, diff.data, width, height, {
    threshold: 0,
    includeAA: true,
  });
  result.pixels = {
    width,
    height,
    total: width * height,
    different: differentPixels,
    fraction: differentPixels / (width * height),
  };
  return { diff, differentPixels };
}

function recordOneObservationDifferences(result, label) {
  const observation = result[label];
  if (observation.navigationError) result.differences.push(`${label}: navigation failed.`);
  if (!observation.status || observation.status >= 400)
    result.differences.push(`${label}: HTTP ${observation.status ?? 'unknown'}.`);
  if (observation.signIn || observation.originChanged || observation.blockedPage)
    result.differences.push(`${label}: sign-in, origin redirect, or blocked page observed.`);
  if (observation.emptyPage) result.differences.push(`${label}: empty page observed.`);
  for (const field of [
    'consoleErrors',
    'pageErrors',
    'failedRequests',
    'failedResponses',
    'blockedWrites',
    'readinessFailures',
  ])
    if (observation[field].length) result.differences.push(`${label}: ${observation[field].length} ${field}.`);
  if (observation.pendingRequests.length)
    result.differences.push(`${label}: ${observation.pendingRequests.length} requests remained pending.`);
}

function recordObservationDifferences(result) {
  for (const label of ['live', 'local']) recordOneObservationDifferences(result, label);
}

function recordFinalSimulatorState(result, finalState, localTarget) {
  result.simulator.diagnostics = (finalState.diagnostics || [])
    .filter((item) => !item.path || item.path === localTarget.pathname)
    .map((item) => ({
      ...item,
      ...(item.message ? { message: safeMessage(item.message) } : {}),
      ...(item.path ? { path: item.path.split(/[?#]/)[0] } : {}),
    }));
  if (result.simulator.diagnostics.length)
    result.differences.push(`Local simulator reported ${result.simulator.diagnostics.length} relevant diagnostics.`);
  if (
    finalState.config?.pageMode !== result.simulator.pageMode ||
    finalState.config?.mode !== result.simulator.mode ||
    finalState.status?.revision !== result.simulator.revision
  )
    result.differences.push('Simulator configuration or source revision changed during verification.');
  if (sha(JSON.stringify({ config: finalState.config, data: finalState.data })) !== result.simulator.stateSha256)
    result.differences.push('Simulator data or configuration changed during verification.');
  if (finalState.status?.sourceFingerprint !== result.simulator.sourceFingerprint)
    result.differences.push('Simulator source fingerprint changed during verification.');
  if (finalState.status?.implementationFingerprint !== result.simulator.implementationFingerprint)
    result.differences.push('Simulator implementation changed during verification.');
}

function isRelevantOrigin(value, relevantOrigins) {
  try {
    return relevantOrigins.has(new URL(value).origin);
  } catch {
    return false;
  }
}

/** Read-only, strict observed comparison. Owns only two new pages in the attached identity. */
export async function verifyParity({
  localUrl,
  origin,
  cdpUrl,
  path = '/',
  outputDir,
  viewport = { width: 1440, height: 1000 },
  timeout = 30_000,
  // Bounds the post-load readiness waits (required selectors, fonts, network idle) separately from the page load.
  readinessTimeout = Math.min(timeout, 5000),
  settleMs = 500,
  allowLoopbackLive = false,
  sessionStorageSeeds = {},
  requiredSelectors = [],
} = {}) {
  const validated = validateParityInputs({
    localUrl,
    origin,
    cdpUrl,
    path,
    outputDir,
    viewport,
    readinessTimeout,
    allowLoopbackLive,
    sessionStorageSeeds,
    requiredSelectors,
  });
  const { local, live, cdp, localTarget, liveTarget } = validated;
  outputDir = validated.outputDir;
  await fs.mkdir(outputDir, { recursive: true });
  const result = {
    version: 1,
    passed: false,
    verified: false,
    time: new Date().toISOString(),
    path: safeUrl(localTarget.href).slice(local.origin.length),
    viewport,
    localOrigin: local.origin,
    liveOrigin: live.origin,
    comparison: {
      pixelThreshold: 0,
      maximumDifferentPixels: 0,
      semanticDomRequired: true,
      normalizations: [
        'Origins in attributes are matched.',
        'Antiforgery token values are excluded.',
        'Script/style/link/meta elements do not form the semantic DOM.',
        'The toolkit dev panel host #paqvilo-panel is excluded from the semantic DOM and hidden in screenshots.',
        'Screenshots disable animations and hide the caret.',
        'The local Mirage /__sim/events event stream is tracked as a persistent connection.',
      ],
      sessionStorageKeys: Object.keys(sessionStorageSeeds).sort(/* NOSONAR: preserve default string coercion */),
      requiredSelectors,
    },
    local: {},
    live: {},
    differences: [],
    artifacts: {},
  };
  let browser;
  const pages = [];
  try {
    const stateResponse = await fetch(new URL('/__sim/api/state', local.origin), {
      signal: AbortSignal.timeout(timeout),
    });
    if (!stateResponse.ok) throw new Error('Local simulator state is unavailable; rendering mode cannot be verified.');
    const simulatorState = await stateResponse.json();
    recordInitialSimulatorState(result, simulatorState);
    browser = await chromium.connectOverCDP(cdp.href, { timeout });
    const contexts = browser.contexts();
    if (contexts.length !== 1) throw new Error('Verification requires exactly one connected browser identity.');
    const context = contexts[0];
    const relevantOrigins = new Set([local.origin, live.origin]);
    const relevant = (value) => isRelevantOrigin(value, relevantOrigins);
    if (context.serviceWorkers().some((worker) => relevant(worker.url())))
      throw new Error(
        'A relevant service worker is active. Use the intended browser identity without portal service workers for read-only verification.',
      );
    for (const existingPage of context.pages().filter((page) => relevant(page.url()))) {
      const registrations = await existingPage.evaluate(async () =>
        navigator.serviceWorker
          ? (await navigator.serviceWorker.getRegistrations()).map((registration) => registration.scope)
          : [],
      );
      if (registrations.some(relevant))
        throw new Error(
          'A relevant service worker is registered. Read-only verification cannot intercept its requests in an attached browser.',
        );
    }
    // Keep the same browser identity, viewport, and timing policy for both captures.
    const captureOptions = {
      context,
      viewport,
      result,
      localOrigin: local.origin,
      liveOrigin: live.origin,
      sessionStorageSeeds,
      requiredSelectors,
      readinessTimeout,
      settleMs,
      timeout,
      outputDir,
      pages,
    };
    const livePng = await capturePage('live', liveTarget, captureOptions);
    const localPng = await capturePage('local', localTarget, captureOptions);
    const comparison = compareScreenshots(result, livePng, localPng);
    await fs.writeFile(pathModule.join(outputDir, 'difference.png'), PNG.sync.write(comparison.diff));
    result.artifacts.difference = pathModule.join(outputDir, 'difference.png');
    if (comparison.differentPixels) result.differences.push(`${comparison.differentPixels} screenshot pixels differ.`);
    if (result.local.semanticDomSha256 !== result.live.semanticDomSha256)
      result.differences.push('Semantic DOM differs.');
    recordObservationDifferences(result);
    const finalStateResponse = await fetch(new URL('/__sim/api/state', local.origin), {
      signal: AbortSignal.timeout(timeout),
    });
    if (!finalStateResponse.ok) throw new Error('Local simulator state became unavailable during verification.');
    const finalState = await finalStateResponse.json();
    recordFinalSimulatorState(result, finalState, localTarget);
    result.passed = result.verified = result.differences.length === 0;
  } catch (error) {
    result.differences.push(safeMessage(error.message));
  } finally {
    for (const page of pages) await page.close().catch(() => {});
    await browser?.close().catch(() => {});
    result.artifacts.report = pathModule.join(outputDir, 'report.json');
    await fs.writeFile(result.artifacts.report, JSON.stringify(result, null, 2));
  }
  return result;
}

if (process.argv[1] && pathModule.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: Object.fromEntries(
        ['local', 'origin', 'cdp', 'path', 'output'].map((name) => [name, { type: 'string' }]),
      ),
    });
    const report = await verifyParity({
      localUrl: values.local,
      origin: values.origin,
      cdpUrl: values.cdp,
      path: values.path,
      outputDir: values.output,
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    console.error(safeMessage(error.message));
    process.exitCode = 1;
  }
}

// Playwright's screenshot first waits for document.fonts.ready, bounded only by its own timeout: a web font that never
// arrives costs the whole timeout (30 s by default) and yields no image. Once the bounded readiness wait has recorded
// unsettled fonts, capture what the page rendered with its fallback fonts through CDP, which does not wait for them.
async function renderedScreenshot(page, file) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await page.evaluate(() =>
      document.getElementById('paqvilo-panel')?.style.setProperty('visibility', 'hidden', 'important'),
    );
    const { cssContentSize } = await cdp.send('Page.getLayoutMetrics');
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: Math.ceil(cssContentSize.width), height: Math.ceil(cssContentSize.height), scale: 1 },
    });
    const png = Buffer.from(data, 'base64');
    await fs.writeFile(file, png);
    return png;
  } finally {
    await cdp.detach().catch(() => {});
  }
}
