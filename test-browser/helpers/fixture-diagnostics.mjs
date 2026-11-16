// Explicit synthetic fixture registrations publish typed diagnostics, never whole report/state/profile trees.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readOwnedFixtureBytes, redactFixtureText } from './verify-evidence.mjs';

export const FIXTURE_DIAGNOSTIC_MARKER = '.paqvilo-fixture-diagnostics.json';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const list = (value, maximum = 200) => (Array.isArray(value) ? value.slice(0, maximum) : []);
const primitive = (value) =>
  typeof value === 'string'
    ? redactFixtureText(value)
    : typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
      ? value
      : undefined;
const location = (value) => redactFixtureText(value).replace(/[?#].*$/, '');
const select = (value, keys) => {
  const selected = Object.fromEntries(
    keys.flatMap((key) =>
      primitive(value?.[key]) === undefined
        ? []
        : [
            [
              key,
              ['path', 'url', 'where', 'finalUrl', 'origin'].includes(key) && typeof value[key] === 'string'
                ? location(value[key])
                : primitive(value[key]),
            ],
          ],
    ),
  );
  const truncatedFields = keys.filter((key) => typeof value?.[key] === 'string' && value[key].length > 4000);
  return truncatedFields.length ? { ...selected, truncatedFields } : selected;
};
const limits = (value, maximum) => ({
  total: Array.isArray(value) ? value.length : 0,
  retained: list(value, maximum).length,
  truncated: Array.isArray(value) && value.length > maximum,
});
const decode = (bytes) => {
  try {
    return JSON.parse(bytes);
  } catch {
    throw new Error('Malformed synthetic fixture diagnostic');
  }
};
function loopbackOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('A synthetic fixture requires a loopback origin');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('A synthetic fixture requires a credential-free loopback origin');
  return url.origin;
}
function marker(value) {
  if (
    value?.schemaVersion !== 1 ||
    value.synthetic !== true ||
    !['acceptance', 'model-driven'].includes(value.kind) ||
    !Array.isArray(value.reportRoots) ||
    !value.reportRoots.length ||
    value.reportRoots.length > 2 ||
    Object.keys(value).some((key) => !['schemaVersion', 'synthetic', 'kind', 'origin', 'reportRoots'].includes(key))
  )
    throw new Error('Invalid synthetic fixture registration');
  const allowed = value.kind === 'model-driven' ? ['report.json'] : ['evidence', 'failed-evidence'];
  if (
    value.reportRoots.some((name) => !allowed.includes(name)) ||
    new Set(value.reportRoots).size !== value.reportRoots.length
  )
    throw new Error('Unapproved synthetic fixture report root');
  return { ...value, origin: loopbackOrigin(value.origin) };
}
function ownedRoot(directory) {
  const root = fs.realpathSync.native(directory);
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink())
    throw new Error('Synthetic fixture root must be an ordinary directory');
  return root;
}
function publish(directory, name, bytes, replace = false) {
  fs.mkdirSync(directory, { recursive: true });
  const root = ownedRoot(directory);
  const stage = path.join(root, `.fixture-diagnostic-${randomUUID()}.tmp`);
  const fd = fs.openSync(stage, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (ownedRoot(directory) !== root) throw new Error('Synthetic fixture publication root changed');
    if (replace) fs.renameSync(stage, path.join(root, name));
    else fs.linkSync(stage, path.join(root, name));
  } finally {
    fs.rmSync(stage, { force: true });
  }
  return path.join(root, name);
}

/** Register before invoking the producer. The marker contains only typed relative paths and a loopback origin. */
export function registerFixtureDiagnostics({ fixtureRoot, kind, reportRoots, origin, outputRoot }) {
  const root = ownedRoot(fixtureRoot);
  let registered = marker({ schemaVersion: 1, synthetic: true, kind, reportRoots, origin });
  const existing = path.join(root, FIXTURE_DIAGNOSTIC_MARKER);
  if (fs.existsSync(existing)) {
    const earlier = marker(decode(readOwnedFixtureBytes(existing, root, 4096)));
    if (earlier.kind !== kind || earlier.origin !== registered.origin)
      throw new Error('Synthetic fixture producer identity changed');
    registered = marker({
      ...registered,
      reportRoots: [...new Set([...earlier.reportRoots, ...registered.reportRoots])],
    });
  }
  publish(root, FIXTURE_DIAGNOSTIC_MARKER, JSON.stringify(registered), true);
  return { fixtureRoot: root, outputRoot, ...registered };
}

