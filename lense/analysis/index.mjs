import { createHash } from 'node:crypto';
import { collectAnalysisInputs, ANALYSIS_LIMITS } from './inventory.mjs';
import { recordRules, analyzeRecords } from './record-rules.mjs';
import { contentRules, analyzeContent } from './content-rules.mjs';
import { analysisSources } from './sources.mjs';
import { dataverseRules, analyzeDataverse } from './dataverse-rules.mjs';
import { appRules, analyzeApps } from './app-rules.mjs';
import { flowRules, analyzeFlows } from './flow-rules.mjs';
import { capabilityCoverage } from './capabilities.mjs';
import { nativeRules, analyzeNative } from './native-rules.mjs';

const sourceRule = {
  id: 'PAQ-SOURCE-001',
  title: 'Unparsed source metadata',
  severity: 'error',
  category: 'reliability',
  confidence: 'high',
  message: 'Export metadata could not be parsed; dependent checks are incomplete.',
  remediation: 'Correct source syntax and rerun analysis. Diagnostic output deliberately omits source values.',
  references: ['https://maksii.github.io/paqvilo/'],
};
const payloadRule = {
  id: 'PAQ-SOURCE-002',
  title: 'Enhanced record payload unavailable',
  severity: 'warning',
  category: 'reliability',
  confidence: 'high',
  message:
    'The XML envelope is readable, but its record payload is absent, empty or unsupported; dependent checks are incomplete.',
  remediation:
    'Check the export format and record availability. Retain incomplete coverage for withheld settings; do not disclose or invent secret values.',
  references: ['https://maksii.github.io/paqvilo/'],
};
export const analysisRules = Object.freeze(
  [
    sourceRule,
    payloadRule,
    ...recordRules,
    ...contentRules,
    ...dataverseRules,
    ...appRules,
    ...flowRules,
    ...nativeRules,
  ].map((rule) =>
    Object.freeze({
      ...rule,
      domain: rule.domain ?? ruleDomain(rule.id),
      references: Object.freeze([...rule.references]),
    }),
  ),
);
const byId = new Map(analysisRules.map((rule) => [rule.id, rule]));
const rank = { none: 0, error: 3, warning: 2, hint: 1 };

function ruleDomain(id) {
  const domains = [
    ['PP-', 'power-pages'],
    ['content.', 'web-content'],
    ['DV-', 'dataverse'],
    ['APP-PCF-', 'pcf'],
    ['APP-CANVAS-', 'canvas'],
    ['APP-CODE-', 'code-apps'],
    ['APP-DEPS-', 'project-dependencies'],
    ['FLOW-', 'flows'],
    ['CONN-', 'connectors'],
    ['MCP-', 'mcp-apps'],
    ['NATIVE-', 'mobile-extension'],
    ['MOBILE-', 'mobile-apps'],
  ];
  return domains.find(([prefix]) => id.startsWith(prefix))?.[1] ?? 'source';
}

export function validateAnalysisPolicy(failOn) {
  if (!Object.hasOwn(rank, failOn))
    throw Object.assign(new Error('--fail-on must be none, error, warning or hint'), { code: 'invalid_argument' });
  return failOn;
}

const lineIndexes = new WeakMap();
function contentPosition(source, offset) {
  if (typeof offset !== 'number') return { line: 1, column: 1 };
  let starts = lineIndexes.get(source);
  if (!starts) {
    starts = [0];
    for (let index = 0; index < source.text.length; index++) if (source.text[index] === '\n') starts.push(index + 1);
    lineIndexes.set(source, starts);
  }
  let low = 0,
    high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle;
    else high = middle;
  }
  return { line: low + 1, column: offset - starts[low] + 1 };
}
function findingLocation(source, field, offset) {
  const base = source.fieldLocations?.[field] ?? { line: source.line ?? 1, column: source.column ?? 1 };
  const content = contentPosition(source, offset);
  const approximate = source.exactLocation === false;
  const identity = source.recordId ?? source.fields?.id ?? source.fields?.[`${source.kind}id`];
  const exactColumn = content.line > 1 ? content.column : base.column + content.column - 1;
  return {
    file: source.file,
    line: approximate ? base.line : base.line + content.line - 1,
    column: approximate ? base.column : exactColumn,
    ...((field ?? source.field) ? { field: field ?? source.field } : {}),
    ...(approximate && typeof offset === 'number' ? { contentLine: content.line, contentColumn: content.column } : {}),
    exactLocation: !approximate,
    ...(typeof identity === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(identity)
      ? { recordId: identity.toLowerCase() }
      : {}),
  };
}

