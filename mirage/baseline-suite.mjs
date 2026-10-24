import {
  validateScenarioId,
  validateCaptureLabel,
  boundedScenarioDirectory,
  ensureCaptureDestination,
} from './baseline-paths.mjs';
/**
 * Baseline suite: capture every scenario of a matrix on one side into deterministic evidence
 * folders, then compare sides with the allowlist.
 *
 * Live side (the reference portal) runs through the user's own signed-in browser profile via a
 * browser bridge that exposes a Playwright page (for example `@playwright/mcp --extension`); the
 * bridge command comes from the matrix (`live.command`, `live.args`) so no profile name lives in
 * toolkit code. Live writes are refused unless `--allow-writes` names the run as authorised and
 * the request falls inside the matrix `writeScope`; every other non-GET is aborted and recorded.
 *
 * node mirage/baseline-suite.mjs capture --matrix FILE --out DIR --side live [--allow-writes] [--label live|live-2] [--ids FILE] [--only IDS|@FILE]
 * node mirage/baseline-suite.mjs capture --matrix FILE --out DIR --side mirage --config FILE --site ID [--source DIR] [--state FILE] [--label mirage] [--ids FILE] [--only IDS|@FILE] [--headed]
 * node mirage/baseline-suite.mjs compare --matrix FILE --out DIR [--live live] [--mirage mirage] [--second-live live-2] [--allowlist FILE] [--evidence-changes FILE] [--only IDS|@FILE]
 */
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { parseArgs } from 'node:util';
import { runMutatingHook, MUTATING_HOOK_FAILURE } from './baseline-hooks.mjs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  captureScenario,
  pageRunnerSource,
  runnerOptions,
  siteOriginPlaceholder,
  writeCapture,
} from './baseline-capture.mjs';
import {
  compareScenario,
  loadAllowlist,
  loadEvidenceChanges,
  finalizeEvidenceChanges,
  summarize,
  summaryMarkdown,
} from './baseline-compare.mjs';
import { startMcpServer } from './mcp-stdio.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// `--only a,b,c` or `--only @file` selects scenarios. A list file holds one scenario per line: the first
// whitespace-delimited token is the id, so "id<tab>reason" and "id  # reason" lines work; `#` comments and blank
// lines are skipped. A list that yields no id is an error (a silently empty selection captures or compares nothing).
export const list = (value) => {
  if (!value) return null;
  const ids = String(value).startsWith('@')
    ? readFileSync(String(value).slice(1), 'utf8')
        .split(/\r?\n/)
        .map((line) => line.replace(/#.*/, '').trim().split(/\s+/)[0])
        .filter(Boolean)
    : String(value)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
  if (!ids.length) throw new Error(`--only ${value} selects no scenario ids`);
  return ids;
};

export function validateMatrix(matrix) {
  if (!matrix || matrix.version !== 1 || !Array.isArray(matrix.scenarios) || !matrix.scenarios.length)
    throw new Error('A version 1 matrix with scenarios is required.');
  const ids = new Set();
  for (const scenario of matrix.scenarios) {
    validateScenarioId(scenario.id);
    if (ids.has(scenario.id)) throw new Error(`Duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
    if (!Array.isArray(scenario.steps) || !scenario.steps.length)
      throw new Error(`Scenario ${scenario.id} needs steps.`);
    if (scenario.persona && !matrix.personas?.[scenario.persona])
      throw new Error(`Scenario ${scenario.id} uses unknown persona ${scenario.persona}.`);
  }
  for (const pattern of matrix.writeScope?.paths ?? []) new RegExp(pattern);
  if (matrix.origin && !/^https:\/\/[^/?#]+$/.test(matrix.origin))
    throw new Error('matrix.origin must be a bare HTTPS origin.');
  return matrix;
}

/** Folder of one scenario on one side: <out>/<scenario id segments>/<label>. */
export const scenarioDir = boundedScenarioDirectory;

/** Loopback receiver for raw evidence posted by the runner inside the bridge process. Each run has its own nonce:
 * a bridge call that timed out keeps running in the bridge, and its late post must not resolve the next run's wait.
 * Late posts answer 409 and are recorded in `late`. */
export async function startSaver() {
  const token = randomBytes(16).toString('hex');
  let waiting = null,
    closePromise,
    closed = false;
  const late = [];
  const refuseLate = (run, response) => {
    late.push({ run: run ?? null, at: new Date().toISOString() });
    process.stderr.write(
      `baseline-suite: refused a late evidence post of an abandoned bridge run (${run ?? 'no run id'})\n`,
    );
    response.writeHead(409).end();
  };
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/capture' || request.headers['x-baseline-token'] !== token) {
      request.resume();
      response.writeHead(403).end();
      return;
    }
    const run = request.headers['x-baseline-run'];
    const target = waiting;
    if (!target || run !== target.run) {
      request.resume();
      refuseLate(run, response);
      return;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('aborted', () => {
      if (waiting === target) waiting = null;
      target.reject(new Error('Evidence post ended before its body completed.'));
    });
    request.on('error', (error) => {
      if (waiting === target) waiting = null;
      target.reject(error);
    });
    request.on('end', () => {
      // Admission at headers is insufficient: another run can be armed while this body streams.
      if (closed || waiting !== target || run !== waiting.run) {
        refuseLate(run, response);
        return;
      }
      waiting = null;
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        target.resolve(result);
        response.writeHead(204).end();
      } catch (error) {
        target.reject(error);
        response.writeHead(400).end();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/capture`;
  return {
    url,
    token,
    late,
    expect() {
      if (closed) throw new Error('Evidence receiver is closed.');
      waiting?.reject(new Error('Evidence wait was superseded by another run.'));
      const run = randomBytes(8).toString('hex');
      const received = new Promise((resolve, reject) => {
        waiting = { run, resolve, reject };
      });
      // The bridge can fail before runInBridge reaches this promise; keep it handled meanwhile.
      void received.catch(() => {});
      return { run, received };
    },
    close() {
      if (!closePromise) {
        closed = true;
        waiting?.reject(new Error('Evidence receiver closed before a post completed.'));
        waiting = null;
        closePromise = new Promise((resolve) => server.close(resolve));
        // Only this owned loopback receiver's connections are closed, including incomplete posts.
        server.closeAllConnections?.();
      }
      return closePromise;
    },
  };
}

async function liveSide({ matrix, allowWrites, cwd, outputRoot, signInOut = null }) {
  const bridge = matrix.live;
  if (!bridge?.command)
    throw new Error(
      'matrix.live.command is required for the live side (a browser bridge that exposes a Playwright page, such as @playwright/mcp --extension).',
    );
  const stderr = [];
  const client = startMcpServer({
    command: bridge.command === 'node' ? process.execPath : bridge.command,
    args: bridge.args ?? [],
    cwd: bridge.cwd ? path.resolve(cwd, bridge.cwd) : cwd,
    onStderr: (text) => stderr.push(text.slice(0, 300)),
  });
  let saver;
  const abortSetup = async (error) => {
    await Promise.allSettled([saver?.close(), client.close()]);
    throw error;
  };
  await client.initialize().catch(abortSetup);
  const tools = new Set((await client.listTools().catch(abortSetup)).map((tool) => tool.name));
  const runTool = bridge.tool ?? 'browser_run_code_unsafe';
  if (!tools.has(runTool)) await abortSetup(new Error(`The browser bridge offers no ${runTool} tool.`));
  saver = await startSaver().catch(abortSetup);
  const source = pageRunnerSource();
  const runInBridge = async (scenario, { ids = {}, allowWrites: writes = allowWrites } = {}) => {
    const options = runnerOptions({ scenario, origin: matrix.origin, ids, matrix, allowWrites: writes });
    // A scenario expecting the sign-in page (`expect.signIn`, anonymous access to a restrict-read page) checks its markers itself.
    if (scenario.expect?.signIn) options.signInMarkers = [];
    const { run, received } = saver.expect();
    const code = `async (page) => {\n  const run = ${source};\n  const result = await run(page, ${JSON.stringify(options)});\n  const posted = await fetch(${JSON.stringify(saver.url)}, { method: "POST", headers: { "content-type": "application/json", "x-baseline-token": ${JSON.stringify(saver.token)}, "x-baseline-run": ${JSON.stringify(run)} }, body: JSON.stringify(result) });\n  return JSON.stringify({ ...result.summary, posted: posted.status });\n}`;
    const text = await client.callTool(runTool, { code }, (scenario.timeout ?? 240) * 1000 + 60000);
    let timer;
    try {
      return await Promise.race([
        received,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Bridge returned without posting evidence: ${text.slice(0, 300)}`)),
            30000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  // Optional scripted portal sign-in through the profile's identity provider. No credentials are
  // involved: the profile's SSO either completes or the run stops and names the human step.
  // A failed sign-in or persona check saves its page and throws; the bridge stays open for the next persona group.
  const fail = async (message, result, folder) => {
    if (signInOut && result)
      await writeCapture(result, {
        outDir: path.join(signInOut, folder),
        outputRoot,
        origin: matrix.origin,
        side: folder,
        meta: { runtime: 'reference' },
      }).catch(() => {});
    throw new Error(message);
  };
  const ensureSignedIn = async () => {
    if (!bridge.signIn) return;
    const expect = {
      absent: ["form[action*='/Account/Login/ExternalLogin']", ...(bridge.signIn.expectAbsent ?? [])],
      present: bridge.signIn.expectPresent ?? [],
    };
    // Already signed in: the first navigation alone shows the signed-in markers, so the provider click is skipped.
    const first = bridge.signIn.steps.find((step) => step.goto);
    let result = first
      ? await runInBridge({ id: 'sign-in', steps: [first, { wait: 1500 }], expect }, { allowWrites: false })
      : { summary: { status: 'skipped' } };
    if (result.summary.status !== 'captured')
      result = await runInBridge({ id: 'sign-in', steps: bridge.signIn.steps, expect }, { allowWrites: false });
    if (result.summary.status !== 'captured')
      await fail(
        `Portal sign-in did not complete through the browser profile (${result.summary.problems.join('; ')}). Sign in once in that profile (credential or MFA prompt), then rerun.`,
        result,
        'sign-in',
      );
  };
  const signOut = async () => {
    if (!bridge.signOut)
      throw new Error(
        'matrix.live.signOut is required for anonymous scenarios on the live side (steps that sign the portal session out).',
      );
    const expect = { absent: bridge.signIn?.expectPresent ?? [], ...(bridge.signOut.expect ?? {}) };
    const result = await runInBridge({ id: 'sign-out', steps: bridge.signOut.steps, expect }, { allowWrites: false });
    if (result.summary.status !== 'captured')
      await fail(`Portal sign-out did not complete (${result.summary.problems.join('; ')}).`, result, 'sign-out');
  };
  // Role changes reach the portal through its cache: a persona is in effect only once its verification probe passes.
  // `verify` is one probe ({ steps, expect }) or several ({ probes: [...] }); every probe must pass within one attempt,
  // because the portal's permission cache refreshes per page and the previous persona can linger on some of them.
  // `settleMs` is waited after the attempt that passes.
  const verifyPersona = async (name, verify, ids) => {
    const attempts = verify.attempts ?? 12;
    const probes = verify.probes ?? [{ steps: verify.steps, expect: verify.expect }];
    let result;
    let failedProbe = 0;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let passed = true;
      for (const [index, probe] of probes.entries()) {
        result = await runInBridge(
          { id: `persona-${name}-${index + 1}`, steps: probe.steps, expect: probe.expect ?? {} },
          { ids, allowWrites: false },
        );
        if (result.summary.status !== 'captured') {
          passed = false;
          failedProbe = index + 1;
          break;
        }
      }
      if (passed) {
        if (verify.settleMs) await sleep(verify.settleMs);
        return attempt;
      }
      await sleep(verify.delay ?? 15000);
    }
    await fail(
      `Persona ${name} did not take effect on the portal after ${attempts} attempts (probe ${failedProbe}: ${result.summary.problems.join('; ')}).`,
      result,
      `persona-${name}`,
    );
  };
  // Optional cache refresh after a persona switch (`matrix.live.refresh`: steps the signed-in session runs, such as
  // the portal's own clear-cache control), so role changes reach the pages at once instead of after the cache lag.
  const refresh = async () => {
    if (!bridge.refresh) return;
    const result = await runInBridge(
      { id: 'refresh', steps: bridge.refresh.steps, expect: bridge.refresh.expect ?? {} },
      { allowWrites: true },
    );
    if (result.summary.status !== 'captured')
      await fail(`Portal cache refresh did not complete (${result.summary.problems.join('; ')}).`, result, 'refresh');
  };
  // One cache-clear cycle for a persona whose probes failed (`hooks.liveAdminAdd`/`liveAdminRemove` + `live.clearCache`):
  // the portal offers its Clear cache control only to an admin role the personas do not hold, and role changes behind table
  // permissions can lag for many minutes without a clear. The add hook grants the role, the clear steps are retried until
  // the control appears (attempts × delay), the remove hook takes the role away again.
  const adminCycle = async () => {
    const options = { cwd: matrix.hooks?.cwd ? path.resolve(cwd, matrix.hooks.cwd) : cwd };
    const clear = bridge.clearCache;
    // Failed add hooks must reconcile their own partial effects; generic code cannot infer original membership.
    await runMutatingHook('liveAdminAdd', matrix.hooks.liveAdminAdd, options);
    let failure;
    try {
      let result;
      for (let attempt = 1; attempt <= (clear.attempts ?? 12); attempt++) {
        result = await runInBridge(
          { id: 'clear-cache', steps: clear.steps, expect: clear.expect ?? {} },
          { allowWrites: true },
        );
        if (result.summary.status === 'captured') break;
        await sleep(clear.delay ?? 10000);
      }
      if (result?.summary.status !== 'captured') {
        await fail(
          `Portal cache clear did not complete (${result?.summary.problems.join('; ') ?? 'no attempt completed'}).`,
          result,
          'clear-cache',
        );
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        await runMutatingHook('liveAdminRemove', matrix.hooks.liveAdminRemove, options);
      } catch (cleanupError) {
        if (failure) {
          // eslint-disable-next-line no-unsafe-finally -- Cleanup failure is deliberately reported while preserving the primary failure.
          throw new AggregateError(
            [failure, cleanupError],
            `Portal cache clear failed (${failure.message}); admin role cleanup also failed (${cleanupError.message}).`,
            { cause: cleanupError },
          );
        }
        // eslint-disable-next-line no-unsafe-finally -- Cleanup failure is deliberately reported while preserving the primary failure.
        throw cleanupError;
      }
    }
  };

  await ensureSignedIn().catch(abortSetup);
  return {
    name: 'live',
    async persona(name, { ids = {} } = {}) {
      const persona = matrix.personas?.[name] ?? {};
      await runMutatingHook('livePersona', matrix.hooks?.livePersona, {
        persona: name,
        cwd: matrix.hooks?.cwd ? path.resolve(cwd, matrix.hooks.cwd) : cwd,
      });
      await ensureSignedIn();
      await refresh();
      if (persona.anonymous) await signOut();
      if (!persona.verify) return;
      try {
        await verifyPersona(name, persona.verify, ids);
      } catch (error) {
        if (!(matrix.hooks?.liveAdminAdd && matrix.hooks?.liveAdminRemove && bridge.clearCache)) throw error;
        await adminCycle();
        await verifyPersona(name, persona.verify, ids);
      }
    },
    async reset() {
      const options = { cwd: matrix.hooks?.cwd ? path.resolve(cwd, matrix.hooks.cwd) : cwd };
      // Project hooks may retry their own known-safe operations; a generic retry could duplicate a partial write.
      await runMutatingHook('liveReset', matrix.hooks?.liveReset, options);
    },
    async capture(scenario, { outDir, outputRoot, ids, label, meta }) {
      const result = await runInBridge(scenario, { ids });
      return writeCapture(result, {
        outDir,
        outputRoot,
        origin: matrix.origin,
        side: label,
        scenarioId: scenario.id,
        meta: {
          ...meta,
          origin: new URL(matrix.origin).hostname.replace(/^[^.]+/, '{site}'),
          runtime: 'reference',
          bridge: bridge.name ?? 'browser-bridge',
        },
      });
    },
    diagnostics: () => [
      ...stderr.slice(-20),
      ...saver.late.map((post) => `late evidence post of an abandoned run ${post.run} at ${post.at} refused`),
    ],
    async close() {
      try {
        await saver.close();
      } finally {
        await client.close();
      }
    },
  };
}

async function mirageSide({ matrix, config, site, env, source, state, headed, workDir }) {
  const { startIsolatedMirage, createIdentityController } = await import('./parity-suite.mjs');
  const { chromium } = await import('playwright-core');
  const { browserLaunchOptions } = await import('./lib/browser-launch.mjs');
  let catalogue = null;
  if (site) {
    const { loadConfig } = await import('../lense/config.mjs');
    catalogue = await loadConfig({ site, env, config });
  }
  const sourceDir = path.resolve(source ?? catalogue?.sourceDir);
  const siteMirage = catalogue?.mirageConfig ?? null;
  let roots = null;
  if (siteMirage) {
    const { resolveSolutionRoots } = await import('./lib/solution-roots.mjs');
    roots = await resolveSolutionRoots({
      sourceDir,
      catalogue: siteMirage,
      cacheFile: path.join(workDir, 'cache', 'solution-sources.json'),
    });
  }
  const preset = matrix.mirage?.preset ?? siteMirage?.preset ?? null;
  const owned = await startIsolatedMirage({
    sourceDir,
    dataPacks: siteMirage?.dataPacks ?? [],
    baselineState: state ? path.resolve(state) : undefined,
    ...(roots ? { solutionRoots: roots.roots, solutionOrder: roots.order } : {}),
    ...(siteMirage?.observed ? { observed: siteMirage.observed } : {}),
    preset,
    origin: matrix.origin ?? 'https://baseline.invalid',
    workDir,
  });
  const identity = createIdentityController(owned.url);
  // Headless Chromium hides scrollbars (width 0) while the live capture's headed Edge has a 15 px one, which shows as
  // body padding-right when a dialog opens: keep the scrollbar so both sides measure the same.
  const browser = await chromium.launch(
    browserLaunchOptions({ headless: !headed, ignoreDefaultArgs: ['--hide-scrollbars'] }),
  );
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const status = await (await fetch(owned.url + '/__sim/api/state?summary=1')).json();
  const csrf = () => owned.app.state().csrf;
  // The live portal shows the signed-in tester's own name, parent account and base roles; the project declares those
  // observed values (`matrix.mirage.identity.contact`) and they are written onto the mirrored contact after every reset.
  // With `liveContactId` (the live tester's contact id) the preset contact is rekeyed to it across the exported state (row
  // ids and every lookup), so lookups and the signed-in identity carry the same id and name as on live.
  const presetContact = matrix.mirage?.identity?.contactId ?? status.config?.identity?.contactId;
  const liveContact = matrix.mirage?.identity?.liveContactId;
  const contactOf = (id) =>
    liveContact && id && presetContact && id.toLowerCase() === presetContact.toLowerCase() ? liveContact : id;
  let mirrored = false;
  let currentPersona = null;
  const mirrorIdentityFields = async () => {
    mirrored = true;
    // Fields a live persona switch changes on the tester (persona.mirageContactFields) apply on top of the identity fields.
    const personaFields = matrix.personas?.[currentPersona]?.mirageContactFields;
    const fields = personaFields
      ? { ...matrix.mirage?.identity?.contact, ...personaFields }
      : matrix.mirage?.identity?.contact;
    const rekey = Boolean(liveContact && presetContact && liveContact.toLowerCase() !== presetContact.toLowerCase());
    if (!fields && !rekey) return;
    const exported = await (await fetch(owned.url + '/__sim/api/state/export')).json();
    const state = rekey ? JSON.parse(JSON.stringify(exported).replaceAll(presetContact, liveContact)) : exported;
    const contactId = contactOf(presetContact);
    const row = (state.tables?.contact ?? []).find((record) => record.contactid === contactId);
    if (!row)
      throw new Error(
        `Mirage identity contact ${contactId} is not in the preset data; cannot mirror the live tester's fields.`,
      );
    for (const [field, value] of Object.entries(fields ?? {}))
      row[field] =
        value && typeof value === 'object' && row[field] && typeof row[field] === 'object'
          ? { ...row[field], ...value }
          : value;
    // Lookups to the mirrored contact show its (mirrored) name.
    const name = row.fullname ?? [row.firstname, row.lastname].filter(Boolean).join(' ');
    if (name)
      for (const rows of Object.values(state.tables ?? {}))
        for (const record of Array.isArray(rows) ? rows : [])
          for (const value of Object.values(record))
            if (value && typeof value === 'object' && value.logical_name === 'contact' && value.id === contactId)
              value.name = name;
    // Fixture fields go only to the disposable runtime started above, never matrix.origin.
    const response = await fetch(owned.url + '/__sim/api/state/import', {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf() },
      body: JSON.stringify(state),
    });
    if (!response.ok) throw new Error(`Mirage identity mirror failed (${response.status})`);
  };
  return {
    name: 'mirage',
    url: owned.url,
    async persona(name) {
      const persona = matrix.personas?.[name];
      if (!persona) throw new Error(`Unknown persona ${name}`);
      if (persona.anonymous) {
        await identity.restore();
        return;
      }
      // The first persona signs in before the first reset: the rekeyed contact must exist already.
      const switched = currentPersona !== name;
      currentPersona = name;
      if (!mirrored || switched) await mirrorIdentityFields();
      if (persona.roles)
        await identity.mirror({
          contactId: contactOf(persona.mirageContact ?? status.config?.identity?.contactId),
          roles: persona.roles,
        });
      else await identity.signInAs(contactOf(persona.mirageContact));
      await identity.use('signed-in');
    },
    async reset() {
      const response = await fetch(owned.url + '/__sim/api/reset', {
        method: 'POST',
        headers: { 'x-sim-csrf': csrf() },
      });
      if (!response.ok) throw new Error(`Mirage reset failed (${response.status})`);
      if (preset) await owned.app.applyPreset(preset);
      await mirrorIdentityFields();
      const config = await fetch(owned.url + '/__sim/api/config', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf() },
        body: JSON.stringify({ mode: 'local', pageMode: 'local', live: { allowWrites: false } }),
      });
      if (!config.ok) throw new Error(`Mirage configuration failed (${config.status})`);
    },
    async capture(scenario, { outDir, outputRoot, ids, label, meta }) {
      await context.clearCookies();
      const cookie = identity.cookie();
      if (cookie) await context.addCookies([{ name: cookie.name, value: cookie.value, url: owned.url }]);
      const page = await context.newPage();
      // The live capture runs with the browser cache disabled, so every resource (frames included) is requested again;
      // the Mirage page does the same so both sides record the same request sequence.
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      try {
        return await captureScenario(page, scenario, {
          origin: owned.url,
          outDir,
          outputRoot,
          ids,
          side: label,
          matrix,
          allowWrites: true,
          meta: {
            ...meta,
            origin: '{mirage}',
            runtime: 'mirage',
            preset,
            solutionRoots: owned.solutionRoots.map((root) => path.basename(root)),
            sourceFingerprint: status.status?.sourceFingerprint ?? null,
            implementationFingerprint: status.status?.implementationFingerprint ?? null,
          },
        });
      } finally {
        await page.close().catch(() => {});
      }
    },
    diagnostics: () => [],
    async close() {
      await identity.restore().catch(() => {});
      await browser.close().catch(() => {});
      await owned.app.close().catch(() => {});
      if (owned.workspace) await fs.rm(owned.workspace, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Preserve uncertain hook markers through aggregate cleanup errors. */
function uncertainMutatingHook(error) {
  const pending = [error],
    seen = new Set();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (value.code === MUTATING_HOOK_FAILURE && typeof value.hook === 'string') return value.hook;
    if (Array.isArray(value.errors)) pending.push(...value.errors);
    if (value.cause) pending.push(value.cause);
  }
  return null;
}

export async function captureMatrix({ matrix, side, outDir, label, ids = {}, only = null }) {
  validateMatrix(matrix);
  validateCaptureLabel(label);
  const results = [];
  let currentPersona = Symbol('none');
  const failedPersonas = new Map();
  let blockedBy = null;
  // Persona switches are the expensive step on a live portal (its permission cache lags role changes by
  // minutes), so scenarios run grouped by persona in first-appearance order; the order within a persona is kept.
  const personaOrder = [];
  for (const scenario of matrix.scenarios)
    if (!personaOrder.includes(scenario.persona ?? null)) personaOrder.push(scenario.persona ?? null);
  const selected = matrix.scenarios
    .filter((scenario) => !only || only.includes(scenario.id))
    .map((scenario, index) => ({ scenario, index }))
    .sort(
      (a, b) =>
        personaOrder.indexOf(a.scenario.persona ?? null) - personaOrder.indexOf(b.scenario.persona ?? null) ||
        a.index - b.index,
    )
    .map(({ scenario }) => scenario);
  for (const scenario of selected)
    await ensureCaptureDestination(scenarioDir(outDir, scenario, label), outDir, { create: false });
  for (const scenario of selected) {
    const folder = scenarioDir(outDir, scenario, label);
    const personaName = scenario.persona ?? null;
    const summary = { id: scenario.id, folder: path.relative(outDir, folder), ms: {} };
    let phase = null;
    const timed = async (name, work) => {
      phase = name;
      const started = Date.now();
      try {
        return await work();
      } finally {
        summary.ms[name] = Date.now() - started;
      }
    };
    try {
      if (blockedBy) {
        summary.notAttempted = true;
        summary.blockedBy = { ...blockedBy };
        throw new Error(
          `Not attempted: uncertain mutating hook ${blockedBy.hook} in ${blockedBy.scenario} requires project reconciliation.`,
        );
      }
      // A persona that did not take effect fails every scenario of its group at once instead of re-probing per scenario.
      if (failedPersonas.has(personaName)) throw new Error(failedPersonas.get(personaName));
      if (personaName !== currentPersona) {
        try {
          await timed('persona', () => side.persona(personaName ?? 'anonymous', { ids }));
        } catch (error) {
          failedPersonas.set(personaName, String(error.message));
          throw error;
        }
        currentPersona = personaName;
      }
      if (scenario.reset !== false) await timed('reset', () => side.reset());
      const capture = await timed('capture', () =>
        side.capture(scenario, {
          outDir: folder,
          outputRoot: outDir,
          ids,
          label,
          meta: {
            persona: personaName,
            component: scenario.component ?? null,
            variation: scenario.variation ?? null,
            state: scenario.state ?? null,
          },
        }),
      );
      Object.assign(summary, {
        status: capture.status,
        problems: capture.problems,
        requests: capture.requests,
        elements: capture.elements,
        blockedWrites: capture.blockedWrites?.length ?? 0,
      });
    } catch (error) {
      const hook = uncertainMutatingHook(error);
      if (hook) {
        blockedBy = { scenario: scenario.id, phase, hook, code: MUTATING_HOOK_FAILURE };
        summary.uncertainHook = { hook, code: MUTATING_HOOK_FAILURE, reconciliationRequired: true };
      }
      Object.assign(summary, {
        status: 'error',
        problems: [String(error.message).slice(0, 500), ...(summary.notAttempted ? [] : side.diagnostics().slice(-3))],
      });
    }
    results.push(summary);
    console.log(
      JSON.stringify({
        scenario: scenario.id,
        side: label,
        status: summary.status,
        problems: summary.problems ?? [],
        ms: summary.ms,
        ...(summary.notAttempted ? { notAttempted: true, blockedBy: summary.blockedBy } : {}),
        ...(summary.uncertainHook ? { uncertainHook: summary.uncertainHook } : {}),
      }),
    );
    if (!summary.notAttempted) await sleep(matrix.delayMs ?? 250);
  }
  return results;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      matrix: { type: 'string' },
      out: { type: 'string' },
      side: { type: 'string' },
      label: { type: 'string' },
      'allow-writes': { type: 'boolean' },
      ids: { type: 'string' },
      only: { type: 'string' },
      config: { type: 'string' },
      site: { type: 'string' },
      env: { type: 'string' },
      source: { type: 'string' },
      state: { type: 'string' },
      headed: { type: 'boolean' },
      'work-dir': { type: 'string' },
      live: { type: 'string' },
      mirage: { type: 'string' },
      allowlist: { type: 'string' },
      'second-live': { type: 'string' },
      'evidence-changes': { type: 'string' },
    },
  });
  const action = positionals[0];
  if (!['capture', 'compare'].includes(action) || !values.matrix || !values.out)
    throw new Error('Usage: suite.mjs capture|compare --matrix FILE --out DIR ...');
  const matrixFile = path.resolve(values.matrix);
  const matrix = validateMatrix(JSON.parse(await fs.readFile(matrixFile, 'utf8')));
  const outDir = path.resolve(values.out);
  const only = list(values.only);
  if (action === 'capture') {
    // `run` is a short token scenarios embed in values that must be unique per run yet equal on both sides.
    const ids = {
      run: matrix.runToken ?? 'r1',
      ...(values.ids ? JSON.parse(await fs.readFile(values.ids, 'utf8')) : {}),
    };
    const label = validateCaptureLabel(values.label ?? values.side);
    for (const scenario of matrix.scenarios.filter((item) => !only || only.includes(item.id)))
      await ensureCaptureDestination(scenarioDir(outDir, scenario, label), outDir, { create: false });
    await ensureCaptureDestination(path.join(outDir, '_sign-in'), outDir, { create: false });
    if (values.side === 'mirage' && !values['work-dir'])
      await ensureCaptureDestination(path.join(outDir, '.runtime'), outDir, { create: false });
    const startedAt = new Date().toISOString();
    await ensureCaptureDestination(outDir, outDir, {
      create: false,
      files: [`run-${label}.json`, `run-${label}-${startedAt.replace(/:/g, '')}.json`],
    });
    let side;
    if (values.side === 'live') {
      if (!matrix.origin) throw new Error('matrix.origin (HTTPS reference origin) is required for the live side.');
      side = await liveSide({
        matrix,
        allowWrites: Boolean(values['allow-writes']),
        cwd: path.dirname(matrixFile),
        outputRoot: outDir,
        signInOut: path.join(outDir, '_sign-in'),
      });
    } else if (values.side === 'mirage') {
      side = await mirageSide({
        matrix,
        config: values.config,
        site: values.site,
        env: values.env,
        source: values.source,
        state: values.state,
        headed: Boolean(values.headed),
        workDir: path.resolve(values['work-dir'] ?? path.join(outDir, '.runtime')),
      });
    } else throw new Error('--side must be live or mirage.');

    let results;
    try {
      results = await captureMatrix({ matrix, side, outDir, label, ids, only });
    } finally {
      await side.close();
    }
    const run = {
      version: 1,
      action,
      side: values.side,
      label,
      startedAt,
      finishedAt: new Date().toISOString(),
      allowWrites: Boolean(values['allow-writes']),
      scenarios: results,
      totals: {
        captured: results.filter((r) => r.status === 'captured').length,
        failed: results.filter((r) => r.status === 'failed').length,
        error: results.filter((r) => r.status === 'error').length,
        blockedWrites: results.reduce((sum, r) => sum + (r.blockedWrites ?? 0), 0),
        notAttempted: results.filter((r) => r.notAttempted).length,
      },
    };
    await ensureCaptureDestination(outDir, outDir, {
      files: [`run-${label}.json`, `run-${label}-${startedAt.replace(/:/g, '')}.json`],
    });
    await fs.writeFile(path.join(outDir, `run-${label}.json`), JSON.stringify(run, null, 2));
    // Keep every run: run-<label>.json is the latest, run-<label>-<startedAt>.json (colon-free) the history.
    await fs.writeFile(
      path.join(outDir, `run-${label}-${startedAt.replace(/:/g, '')}.json`),
      JSON.stringify(run, null, 2),
    );
    console.log(JSON.stringify({ run: path.join(outDir, `run-${label}.json`), totals: run.totals }));
    process.exitCode = run.totals.error ? 2 : run.totals.failed || run.totals.blockedWrites ? 1 : 0;
    return;
  }
  const allowlist = values.allowlist ? await loadAllowlist(values.allowlist) : { entries: [] };
  const changes = values['evidence-changes'] ? (await loadEvidenceChanges(values['evidence-changes'])).changes : [];
  const report = {
    version: 1,
    action,
    generatedAt: new Date().toISOString(),
    live: values.live ?? 'live',
    mirage: values.mirage ?? 'mirage',
    allowlist: values.allowlist ? path.resolve(values.allowlist) : null,
    evidenceChangesFile: values['evidence-changes'] ? path.resolve(values['evidence-changes']) : null,
    scenarios: [],
  };
  const results = [];
  for (const scenario of matrix.scenarios.filter((item) => !only || only.includes(item.id))) {
    const liveDir = scenarioDir(outDir, scenario, report.live);
    const mirageDir = scenarioDir(outDir, scenario, report.mirage);
    const secondDir = values['second-live'] ? scenarioDir(outDir, scenario, values['second-live']) : null;
    for (const source of [liveDir, mirageDir, secondDir].filter(Boolean))
      await ensureCaptureDestination(source, outDir, { create: false });
    results.push(
      await compareScenario({
        scenario,
        liveDir,
        mirageDir,
        secondDir,
        allowlist,
        changes,
        origins: [matrix.origin, siteOriginPlaceholder(matrix.origin)].filter(Boolean),
      }),
    );
  }
  // Evidence age is decided once every scenario is compared: the proof scenarios of each change are checked here.
  if (changes.length) report.evidenceChanges = finalizeEvidenceChanges(results, changes);
  for (const result of results) {
    await ensureCaptureDestination(path.join(outDir, ...result.id.split('/')), outDir, { files: ['diff.json'] });
    await fs.writeFile(path.join(outDir, ...result.id.split('/'), 'diff.json'), JSON.stringify(result, null, 2));
    report.scenarios.push({
      id: result.id,
      verdict: result.verdict,
      counts: result.counts,
      signatures: result.signatures,
      reason: result.reason,
    });
    console.log(
      JSON.stringify({ scenario: result.id, verdict: result.verdict, counts: result.counts, reason: result.reason }),
    );
  }
  Object.assign(report, summarize(report));
  await ensureCaptureDestination(outDir, outDir, { files: ['report.json', 'summary.md'] });
  await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(outDir, 'summary.md'), summaryMarkdown(report));
  console.log(
    JSON.stringify({
      report: path.join(outDir, 'report.json'),
      totals: report.totals,
      topSignatures: report.bySignature.slice(0, 10),
    }),
  );
  process.exitCode = report.totals.fail || report.totals.error ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