function modelProjection(report, registration) {
  if (
    report?.kind !== 'model-driven-overlay' ||
    report.schemaVersion !== 1 ||
    loopbackOrigin(report.origin) !== registration.origin ||
    !Array.isArray(report.resources)
  )
    throw new Error('Unexpected synthetic model-driven report');
  return {
    ...select(report, [
      'kind',
      'schemaVersion',
      'revision',
      'applied',
      'currentRevisionApplied',
      'online',
      'localSimulation',
    ]),
    resources: list(report.resources).map((row) => ({
      ...select(row, ['name', 'mime', 'applied', 'currentRevisionApplied', 'paused']),
      paths: list(row.paths, 50)
        .filter((value) => typeof value === 'string')
        .map(location),
      pathsLimit: limits(row.paths, 50),
      sourceAttribution: select(row.sourceAttribution, ['state', 'reason']),
    })),
    diagnostics: list(report.diagnostics).map((row) => select(row, ['code', 'name', 'reason'])),
    unmatched: list(report.unmatched).map((row) => select(row, ['path', 'count'])),
    targets: list(report.targets).map((row) => select(row, ['id', 'origin', 'activated', 'applied'])),
    scriptProvenance: select(report.scriptProvenance, ['cachedAssets', 'bodyBytes', 'lineEntries']),
    collectionLimits: {
      resources: limits(report.resources, 200),
      diagnostics: limits(report.diagnostics, 200),
      unmatched: limits(report.unmatched, 200),
      targets: limits(report.targets, 200),
    },
  };
}
function acceptanceProjection(report, registration) {
  if (
    !report ||
    !Array.isArray(report.flows) ||
    typeof report.sourceFingerprint !== 'string' ||
    typeof report.implementationFingerprint !== 'string'
  )
    throw new Error('Unexpected synthetic acceptance report');
  for (const flow of report.flows) {
    if (flow.mode !== 'local') throw new Error('Only local synthetic acceptance diagnostics can be published');
    if (!flow.finalUrl || ['about:blank', 'nullblank', '<invalid URL>'].includes(flow.finalUrl)) continue;
    let final;
    try {
      final = new URL(flow.finalUrl);
    } catch {
      throw new Error('Unexpected synthetic acceptance document location');
    }
    if (final.username || final.password || final.origin !== registration.origin)
      throw new Error('Synthetic acceptance document left its registered origin');
  }
  return {
    ...select(report, ['passed', 'error', 'sourceChanged', 'implementationChanged']),
    flows: list(report.flows, 100).map((flow) => ({
      ...select(flow, ['name', 'mode', 'passed', 'error', 'screenshotError', 'auditError', 'finalUrl']),
      steps: list(flow.steps).map((step) => select(step, ['action', 'passed', 'status', 'durationMs', 'error'])),
      requests: list(flow.failedRequests).map((row) => select(row, ['method', 'url', 'status', 'failure', 'reason'])),
      pendingRequests: list(flow.pendingRequests).map((row) => select(row, ['method', 'url', 'status', 'elapsedMs'])),
      pageErrors: list(flow.pageErrors, 50)
        .filter((value) => typeof value === 'string')
        .map(redactFixtureText),
      consoleErrors: list(flow.consoleErrors, 50)
        .filter((value) => typeof value === 'string')
        .map(redactFixtureText),
      collectionLimits: {
        steps: limits(flow.steps, 200),
        failedRequests: limits(flow.failedRequests, 200),
        pendingRequests: limits(flow.pendingRequests, 200),
        pageErrors: limits(flow.pageErrors, 50),
        consoleErrors: limits(flow.consoleErrors, 50),
      },
    })),
    collectionLimits: { flows: limits(report.flows, 100) },
  };
}
function auxiliaryProjection(directory, index) {
  const result = {};
  for (const [kind, name] of [
    ['audit', `${index}-request-audit.json`],
    ['network', `${index}-browser-network.json`],
  ]) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) continue;
    const value = decode(readOwnedFixtureBytes(file, directory, 4 * 1024 * 1024));
    if (kind === 'audit') {
      const entries = Array.isArray(value.items) ? value.items : Array.isArray(value.events) ? value.events : [];
      result.audit = {
        ...limits(entries, 200),
        items: list(entries).map((row) =>
          select(row, [
            'kind',
            'operation',
            'method',
            'path',
            'url',
            'status',
            'durationMs',
            'elapsedMs',
            'rowCount',
            'outcome',
            'reason',
            'provider',
          ]),
        ),
      };
    } else
      result.network = {
        records: list(value.records).map((row) =>
          select(row, [
            'method',
            'path',
            'status',
            'type',
            'mimeType',
            'startedAt',
            'startedTimestamp',
            'finishedTimestamp',
            'failed',
            'failure',
            'error',
            'errorText',
            'cancelled',
            'handedOff',
          ]),
        ),
        frameEvents: list(value.frameEvents).map((row) => select(row, ['event', 'observedAt', 'reason'])),
        collectionLimits: { records: limits(value.records, 200), frameEvents: limits(value.frameEvents, 200) },
      };
  }
  return result;
}
function reportDirectories(root, registration) {
  if (registration.kind === 'model-driven') return [root];
  return registration.reportRoots.flatMap((name) => {
    const parent = path.join(root, name);
    if (!fs.existsSync(parent)) return [];
    if (ownedRoot(parent) !== parent) throw new Error('Synthetic acceptance output escaped its fixture');
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && !entry.isSymbolicLink() && /^\d{4}-\d{2}-\d{2}T\d{9}Z$/.test(entry.name),
      )
      .slice(0, 100)
      .map((entry) => path.join(parent, entry.name));
  });
}