/** Independent offline review; findings describe source evidence, never deployed behavior. */
export function analyzeProject(sourceDir, { failOn = 'error', limits = ANALYSIS_LIMITS, sourceRoots } = {}) {
  validateAnalysisPolicy(failOn);
  const input = collectAnalysisInputs(sourceRoots ?? [{ path: sourceDir, id: 'source' }], limits);
  limits = input.limits;
  const findings = [],
    seen = new Set();
  let truncated = false;
  const emit = (ruleId, source, field, offset) => {
    if (truncated) return;
    const rule = byId.get(ruleId);
    if (!rule) throw new Error(`Unknown analysis rule: ${ruleId}`);
    const location = findingLocation(source, field, offset);
    const key = JSON.stringify([ruleId, location]);
    if (seen.has(key)) return;
    if (findings.length >= limits.files) {
      truncated = true;
      return;
    }
    seen.add(key);
    findings.push({
      id: createHash('sha256').update(key).digest('hex').slice(0, 24),
      ruleId,
      severity: rule.severity,
      category: rule.category,
      confidence: rule.confidence,
      domain: rule.domain,
      ...location,
      message: rule.message,
      remediation: rule.remediation,
      references: rule.references,
    });
  };
  for (const source of input.syntax) emit(sourceRule.id, source);
  for (const source of input.incomplete) emit(payloadRule.id, source);
  analyzeRecords(input.records, emit);
  input.skipped.push(...analyzeContent(input.units, emit));
  const adapters = [
    analyzeDataverse(input.inputs, emit),
    analyzeApps(input.inputs, emit),
    analyzeFlows(input.inputs, emit),
    analyzeNative(input.inputs, emit),
  ];
  const domains = analysisDomains(input, adapters);
  const recognized =
    input.records.length +
    input.units.length +
    domains
      .filter((domain) => domain.domain !== 'power-pages' && domain.domain !== 'web-content')
      .reduce((sum, domain) => sum + (domain.recognized ?? 0), 0);
  if (!recognized && input.stats.files && input.complete)
    input.skipped.push({ file: '.', reason: 'no-recognized-platform-sources' });
  findings.sort(
    (a, b) =>
      a.file.localeCompare(b.file, 'en') ||
      a.line - b.line ||
      a.column - b.column ||
      a.ruleId.localeCompare(b.ruleId, 'en'),
  );
  const counts = { error: 0, warning: 0, hint: 0 };
  for (const finding of findings) counts[finding.severity]++;
  const complete =
    input.complete &&
    !truncated &&
    recognized > 0 &&
    domains.every((domain) => !domain.files || domain.complete !== false) &&
    adapters.every(
      (adapter) => adapter?.complete !== false && !adapter?.domains?.some((domain) => domain.complete === false),
    );
  const meetsThreshold = failOn !== 'none' && findings.some((finding) => rank[finding.severity] >= rank[failOn]);
  return {
    schemaVersion: 1,
    engine: 'paqvilo-static-analysis',
    offline: true,
    writesFiles: [],
    failOn,
    ready: failOn === 'none' || (complete && !meetsThreshold),
    complete,
    sourceDigest: input.sourceDigest,
    sources: analysisSources,
    scope:
      'Declared local Power Platform source roots and bounded in-memory Solution/Canvas packages; no project code, native tools or live services executed.',
    counts,
    findings,
    capabilities: capabilityCoverage(domains),
    coverage: {
      ...input.stats,
      records: input.records.length,
      contentUnits: input.units.length,
      limits,
      findingsTruncated: truncated,
      skipped: input.skipped,
      roots: input.roots,
      domains,
      availableRules: analysisRules.map((rule) => rule.id),
      evaluatedRules: evaluatedRuleIds(input, domains, findings),
      notPerformed: [
        ...new Set([
          'live-authorization',
          'rendered-accessibility',
          'javascript-dataflow',
          'solution-checker',
          'view-column-resolution',
          'deployment-version-verification',
          'native-app-build-and-compile',
          'native-mobile-device-and-host-tests',
          'flow-runs-and-connector-authentication',
          'tenant-governance-and-service-health',
          'business-process-metrics',
          ...adapters.flatMap((adapter) => adapter?.notPerformed ?? []),
        ]),
      ],
    },
  };
}

