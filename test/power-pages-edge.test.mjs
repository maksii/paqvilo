// @test-kind contract: the Power Pages edge report reads site visibility, WAF and IP restrictions through read-only PAC commands and states what Mirage emulates
import test from 'node:test';
import assert from 'node:assert/strict';
import { readPowerPagesEdge } from 'paqvilo/dataverse';

const id = '10000000-0000-4000-8000-000000000002';
const site = {
  id,
  websiteRecordId: '20000000-0000-4000-8000-000000000002',
  websiteUrl: 'https://edge.example.invalid',
  siteVisibility: 'public',
  name: 'Invented',
  type: 'Production',
  status: 'OperationComplete',
};
// Shapes of the Power Platform API Websites operations (Learn REST reference, api-version 2024-10-01), invented values.
const custom = {
  CustomRules: [
    {
      name: 'BlockInventedRange',
      priority: 10,
      enabledState: 'Enabled',
      action: 'Block',
      ruleType: 'MatchRule',
      matchConditions: [
        { matchVariable: 'RemoteAddr', operator: 'Equals', negateCondition: false, matchValue: ['192.0.2.0/24'] },
        {
          matchVariable: 'RequestHeader',
          selector: 'X-Invented-Key',
          operator: 'Equals',
          matchValue: ['WITHHELD_SHARED_SECRET'],
          transforms: ['Lowercase'],
        },
      ],
    },
    {
      name: 'InventedRateLimit',
      priority: 20,
      enabledState: 'Disabled',
      action: 'Log',
      ruleType: 'RateLimitRule',
      rateLimitThreshold: 100,
      rateLimitDurationInMinutes: 1,
      matchConditions: [{ matchVariable: 'RemoteAddr', operator: 'GeoMatch', matchValue: ['ZZ'] }],
    },
  ],
};
const managed = {
  ManagedRules: [
    {
      RuleSetType: 'Microsoft_DefaultRuleSet',
      RuleSetVersion: '2.1',
      RuleSetAction: 'Block',
      Exclusions: ['WITHHELD'],
      RuleGroupOverrides: [{ RuleGroupName: 'SQLI', Rules: [{ RuleId: '942100', EnabledState: 'Disabled' }] }],
    },
  ],
};
const addresses = [
  { IpAddress: '198.51.100.0/24', IpAddressType: 'IPv4' },
  { IpAddress: '2001:db8::/32', IpAddressType: 'IPv6' },
  { IpAddress: 'not an address WITHHELD', IpAddressType: 'IPv4' },
];

function pac(answers) {
  const calls = [];
  return {
    calls,
    options: {
      environment: 'https://tenant.example.invalid',
      executable: 'C:/CLI/pac.exe',
      id,
      run: async (program, args, settings) => {
        calls.push({ args, settings });
        const name = args[1];
        const key = name === 'get-waf-rules' ? `${name}:${args[args.indexOf('--rule-type') + 1]}` : name;
        const answer = answers[key];
        return typeof answer === 'function' ? answer() : { stdout: JSON.stringify(answer) };
      },
    },
  };
}