/** Called only for the registered fixture, after its producer settled or by the lab after its child stopped. */
export function recoverFixtureDiagnostics({ fixtureRoot, outputRoot }) {
  const root = ownedRoot(fixtureRoot);
  const registration = marker(decode(readOwnedFixtureBytes(path.join(root, FIXTURE_DIAGNOSTIC_MARKER), root, 4096)));
  const files = [];
  let reports = 0;
  for (const directory of reportDirectories(root, registration)) {
    if (
      ownedRoot(directory) !== directory ||
      !path
        .relative(root, directory)
        .split(path.sep)
        .every((part) => part !== '..')
    )
      throw new Error('Synthetic report directory escaped its fixture');
    const file = path.join(directory, 'report.json');
    if (!fs.existsSync(file)) continue;
    const report = decode(readOwnedFixtureBytes(file, directory, 4 * 1024 * 1024));
    const projection =
      registration.kind === 'model-driven'
        ? modelProjection(report, registration)
        : acceptanceProjection(report, registration);
    if (registration.kind === 'acceptance')
      projection.flows = projection.flows.map((flow, index) => ({
        ...flow,
        ...auxiliaryProjection(directory, index + 1),
      }));
    const diagnostic = {
      synthetic: true,
      kind: 'fixture-diagnostic',
      producer: registration.kind,
      origin: registration.origin,
      complete: true,
      reportWritten: true,
      report: projection,
      screenshots: [],
    };
    const destination = path.join(outputRoot, 'fixture-diagnostics');
    const declaredImages =
      registration.kind === 'acceptance'
        ? [...new Set(report.flows.flatMap((flow) => list(flow.screenshots, 100)))]
        : [];
    if (declaredImages.length > 100) throw new Error('Synthetic acceptance screenshot count exceeds its bound');
    for (const declared of declaredImages) {
      if (typeof declared !== 'string') throw new Error('Unexpected synthetic acceptance screenshot declaration');
      const image = path.basename(declared);
      if (!/^[a-zA-Z0-9_-]+\.png$/.test(image) || path.resolve(directory, declared) !== path.join(directory, image))
        throw new Error('Synthetic acceptance screenshot escaped its registered report');
      const bytes = readOwnedFixtureBytes(path.join(directory, image), directory, 20 * 1024 * 1024);
      if (!bytes.subarray(0, PNG.length).equals(PNG)) throw new Error('Synthetic fixture screenshot is not a PNG');
      const name = `${randomUUID().replaceAll('-', '')}-failure.png`;
      files.push(publish(destination, name, bytes));
      diagnostic.screenshots.push({
        file: name,
        stage: image.endsWith('-failure.png') ? 'failure' : image.endsWith('-final.png') ? 'final' : 'step',
      });
    }
    files.push(
      publish(
        destination,
        `${randomUUID().replaceAll('-', '')}-diagnostic.json`,
        JSON.stringify(diagnostic, null, 2) + '\n',
      ),
    );
    reports++;
  }
  if (!reports)
    files.push(
      publish(
        path.join(outputRoot, 'fixture-diagnostics'),
        `${randomUUID().replaceAll('-', '')}-diagnostic.json`,
        JSON.stringify(
          {
            synthetic: true,
            kind: 'fixture-diagnostic',
            producer: registration.kind,
            origin: registration.origin,
            complete: false,
            reportWritten: false,
            report: null,
            missingReason: 'report-not-written',
          },
          null,
          2,
        ) + '\n',
      ),
    );
  return { files, reports };
}

export function finalizeFixtureDiagnostics(registration, signal) {
  return { ...recoverFixtureDiagnostics(registration), canRemove: !signal?.aborted };
}
