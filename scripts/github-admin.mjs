// Declarative repository setup via gh. No tokens, private data or registry publishing.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const apply = process.argv.includes('--apply');
const repo = 'maksii/paqvilo';
const endpoint = `repos/${repo}`;
function api(method, route, body, { missing = false } = {}) {
  const result = spawnSync('gh', ['api', '--method', method, route, ...(body ? ['--input', '-'] : [])], {
    input: body ? JSON.stringify(body) : undefined, encoding: 'utf8', windowsHide: true, timeout: 60_000,
  });
  if (result.status !== 0) {
    if (missing && /HTTP 404/.test(result.stderr)) return null;
    throw new Error(`${method} ${route}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : { ok: true };
}
const settings = {
  description: 'Local-first, pro-code tools for Microsoft Power Pages: live previews with Lense and local rendering with Mirage.',
  homepage: 'https://maksii.github.io/paqvilo/',
  has_issues: true, has_discussions: true,
  allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false,
  delete_branch_on_merge: true, allow_auto_merge: true,
  squash_merge_commit_title: 'PR_TITLE', squash_merge_commit_message: 'PR_BODY',
  security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } },
};
const protection = {
  required_status_checks: { strict: true, checks: [{ context: 'CI gate', app_id: 15368 }, { context: 'Security gate', app_id: 15368 }] },
  enforce_admins: true,
  required_pull_request_reviews: { dismiss_stale_reviews: true, require_code_owner_reviews: false, required_approving_review_count: 0, require_last_push_approval: false },
  restrictions: null, required_linear_history: true, allow_force_pushes: false, allow_deletions: false,
  required_conversation_resolution: true,
};
const tagRules = {
  name: 'Immutable release tags', target: 'tag', enforcement: 'active', bypass_actors: [],
  conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
  rules: [{ type: 'deletion' }, { type: 'update', parameters: { update_allows_fetch_and_merge: false } }],
};

if (!apply) {
  console.log(JSON.stringify({ repo, settings, protection, tagRules, additional: ['read-only workflow tokens', 'only GitHub-owned actions; immutable action pins', 'Dependabot alerts and security fixes', 'private vulnerability reporting', 'Pages Actions source and main-only environment', 'npm v*-tag environment', 'labels and repository topics'] }, null, 2));
} else {
  const state = api('GET', endpoint);
  if (!state.permissions?.admin) throw new Error('Repository admin permission is required.');
  if (state.visibility !== 'public') throw new Error('This setup expects the existing public repository; review plan-dependent features before applying elsewhere.');
  api('PATCH', endpoint, settings); console.log('Repository, Discussions and secret scanning configured.');
  for (const feature of ['vulnerability-alerts', 'automated-security-fixes', 'private-vulnerability-reporting']) api('PUT', `${endpoint}/${feature}`);
  api('PUT', `${endpoint}/actions/permissions/workflow`, { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false });
  api('PUT', `${endpoint}/actions/permissions`, { enabled: true, allowed_actions: 'selected', sha_pinning_required: true });
  api('PUT', `${endpoint}/actions/permissions/selected-actions`, { github_owned_allowed: true, verified_allowed: false, patterns_allowed: [] });
  api('PUT', `${endpoint}/branches/main/protection`, protection); console.log('Main protected, including admins; CI/security gates required.');
  const existingRules = api('GET', `${endpoint}/rulesets`);
  const existingTags = existingRules.find((rule) => rule.name === tagRules.name);
  api(existingTags ? 'PUT' : 'POST', `${endpoint}/rulesets${existingTags ? `/${existingTags.id}` : ''}`, tagRules);
  const pages = api('GET', `${endpoint}/pages`, undefined, { missing: true });
  api(pages ? 'PUT' : 'POST', `${endpoint}/pages`, { build_type: 'workflow' });
  // GitHub provisions the certificate after the first deployment; retry on reapply.
  const https = api('PUT', `${endpoint}/pages`, { https_enforced: true }, { missing: true });
  if (!https) console.log('Pages HTTPS certificate pending; reapply after the first deployment.');
  for (const [name, type, pattern] of [['github-pages', 'branch', 'main'], ['npm', 'tag', 'v*']]) {
    api('PUT', `${endpoint}/environments/${name}`, { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
    const policies = api('GET', `${endpoint}/environments/${name}/deployment-branch-policies`);
    if (!policies.branch_policies.some((policy) => policy.name === pattern && policy.type === type)) api('POST', `${endpoint}/environments/${name}/deployment-branch-policies`, { name: pattern, type });
  }
  api('PUT', `${endpoint}/topics`, { names: ['power-pages', 'power-platform', 'dataverse', 'liquid', 'local-development', 'developer-tools', 'simulation'] });
  const labels = api('GET', `${endpoint}/labels?per_page=100`);
  for (const [name, color, description] of [['bug', 'd73a4a', 'Reproducible problem'], ['enhancement', 'a2eeef', 'New capability or improvement'], ['skip-changelog', 'ededed', 'Exclude from generated release notes']]) {
    api(labels.some((label) => label.name === name) ? 'PATCH' : 'POST', `${endpoint}/labels${labels.some((label) => label.name === name) ? `/${name}` : ''}`, { name, color, description });
  }
  // Establish the main baseline before requiring this tool for future merges.
  const analyses = api('GET', `${endpoint}/code-scanning/analyses?ref=refs%2Fheads%2Fmain&per_page=1`, undefined, { missing: true });
  if (analyses?.length) {
    const scanning = JSON.parse(fs.readFileSync('.github/code-scanning-ruleset.json', 'utf8'));
    const existingScan = existingRules.find((rule) => rule.name === scanning.name);
    api(existingScan ? 'PUT' : 'POST', `${endpoint}/rulesets${existingScan ? `/${existingScan.id}` : ''}`, scanning);
    console.log('CodeQL merge protection enabled: error alerts and high/critical security findings.');
  } else console.log('CodeQL main baseline pending; reapply after the first main Security run.');
  console.log('Release tags, Pages, environments, dependency security and topics configured.');
  const configured = api('GET', endpoint);
  const repository = Object.fromEntries(['full_name', 'visibility', 'homepage', 'has_discussions', 'security_and_analysis', 'allow_squash_merge', 'allow_merge_commit', 'allow_rebase_merge', 'delete_branch_on_merge'].map(key => [key, configured[key]]));
  const report = { date: new Date().toISOString(), repository, protection: api('GET', `${endpoint}/branches/main/protection`), pages: api('GET', `${endpoint}/pages`), rulesets: api('GET', `${endpoint}/rulesets`) };
  fs.mkdirSync('.paqvilo/admin', { recursive: true });
  fs.writeFileSync('.paqvilo/admin/setup.json', JSON.stringify(report, null, 2));
  console.log('Verified settings saved under ignored .paqvilo/admin/setup.json.');
}
