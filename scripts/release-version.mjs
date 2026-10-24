import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const core = '(?:0|[1-9][0-9]*)';
const versionPattern = new RegExp(`^${core}\\.${core}\\.${core}(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
function baseVersion(version) {
  if (
    typeof version !== 'string' ||
    version.trim() !== version ||
    !versionPattern.test(version) ||
    version
      .split('-')
      .slice(1)
      .join('-')
      .split('.')
      .some((value) => /^0[0-9]+$/.test(value))
  )
    throw new Error('Invalid package version.');
  return version.split('-')[0];
}

export function branchToken(branch) {
  if (typeof branch !== 'string' || !branch || branch.startsWith('-')) throw new Error('A branch name is required.');
  execFileSync('git', ['check-ref-format', `refs/heads/${branch}`], { stdio: 'pipe', windowsHide: true });
  const slug =
    branch
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32)
      .replace(/-$/, '') || 'branch';
  return `${slug}-${createHash('sha256').update(branch).digest('hex').slice(0, 8)}`;
}

export function previewRelease({ branch, version, sha, timestamp = Date.now() }) {
  if (typeof sha !== 'string' || sha.length !== 40 || !/^[a-f0-9]{40}$/.test(sha))
    throw new Error('Expected a full commit SHA.');
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error('Invalid preview timestamp.');
  const token = branchToken(branch);
  const preview = `${baseVersion(version)}-preview.${token}.${timestamp}.g${sha.slice(0, 12)}`;
  return { version: preview, tag: `v${preview}`, distTag: `preview-${token}`, sha, preview: true };
}

/** Stable tags stay on main; only commit-bound preview versions may come from a branch. */
export function releasePlan({ tag, version, sha, onMain }) {
  const base = baseVersion(version);
  if (typeof sha !== 'string' || sha.length !== 40 || !/^[a-f0-9]{40}$/.test(sha))
    throw new Error('Expected a full commit SHA.');
  if (typeof tag !== 'string' || tag.trim() !== tag) throw new Error('Invalid release tag.');
  const match = /^v([0-9]+\.[0-9]+\.[0-9]+)-preview\.([a-z0-9-]+-[a-f0-9]{8})\.([1-9][0-9]*)\.g([a-f0-9]{12})$/.exec(
    tag,
  );
  if (match) {
    if (match[1] !== base || match[4] !== sha.slice(0, 12))
      throw new Error('Preview tag does not match its package base version and commit.');
    return { version: tag.slice(1), tag, distTag: `preview-${match[2]}`, sha, preview: true };
  }
  if (tag !== `v${version}` || version.includes('-preview.'))
    throw new Error('Tag does not match package version or preview format.');
  if (!onMain) throw new Error('Release tag must point to a commit on main.');
  return { version, tag, distTag: version.includes('-') ? 'next' : 'latest', sha, preview: false };
}

/** Change only release metadata in the runner checkout, never commit a version bump. */
export function stampVersion(root, version) {
  baseVersion(version);
  const files = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json'];
  const documents = files.map((file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')));
  if (documents[0].name !== 'paqvilo' || documents.some((document) => document.version !== documents[0].version))
    throw new Error('Package and lockfile versions must agree before stamping.');
  for (const document of documents.slice(1))
    if (document.packages?.['']?.version !== documents[0].version)
      throw new Error('Lockfile root version must agree before stamping.');
  for (let index = 0; index < files.length; index++) {
    const document = documents[index];
    document.version = version;
    if (index > 0) document.packages[''].version = version;
    fs.writeFileSync(path.join(root, files[index]), JSON.stringify(document, null, 2) + '\n');
  }
}

export function verifyArchive(directory, version) {
  baseVersion(version);
  const archives = fs.readdirSync(directory).filter((file) => file.endsWith('.tgz'));
  const expected = `paqvilo-${version}.tgz`;
  if (archives.length !== 1 || archives[0] !== expected) throw new Error('Expected exactly the gated package archive.');
  const archive = path.resolve(directory, expected);
  const read = (file) =>
    JSON.parse(
      execFileSync('tar', ['-xOf', expected, `package/${file}`], {
        cwd: path.resolve(directory),
        encoding: 'utf8',
        windowsHide: true,
      }),
    );
  const pkg = read('package.json'),
    lock = read('npm-shrinkwrap.json');
  if (
    pkg.name !== 'paqvilo' ||
    pkg.version !== version ||
    lock.version !== version ||
    lock.packages?.['']?.version !== version
  )
    throw new Error('Gated package archive metadata does not match the release.');
  return archive;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    if (command === 'stamp') stampVersion(process.cwd(), process.env.PACKAGE_VERSION);
    else if (command === 'verify') console.log(verifyArchive('dist', process.env.PACKAGE_VERSION));
    else if (command === 'plan') {
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      let onMain = false;
      if (!process.env.RELEASE_TAG?.includes('-preview.')) {
        execFileSync('git', ['fetch', 'origin', 'main'], { stdio: 'inherit' });
        try {
          execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);
          onMain = true;
        } catch {
          /* rejected below */
        }
      }
      const plan = releasePlan({ tag: process.env.RELEASE_TAG, version: pkg.version, sha, onMain });
      if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.GITHUB_REF !== `refs/tags/${plan.tag}`)
        throw new Error('Dispatch the Release workflow with --ref set to the selected tag.');
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        Object.entries(plan)
          .map(([name, value]) => `${name}=${value}\n`)
          .join(''),
      );
      console.log(JSON.stringify(plan));
    } else throw new Error('Usage: node scripts/release-version.mjs plan|stamp|verify');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
