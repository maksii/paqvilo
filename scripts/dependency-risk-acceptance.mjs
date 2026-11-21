import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// dependency-risk-acceptance.json holds at most one owner-approved, time-limited acceptance pinned to exact development
// graphs; the empty object `{}` means no acceptance is in force. The clock and policy parameters are in-memory only for
// policy tests. The CLI never takes a time or policy override.
const livePolicy = JSON.parse(fs.readFileSync(new URL('./dependency-risk-acceptance.json', import.meta.url), 'utf8'));
const pinnedHashes = ['manifestSha256', 'lockSha256', 'findingGraphSha256', 'normalizedSecurityReportSha256'];

// The acceptance in force, or null for `{}`. Anything else that is not a complete entry throws, so it fails the audit.
function acceptanceInForce(policy) {
  if (object(policy) && Object.keys(policy).length === 0) return null;
  if (
    !object(policy) ||
    typeof policy.advisory !== 'string' ||
    !policy.advisory ||
    typeof policy.approvedOn !== 'string' ||
    !policy.approvedOn ||
    typeof policy.approval !== 'string' ||
    !policy.approval ||
    !Number.isFinite(Date.parse(policy.expiresAt)) ||
    !Number.isFinite(Date.parse(policy.evidenceCapturedAt)) ||
    !object(policy.projects) ||
    Object.keys(policy.projects).length === 0 ||
    Object.values(policy.projects).some(
      (entry) => !object(entry) || pinnedHashes.some((key) => !/^[0-9a-f]{64}$/.test(entry[key] ?? '')),
    )
  )
    throw new Error('Invalid scripts/dependency-risk-acceptance.json: use {} or one complete pinned acceptance.');
  return policy;
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Cryptographic fingerprints retain UTF-16 ordinal key order, independently of the host locale.
function compareCanonicalKeys(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareCanonicalKeys)
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
};
const fingerprint = (value) => sha256(JSON.stringify(canonical(value)));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const severities = ['info', 'low', 'moderate', 'high', 'critical'];
const versionCore = '(0|[1-9][0-9]*)';
const recommendationVersion = new RegExp(
  String.raw`^${versionCore}\.${versionCore}\.${versionCore}(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`,
);

function validRecommendationVersion(version) {
  if (typeof version !== 'string' || version.length > 256) return false;
  const match = recommendationVersion.exec(version);
  if (!match) return false;
  return (
    match.slice(1, 4).every((part) => Number.isSafeInteger(Number(part))) &&
    (match[4]?.split('.').every((part) => !/^0\d+$/.test(part)) ?? true)
  );
}

function isAffectedAncestor(vulnerabilities, name, target) {
  const pending = [name];
  const seen = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (seen.has(current) || !Object.hasOwn(vulnerabilities, current)) continue;
    seen.add(current);
    const finding = vulnerabilities[current];
    // A direct finding can recommend its own top-level package (the zero-length ancestor path).
    if (current === target && finding.isDirect === true) return true;
    pending.push(...finding.effects);
  }
  return false;
}

function normalizedSecurityReport(report) {
  const normalized = structuredClone(report);
  for (const [name, finding] of Object.entries(normalized.vulnerabilities)) {
    const hint = finding.fixAvailable;
    if (!object(hint)) continue;
    if (!validRecommendationVersion(hint.version) || !isAffectedAncestor(normalized.vulnerabilities, name, hint.name))
      throw new Error('Invalid or unrelated npm remediation recommendation.');
    // npm propagates one top-level remediation hint by traversal order. It is not an installed package version.
    // Preserve object/boolean state, isSemVerMajor, unknown properties and every other report field exactly.
    hint.name = '<affected-ancestor-recommendation>';
    hint.version = '<semver-recommendation>';
  }
  return normalized;
}

export function validateAuditReport(report, status) {
  if (!object(report) || report.error || report.auditReportVersion !== 2 || !object(report.vulnerabilities))
    throw new Error('Dependency audit unavailable: invalid or missing audit report.');
  const counts = report.metadata?.vulnerabilities;
  const dependencies = report.metadata?.dependencies;
  if (
    !object(counts) ||
    [...severities, 'total'].some((key) => !Number.isSafeInteger(counts[key]) || counts[key] < 0) ||
    counts.total !== severities.reduce((total, key) => total + counts[key], 0) ||
    counts.total !== Object.keys(report.vulnerabilities).length
  )
    throw new Error('Dependency audit unavailable: inconsistent vulnerability counts.');
  if (
    !object(dependencies) ||
    ['prod', 'dev', 'optional', 'peer', 'peerOptional', 'total'].some(
      (key) => !Number.isSafeInteger(dependencies[key]) || dependencies[key] < 0,
    )
  )
    throw new Error('Dependency audit unavailable: invalid or missing dependency counts.');
  for (const severity of severities)
    if (
      Object.values(report.vulnerabilities).filter((finding) => finding?.severity === severity).length !==
      counts[severity]
    )
      throw new Error('Dependency audit unavailable: inconsistent severity counts.');
  if (status !== (counts.total > 0 ? 1 : 0))
    throw new Error(`Dependency audit failed: unexpected audit exit status ${status}.`);
}

