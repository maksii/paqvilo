import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pacExecutable } from './connection.mjs';
import { requiredArgument } from '../../mirage/lib/required-argument.mjs';

const execute = promisify(execFile);
const ACCEPTED_EXECUTABLES = new Set(['pac', 'pac.exe', 'pac.launcher.exe']);
const guid = (value) => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
function environmentArgument(value) {
  if (guid(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Power Pages management requires an explicit environment GUID or HTTPS origin.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Power Pages management requires an explicit environment GUID or HTTPS origin.');
  return url.origin;
}
// pacExecutable() throws only when no PAC executable is found on PATH or in PAQVILO_PAC_EXECUTABLE.
function discoveredExecutable() {
  try {
    return pacExecutable();
  } catch (error) {
    throw executableMissing(error);
  }
}
function configuration(options) {
  const environment = environmentArgument(options.environment);
  const timeout = options.timeout ?? 120000;
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 120000)
    throw new Error('Power Pages management timeout must be bounded to 1..120 seconds.');
  const executable = options.executable ?? discoveredExecutable(),
    base = path.basename(executable.replaceAll('\\', '/')).toLowerCase();
  if (!ACCEPTED_EXECUTABLES.has(base) || executable.includes('\0'))
    throw new Error('Power Pages management requires the PAC executable, without a command shell.');
  return { executable, timeout, environment };
}
function executableMissing(cause) {
  return Object.assign(
    new Error('PAC executable not found; pass executable or set PAQVILO_PAC_EXECUTABLE', { cause }),
    {
      code: 'POWER_PAGES_PAC_MISSING',
    },
  );
}
function managementFailure(result) {
  const output = String(result?.stdout ?? '') + '\n' + String(result?.stderr ?? ''),
    match = /(?:HTTP|StatusCode|status.code|status)\D{0,8}([45]\d\d)/i.exec(output);
  let exitCode;
  if (Number.isInteger(result?.exitCode)) exitCode = result.exitCode;
  else if (Number.isInteger(result?.code)) exitCode = result.code;
  else exitCode = null;
  const status = match ? Number(match[1]) : null;
  // PAC 2.13.1 answers a command sent while another operation on the site runs (for example a second enable-waf while
  // the WAF is Creating) with exit 1 and HTTP 409 (hosted session F5).
  const message =
    status === 409
      ? 'PAC Power Pages management failed: another operation on the site is in progress (HTTP 409); retry after it completes. Command output withheld.'
      : 'PAC Power Pages management failed; command output withheld.';
  return Object.assign(new Error(message), {
    code: 'POWER_PAGES_MANAGEMENT_FAILED',
    status,
    exitCode,
    ...(status === 409 ? { reason: 'operation-in-progress' } : {}),
  });
}
async function command(name, args, options) {
  const config = configuration(options),
    argv = [
      'power-pages',
      name,
      '--environment',
      config.environment,
      ...args,
      ...(name === 'update-site-visibility' ? [] : ['--json']),
    ];
  let result;
  try {
    result = options.run
      ? await options.run(config.executable, argv, {
          shell: false,
          windowsHide: true,
          timeout: config.timeout,
          maxBuffer: 4 * 1024 * 1024,
        })
      : await execute(config.executable, argv, {
          shell: false,
          windowsHide: true,
          timeout: config.timeout,
          maxBuffer: 4 * 1024 * 1024,
        });
  } catch (error) {
    throw error?.code === 'ENOENT' ? executableMissing() : managementFailure(error);
  }
  if (result.exitCode !== undefined && result.exitCode !== 0) throw managementFailure(result);
  const stdout = typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? '');
  // PAC 2.13.1 reports a refused Power Platform API call (for example WAF on a trial site) as "Error: ... [HTTP 400
  // (BadRequest)]" text with exit code 1 (hosted session F5), which the check above throws. The same text with exit
  // code 0 is the same failure; its text stays withheld either way.
  if (/^\s*Error:/i.test(stdout) && /\[HTTP\s+[45]\d\d\b/i.test(stdout)) throw managementFailure({ ...result, stdout });
  return stdout;
}
function jsonResponse(output) {
  try {
    return JSON.parse(output.trim());
  } catch {
    /* Optional inspection or cleanup failure must not interrupt the owning operation. */
  }
  const lines = output.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++)
    if (/^[[{]/.test(lines[index].trim()))
      try {
        return JSON.parse(lines.slice(index).join('\n'));
      } catch {
        /* Optional inspection or cleanup failure must not interrupt the owning operation. */
      }
  throw new Error('PAC Power Pages management returned no JSON record; command output withheld.');
}
// A site that is still provisioning is listed with websiteRecordId "" or null (hosted session F5). It is kept, with
// websiteRecordId null, so that one such site does not fail the whole inventory.
const provisioningRecordId = (value) => value === '' || value === null;
function siteRecord(row) {
  if (
    !row ||
    !guid(row.id) ||
    !(guid(row.websiteRecordId) || provisioningRecordId(row.websiteRecordId)) ||
    typeof row.websiteUrl !== 'string' ||
    !['private', 'public'].includes(String(row.siteVisibility).toLowerCase())
  )
    throw new Error('Power Pages management site identity or visibility is incomplete.');
  if (
    ['name', 'type', 'status'].some(
      (key) => row[key] != null && (typeof row[key] !== 'string' || row[key].length > 512),
    )
  )
    throw new Error('Power Pages management site metadata must be bounded scalar text.');
  let url;
  try {
    url = new URL(row.websiteUrl);
  } catch {
    throw new Error('Power Pages management returned an invalid site URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('Power Pages management returned an invalid site URL.');
  // Site metadata only: settings, credentials, certificates and unrecognized
  // response properties never leave this wrapper.
  return {
    id: row.id,
    websiteRecordId: guid(row.websiteRecordId) ? row.websiteRecordId : null,
    websiteUrl: url.href,
    siteVisibility: String(row.siteVisibility).toLowerCase(),
    name: row.name ?? null,
    type: row.type ?? null,
    status: row.status ?? null,
    trialExpiringInDays: trialDays(row.trialExpiringInDays),
    dataModel: dataModelName(row.dataModel),
  };
}
function trialDays(value) {
  return Number.isSafeInteger(value) && value >= 0 && value < 100000 ? value : null;
}
function dataModelName(value) {
  return typeof value === 'string' && value.length <= 64 ? value : null;
}
/** Read the management-plane inventory, separately from Dataverse site rows. */
export async function readPowerPagesSites(
  options = requiredArgument('readPowerPagesSites({ environment })', 'an options object with the environment'),
) {
  const data = jsonResponse(await command('get-websites', [], options)),
    rows = Array.isArray(data) ? data : data.value;
  if (!Array.isArray(rows)) throw new Error('Power Pages management inventory is not a collection.');
  const sites = rows.map(siteRecord);
  if (new Set(sites.map((site) => site.id)).size !== sites.length)
    throw new Error('Power Pages management inventory repeats a site identity.');
  return sites;
}
/** Read a single management ID; never infer it from a Dataverse website GUID. */
export async function readPowerPagesSite(
  options = requiredArgument(
    'readPowerPagesSite({ environment, id })',
    'an options object with the management site id',
  ),
) {
  if (!guid(options.id)) throw new Error('Power Pages management requires an explicit management site GUID.');
  const data = jsonResponse(await command('get-website-by-id', ['--id', options.id], options));
  let rows;
  if (Array.isArray(data)) rows = data;
  else if (Array.isArray(data.value)) rows = data.value;
  else rows = [data.value ?? data];
  if (rows.length !== 1) throw new Error('Power Pages management returned an ambiguous site.');
  const site = siteRecord(rows[0]);
  if (site.id.toLowerCase() !== options.id.toLowerCase())
    throw new Error('Power Pages management returned a different site identity.');
  return site;
}
/** Explicit mutation only. A completed command is not visibility propagation
 * proof; callers must journal beforehand and read back the exact target. */
export async function setPowerPagesSiteVisibility(
  options = requiredArgument(
    'setPowerPagesSiteVisibility({ environment, id, visibility })',
    'an options object with the management site id and visibility',
  ),
) {
  if (!guid(options.id) || !['private', 'public'].includes(options.visibility))
    throw new Error('Power Pages visibility requires an explicit management GUID and private/public value.');
  try {
    await command('update-site-visibility', ['--id', options.id, '--site-visibility', options.visibility], options);
  } catch (error) {
    // PAC 2.13.1 refuses a change to public with exit 1 and "HTTP 400" and prints no response body (hosted session
    // F5). The documented tenant cause to check is named; the withheld output cannot confirm it.
    if (error?.code === 'POWER_PAGES_MANAGEMENT_FAILED' && error.status === 400 && options.visibility === 'public')
      error.message =
        'PAC Power Pages management refused the visibility change (HTTP 400); command output withheld. A documented cause to check: the tenant governance control "Set site visibility to public access for non-production sites" (Power Platform admin center, Manage > Power Pages > Settings), which applies when the site or its environment is non-production, defaults to None and only tenant admins change.';
    throw error;
  }
  return {
    managementId: options.id,
    requestedVisibility: options.visibility,
    commandCompleted: true,
    readbackVerified: false,
  };
}

// The edge report: read-only PAC commands that wrap the Power Platform API Websites operations Get WAF Status, Get WAF
// Rules and Get Allowed Ip Addresses (Learn, "Use Power Pages admin APIs"). Only bounded, documented fields are kept.
const text = (value, max = 128) => (typeof value === 'string' && value.length <= max ? value : null);
const integer = (value) => (Number.isSafeInteger(value) ? value : null);
const pick = (row, ...keys) => {
  for (const key of keys) if (row && typeof row === 'object' && Object.hasOwn(row, key)) return row[key];
  return undefined;
};
const array = (value) => (Array.isArray(value) ? value : []);
const choice = (value, choices) =>
  choices.find((entry) => entry.toLowerCase() === String(value ?? '').toLowerCase()) ?? null;
// Match values of these variables are addresses, methods, paths or country codes. Other variables (headers, cookies,
// query strings, bodies) can hold shared secrets, so only their value count is reported.
const REPORTED_MATCH_VALUES = new Set(['remoteaddr', 'socketaddr', 'requestmethod', 'requesturi']);
const OPERATORS = ['Contains', 'EndsWith', 'Equals', 'GeoMatch', 'StartsWith'];
// The largest condition Mirage's observed.firewall takes (mirage/lib/edge-access.mjs). A condition beyond it is never
// cut, which would change what the rule matches: its values are reported withheld (null), so Mirage cannot decide it
// and fails closed.
const MAX_MATCH_VALUES = 600;
const MAX_MATCH_VALUE_LENGTH = 256;
const MAX_TRANSFORMS = 16;
const whole = (entries, max, length) =>
  entries.length <= max && entries.every((entry) => typeof entry === 'string' && entry.length <= length);
function matchCondition(condition) {
  const variable = text(pick(condition, 'matchVariable', 'MatchVariable'), 64);
  const operator = choice(pick(condition, 'operator', 'Operator'), OPERATORS);
  const values = array(pick(condition, 'matchValue', 'MatchValue'));
  const reported = REPORTED_MATCH_VALUES.has(String(variable).toLowerCase()) || operator === 'GeoMatch';
  const transforms = array(pick(condition, 'transforms', 'Transforms'));
  const transformsWhole = whole(transforms, MAX_TRANSFORMS, 64);
  return {
    matchVariable: variable,
    operator,
    negateCondition: pick(condition, 'negateCondition', 'NegateCondition') === true,
    selector: reported ? text(pick(condition, 'selector', 'Selector')) : null,
    transforms: transformsWhole ? transforms : [],
    valueCount: values.length,
    values: reported && transformsWhole && whole(values, MAX_MATCH_VALUES, MAX_MATCH_VALUE_LENGTH) ? values : null,
  };
}
function customRule(rule) {
  return {
    name: text(pick(rule, 'name', 'Name')),
    priority: integer(pick(rule, 'priority', 'Priority')),
    enabledState: choice(pick(rule, 'enabledState', 'EnabledState'), ['Disabled', 'Enabled']),
    action: choice(pick(rule, 'action', 'Action'), ['Allow', 'Block', 'Log']),
    ruleType: choice(pick(rule, 'ruleType', 'RuleType'), ['MatchRule', 'RateLimitRule']),
    rateLimitThreshold: integer(pick(rule, 'rateLimitThreshold', 'RateLimitThreshold')),
    rateLimitDurationInMinutes: integer(pick(rule, 'rateLimitDurationInMinutes', 'RateLimitDurationInMinutes')),
    // Every condition: dropping one would widen what the rule matches.
    matchConditions: array(pick(rule, 'matchConditions', 'MatchConditions')).map(matchCondition),
  };
}
// PAC 2.13.1 writes a managed rule set with dotted keys (properties.ruleSetType, properties.ruleSetVersion and
// properties.ruleGroups, the rule set's default groups and rules, not overrides); hosted session F5.
function managedRuleSet(set) {
  const groups = array(pick(set, 'RuleGroupOverrides', 'ruleGroupOverrides'));
  const defaults = array(pick(set, 'properties.ruleGroups'));
  return {
    ruleSetType: text(pick(set, 'RuleSetType', 'ruleSetType', 'properties.ruleSetType')),
    ruleSetVersion: text(pick(set, 'RuleSetVersion', 'ruleSetVersion', 'properties.ruleSetVersion'), 32),
    ruleSetAction: choice(pick(set, 'RuleSetAction', 'ruleSetAction'), ['Allow', 'Block', 'Log']),
    ruleGroupOverrides: groups.length,
    overriddenRules: groups.reduce((sum, group) => sum + array(pick(group, 'Rules', 'rules')).length, 0),
    exclusions: array(pick(set, 'Exclusions', 'exclusions')).length,
    ruleGroups: defaults.length,
    rules: defaults.reduce((sum, group) => sum + array(pick(group, 'rules', 'Rules')).length, 0),
  };
}
const unwrapped = (data) => (data?.value && !Array.isArray(data.value) ? data.value : data);
// With --rule-type custom or managed PAC 2.13.1 returns a bare array; without a type, an object with CustomRules and
// ManagedRules (hosted session F5).
const listed = (data, ...keys) => (Array.isArray(data) ? data : array(pick(unwrapped(data), ...keys)));
const customRules = (data) => ({
  // Every rule: dropping a Block rule would let through what the site refuses.
  rules: listed(data, 'CustomRules', 'customRules').map(customRule),
});
const managedRules = (data) => ({
  ruleSets: listed(data, 'ManagedRules', 'managedRules').slice(0, 16).map(managedRuleSet),
});
// Learn documents no schema for WebApplicationFirewallStatus. PAC 2.13.1 prints a bare JSON string: None, Creating,
// Created, CreationFailed or Deleting (hosted session F5). A string, or one status-like property, is kept.
function firewallStatus(data) {
  if (typeof data === 'string') return { status: text(data, 64) };
  const root = unwrapped(data);
  const status = pick(root, 'status', 'Status', 'wafStatus', 'WafStatus', 'state', 'State');
  if (typeof status === 'string') return { status: text(status, 64) };
  const enabled = pick(root, 'enabled', 'Enabled', 'isEnabled', 'IsEnabled');
  if (typeof enabled === 'boolean') return { status: enabled ? 'Enabled' : 'Disabled' };
  return { status: null, shape: 'unrecognized' };
}
const IP_ENTRY = /^[0-9a-f:.]{2,45}(?:\/\d{1,3})?$/i;
function ipRestrictions(data) {
  const rows = Array.isArray(data) ? data : data?.value;
  if (!Array.isArray(rows)) throw new Error('Power Pages IP restriction list is not a collection.');
  const entries = rows
    .map((row) => ({
      ipAddress: text(pick(row, 'IpAddress', 'ipAddress'), 49),
      type: choice(pick(row, 'IpAddressType', 'ipAddressType'), ['IPv4', 'IPv6']),
    }))
    .filter((entry) => entry.ipAddress && IP_ENTRY.test(entry.ipAddress));
  // A row that is not a bounded address is withheld; it still restricts the site.
  return { restricted: rows.length > 0, entries, withheld: rows.length - entries.length };
}
// Why a read was refused. Hosted session F5: WAF reads on a trial site answer HTTP 400; WAF rule reads answer HTTP
// 500 while the WAF status is not Created (observed None and Creating); HTTP 409 means another operation is running.
function refusalReason(error, site, firewall) {
  if (error.status === 400 && /^trial$/i.test(site.type ?? '')) return 'trial-site';
  if (error.status === 409) return 'operation-in-progress';
  if (error.status === 500 && firewall?.available && firewall.status && firewall.status !== 'Created')
    return 'firewall-not-created';
  return 'refused';
}
// One read; a refused read (for example WAF on a trial site, HTTP 400) is reported by its status, never its output.
async function edgeSection(read, project, site, firewall = null) {
  try {
    return { available: true, ...project(jsonResponse(await read())) };
  } catch (error) {
    if (error?.code !== 'POWER_PAGES_MANAGEMENT_FAILED') throw error;
    return { available: false, reason: refusalReason(error, site, firewall), status: error.status ?? null };
  }
}
/**
 * Read-only report of the controls the hosted edge applies before a request reaches the site: site visibility, the
 * web application firewall (status, custom rules, managed rule sets) and the IP restriction allow list, with what a
 * local Mirage runtime emulates of each. It never changes the site; PAC holds the sign-in, so no token passes here.
 */
export async function readPowerPagesEdge(
  options = requiredArgument(
    'readPowerPagesEdge({ environment, id })',
    'an options object with the management site id',
  ),
) {
  const site = await readPowerPagesSite(options);
  const args = ['--id', site.id];
  const read =
    (name, extra = []) =>
    () =>
      command(name, [...args, ...extra], options);
  const status = await edgeSection(read('get-waf-status'), firewallStatus, site);
  const custom = await edgeSection(read('get-waf-rules', ['--rule-type', 'custom']), customRules, site, status);
  const managed = await edgeSection(read('get-waf-rules', ['--rule-type', 'managed']), managedRules, site, status);
  const ip = await edgeSection(read('get-allowed-ip-addresses'), ipRestrictions, site);
  return {
    managementId: site.id,
    websiteUrl: site.websiteUrl,
    type: site.type,
    siteVisibility: site.siteVisibility,
    firewall: { status, customRules: custom, managedRules: managed },
    ipRestrictions: ip,
    local: {
      siteVisibility: {
        emulated: true,
        setting: 'observed.siteVisibility',
        value: site.siteVisibility,
        note: 'Mirage renders the private-site banner and, with privateSiteContactIds, admits only those contacts.',
      },
      ipRestrictions: {
        emulated: true,
        setting: 'observed.ipRestrictions',
        value: ip.available ? { allowed: ip.entries.map((entry) => entry.ipAddress), withheld: ip.withheld } : null,
        note: 'Mirage answers a visitor address outside the list with the hosted 403 page; a loopback request comes from 127.0.0.1 or ::1. With withheld rows, a visitor not on the known entries is refused (fail closed).',
      },
      firewallCustomRules: {
        emulated: true,
        setting: 'observed.firewall',
        value: custom.available ? { customRules: custom.rules } : null,
        note: 'Mirage evaluates custom rules in priority order before the site; a rule it cannot decide locally (a country match, withheld values, a request body) fails closed.',
      },
      firewallManagedRules: {
        emulated: false,
        note: 'The managed rule set content and its anomaly thresholds are not published.',
      },
    },
  };
}
