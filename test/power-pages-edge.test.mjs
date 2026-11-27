// @test-kind contract: the Power Pages edge report reads site visibility, WAF and IP restrictions through read-only PAC commands and states what Mirage emulates
import test from 'node:test';
import assert from 'node:assert/strict';
import { readPowerPagesEdge } from 'paqvilo/dataverse';
import { observedConfig } from '../mirage/lib/project-config.mjs';
import { createEdgeAccess } from '../mirage/lib/edge-access.mjs';

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
      ruleGroups: 0,
      rules: 0,
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
      ['ipRestrictions', true],
      ['firewallCustomRules', true],
      ['firewallManagedRules', false],
    ],
  );
  // The values the report names are the Mirage observations that model them, accepted as they are.
  const observed = observedConfig({
    ipRestrictions: report.local.ipRestrictions.value,
    firewall: report.local.firewallCustomRules.value,
    evidence: 'invented edge report',
  });
  assert.deepEqual(observed.ipRestrictions, { allowed: ['198.51.100.0/24', '2001:db8::/32'], withheld: 1 });
  assert.deepEqual(
    observed.firewall.customRules.map((rule) => [rule.name, rule.matchConditions.map((condition) => condition.values)]),
    [
      ['BlockInventedRange', [['192.0.2.0/24'], null]],
      ['InventedRateLimit', [['ZZ']]],
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

// @test-kind observation: PAC 2.13.1 shapes from hosted session F5 (edge-d-production-writes-*.json): bare status strings, bare custom/managed arrays and dotted managed rule set keys; invented values
test('the edge report reads the PAC 2.13.1 bare WAF status, bare rule arrays and dotted managed rule set keys', async () => {
  const { options } = pac({
    'get-website-by-id': site,
    'get-waf-status': 'Created',
    'get-waf-rules:custom': [
      {
        name: 'InventedProbe',
        priority: 100,
        enabledState: 'Enabled',
        ruleType: 'MatchRule',
        rateLimitDurationInMinutes: null,
        rateLimitThreshold: null,
        matchConditions: [
          {
            matchVariable: 'RequestUri',
            selector: null,
            operator: 'Contains',
            negateCondition: false,
            matchValue: ['/invented-blocked'],
            transforms: [],
          },
        ],
        action: 'Block',
      },
    ],
    'get-waf-rules:managed': [
      {
        id: '/providers/Microsoft.Network/frontdoorwebapplicationfirewallmanagedrulesets/Invented_RuleSet_1.0',
        name: 'Invented_RuleSet_1.0',
        'properties.provisioningState': 'Succeeded',
        'properties.ruleSetId': '30000000-0000-4000-8000-000000000003',
        'properties.ruleSetType': 'Invented_RuleSet',
        'properties.ruleSetVersion': '1.0',
        'properties.ruleGroups': [
          { ruleGroupName: 'INVENTED-A', description: 'Invented', rules: [{ ruleId: '1' }, { ruleId: '2' }] },
          { ruleGroupName: 'INVENTED-B', description: 'Invented', rules: [{ ruleId: '3' }] },
        ],
      },
    ],
    'get-allowed-ip-addresses': [{ IpAddress: '203.0.113.9/32', IpAddressType: 'IPv4' }],
  });
  const report = await readPowerPagesEdge(options);
  assert.deepEqual(report.firewall.status, { available: true, status: 'Created' });
  assert.deepEqual(
    report.firewall.customRules.rules.map((rule) => [rule.name, rule.action, rule.matchConditions[0].values]),
    [['InventedProbe', 'Block', ['/invented-blocked']]],
  );
  assert.deepEqual(report.firewall.managedRules.ruleSets, [
    {
      ruleSetType: 'Invented_RuleSet',
      ruleSetVersion: '1.0',
      ruleSetAction: null,
      ruleGroupOverrides: 0,
      overriddenRules: 0,
      exclusions: 0,
      ruleGroups: 2,
      rules: 3,
    },
  ]);
  assert.deepEqual(report.ipRestrictions.entries, [{ ipAddress: '203.0.113.9/32', type: 'IPv4' }]);
  for (const status of ['None', 'Creating', 'CreationFailed', 'Deleting']) {
    const { options: next } = pac({
      'get-website-by-id': site,
      'get-waf-status': status,
      'get-waf-rules:custom': [],
      'get-waf-rules:managed': [],
      'get-allowed-ip-addresses': [],
    });
    assert.deepEqual((await readPowerPagesEdge(next)).firewall.status, { available: true, status }, status);
  }
});

// @test-kind observation: PAC 2.13.1 refusals from hosted session F5 (edge-a-read-*.json, edge-b-production-read-*.json, edge-d-production-writes-*.json): exit 1 with HTTP 400 on a trial site, HTTP 500 for rule reads while the WAF status is None, HTTP 409 during another operation
test('refused WAF reads exit 1 and are classified by site type, WAF status and HTTP status', async () => {
  const refused = (status, reason) => () => ({
    exitCode: 1,
    stdout: `Microsoft PowerPlatform CLI\nError: WITHHELD_DETAIL [HTTP ${status} (${reason})] Correlation ID: WITHHELD`,
  });
  const trial = pac({
    'get-website-by-id': { ...site, type: 'Trial' },
    'get-waf-status': refused(400, 'BadRequest'),
    'get-waf-rules:custom': refused(400, 'BadRequest'),
    'get-waf-rules:managed': refused(400, 'BadRequest'),
    'get-allowed-ip-addresses': [],
  });
  const trialReport = await readPowerPagesEdge(trial.options);
  for (const section of [trialReport.firewall.status, trialReport.firewall.customRules])
    assert.deepEqual(section, { available: false, reason: 'trial-site', status: 400 });
  const off = pac({
    'get-website-by-id': site,
    'get-waf-status': 'None',
    'get-waf-rules:custom': refused(500, 'InternalServerError'),
    'get-waf-rules:managed': refused(409, 'Conflict'),
    'get-allowed-ip-addresses': [],
  });
  const offReport = await readPowerPagesEdge(off.options);
  assert.deepEqual(offReport.firewall.status, { available: true, status: 'None' });
  assert.deepEqual(offReport.firewall.customRules, { available: false, reason: 'firewall-not-created', status: 500 });
  assert.deepEqual(offReport.firewall.managedRules, { available: false, reason: 'operation-in-progress', status: 409 });
  // A 500 once the WAF is Created is not explained by its status.
  const created = pac({
    'get-website-by-id': site,
    'get-waf-status': 'Created',
    'get-waf-rules:custom': refused(500, 'InternalServerError'),
    'get-waf-rules:managed': [],
    'get-allowed-ip-addresses': [],
  });
  assert.deepEqual((await readPowerPagesEdge(created.options)).firewall.customRules, {
    available: false,
    reason: 'refused',
    status: 500,
  });
  assert.doesNotMatch(JSON.stringify([trialReport, offReport]), /WITHHELD/);
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

// The Mirage edge gate on one loopback request, from a report's local values (mirage/lib/edge-access.mjs).
const gateFrom = (report, target = '/') => {
  const observed = observedConfig({
    ipRestrictions: report.local.ipRestrictions.value,
    firewall: report.local.firewallCustomRules.value,
    evidence: 'invented edge report',
  });
  return createEdgeAccess({ observed: () => observed }).check(
    { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    new URL(target, 'http://127.0.0.1:8787'),
  );
};

// @test-kind security: an allow list whose rows the read could not report still restricts the site: the report keeps it restricted with its withheld count, and Mirage refuses a visitor the known entries do not admit (fail closed), from the report to the request
test('withheld allow-list rows fail closed from the report to the local request', async () => {
  const { options } = pac({
    'get-website-by-id': site,
    'get-waf-status': { status: 'Created' },
    'get-waf-rules:custom': [],
    'get-waf-rules:managed': [],
    'get-allowed-ip-addresses': [
      { IpAddress: 'not an address WITHHELD', IpAddressType: 'IPv4' },
      { IpAddress: `${'1'.repeat(60)}/32`, IpAddressType: 'IPv4' },
    ],
  });
  const report = await readPowerPagesEdge(options);
  assert.deepEqual(report.ipRestrictions, { available: true, restricted: true, entries: [], withheld: 2 });
  assert.deepEqual(report.local.ipRestrictions.value, { allowed: [], withheld: 2 });
  const { refusal, events } = gateFrom(report);
  assert.equal(refusal.code, 'PORTAL_EDGE_IP_FORBIDDEN');
  assert.deepEqual(
    events.map((event) => [event.rule, event.decided, event.reason]),
    [['IP restriction allow list', false, 'the read withheld 2 allow-list row(s)']],
  );
});

// @test-kind security: match values are never cut: a condition is carried whole, or, beyond what Mirage can hold, reported withheld so that Mirage cannot decide the rule and fails closed; every rule and condition is kept
test('match conditions are carried whole or withheld, never truncated', async () => {
  const many = Array.from({ length: 150 }, (_, index) => `/area-${index}`);
  const rules = [
    rule('ManyPaths', 1, [{ matchVariable: 'RequestUri', operator: 'StartsWith', matchValue: many }]),
    rule('LongPath', 2, [{ matchVariable: 'RequestUri', operator: 'Equals', matchValue: [`/${'x'.repeat(300)}`] }]),
    ...Array.from({ length: 105 }, (_, index) =>
      rule(`Filler${index}`, 10 + index, [{ matchVariable: 'RequestMethod', operator: 'Equals', matchValue: ['PUT'] }]),
    ),
  ];
  const { options } = pac({
    'get-website-by-id': site,
    'get-waf-status': { status: 'Created' },
    'get-waf-rules:custom': rules,
    'get-waf-rules:managed': [],
    'get-allowed-ip-addresses': [],
  });
  const report = await readPowerPagesEdge(options);
  const [manyPaths, longPath] = report.firewall.customRules.rules;
  assert.equal(report.firewall.customRules.rules.length, 107);
  assert.deepEqual(manyPaths.matchConditions[0].values, many);
  assert.equal(longPath.matchConditions[0].values, null);
  assert.equal(longPath.matchConditions[0].valueCount, 1);
  // More rules than Mirage takes is refused where it is loaded, never silently shortened.
  assert.throws(() => gateFrom(report), /at most 100 rules/);
  report.local.firewallCustomRules.value.customRules.splice(2);
  assert.equal(gateFrom(report, '/area-149/page').refusal.code, 'PORTAL_EDGE_FIREWALL_BLOCKED');
  // The withheld long value: the rule cannot be decided locally, so it blocks.
  const undecided = gateFrom(report, '/elsewhere');
  assert.equal(undecided.refusal.code, 'PORTAL_EDGE_FIREWALL_BLOCKED');
  assert.deepEqual(
    undecided.events.map((event) => [event.rule, event.decided]),
    [['LongPath', false]],
  );
});

function rule(name, priority, matchConditions) {
  return { name, priority, enabledState: 'Enabled', action: 'Block', ruleType: 'MatchRule', matchConditions };
}
