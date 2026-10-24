import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { branchToken, previewRelease } from './release-version.mjs';

const gh = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

export function requestPreview({ repo, branch, publish = false, timestamp, runGh = gh }) {
  if (typeof repo !== 'string' || repo.trim() !== repo || !/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error('Expected repository owner/name.');
  if (typeof publish !== 'boolean') throw new Error('publish must be a boolean.');
  branchToken(branch);
  const ref = JSON.parse(runGh(['api', `repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`]));
  if (ref.object?.type !== 'commit') throw new Error('The selected branch must resolve to a commit.');
  const sha = ref.object.sha;
  const content = JSON.parse(runGh(['api', `repos/${repo}/contents/package.json?ref=${sha}`]));
  const pkg = JSON.parse(Buffer.from(content.content, 'base64').toString('utf8'));
  if (pkg.name !== 'paqvilo') throw new Error('The selected branch is not the Paqvilo package.');
  const workflowContent = JSON.parse(runGh(['api', `repos/${repo}/contents/.github/workflows/release.yml?ref=${sha}`]));
  const workflow = parse(Buffer.from(workflowContent.content, 'base64').toString('utf8'));
  if (
    !workflow.on?.workflow_dispatch ||
    !workflow.on?.push?.tags?.includes('!v*-preview.*') ||
    !workflow.jobs?.ci?.with?.package_version
  )
    throw new Error(
      'The selected branch needs the preview Release workflow; merge or rebase that workflow into it first.',
    );
  const plan = previewRelease({ branch, version: pkg.version, sha, timestamp });
  // Never move or overwrite a tag: its name permanently identifies one source commit.
  runGh(['api', `repos/${repo}/git/refs`, '--method', 'POST', '-f', `ref=refs/tags/${plan.tag}`, '-f', `sha=${sha}`]);
  try {
    runGh([
      'workflow',
      'run',
      'release.yml',
      '--repo',
      repo,
      '--ref',
      plan.tag,
      '-f',
      `tag=${plan.tag}`,
      '-f',
      `dry_run=${!publish}`,
    ]);
  } catch (error) {
    throw new Error(
      `Created ${plan.tag}, but workflow dispatch failed. Retry with: gh workflow run release.yml --repo ${repo} --ref ${plan.tag} -f tag=${plan.tag} -f dry_run=${!publish}`,
      { cause: error },
    );
  }
  return {
    ...plan,
    branch,
    dryRun: !publish,
    workflow: `https://github.com/${repo}/actions/workflows/release.yml`,
    install: `npm install --save-dev --save-exact paqvilo@${plan.version}`,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
      console.log(
        'Usage: node scripts/preview-release.mjs --branch <branch> [--repo <owner/name>] [--publish]\nCreates an immutable preview tag and runs the full Release gates. Defaults to npm publish --dry-run.',
      );
    } else {
      let branch,
        repo,
        publish = false;
      for (let index = 0; index < args.length; index++) {
        if (args[index] === '--publish') publish = true;
        else if (args[index] === '--branch' && args[index + 1]) branch = args[++index];
        else if (args[index] === '--repo' && args[index + 1]) repo = args[++index];
        else throw new Error(`Unknown or incomplete option: ${args[index]}`);
      }
      branchToken(branch);
      repo ??= gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
      console.log(JSON.stringify(requestPreview({ repo, branch, publish }), null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
