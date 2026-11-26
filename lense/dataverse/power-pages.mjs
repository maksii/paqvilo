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
  return Object.assign(new Error('PAC Power Pages management failed; command output withheld.'), {
    code: 'POWER_PAGES_MANAGEMENT_FAILED',
    status: match ? Number(match[1]) : null,
    exitCode,
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
  // PAC 2.13 reports a refused Power Platform API call (for example WAF on a trial site) as "Error: ... [HTTP 400
  // (BadRequest)]" text with exit code 0; it is a failure, and its text stays withheld.
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
function siteRecord(row) {
  if (
    !row ||
    !guid(row.id) ||
    !guid(row.websiteRecordId) ||
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
    websiteRecordId: row.websiteRecordId,
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
  await command('update-site-visibility', ['--id', options.id, '--site-visibility', options.visibility], options);
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
function matchCondition(condition) {
  const variable = text(pick(condition, 'matchVariable', 'MatchVariable'), 64);
  const operator = choice(pick(condition, 'operator', 'Operator'), OPERATORS);
  const values = array(pick(condition, 'matchValue', 'MatchValue'));
  const reported = REPORTED_MATCH_VALUES.has(String(variable).toLowerCase()) || operator === 'GeoMatch';
  return {
    matchVariable: variable,
    operator,
    negateCondition: pick(condition, 'negateCondition', 'NegateCondition') === true,
    selector: reported ? text(pick(condition, 'selector', 'Selector')) : null,
    transforms: array(pick(condition, 'transforms', 'Transforms'))
      .map((entry) => text(entry, 64))
      .filter(Boolean)
      .slice(0, 16),
    valueCount: values.length,
    values: reported ? values.slice(0, 100).map((entry) => text(entry, 256)) : null,
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
    matchConditions: array(pick(rule, 'matchConditions', 'MatchConditions'))
      .slice(0, 32)
      .map(matchCondition),
  };
}
function managedRuleSet(set) {
  const groups = array(pick(set, 'RuleGroupOverrides', 'ruleGroupOverrides'));
  return {
    ruleSetType: text(pick(set, 'RuleSetType', 'ruleSetType')),
    ruleSetVersion: text(pick(set, 'RuleSetVersion', 'ruleSetVersion'), 32),
    ruleSetAction: choice(pick(set, 'RuleSetAction', 'ruleSetAction'), ['Allow', 'Block', 'Log']),
    ruleGroupOverrides: groups.length,
    overriddenRules: groups.reduce((sum, group) => sum + array(pick(group, 'Rules', 'rules')).length, 0),
    exclusions: array(pick(set, 'Exclusions', 'exclusions')).length,
  };
}
const unwrapped = (data) => (data?.value && !Array.isArray(data.value) ? data.value : data);
const customRules = (data) => ({
  rules: array(pick(unwrapped(data), 'CustomRules', 'customRules'))
    .slice(0, 100)
    .map(customRule),
});
const managedRules = (data) => ({
  ruleSets: array(pick(unwrapped(data), 'ManagedRules', 'managedRules'))
    .slice(0, 16)
    .map(managedRuleSet),
});
// Learn documents no schema for WebApplicationFirewallStatus: a string, or one status-like property, is kept.
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
  return { restricted: entries.length > 0, entries, withheld: rows.length - entries.length };
}
// One read; a refused read (for example WAF on a trial site, HTTP 400) is reported by its status, never its output.
async function edgeSection(read, project, site) {
  try {
    return { available: true, ...project(jsonResponse(await read())) };
  } catch (error) {
    if (error?.code !== 'POWER_PAGES_MANAGEMENT_FAILED') throw error;
    const reason = error.status === 400 && /^trial$/i.test(site.type ?? '') ? 'trial-site' : 'refused';
    return { available: false, reason, status: error.status ?? null };
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
  const custom = await edgeSection(read('get-waf-rules', ['--rule-type', 'custom']), customRules, site);
  const managed = await edgeSection(read('get-waf-rules', ['--rule-type', 'managed']), managedRules, site);
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
        emulated: false,
        note: 'Every loopback request comes from the local machine; Mirage has no client-address model.',
      },
      firewallCustomRules: {
        emulated: false,
        note: 'The edge evaluates custom rules before the site; Mirage applies no request filtering or rate limits.',
      },
      firewallManagedRules: {
        emulated: false,
        note: 'The managed rule set content and its anomaly thresholds are not published.',
      },
    },
  };
}
