// Validates the relationships in a Microsoft CDN evidence descriptor. This is not a network verifier:
// callers must independently bind the publisher reads and run data to genuine captured bytes and producers.
import { createHash } from 'node:crypto';

const SHA = /^[a-f0-9]{64}$/u;
const BASE = 'https://content.powerapps.com/resource/powerappsportal/controls/';
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const COMPONENT = /^[a-z0-9_]+$/u;
const IMMUTABLE = /^[A-Za-z0-9_-]+\.[a-f0-9]{10,64}(?:\.chunk)?\.js$/u;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const officialArtifactJsonSha256 = (value) => digest(JSON.stringify(value));
const validSize = (n) => Number.isSafeInteger(n) && n > 0;

function controlUrl(source) {
  if (typeof source !== 'string' || !source.startsWith(BASE)) return null;
  const path = source.slice(BASE.length);
  if (!path || /[%?#\\]/u.test(path)) return null;
  const parts = path.split('/');
  if (parts.length !== 2 || !COMPONENT.test(parts[0]) || !parts[1] || parts[1] === '.' || parts[1] === '..')
    return null;
  return { component: parts[0], name: parts[1] };
}
function entryUrl(path, component) {
  if (typeof path !== 'string' || !path.startsWith(`/${component}/`)) return null;
  const source = BASE + path.slice(1);
  const parsed = controlUrl(source);
  return parsed && IMMUTABLE.test(parsed.name) ? source : null;
}
function manifest(pkgManifest) {
  const parsed = controlUrl(pkgManifest?.source);
  if (!parsed || !SEMVER.test(pkgManifest.version) || parsed.name !== `manifest-${pkgManifest.version}.json`)
    return null;
  if (!SHA.test(pkgManifest.sha256) || typeof pkgManifest.bodyBase64 !== 'string') return null;
  const bytes = Buffer.from(pkgManifest.bodyBase64, 'base64');
  if (!bytes.length || bytes.toString('base64') !== pkgManifest.bodyBase64 || digest(bytes) !== pkgManifest.sha256)
    return null;
  let json;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json) || !Object.keys(json).length) return null;
  if (Object.hasOwn(json, 'hash')) {
    if (parsed.component !== 'host' || Object.keys(json).length !== 1) return null;
    const entry = entryUrl(json.hash, parsed.component);
    return entry ? { size: bytes.length, entries: [entry] } : null;
  }
  const entries = [];
  for (const [name, control] of Object.entries(json)) {
    if (
      !name ||
      !control ||
      typeof control !== 'object' ||
      Array.isArray(control) ||
      control.library !== parsed.component ||
      typeof control.control !== 'string' ||
      !/^\.\/\w+$/u.test(control.control)
    )
      return null;
    const entry = entryUrl(control.remoteEntry, parsed.component);
    if (!entry) return null;
    entries.push(entry);
  }
  return { size: bytes.length, entries };
}
function scriptKey(row) {
  return `${row.kind}\0${row.source}\0${row.sha256}\0${row.size}`;
}
function inventory(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const ids = new Set();
  for (const row of rows) {
    if (
      !row ||
      !['controls', 'other'].includes(row.kind) ||
      typeof row.source !== 'string' ||
      !row.source ||
      !SHA.test(row.sha256) ||
      !validSize(row.size) ||
      ids.has(row.source)
    )
      return null;
    if (row.kind === 'controls' && !controlUrl(row.source)) return null;
    if (row.kind === 'other' && (row.source.startsWith(BASE) || /[\r\n]/u.test(row.source))) return null;
    ids.add(row.source);
  }
  return new Set(rows.map(scriptKey));
}
/** Verify a scoped descriptor, published-read records and two independently bound offline runs. */
export function validateMicrosoftCdnArtifact(pkg, publisherReads, runs) {
  try {
    if (
      pkg?.ecosystem !== 'microsoft-cdn' ||
      pkg.id !== 'powerappsportal-controls' ||
      !Array.isArray(pkg.manifests) ||
      !pkg.manifests.length ||
      !Array.isArray(pkg.executedSourceClosure) ||
      !pkg.executedSourceClosure.length ||
      !Array.isArray(publisherReads) ||
      !Array.isArray(runs) ||
      runs.length !== 2
    )
      return false;
    const validatePublisher = () => {
      const expectedReads = new Map();
      const declared = new Set();
      for (const item of pkg.manifests) {
        const info = manifest(item);
        if (!info || expectedReads.has(item.source)) return false;
        expectedReads.set(item.source, { sha256: item.sha256, size: info.size });
        for (const entry of info.entries) declared.add(entry);
      }
      const assets = new Map();
      for (const item of pkg.executedSourceClosure) {
        const parsed = controlUrl(item?.source);
        if (
          !parsed ||
          !IMMUTABLE.test(parsed.name) ||
          !SHA.test(item.sha256) ||
          !validSize(item.size) ||
          expectedReads.has(item.source)
        )
          return false;
        assets.set(item.source, item);
        expectedReads.set(item.source, item);
      }
      const components = new Set([...assets.keys()].map((source) => controlUrl(source).component));
      for (const component of components)
        if (![...declared].some((entry) => assets.has(entry) && controlUrl(entry).component === component))
          return false;
      if (publisherReads.length !== expectedReads.size) return false;
      const seenReads = new Set();
      for (const read of publisherReads) {
        const expected = expectedReads.get(read?.source);
        if (
          !expected ||
          seenReads.has(read.source) ||
          read.status !== 200 ||
          read.finalUrl !== read.source ||
          read.sha256 !== expected.sha256 ||
          read.size !== expected.size
        )
          return false;
        seenReads.add(read.source);
      }
      return assets;
    };
    const assets = validatePublisher();
    if (!assets) return false;
    let previous;
    const validateRun = (run, previous) => {
      if (
        !run ||
        typeof run.id !== 'string' ||
        !run.id ||
        !SHA.test(run.producerSha256) ||
        !SHA.test(run.inputSha256) ||
        !SHA.test(run.resultSha256) ||
        !SHA.test(run.receiptSha256) ||
        !run.input ||
        !run.result ||
        !SHA.test(run.input.contextSha256) ||
        !SHA.test(run.result.sourceCaptureSha256)
      )
        return false;
      if (
        officialArtifactJsonSha256(run.input) !== run.inputSha256 ||
        officialArtifactJsonSha256(run.result) !== run.resultSha256 ||
        officialArtifactJsonSha256({
          id: run.id,
          producerSha256: run.producerSha256,
          inputSha256: run.inputSha256,
          resultSha256: run.resultSha256,
        }) !== run.receiptSha256
      )
        return false;
      const input = inventory(run.input.executedScripts),
        result = inventory(run.result.executedScripts);
      if (!input || !result || input.size !== result.size || [...input].some((key) => !result.has(key))) return false;
      const policy = run.result.networkPolicy;
      if (
        policy?.contextOffline !== true ||
        policy.proxyDeny !== true ||
        policy.allRequestsRouted !== true ||
        policy.serviceWorkersBlocked !== true ||
        policy.webSocketsDenied !== true ||
        policy.unexpectedNetwork !== 0
      )
        return false;
      const controls = run.input.executedScripts.filter((row) => row.kind === 'controls');
      if (controls.length !== assets.size || !run.input.executedScripts.some((row) => row.kind === 'other'))
        return false;
      for (const row of controls) {
        const asset = assets.get(row.source);
        if (!asset || asset.sha256 !== row.sha256 || asset.size !== row.size) return false;
      }
      if (
        previous &&
        (previous.id === run.id ||
          previous.receiptSha256 === run.receiptSha256 ||
          previous.result.sourceCaptureSha256 === run.result.sourceCaptureSha256 ||
          previous.producerSha256 !== run.producerSha256 ||
          previous.inputSha256 !== run.inputSha256)
      )
        return false;
      return true;
    };
    for (const run of runs) {
      if (!validateRun(run, previous)) return false;
      previous = run;
    }
    return true;
  } catch {
    return false;
  }
}
