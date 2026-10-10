import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function classifyChanges(files) {
  // A narrow secondary allowlist means new source directories receive full validation.
  const secondary = /^(?:docs\/|site\/|README\.md$|CONTRIBUTING\.md$|SECURITY\.md$|CODE_OF_CONDUCT\.md$|\.github\/(?:ISSUE_TEMPLATE\/|DISCUSSION_TEMPLATE\/|PULL_REQUEST_TEMPLATE\.md$|CODEOWNERS$|release\.yml$|workflows\/pages\.yml$))/;
  return {
    runtime: files.some((file) => !secondary.test(file)),
    package: files.some((file) => !/^(?:site\/|\.github\/|SECURITY\.md$|CODE_OF_CONDUCT\.md$)/.test(file)),
    dependencies: files.some((file) => /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json)$/.test(file)),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const base = event.pull_request?.base.sha ?? event.before;
  const head = event.pull_request?.head.sha ?? process.env.GITHUB_SHA;
  let scope = { runtime: true, package: true, dependencies: true };
  if (base && !/^0+$/.test(base) && process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' && process.env.VALIDATE_ALL !== 'true') {
    const diff = spawnSync('git', ['diff', '--name-only', '-z', base, head], { encoding: 'utf8', windowsHide: true });
    if (diff.status !== 0) throw new Error('Cannot determine changed files; refusing to skip validation.');
    scope = classifyChanges(diff.stdout.split('\0').filter(Boolean));
  }
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(scope).map(([key, value]) => `${key}=${value}\n`).join(''));
  console.log(JSON.stringify(scope));
}