export function readAuditInputs(rootDirectory, project) {
  const cwd = path.resolve(rootDirectory, project);
  const manifest = fs.readFileSync(path.join(cwd, 'package.json'));
  const lock = fs.readFileSync(path.join(cwd, project === '.' ? 'paqvilo-lock.json' : 'package-lock.json'));
  // npm audits the generated file; bind those exact bytes to the repository's canonical root lock before spawning it.
  const auditedLock = project === '.' ? fs.readFileSync(path.join(cwd, 'package-lock.json')) : lock;
  if (!auditedLock.equals(lock))
    throw new Error('Generated root package-lock.json differs from canonical paqvilo-lock.json.');
  return { manifest, lock, auditedLock };
}

export function unchangedAuditInputs(before, after) {
  return ['manifest', 'lock', 'auditedLock'].every((key) => before[key].equals(after[key]));
}

export function matchesApprovedRiskInputs(project, evidence, policy = livePolicy) {
  const accepted = acceptanceInForce(policy);
  const expected = accepted !== null && Object.hasOwn(accepted.projects, project) && accepted.projects[project];
  return Boolean(
    expected &&
    Buffer.isBuffer(evidence?.manifest) &&
    Buffer.isBuffer(evidence.lock) &&
    Buffer.isBuffer(evidence.auditedLock) &&
    evidence.auditedLock.equals(evidence.lock) &&
    sha256(evidence.manifest) === expected.manifestSha256 &&
    sha256(evidence.lock) === expected.lockSha256,
  );
}

function findingGraph(report, manifest, lockfile) {
  return Object.fromEntries(
    Object.entries(report.vulnerabilities).map(([name, finding]) => {
      const nodes = finding.nodes.map((location) => {
        const entry = lockfile.packages[location];
        if (entry?.dev !== true) throw new Error('A finding has a missing or production dependency node.');
        return {
          location,
          version: entry.version,
          dev: entry.dev,
          optional: entry.optional ?? false,
          resolved: entry.resolved,
          integrity: entry.integrity,
          dependencies: entry.dependencies ?? {},
          peerDependencies: entry.peerDependencies ?? {},
        };
      });
      if (manifest.dependencies?.[name] !== undefined) throw new Error('A finding is a direct production dependency.');
      return [
        name,
        {
          severity: finding.severity,
          isDirect: finding.isDirect,
          nodes,
          via: finding.via,
          effects: finding.effects,
          range: finding.range,
          directProjectDevSpec: manifest.devDependencies?.[name] ?? null,
          directProjectProductionSpec: manifest.dependencies?.[name] ?? null,
        },
      ];
    }),
  );
}

export function temporaryRiskAcceptance(
  project,
  report,
  status,
  evidence,
  { now = Date.now, policy = livePolicy } = {},
) {
  const reject = (reason) => ({ accepted: false, reason });
  try {
    if (acceptanceInForce(policy) === null) return reject('no temporary risk acceptance is in force');
    const expected = Object.hasOwn(policy.projects, project) && policy.projects[project];
    if (!expected) return reject('project is outside the approved temporary scope');
    validateAuditReport(report, status);
    const currentTime = now();
    const capturedAt = Date.parse(policy.evidenceCapturedAt);
    const expiresAt = Date.parse(policy.expiresAt);
    if (
      typeof currentTime !== 'number' ||
      !Number.isFinite(currentTime) ||
      !Number.isFinite(capturedAt) ||
      !Number.isFinite(expiresAt) ||
      currentTime < capturedAt ||
      currentTime >= expiresAt
    )
      return reject('temporary acceptance expired or current UTC time evidence is invalid');
    if (!matchesApprovedRiskInputs(project, evidence, policy))
      return reject('manifest, canonical lock or actual audited lock differs from the approved bytes');
    const manifest = JSON.parse(evidence.manifest);
    const lockfile = JSON.parse(evidence.lock);
    const graph = findingGraph(report, manifest, lockfile);
    if (fingerprint(graph) !== expected.findingGraphSha256)
      return reject('finding nodes, development flags, versions or dependency/advisory graph changed');
    // The installed graph was checked above before using its effects to validate recommendation ancestry.
    // Normalize only the two non-installed hint values; all metadata, advisory objects and hint state remain bound.
    if (fingerprint(normalizedSecurityReport(report)) !== expected.normalizedSecurityReportSha256)
      return reject('current audit report differs from the approved advisory and report metadata');
    return {
      accepted: true,
      names: Object.keys(report.vulnerabilities),
      message: `${policy.advisory}: TEMPORARY RISK ACCEPTANCE (not fixed); user-approved ${policy.approvedOn}; expires ${policy.expiresAt}; exact development graph only.`,
    };
  } catch (error) {
    return reject(error.message);
  }
}
