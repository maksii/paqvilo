import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const registry = 'https://registry.npmjs.org/';
const core = '(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)';
const stablePattern = new RegExp(`^${core}$`);
// Only versions created by our immutable branch-preview publisher are disposable.
const previewPattern = new RegExp(`^${core}-preview\\.([a-z0-9-]+-[a-f0-9]{8})\\.([1-9][0-9]*)\\.g[a-f0-9]{12}$`);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const compareCore = (left, right) => {
  for (let i = 1; i <= 3; i++) {
    const a = BigInt(left[i]), b = BigInt(right[i]);
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
};

export function retentionPlan(metadata, { keep = 3 } = {}) {
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > 100) throw new Error('keep must be an integer from 1 to 100.');
  if (!object(metadata) || metadata.name !== 'paqvilo' || !object(metadata.versions) || !object(metadata.time) || !object(metadata['dist-tags']))
    throw new Error('Expected complete paqvilo registry metadata.');
  const versions = Object.keys(metadata.versions), tags = metadata['dist-tags'];
  const stable = versions.map(version => ({ version, match: stablePattern.exec(version) })).filter(item => item.match)
    .sort((a, b) => compareCore(b.match, a.match));
  if (!stable.length || !stablePattern.test(tags.latest ?? '') || !versions.includes(tags.latest))
    throw new Error('A published stable latest version is required before preview cleanup.');
  const previews = versions.flatMap(version => {
    const match = previewPattern.exec(version);
    if (!match) return [];
    const published = Date.parse(metadata.time[version]);
    if (!Number.isFinite(published)) throw new Error(`Missing publication time for ${version}.`);
    const channel = `preview-${match[4]}`;
    // Preserve versions referenced by latest, next, custom tags or another branch's channel.
    const protectedTags = Object.entries(tags).filter(([tag, target]) => target === version && tag !== channel).map(([tag]) => tag);
    return [{ version, channel, published, released: compareCore(match, stable[0].match) <= 0, protectedTags }];
  }).sort((a, b) => b.published - a.published || b.version.localeCompare(a.version));
  // Protected previews count toward the cap; never silently delete custom-tag targets.
  const current = previews.filter(item => !item.released);
  const protectedCurrent = current.filter(item => item.protectedTags.length);
  const slots = Math.max(0, keep - protectedCurrent.length);
  const retained = new Set(current.filter(item => !item.protectedTags.length).slice(0, slots).map(item => item.version));
  const remove = [], preserve = [];
  for (const item of previews) {
    if (item.protectedTags.length) preserve.push({ version: item.version, reason: 'protected-tag', tags: item.protectedTags });
    else if (item.released) remove.push({ version: item.version, reason: 'stable-released' });
    else if (!retained.has(item.version)) remove.push({ version: item.version, reason: 'preview-limit' });
    else preserve.push({ version: item.version, reason: 'recent-preview' });
  }
  return { package: 'paqvilo', keep, newestStable: stable[0].version, remove, preserve,
    preservedOtherVersions: versions.filter(version => !previewPattern.test(version)),
    warnings: preserve.some(item => item.reason === 'protected-tag') ? ['Custom tags protect previews from removal; the cap may be exceeded.'] : [] };
}

export async function readRegistry() {
  const response = await fetch(`${registry}paqvilo?write=true`, { signal: AbortSignal.timeout(30_000), headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } });
  if (!response.ok) throw new Error(`Registry metadata request failed (${response.status}).`);
  return response.json();
}

function npm(args) {
  // execFile avoids shell interpolation; npm_execpath is available under npm run.
  const cli = process.env.npm_execpath;
  if (!cli || !fs.existsSync(cli)) throw new Error('Run through npm run preview:cleanup so the npm CLI is available.');
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  try {
    return execFileSync(process.execPath, [cli, ...args, `--registry=${registry}`, '--ignore-scripts'],
      { encoding: 'utf8', windowsHide: true, timeout: 120_000, stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // Never echo npm configuration, authentication details or full child-process errors.
    const code = /(?:npm (?:error|ERR!) code )([A-Z0-9_]+)/.exec(error.stderr ?? '')?.[1] ?? 'FAILED';
    throw new Error(`npm ${args[0]} failed (${code}). Check maintenance authentication, 2FA and npm's unpublish policy.`, { cause: undefined });
  }
}

export async function prunePreviews({ keep = 3, apply = false, read = readRegistry, runNpm = npm, report = () => {} } = {}) {
  if (typeof apply !== 'boolean') throw new Error('apply must be a boolean.');
  const plan = retentionPlan(await read(), { keep });
  report(plan);
  const removed = [], skipped = [];
  if (!apply || !plan.remove.length) return { ...plan, applied: false, removed, skipped };
  // Test permission with the intended exact-version operation instead of using
  // whoami as an unpublish permission probe.
  for (const candidate of plan.remove) {
    // A fresh plan protects newly tagged versions and concurrent publications.
    const current = retentionPlan(await read(), { keep });
    if (!current.remove.some(item => item.version === candidate.version)) { skipped.push(candidate.version); continue; }
    runNpm(['unpublish', `paqvilo@${candidate.version}`]);
    const after = await read();
    if (Object.hasOwn(after.versions, candidate.version)) throw new Error(`Registry still lists ${candidate.version}; cleanup stopped. npm can return success after a rejected HTTP 404 write. Check maintenance access and registry propagation before retrying.`);
    removed.push(candidate.version);
    report({ removed: candidate.version });
  }
  return { ...plan, applied: true, removed, skipped };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let keep = 3, apply = false;
    for (let i = 2; i < process.argv.length; i++) {
      if (process.argv[i] === '--apply') apply = true;
      else if (process.argv[i] === '--keep' && /^[1-9][0-9]*$/.test(process.argv[i + 1] ?? '')) keep = Number(process.argv[++i]);
      else throw new Error('Usage: npm run preview:cleanup -- [--keep 3] [--apply]');
    }
    const result = await prunePreviews({ keep, apply, report: value => console.log(JSON.stringify(value, null, 2)) });
    console.log(JSON.stringify({ applied: result.applied, candidates: result.remove.length, removed: result.removed.length, skipped: result.skipped.length }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
