import { createHash } from 'node:crypto';
import { collectAnalysisSources, ANALYSIS_LIMITS } from './inventory.mjs';
import { recordRules, analyzeRecords } from './record-rules.mjs';
import { contentRules, analyzeContent } from './content-rules.mjs';
import { analysisSources } from './sources.mjs';

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
export const analysisRules = Object.freeze(
  [sourceRule, ...recordRules, ...contentRules].map((rule) =>
    Object.freeze({ ...rule, references: Object.freeze([...rule.references]) }),
  ),
);
const byId = new Map(analysisRules.map((rule) => [rule.id, rule]));
const rank = { none: 0, error: 3, warning: 2, hint: 1 };

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
export function analyzeProject(sourceDir, { failOn = 'error', limits = ANALYSIS_LIMITS } = {}) {
  validateAnalysisPolicy(failOn);
  const input = collectAnalysisSources(sourceDir, limits);
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
      ...location,
      message: rule.message,
      remediation: rule.remediation,
      references: rule.references,
    });
  };
  for (const source of input.syntax) emit(sourceRule.id, source);
  analyzeRecords(input.records, emit);
  analyzeContent(input.units, emit);
  findings.sort(
    (a, b) =>
      a.file.localeCompare(b.file, 'en') ||
      a.line - b.line ||
      a.column - b.column ||
      a.ruleId.localeCompare(b.ruleId, 'en'),
  );
  const counts = { error: 0, warning: 0, hint: 0 };
  for (const finding of findings) counts[finding.severity]++;
  const complete = input.complete && !truncated;
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
      'Local portal record YAML, enhanced component XML, HTML/Liquid, CSS and JavaScript source files; deployment profiles, hidden state, dependencies and build output excluded.',
    counts,
    findings,
    coverage: {
      ...input.stats,
      records: input.records.length,
      contentUnits: input.units.length,
      limits,
      findingsTruncated: truncated,
      skipped: input.skipped,
      evaluatedRules: analysisRules.map((rule) => rule.id),
      notPerformed: [
        'live-authorization',
        'rendered-accessibility',
        'javascript-dataflow',
        'solution-checker',
        'view-column-resolution',
        'deployment-version-verification',
      ],
    },
  };
}