test('the edge report projects WAF rules, IP restrictions and visibility and names what Mirage emulates', async () => {
  const { calls, options } = pac({
    'get-website-by-id': site,
    'get-waf-status': { status: 'Enabled' },
    'get-waf-rules:custom': custom,
    'get-waf-rules:managed': managed,
    'get-allowed-ip-addresses': addresses,
  });
  const report = await readPowerPagesEdge(options);
  assert.equal(report.siteVisibility, 'public');
  assert.deepEqual(report.firewall.status, { available: true, status: 'Enabled' });
  const [block, rate] = report.firewall.customRules.rules;
  assert.deepEqual(
    [block.name, block.priority, block.action, block.enabledState, block.ruleType],
    ['BlockInventedRange', 10, 'Block', 'Enabled', 'MatchRule'],
  );
  assert.deepEqual(block.matchConditions[0].values, ['192.0.2.0/24']);
  assert.deepEqual(rate.matchConditions[0].values, ['ZZ']);
  assert.deepEqual([rate.rateLimitThreshold, rate.rateLimitDurationInMinutes], [100, 1]);
  assert.deepEqual(report.firewall.managedRules.ruleSets, [
    {
      ruleSetType: 'Microsoft_DefaultRuleSet',
      ruleSetVersion: '2.1',
      ruleSetAction: 'Block',
      ruleGroupOverrides: 1,
      overriddenRules: 1,
      exclusions: 1,
    },
  ]);
  assert.deepEqual(report.ipRestrictions, {
    available: true,
    restricted: true,
    entries: [
      { ipAddress: '198.51.100.0/24', type: 'IPv4' },
      { ipAddress: '2001:db8::/32', type: 'IPv6' },
    ],
    withheld: 1,
  });
  assert.deepEqual(
    Object.entries(report.local).map(([control, entry]) => [control, entry.emulated]),
    [
      ['siteVisibility', true],
      ['ipRestrictions', false],
      ['firewallCustomRules', false],
      ['firewallManagedRules', false],
    ],
  );
  // Only read commands run, each shell-free and bounded.
  assert.deepEqual(
    calls.map((call) => call.args.slice(0, 2).join(' ')),
    [
      'power-pages get-website-by-id',
      'power-pages get-waf-status',
      'power-pages get-waf-rules',
      'power-pages get-waf-rules',
      'power-pages get-allowed-ip-addresses',
    ],
  );
  assert.ok(calls.every((call) => call.settings.shell === false && call.args.includes('--json')));
});

// @test-kind security: match values of headers, cookies, query strings and bodies, and unknown response fields, never reach the report
test('the edge report withholds values that can hold shared secrets', async () => {
  const { options } = pac({
    'get-website-by-id': { ...site, clientSecret: 'WITHHELD' },
    'get-waf-status': { status: 'Enabled', token: 'WITHHELD' },
    'get-waf-rules:custom': custom,
    'get-waf-rules:managed': managed,
    'get-allowed-ip-addresses': addresses,
  });
  const report = await readPowerPagesEdge(options);
  const header = report.firewall.customRules.rules[0].matchConditions[1];
  assert.deepEqual(
    [header.matchVariable, header.values, header.selector, header.valueCount],
    ['RequestHeader', null, null, 1],
  );
  assert.doesNotMatch(JSON.stringify(report), /WITHHELD/);
});

// @test-kind security: a refused read is reported by its HTTP status; PAC's error text (correlation ids, messages) is withheld
test('a refused WAF read on a trial site is reported without its output', async () => {
  const refusal = () => ({
    stdout:
      'Error: WAF is not supported for trial portals. WITHHELD_DETAIL [HTTP 400 (BadRequest)] Correlation ID: WITHHELD',
  });
  const { options } = pac({
    'get-website-by-id': { ...site, type: 'Trial', siteVisibility: 'private' },
    'get-waf-status': refusal,
    'get-waf-rules:custom': refusal,
    'get-waf-rules:managed': () => ({ stdout: 'Error: WITHHELD [HTTP 403 (Forbidden)]' }),
    'get-allowed-ip-addresses': [],
  });
  const report = await readPowerPagesEdge(options);
  assert.deepEqual(report.firewall.status, { available: false, reason: 'trial-site', status: 400 });
  assert.deepEqual(report.firewall.customRules, { available: false, reason: 'trial-site', status: 400 });
  assert.deepEqual(report.firewall.managedRules, { available: false, reason: 'refused', status: 403 });
  assert.deepEqual(report.ipRestrictions, { available: true, restricted: false, entries: [], withheld: 0 });
  assert.equal(report.local.siteVisibility.value, 'private');
  assert.doesNotMatch(JSON.stringify(report), /WITHHELD/);
});

// @test-kind security: the report needs an explicit management id and refuses a shell executable before any command runs
test('the edge report validates its target before running PAC', async () => {
  let called = false;
  const options = {
    environment: 'https://tenant.example.invalid',
    executable: 'C:/CLI/pac.exe',
    run: async () => {
      called = true;
      return { stdout: '{}' };
    },
  };
  await assert.rejects(readPowerPagesEdge(options), /explicit management site GUID/);
  await assert.rejects(readPowerPagesEdge({ ...options, id: `${id} & calc` }), /explicit management site GUID/);
  await assert.rejects(readPowerPagesEdge({ ...options, id, executable: 'pac.cmd' }), /without a command shell/);
  assert.equal(called, false);
});
