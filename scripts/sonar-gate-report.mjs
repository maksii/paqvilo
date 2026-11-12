import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readApi } from './verify-sonar-branch.mjs';

const MAX_LINE = 299;
const MAX_MESSAGE = 200;

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function oneLine(value) {
  return String(value ?? '-').replace(/\s+/g, ' ');
}

function unexpectedShape() {
  return new Error('Sonar API returned an unexpected shape.');
}

// readApi errors carry fixed messages without the host or token; keep only the reason.
function readReason(error) {
  return error.message.replace(/^Sonar API (returned )?/, '').replace(/\.$/, '');
}

function finding(rule, component, line, message, projectKey) {
  const prefix = `${projectKey}:`;
  const location = oneLine(component);
  const file = location.startsWith(prefix) ? location.slice(prefix.length) : location;
  return clip(`  ${oneLine(rule)} ${file}:${oneLine(line)} ${clip(oneLine(message), MAX_MESSAGE)}`, MAX_LINE);
}

function conditionLine(condition) {
  const comparison = `${oneLine(condition.comparator)} ${oneLine(condition.errorThreshold)}`;
  return `  FAILED ${oneLine(condition.metricKey)}: actual ${oneLine(condition.actualValue)}, ${comparison}`;
}

async function gateLines(call, projectKey) {
  const data = await call('api/qualitygates/project_status', { projectKey });
  const gate = data?.projectStatus;
  if (typeof gate?.status !== 'string' || !Array.isArray(gate.conditions)) throw unexpectedShape();
  const failed = gate.conditions.filter((condition) => condition.status !== 'OK').map(conditionLine);
  return [`Quality gate: ${gate.status}`, ...failed];
}

async function issueLines(call, projectKey) {
  const data = await call('api/issues/search', {
    components: projectKey,
    inNewCodePeriod: 'true',
    issueStatuses: 'OPEN,CONFIRMED',
    ps: 100,
    s: 'FILE_LINE',
  });
  if (!Number.isSafeInteger(data?.total) || !Array.isArray(data.issues)) throw unexpectedShape();
  const items = data.issues.map((issue) => finding(issue.rule, issue.component, issue.line, issue.message, projectKey));
  return [`Open issues in new code: ${data.total}`, ...items];
}

async function hotspotLines(call, projectKey) {
  const data = await call('api/hotspots/search', {
    project: projectKey,
    inNewCodePeriod: 'true',
    status: 'TO_REVIEW',
    ps: 100,
  });
  if (!Number.isSafeInteger(data?.paging?.total) || !Array.isArray(data.hotspots)) throw unexpectedShape();
  const items = data.hotspots.map((hotspot) =>
    finding(hotspot.ruleKey ?? hotspot.securityCategory, hotspot.component, hotspot.line, hotspot.message, projectKey),
  );
  return [`Security hotspots to review in new code: ${data.paging.total}`, ...items];
}

async function section(endpoint, build) {
  try {
    return await build();
  } catch (error) {
    return [clip(`  (could not read ${endpoint}: ${readReason(error)})`, MAX_LINE)];
  }
}

/** Lines describing why a quality gate failed: its conditions, the open issues and the hotspots to review in new code. */
export async function sonarGateReport({ base, token, project, branch = null, pullRequest = null, fetchImpl = fetch }) {
  if ((branch === null) === (pullRequest === null))
    throw new Error('Sonar gate report needs exactly one branch or pull request.');
  const root = new URL(base.endsWith('/') ? base : `${base}/`);
  const scope = pullRequest === null ? { branch } : { pullRequest };
  const call = (endpoint, query) => readApi(root, token, endpoint, { ...query, ...scope }, fetchImpl);
  const parts = await Promise.all([
    section('api/qualitygates/project_status', () => gateLines(call, project)),
    section('api/issues/search', () => issueLines(call, project)),
    section('api/hotspots/search', () => hotspotLines(call, project)),
  ]);
  return parts.flat();
}

async function projectKey() {
  const text = await readFile('sonar-project.properties', 'utf8');
  const match = /^sonar\.projectKey=(.+)$/m.exec(text);
  if (!match) throw new Error('sonar-project.properties has no sonar.projectKey.');
  return match[1].trim();
}

async function main() {
  const host = process.env.SONAR_HOST_URL;
  const token = process.env.SONAR_TOKEN;
  if (!host || !token) {
    console.log('Sonar gate report skipped: no server credentials in this run.');
    return;
  }
  const lines = await sonarGateReport({
    base: host,
    token,
    project: await projectKey(),
    branch: process.env.SONAR_BRANCH || null,
    pullRequest: process.env.SONAR_PULL_REQUEST || null,
  });
  for (const line of lines) console.log(line);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.log(`Sonar gate report could not run: ${error.message}`);
  }
}