function evaluatedRuleIds(input, domains, findings) {
  const established = new Set(
    domains.filter((domain) => domain.recognized > 0 && domain.complete !== false).map((domain) => domain.domain),
  );
  if (input.records.length || input.syntax.length) established.add('source');
  if (
    ['pcf', 'code-apps', 'mobile-apps'].some((domain) => established.has(domain)) &&
    input.inputs.some((entry) => /(?:^|\/)package\.json$/i.test(entry.file))
  )
    established.add('project-dependencies');
  const reported = new Set(findings.map((finding) => finding.ruleId));
  return analysisRules.filter((rule) => established.has(rule.domain) || reported.has(rule.id)).map((rule) => rule.id);
}

function analysisDomains(input, adapters) {
  const domains = [
    {
      domain: 'power-pages',
      files: input.records.length,
      recognized: input.records.length,
      complete: input.complete,
      limitations: ['Effective permissions and rendered behavior require separate native evidence.'],
    },
    {
      domain: 'web-content',
      files: input.units.length,
      recognized: input.units.length,
      complete: input.complete && !input.skipped.some(({ reason }) => reason === 'html-structure-budget'),
      limitations: ['HTML/CSS checks do not identify the hosting platform or implement JavaScript dataflow analysis.'],
    },
  ];
  for (const adapter of adapters) {
    if (Array.isArray(adapter?.domains)) domains.push(...adapter.domains);
    else if (adapter?.domain) domains.push(adapter);
  }
  const canvasPackages = input.inputs.filter((entry) => entry.archive && entry.file.toLowerCase().endsWith('.msapp'));
  const canvasDomain = domains.find((domain) => domain.domain === 'canvas');
  if (canvasPackages.length && canvasDomain && !canvasDomain.files) {
    canvasDomain.files = canvasPackages.length;
    canvasDomain.complete = false;
    canvasDomain.limitations = [
      ...canvasDomain.limitations,
      'No supported Canvas source was inspected in the declared app packages.',
    ];
  }
  const missing = [
    'dataverse',
    'model-driven',
    'alm',
    'pcf',
    'canvas',
    'code-apps',
    'flows',
    'connectors',
    'mcp-apps',
    'mobile-apps',
    'mobile-extension',
  ];
  for (const domain of missing)
    if (!domains.some((item) => item.domain === domain))
      domains.push({
        domain,
        files: 0,
        recognized: 0,
        complete: true,
        limitations: ['No recognized local source for this domain was analyzed.'],
      });
  for (const domain of ['governance', 'process-intelligence'])
    domains.push({
      domain,
      files: 0,
      recognized: 0,
      complete: false,
      status: 'separate-evidence-required',
      limitations: ['Application exports cannot establish tenant state or business analytics.'],
    });
  return domains.map(normalizeDomain);
}

function normalizeDomain(domain) {
  let recognized = domain.recognized;
  if (typeof recognized === 'boolean') recognized = recognized ? domain.files : 0;
  let status = domain.status;
  if (!status) {
    status = 'not-detected';
    if (domain.files > 0 || recognized > 0)
      status = domain.complete === false || !recognized ? 'partial' : 'source-reviewed';
  }
  return { ...domain, recognized, status };
}
