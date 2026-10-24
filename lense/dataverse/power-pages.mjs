import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execute = promisify(execFile);
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
function configuration(options) {
  const executable = options.executable ?? 'pac',
    base = path.basename(executable.replaceAll('\\', '/')).toLowerCase();
  if (!['pac', 'pac.exe'].includes(base) || executable.includes('\0'))
    throw new Error('Power Pages management requires the PAC executable, without a command shell.');
  const timeout = options.timeout ?? 120000;
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 120000)
    throw new Error('Power Pages management timeout must be bounded to 1..120 seconds.');
  return { executable, timeout, environment: environmentArgument(options.environment) };
}
function managementFailure(result) {
  const output = String(result?.stdout ?? '') + '\n' + String(result?.stderr ?? ''),
    match = /(?:HTTP|StatusCode|status.code|status)\D{0,8}([45]\d\d)/i.exec(output);
  return Object.assign(new Error('PAC Power Pages management failed; command output withheld.'), {
    code: 'POWER_PAGES_MANAGEMENT_FAILED',
    status: match ? Number(match[1]) : null,
    exitCode: Number.isInteger(result?.exitCode)
      ? result.exitCode
      : Number.isInteger(result?.code)
        ? result.code
        : null,
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
    throw managementFailure(error);
  }
  if (result.exitCode !== undefined && result.exitCode !== 0) throw managementFailure(result);
  return typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? '');
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
  };
}
/** Read the management-plane inventory, separately from Dataverse site rows. */
export async function readPowerPagesSites(options) {
  const data = jsonResponse(await command('get-websites', [], options)),
    rows = Array.isArray(data) ? data : data.value;
  if (!Array.isArray(rows)) throw new Error('Power Pages management inventory is not a collection.');
  const sites = rows.map(siteRecord);
  if (new Set(sites.map((site) => site.id)).size !== sites.length)
    throw new Error('Power Pages management inventory repeats a site identity.');
  return sites;
}
/** Read a single management ID; never infer it from a Dataverse website GUID. */
export async function readPowerPagesSite(options) {
  if (!guid(options.id)) throw new Error('Power Pages management requires an explicit management site GUID.');
  const data = jsonResponse(await command('get-website-by-id', ['--id', options.id], options));
  const rows = Array.isArray(data) ? data : Array.isArray(data.value) ? data.value : [data.value ?? data];
  if (rows.length !== 1) throw new Error('Power Pages management returned an ambiguous site.');
  const site = siteRecord(rows[0]);
  if (site.id.toLowerCase() !== options.id.toLowerCase())
    throw new Error('Power Pages management returned a different site identity.');
  return site;
}
/** Explicit mutation only. A completed command is not visibility propagation
 * proof; callers must journal beforehand and read back the exact target. */
export async function setPowerPagesSiteVisibility(options) {
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
