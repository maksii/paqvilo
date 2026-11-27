import { stripTrailingCharacter } from './text-scanning.mjs';
import { orderedMap as mapLimit } from '../../lense/async-map.mjs';
import { directoryFiles } from '../../lense/directory-files.mjs';
import {
  componentEnvelope,
  componentIdentity,
  componentPayload,
  enhancedSolutionRoot,
  isEnhancedSiteMetadataSource,
} from '../../lense/portal-model.mjs';
import { COMPONENT_KINDS as TYPES, COMPONENT_TYPE_OF_KIND } from './portal-component-types.mjs';
import { portalField as field } from './portal-field.mjs';
import { assertSingleEnhancedSite, enhancedPortalRecords, enhancedSiteLookup } from './portal-solution.mjs';
import { child, childText, parseSolutionXml } from './solution-xml.mjs';
import { codeSiteUploadPages, readCodeSite } from './code-site.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { duplicateYamlDiagnostics } from '../../lense/yaml-diagnostics.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { portalLanguage } from './portal-languages.mjs';
import { detectSourceDialect, portalSourceDir, unrecognisedSourceMessage } from './source-dialect.mjs';
import { platformChangeDiagnostics } from './platform-changes.mjs';
import { createHash } from 'node:crypto';
import { requiredArgument } from './required-argument.mjs';
const sourceRevisionOf = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const execFileAsync = promisify(execFile);
const slugOf = (value) =>
  String(value ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
/**
 * Sort key of a GUID in SQL Server uniqueidentifier order (System.Data.SqlTypes.SqlGuid:
 * the last six bytes first, then the fourth group, then the byte-swapped third, second
 * and first groups); null for an ID that is not a GUID.
 */
export function guidOrderKey(value) {
  const hex = String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(hex)) return null;
  const digits = hex.replaceAll('-', '');
  return [10, 11, 12, 13, 14, 15, 8, 9, 7, 6, 5, 4, 3, 2, 1, 0]
    .map((index) => digits.slice(index * 2, index * 2 + 2))
    .join('');
}
// Both git queries are local and read-only, and are waited for until git exits: an answer that a time limit replaced
// with "unknown" would let the speed of the host choose which copy of a record is imported.
/** Last commit time of a file (ms) when it is tracked by git, else null. Read-only. */
async function committedAt(file) {
  try {
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%ct', '--', path.basename(file)], {
      cwd: path.dirname(file),
      windowsHide: true,
    });
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  } catch {
    return null;
  }
}
/** The checked-out commit of the repository containing `dir`, else null. Read-only. */
async function checkedOutCommit(dir) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      windowsHide: true,
    });
    return /^[0-9a-f]{40,64}$/.test(stdout.trim()) ? stdout.trim() : null;
  } catch {
    return null;
  }
}
/** Read-only git queries for duplicate-copy resolution; tests replace them. */
export const gitQueries = { head: checkedOutCommit, commitTime: committedAt };
/**
 * The copy of a record exported more than once with different content: the one whose
 * file name matches its record name; else the most recently committed file (git); else
 * the most recently modified file; else the first in export order. `commitTime` reads a
 * file's last commit time in milliseconds (null when unknown); tests replace it.
 */
export async function chooseRecordCopy(copies, { commitTime = committedAt } = {}) {
  const matching = copies.filter(
    (copy) => copy._file && slugOf(path.basename(copy._file).split('.')[0]) === slugOf(copy.name),
  );
  if (matching.length === 1) return { record: matching[0], reason: 'its file name matches the record name' };
  const pool = matching.length > 1 ? matching : copies;
  const newest = (times) => {
    const best = Math.max(...times);
    const winners = times.flatMap((time, index) => (time === best ? [index] : []));
    return winners.length === 1 ? pool[winners[0]] : null;
  };
  const commits = await Promise.all(pool.map((copy) => (copy._file ? commitTime(copy._file) : null)));
  if (commits.every((time) => time !== null)) {
    const record = newest(commits);
    if (record) return { record, reason: 'its file was committed most recently' };
  }
  const modified = await Promise.all(
    pool.map(async (copy) => (await fs.stat(copy._file).catch(() => null))?.mtimeMs ?? 0),
  );
  const record = newest(modified);
  if (record) return { record, reason: 'its file was modified most recently' };
  return { record: pool[0], reason: 'it is the first copy in export order' };
}

export { COMPONENT_KINDS } from './portal-component-types.mjs';
export const DATA_MODELS = Object.freeze(['standard', 'enhanced']);
export { decodeXml } from './xml-text.mjs';
const id = (value) => (value == null ? null : String(idValue(value)).replace(/[{}]/g, '').toLowerCase());
const idValue = (value) => {
  if (typeof value !== 'object') return value;
  return value.id ?? value.value ?? '';
};
const componentIdField = (kind) => {
  if (kind === 'basicform') return 'entityformid';
  if (kind === 'advancedform') return 'webformid';
  if (kind === 'list') return 'entitylistid';
  if (kind === 'tablepermission') return 'entitypermissionid';
  if (kind === 'advancedformstep') return 'webformstepid';
  if (kind === 'basicformmetadata') return 'entityformmetadataid';
  if (kind === 'advancedformmetadata') return 'webformmetadataid';
  return `${kind}id`;
};
const active = (r) => Number(field(r, 'statecode', 0)) !== 1;
// Shortcut target columns in the documented priority order, and the target kinds Mirage does not host.
const SHORTCUT_TARGET_FIELDS = ['externalurl', 'webpageid', 'surveyid', 'webfileid', 'eventid', 'forumid'];
const SHORTCUT_UNSUPPORTED_TARGETS = Object.freeze({ surveyid: 'survey', eventid: 'event', forumid: 'forum' });
// A malformed escape keeps the raw path, so one bad partial URL neither stops an import nor a page request.
const decodePortalPath = (pathname) => {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
};
export const normalizePortalPath = (value) => {
  // A portal path never names a host: a leading "//" is a doubled slash, not an authority.
  const url = new URL(String(value || '/').replace(/^\/{2,}/, '/'), 'http://localhost');
  return (
    decodePortalPath(url.pathname)
      .replace(/\/{2,}/g, '/')
      .replace(/\/$/, '')
      .toLowerCase() || '/'
  );
};

const IO_CONCURRENCY = 32;
/** Source files in name order (lense/directory-files.mjs), with the importer's skip policy. */
const walk = (dir) => directoryFiles(dir, { skip: new Set(['.git', '.portalconfig']), concurrency: IO_CONCURRENCY });
// Text sources are prefetched concurrently; reads fall back to disk for other files.
async function read(file, contents) {
  if (contents?.has(file)) return contents.get(file);
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return '';
  }
}
const TEXT_SOURCE =
  /(?:\.ya?ml|\.(?:copy|summary|source|value)\.html|\.custom_(?:css\.css|javascript\.js)|powerpagecomponent\.xml|powerpagesites\.xml)$/i;
async function prefetch(files) {
  const selected = files.filter((file) => TEXT_SOURCE.test(file));
  const contents = await mapLimit(selected, IO_CONCURRENCY, async (file) => {
    try {
      return await fs.readFile(file, 'utf8');
    } catch {
      return '';
    }
  });
  return new Map(selected.map((file, index) => [file, contents[index]]));
}
async function containedFile(root, file) {
  try {
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
    const rel = path.relative(realRoot, realFile);
    return !rel.startsWith('..') && !path.isAbsolute(rel) && (await fs.stat(realFile)).isFile() ? realFile : null;
  } catch {
    return null;
  }
}
const localized = (value, lcid = 1033) => {
  if (typeof value !== 'string') return value ?? '';
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.some((x) => x && 'LCID' in x))
      return (parsed.find((x) => Number(x.LCID) === Number(lcid)) ?? parsed[0])?.Value ?? '';
  } catch {
    /* Optional metadata remains absent when its source cannot be parsed or read. */
  }
  return value;
};

function overlayRecord(previous, patch, kind, recordId, sourceDir) {
  const record = {
    ...previous,
    kind,
    id: recordId,
    _file: previous._file ?? path.join(sourceDir, '.paqvilo-overlay', kind, recordId + '.yml'),
    _profileFields: { ...previous._profileFields },
  };
  for (const [name, value] of Object.entries(patch)) {
    if (name.startsWith('_') || ['kind', 'id'].includes(name)) continue;
    const bare = name.replace(/^(?:adx|mspp)_/, '');
    // A sparse edit replaces this field's source spelling, preserving siblings and language/record identity.
    delete record[`adx_${bare}`];
    delete record[`mspp_${bare}`];
    record[bare] = value;
    record._profileFields[bare] = value;
  }
  record.name = field(record, 'name', record.name ?? '');
  return record;
}

function applyRecordOverride(key, patch, state) {
  const [kind, recordId] = key.split('/');
  if (!kind || !recordId || key.split('/').length !== 2) throw new Error('Invalid local record overlay identity.');
  if (kind === 'website' && recordId === String(state.website.id ?? field(state.website, 'websiteid'))) {
    if (patch) state.website = overlayRecord(state.website, patch, kind, recordId, state.sourceDir);
    return;
  }
  const index = state.records.findIndex((record) => record.kind === kind && record.id === recordId);
  if (patch === null) {
    if (index >= 0) state.records.splice(index, 1);
    return;
  }
  const previous = index >= 0 ? state.records[index] : {};
  const record = overlayRecord(previous, patch, kind, recordId, state.sourceDir);
  if (index >= 0) state.records[index] = record;
  else state.records.push(record);
}

function pageUrlFor(pageId, aliases, rootMap, urls, seen = new Set()) {
  pageId = aliases.get(id(pageId)) ?? id(pageId);
  if (!pageId) return '/';
  if (urls.has(pageId)) return urls.get(pageId);
  const record = rootMap.get(pageId);
  if (!record || seen.has(pageId)) return null;
  seen.add(pageId);
  const parent = id(field(record, 'parentpageid'));
  const base = parent ? pageUrlFor(parent, aliases, rootMap, urls, seen) : '/';
  if (base === null) return null;
  const partial = stripTrailingCharacter(String(field(record, 'partialurl', '')).replace(/^\/+/, ''), '/');
  const url = partial ? `${base.replace(/\/$/, '')}/${partial}/` : base;
  urls.set(pageId, url);
  return url;
}

function applyWebRoleDefaultFlag(flag, defaultName, roles, diagnostics, flagOf) {
  const flagged = roles.filter((role) => flagOf(field(role, flag, false)));
  const named = roles.filter(
    (role) =>
      String(role.name ?? '')
        .trim()
        .toLowerCase() === defaultName.toLowerCase(),
  );
  if (flagged.length) {
    const unflagged = named.filter((role) => !flagged.includes(role));
    if (flagged.length > 1 || unflagged.length) {
      const unflaggedText = unflagged.length
        ? '; ' + unflagged.map((role) => '"' + role.name + '"').join(', ') + ' is not flagged'
        : '';
      diagnostics.push({
        code: 'WEB_ROLE_FLAG_AS_EXPORTED',
        flag,
        roles: flagged.map((role) => role.name),
        ...(unflagged.length ? { unflagged: unflagged.map((role) => role.name) } : {}),
        message: `The export flags ${flagged.map((role) => '"' + role.name + '"').join(', ')} as the ${defaultName} role${unflaggedText}. The flags are used as exported.`,
      });
    }
    return;
  }
  if (named.length === 1) {
    named[0][`adx_${flag}`] = true;
    diagnostics.push({
      code: 'WEB_ROLE_FLAG_INFERRED',
      id: named[0].id,
      name: named[0].name,
      flag,
      message: `No active web role is flagged as the ${defaultName} role; the role named "${defaultName}" is used as the documented default.`,
    });
  } else if (named.length > 1)
    diagnostics.push({
      code: 'WEB_ROLE_FLAG_AMBIGUOUS',
      ids: named.map((role) => role.id),
      flag,
      message: `No active web role is flagged as the ${defaultName} role and ${named.length} roles are named "${defaultName}"; none is used.`,
    });
}

function orderUrlClaimants(claimants, kind) {
  const keys = new Map(claimants.map((entry) => [entry, guidOrderKey(entry.id)]));
  const ordered = claimants.every((entry) => keys.get(entry));
  let rule;
  if (!ordered) rule = 'export-order';
  else if (kind === 'webpage') rule = 'id-order';
  else rule = 'id-order-last';
  let sorted;
  if (ordered)
    sorted = [...claimants].sort((a, b) => {
      if (keys.get(a) < keys.get(b)) return -1;
      if (keys.get(a) > keys.get(b)) return 1;
      return 0;
    });
  else sorted = claimants;
  const used = rule === 'id-order-last' ? sorted.at(-1) : sorted[0];
  let servedOrder;
  if (rule === 'id-order') servedOrder = 'first in Dataverse ID';
  else if (rule === 'id-order-last') servedOrder = 'last in Dataverse ID';
  else servedOrder = 'first in export';
  return { used, rule, servedOrder };
}

function reportUrlClaim(entries, kind, key, claimants, diagnostics) {
  if (claimants.length < 2) return;
  const { used, rule, servedOrder } = orderUrlClaimants(claimants, kind);
  if (used !== claimants[0]) {
    entries.splice(entries.indexOf(used), 1);
    entries.splice(entries.indexOf(claimants[0]), 0, used);
  }
  diagnostics.push({
    code: 'URL_CLAIMED_TWICE',
    kind,
    path: key,
    usedId: used.id,
    rule,
    claimants: claimants.map((entry) => ({
      id: entry.id,
      name: entry.name,
      url: entry.url,
      file: entry.metadata?._file ?? null,
    })),
    message:
      claimants.length +
      ' ' +
      (kind === 'webpage' ? 'pages' : 'web files') +
      ' claim ' +
      claimants[0].url +
      ': ' +
      claimants.map((entry) => "'" + entry.name + "'").join(', ') +
      "; '" +
      used.name +
      "' is served (" +
      servedOrder +
      ' order).',
  });
}

function prioritizeUrlClaims(entries, kind, diagnostics) {
  const claims = new Map();
  for (const entry of entries) {
    const key = normalizePortalPath(entry.url);
    if (!claims.has(key)) claims.set(key, []);
    claims.get(key).push(entry);
  }
  for (const [key, claimants] of claims) reportUrlClaim(entries, kind, key, claimants, diagnostics);
}

function enhancedComponentRecord(file, xml, siteIds) {
  const envelope = componentEnvelope(xml);
  if (!envelope) throw new Error('Malformed Power Pages component XML.');
  siteIds.push(envelope.powerpagesiteid || envelope.websiteid);
  const type = Number(envelope.powerpagecomponenttype);
  const payload = componentPayload(xml);
  if (payload.status !== 'record' && payload.status !== 'absent')
    throw new Error('Power Pages component content must contain one JSON object.');
  const content = payload.value ?? {};
  const attachment = xml.includes('<filecontent') ? child(parseSolutionXml(xml), 'filecontent') : null;
  const siteLanguageId = id(envelope.powerpagesitelanguageid?.trim() || null);
  const languageFields = siteLanguageId
    ? {
        powerpagesitelanguageid: siteLanguageId,
        ...(type === 2 && content.webpagelanguageid == null ? { webpagelanguageid: siteLanguageId } : {}),
        ...(type === 7 && content.contentsnippetlanguageid == null ? { contentsnippetlanguageid: siteLanguageId } : {}),
      }
    : {};
  // An outer lifecycle status is distinct from any named status inside the content record.
  const status = envelope.statuscode?.trim();
  return {
    kind: TYPES[type] ?? `component:${type}`,
    powerpagecomponenttype: type,
    id: id(componentIdentity(xml) ?? path.basename(path.dirname(file))),
    name: envelope.name ?? '',
    ...content,
    ...languageFields,
    statecode: Number(envelope.statecode ?? 0),
    ...(status !== undefined ? { _componentEnvelope: { statuscode: status ? Number(status) : null } } : {}),
    _file: file,
    _sourceRevision: sourceRevisionOf(xml),
    _attachment: attachment ? { name: attachment.text.trim(), mimeType: attachment.attrs.mimetype } : null,
  };
}

function enhancedWebsiteRecord(site) {
  const auth = childText(site, 'enhancedauthorization');
  return {
    ...JSON.parse(childText(site, 'content') || '{}'),
    id: id(site.attrs.powerpagesiteid),
    name: child(site, 'name')?.text ?? '',
    ...(auth && /^\d+$/.test(auth) ? { enhancedauthorization: Number(auth) } : {}),
  };
}

function enhancedLanguageRecord(language, file, diagnostics) {
  let content = {};
  try {
    content = JSON.parse(childText(language, 'content') || '{}');
  } catch (error) {
    diagnostics.push({ code: 'invalid-enhanced-content', file, message: error.message });
  }
  const name = childText(language, 'name');
  const displayName = childText(language, 'displayname');
  const languageCode = childText(language, 'languagecode');
  const lcid = childText(language, 'lcid');
  return {
    kind: 'websitelanguage',
    id: id(language.attrs.powerpagesitelanguageid),
    name: name ?? displayName ?? '',
    ...content,
    ...(languageCode ? { languagecode: languageCode } : {}),
    ...(lcid ? { lcid: Number(lcid) } : {}),
    ...(displayName ? { displayname: displayName } : {}),
    statecode: Number(childText(language, 'statecode') ?? 0),
    _file: file,
  };
}

// Reports the site metadata files outside the folders that site metadata is read from.
function reportIgnoredSiteMetadata(sourceDir, ignored, metadataCount, diagnostics) {
  if (!ignored.length) return;
  const list = ignored.map((file) => path.relative(sourceDir, file).replaceAll('\\', '/'));
  diagnostics.push({
    code: 'ENHANCED_SITE_METADATA_IGNORED',
    files: list,
    message:
      `${metadataCount ? 'Site metadata' : 'No site metadata was read; site metadata'} outside Assets/ (or the root) ` +
      `of the folder that holds powerpagecomponents/ is ignored: ${list.join(', ')}.`,
  });
}

// Collects the site IDs of the powerpagesites.xml files and returns the website record of the first site, if any.
async function readEnhancedSites(metadata, contents, siteIds, diagnostics) {
  let website;
  for (const file of metadata.filter((name) => /(?:^|[\\/])powerpagesites\.xml$/i.test(name))) {
    try {
      const sites = enhancedPortalRecords(await read(file, contents), 'powerpagesite');
      for (const site of sites) siteIds.push(site.attrs.powerpagesiteid);
      if (!website && sites[0]) website = enhancedWebsiteRecord(sites[0]);
    } catch (error) {
      diagnostics.push({ code: 'invalid-website', message: error.message });
    }
  }
  return website;
}

// Collects the site IDs and the language records of the powerpagesitelanguages.xml files.
async function readEnhancedSiteLanguages(metadata, contents, siteIds, records, diagnostics) {
  for (const file of metadata.filter((name) => /(?:^|[\\/])powerpagesitelanguages\.xml$/i.test(name))) {
    try {
      for (const language of enhancedPortalRecords(await read(file, contents), 'powerpagesitelanguage')) {
        siteIds.push(enhancedSiteLookup(language));
        records.push(enhancedLanguageRecord(language, file, diagnostics));
      }
    } catch (error) {
      diagnostics.push({ code: 'invalid-enhanced-content', file, message: error.message });
    }
  }
}

async function readEnhancedSiteMetadata(sourceDir, files, contents, siteIds, records, diagnostics) {
  // Site metadata is read only where Lense reads it: Assets/ (or the root) of each folder that holds
  // powerpagecomponents/, which may sit below sourceDir. Files arrive in name order.
  const roots = [
    ...new Set(
      files
        .filter((file) => path.basename(file) === 'powerpagecomponent.xml')
        .map(enhancedSolutionRoot)
        .filter(Boolean),
    ),
  ];
  const candidates = files.filter((file) => /^powerpagesite(?:s|languages)\.xml$/i.test(path.basename(file)));
  const metadata = candidates.filter((file) => roots.some((root) => isEnhancedSiteMetadataSource(root, file)));
  const ignored = candidates.filter((file) => !metadata.includes(file));
  reportIgnoredSiteMetadata(sourceDir, ignored, metadata.length, diagnostics);
  const website = await readEnhancedSites(metadata, contents, siteIds, diagnostics);
  await readEnhancedSiteLanguages(metadata, contents, siteIds, records, diagnostics);
  return website ?? {};
}

/**
 * Read a portal source; no source mutation. Layouts: PAC YAML with adx_ keys, YAML with mspp_ keys
 * (a layout PAC 2.13.1 does not write), the short-key .powerpages-site YAML (unprefixed keys, record IDs in id:, language folders under
 * content-pages/ and content-snippets/, one folder per web file, language codes in
 * .portalconfig/*.portallanguage.yml), and an unpacked Solution with powerpagecomponents/.
 * A code-site project folder is read through its .powerpages-site/ folder.
 *
 * `dataModel` ("standard" or "enhanced") selects the site's data model for a YAML layout. The
 * unpacked or mspp_ layout is always the enhanced data model; adx_ YAML defaults to the standard data
 * model (PAC 2.13.1 also downloads enhanced data model sites with adx_ keys, so set dataModel for
 * them), and short-key YAML, which does not record it, defaults to the enhanced data model with
 * a DATA_MODEL_ASSUMED diagnostic (code sites require it).
 */
/* NOSONAR: single-pass routine, splitting it would change shared state */ export async function importPortal(
  sourceDir = requiredArgument('importPortal(sourceDir, options)', 'a portal source directory'),
  {
    languageId,
    lcid = 1033,
    deploymentProfile,
    deploymentProfileFile,
    dataModel: requestedDataModel,
    cache = null,
    git = gitQueries,
    recordOverrides = {},
  } = {},
) {
  if (requestedDataModel != null && !DATA_MODELS.includes(requestedDataModel))
    throw new Error(`dataModel must be standard or enhanced, not ${JSON.stringify(requestedDataModel)}`);
  sourceDir = await fs.realpath(path.resolve(sourceDir));
  let layout = detectSourceDialect(sourceDir);
  const layoutNotes = [];
  if (layout.dialect === 'code-site-project') {
    // A code-site project keeps its site records in .powerpages-site/ beside the app sources.
    const nested = portalSourceDir(sourceDir);
    if (nested !== sourceDir) {
      const siteDir = await fs.realpath(nested);
      layoutNotes.push({
        code: 'CODE_SITE_PROJECT_SOURCE',
        projectDir: sourceDir,
        sourceDir: siteDir,
        message: `${sourceDir} is a code-site project; its site records are read from ${siteDir}.`,
      });
      sourceDir = siteDir;
      layout = detectSourceDialect(sourceDir);
    }
  }
  const shortKey = layout.dialect === 'short-key-yaml';
  const enhancedYaml = layout.dialect === 'enhanced-yaml';
  const compiledOnly = layout.dialect === 'code-site-project';
  // Commit times for differing duplicate copies: one HEAD lookup per import, then each
  // file's last commit time, kept in `cache` (a SolutionFileCache: by file path and
  // content, re-validated when the file's stamp changes, and only for the same HEAD).
  let headLookup = null;
  const commitTime = async (file) => {
    headLookup ??= git.head(sourceDir);
    const head = await headLookup;
    if (!head) return null;
    return cache ? cache.remember(file, 'git-commit@1', head, () => git.commitTime(file)) : git.commitTime(file);
  };
  const files = compiledOnly ? [] : await walk(sourceDir);
  const contents = await prefetch(files);
  const enhanced = files.some((f) => path.basename(f) === 'powerpagecomponent.xml');
  const records = [];
  const diagnostics = [...layoutNotes];
  const codeSite = await readCodeSite(sourceDir, diagnostics);
  let website = compiledOnly && codeSite?.siteName ? { name: codeSite.siteName } : {};
  // The data model: the enhanced layout is the enhanced data model; a YAML layout uses the
  // requested model, else standard (adx_ keys) or enhanced (short keys, assumed).
  let dataModel, dataModelSource;
  if (enhanced || enhancedYaml) {
    dataModel = 'enhanced';
    dataModelSource = 'export';
  } else {
    if (requestedDataModel != null) dataModel = requestedDataModel;
    else if (shortKey || compiledOnly) dataModel = 'enhanced';
    else dataModel = 'standard';
    if (requestedDataModel) dataModelSource = 'configured';
    else if (shortKey || compiledOnly) dataModelSource = 'assumed';
    else dataModelSource = 'export';
  }
  if ((enhanced || enhancedYaml) && requestedDataModel === 'standard')
    diagnostics.push({
      code: 'DATA_MODEL_OVERRIDE_IGNORED',
      requested: requestedDataModel,
      message: enhanced
        ? 'An unpacked Solution with powerpagecomponents/ is the enhanced data model; the requested standard data model is ignored.'
        : 'Portal YAML with mspp_ keys uses the enhanced data model; the requested standard data model is ignored.',
    });
  if (dataModelSource === 'assumed')
    diagnostics.push({
      code: 'DATA_MODEL_ASSUMED',
      dataModel,
      message: compiledOnly
        ? 'Code-site build output does not contain Dataverse site metadata; the enhanced data model is used.'
        : "The .powerpages-site layout does not record the site's data model; the enhanced data model is assumed (code sites require it). For a standard data model site set dataModel: standard (serve and inspect --data-model standard, the project portal's dataModel, or the catalogue site's mirage.dataModel).",
    });
  if (enhanced) {
    const siteIds = [];
    for (const file of files.filter((f) => path.basename(f) === 'powerpagecomponent.xml')) {
      const xml = await read(file, contents);
      try {
        records.push(enhancedComponentRecord(file, xml, siteIds));
      } catch (error) {
        diagnostics.push({
          code: 'invalid-enhanced-content',
          file,
          message: error.message,
        });
      }
    }
    website = await readEnhancedSiteMetadata(sourceDir, files, contents, siteIds, records, diagnostics);
    assertSingleEnhancedSite(sourceDir, siteIds);
  } else {
    for (const file of files.filter((f) => /\.ya?ml$/i.test(f) && !/[\\/]deployment-profiles[\\/]/i.test(f))) {
      const originalKind = path
        .basename(file)
        .replace(/\.ya?ml$/i, '')
        .split('.')
        .at(-1)
        .toLowerCase();
      const kind = originalKind === 'webpagerule' ? 'webpageaccesscontrolrule' : originalKind;
      try {
        const text = await read(file, contents);
        let rows;
        try {
          rows = YAML.parse(text);
        } catch (error) {
          if (!/Map keys must be unique/.test(error.message)) throw error;
          diagnostics.push(...duplicateYamlDiagnostics(text, file));
          rows = YAML.parse(text, { uniqueKeys: false });
        }
        if (!Array.isArray(rows)) rows = [rows];
        // Every row of a multi-record file shares the file's revision.
        const sourceRevision = sourceRevisionOf(text);
        for (const row of rows) {
          if (!row || typeof row !== 'object') continue;
          const record = {
            ...row,
            kind,
            id: id(field(row, componentIdField(kind)) ?? (shortKey ? row.id : undefined)),
            name: field(row, 'name', ''),
            // PAC can export enhanced sites with adx_ keys. The selected data model,
            // rather than the YAML key dialect, determines their component tables.
            ...(dataModel === 'enhanced' && COMPONENT_TYPE_OF_KIND[kind]
              ? { powerpagecomponenttype: COMPONENT_TYPE_OF_KIND[kind] }
              : {}),
            _file: file,
            _sourceRevision: sourceRevision,
          };
          records.push(record);
          if (kind === 'website') website = record;
        }
      } catch (error) {
        diagnostics.push({
          code: 'invalid-yaml',
          file,
          message: error.message,
        });
      }
    }
  }
  // NOSONAR: keep deduplication and profile reads on their original await boundaries.
  // A record exported twice with identical content is one record (the first copy).
  // Differing copies of one record ID are resolved deterministically: the copy whose file
  // name matches its record name, else the most recently committed file (git), else the
  // most recently modified file, else the first in export order; ignored copies are
  // reported with the copy that is used.
  const groups = new Map();
  for (const record of records) {
    if (!record.id) continue;
    const key = `${record.kind}\0${record.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const dropped = new Set();
  const signatureOf = (record) => {
    const { _file, ...content } = record;
    return JSON.stringify(content);
  };
  for (const copies of groups.values()) {
    if (copies.length < 2) continue;
    const distinct = [];
    for (const copy of copies) {
      const same = distinct.find((item) => item.signature === signatureOf(copy));
      if (!same) {
        distinct.push({ record: copy, signature: signatureOf(copy) });
        continue;
      }
      dropped.add(copy);
      diagnostics.push({
        code: 'DUPLICATE_RECORD_IDENTICAL',
        kind: copy.kind,
        id: copy.id,
        file: copy._file,
        firstFile: same.record._file,
        message: 'The export contains the same record twice with identical content; the first copy is used.',
      });
    }
    if (distinct.length < 2) continue;
    const { record: used, reason } = await chooseRecordCopy(
      distinct.map((item) => item.record),
      { commitTime },
    );
    for (const { record: copy } of distinct) {
      if (copy === used) continue;
      for (const twin of copies) if (signatureOf(twin) === signatureOf(copy)) dropped.add(twin);
      diagnostics.push({
        code: 'DUPLICATE_RECORD_RESOLVED',
        kind: copy.kind,
        id: copy.id,
        file: copy._file,
        usedFile: used._file,
        reason,
        message: `The export contains different records with the same ID; the copy in ${used._file} is used (${reason}) and this copy is ignored.`,
      });
    }
  }
  if (dropped.size) records.splice(0, records.length, ...records.filter((record) => !dropped.has(record)));
  const profileChanges = [];
  let selectedProfileFile = null;
  if (deploymentProfile) {
    if (!/^[\w.-]+$/.test(deploymentProfile)) throw new Error('Select a deployment profile by its exported name');
    const profileName = deploymentProfile.replace(/\.deployment\.ya?ml$/i, '');
    const profile =
      deploymentProfileFile ??
      files.find(
        (f) =>
          /[\\/]deployment-profiles[\\/]/i.test(f) &&
          path
            .basename(f)
            .replace(/\.deployment\.ya?ml$/i, '')
            .toLowerCase() === profileName.toLowerCase(),
      );
    if (!profile) throw new Error(`Deployment profile '${deploymentProfile}' is absent in the export`);
    selectedProfileFile = await fs.realpath(profile);
    const profileSource = await fs.readFile(profile, 'utf8');
    const values = /\.json$/i.test(profile)
      ? JSON.parse(profileSource.replace(/^\uFEFF/, ''))
      : YAML.parse(profileSource);
    if (!values || typeof values !== 'object' || Array.isArray(values))
      throw new Error('Deployment profile must map tables to record patches');
    for (const [entity, rows] of Object.entries(values ?? {})) {
      const raw = entity.replace(/^(?:adx|mspp)_/, '');
      const kind =
        {
          entityform: 'basicform',
          webform: 'advancedform',
          entitylist: 'list',
          entitypermission: 'tablepermission',
        }[raw] ?? raw;
      for (const patch of Array.isArray(rows) ? rows : [rows]) {
        const targetId = id(
          patch?.[`${entity}id`] ??
            Object.entries(patch ?? {}).find(([k]) => k === `adx_${raw}id` || k === `mspp_${raw}id`)?.[1],
        );
        const record = records.find(
          (r) => r.kind === kind && (targetId ? r.id === targetId : r.name === field(patch, 'name')),
        );
        if (!record) {
          diagnostics.push({
            code: 'DEPLOYMENT_PROFILE_TARGET_UNRESOLVED',
            profile: profileName,
            entity,
            id: targetId,
            message: 'Profile override has no matching exported record',
          });
          continue;
        }
        const fields = Object.keys(patch).filter((k) => !k.endsWith('id'));
        record._originalName ??= record.name;
        Object.assign(record, patch);
        record.name = field(record, 'name', record.name);
        record._profileFields = {
          ...record._profileFields,
          ...Object.fromEntries(fields.map((k) => [k.replace(/^(?:adx|mspp)_/, ''), patch[k]])),
        };
        record._deploymentProfile = profileName;
        record._profileSourceFiles = {
          ...record._profileSourceFiles,
          ...Object.fromEntries(fields.map((k) => [k.replace(/^(?:adx|mspp)_/, ''), selectedProfileFile])),
        };
        record._profileRevisions = {
          ...record._profileRevisions,
          [selectedProfileFile]: sourceRevisionOf(profileSource),
        };
        profileChanges.push({
          recordId: record.id,
          kind,
          fields,
          profile: profileName,
          file: profile,
        });
      }
    }
  }
  // Local model-driven edits are record overlays. Reuse the normal compiler so page
  // hierarchy, language, forms and templates stay consistent without rewriting exports.
  const overlayState = { sourceDir, records, website };
  for (const [key, patch] of Object.entries(recordOverrides)) applyRecordOverride(key, patch, overlayState);
  website = overlayState.website;
  const live = records.filter(active);
  const byKind = (kind) => live.filter((r) => r.kind === kind);
  const language = id(languageId ?? field(website, 'defaultlanguage'));
  // A page record without an ID (adx_webpageid, or id: in a .powerpages-site export) cannot be
  // placed in the page tree: it is skipped and reported.
  const rawPages = byKind('webpage').filter((r) => r.id);
  const unidentifiedPages = byKind('webpage').filter((r) => !r.id);
  if (unidentifiedPages.length)
    diagnostics.push({
      code: 'RECORD_ID_MISSING',
      kind: 'webpage',
      count: unidentifiedPages.length,
      files: unidentifiedPages.slice(0, 5).map((r) => r._file),
      message: `${unidentifiedPages.length} web page record${unidentifiedPages.length === 1 ? ' has' : 's have'} no ID (adx_webpageid, or id: in a .powerpages-site export) and cannot be placed in the page tree.`,
    });
  const roots = rawPages.filter((r) => field(r, 'isroot', true) !== false);
  const aliases = new Map();
  for (const r of rawPages) {
    const root = id(field(r, 'rootwebpageid'));
    if (root) aliases.set(r.id, root);
  }
  const rootMap = new Map(roots.map((r) => [r.id, r]));
  const urls = new Map();
  const pageUrl = (pageId, seen) => pageUrlFor(pageId, aliases, rootMap, urls, seen);
  // Preserve the exact imported field origin for lazy provenance indexes. Later disk
  // edits must not relabel already imported/rendered bytes with a newer revision.
  for (const record of records) record._fieldOrigins = {};
  // Rows of one multi-record file share their sidecar names; read each name once.
  const sidecars = new Map();
  async function source(record, suffix, fallbackField) {
    const origins = (record._fieldOrigins ??= {});
    const fallback = Object.hasOwn(record._profileFields ?? {}, fallbackField)
      ? record._profileFields[fallbackField]
      : field(record, fallbackField, '');
    const file = record._profileSourceFiles?.[fallbackField] ?? record._file;
    origins[fallbackField] = { value: fallback, file, sidecar: false };
    if (Object.hasOwn(record._profileFields ?? {}, fallbackField) || enhanced) return String(localized(fallback, lcid));
    const stem = String(record._file ?? '').replace(/\.ya?ml$/i, '');
    const sidecar = `${stem}.${suffix}`;
    if (!sidecars.has(sidecar)) sidecars.set(sidecar, read(sidecar, contents));
    const value = await sidecars.get(sidecar);
    if (value) origins[fallbackField] = { value, file: sidecar, sidecar: true };
    return value || String(localized(fallback, lcid));
  }
  const pageBindings = (record) => ({
    pageTemplateId: id(field(record, 'pagetemplateid')),
    formId: id(field(record, 'entityformid', field(record, 'entityform'))),
    advancedFormId: id(field(record, 'webformid', field(record, 'webform'))),
    listId: id(field(record, 'entitylistid', field(record, 'entitylist'))),
  });
  const pages = [];
  for (const r of roots) {
    const copies = rawPages.filter((c) => id(field(c, 'rootwebpageid')) === r.id);
    const copy =
      copies.find((c) => id(field(c, 'webpagelanguageid')) === language) ??
      copies.find((c) => /en-US/i.test(c._file)) ??
      copies[0] ??
      r;
    const merged = { ...r, ...copy };
    // Every language content page by its website language; the renderer selects one per
    // request (website.selected_language).
    const translations = {};
    for (const variant of copies) {
      const variantLanguage = id(field(variant, 'webpagelanguageid'));
      if (!variantLanguage || Object.hasOwn(translations, variantLanguage)) continue;
      const metadata = { ...r, ...variant };
      translations[variantLanguage] = {
        ...pageBindings(metadata),
        title:
          [field(variant, 'title'), field(variant, 'name'), field(r, 'title'), field(r, 'name')]
            .map((value) => String(localized(value, lcid) ?? ''))
            .find((value) => value.trim()) ?? '',
        html: await source(variant, 'copy.html', 'copy'),
        css: await source(variant, 'custom_css.css', 'customcss'),
        js: await source(variant, 'custom_javascript.js', 'customjavascript'),
        summary: await source(variant, 'summary.html', 'summary'),
        metadata,
      };
    }
    const url = pageUrl(r.id);
    if (url === null) {
      diagnostics.push({
        code: 'page-hierarchy',
        pageId: r.id,
        message: 'Missing parent or cycle',
      });
      continue;
    }
    pages.push({
      id: r.id,
      name: field(r, 'name', ''),
      // The node title is adx_title, else adx_name, of the language content page: the first that is not blank, with
      // the spaces the record holds around it (the portal writes them out).
      title:
        [field(copy, 'title'), field(copy, 'name'), field(r, 'title'), field(r, 'name')]
          .map((value) => String(localized(value, lcid) ?? ''))
          .find((value) => value.trim()) ?? '',
      url,
      parentId: id(field(r, 'parentpageid')),
      ...pageBindings(merged),
      html: await source(copy, 'copy.html', 'copy'),
      css: await source(copy, 'custom_css.css', 'customcss'),
      js: await source(copy, 'custom_javascript.js', 'customjavascript'),
      summary: await source(copy, 'summary.html', 'summary'),
      metadata: merged,
      translations,
    });
  }
  if (codeSite?.entryFile && !pages.some((page) => page.url === '/')) {
    const name = website.name || codeSite.siteName || 'Home';
    const root = { id: 'local-code-site-entry', name, isroot: true, partialurl: '/' };
    pages.push({
      id: root.id,
      name,
      title: name,
      url: '/',
      parentId: null,
      html: '',
      metadata: root,
      translations: {},
    });
    diagnostics.push({
      code: 'CODE_SITE_LOCAL_ENTRY',
      message: 'The compiled app uses a local entry page because the project has no exported home-page record.',
    });
  }
  // The local build as pac pages upload-code-site would store it: the landing page in the Home page copy and one web
  // page per build folder (lib/code-site.mjs codeSiteUploadPages).
  if (codeSite?.entryFile) await codeSiteUploadPages(codeSite, pages, diagnostics);
  const templates = {};
  for (const r of byKind('webtemplate')) {
    const t = {
      id: r.id,
      name: r.name,
      source: await source(r, 'source.html', 'source'),
      metadata: r,
    };
    templates[t.id] = t;
    templates[t.name] = t;
  }
  const snippets = {};
  const snippetRank = snippetLanguageRank(language, id(field(website, 'defaultlanguage')));
  const snippetRows = byKind('contentsnippet').sort((a, b) => snippetRank(a) - snippetRank(b));
  const snippetTranslations = {};
  for (const r of snippetRows) {
    const value = await source(r, 'value.html', 'value');
    snippets[r.name] = value;
    const snippetLanguage = id(field(r, 'contentsnippetlanguageid'));
    if (snippetLanguage) {
      snippetTranslations[snippetLanguage] ??= {};
      snippetTranslations[snippetLanguage][r.name] = value;
    }
    if (r._originalName && r._originalName !== r.name) {
      snippets[r._originalName] = value;
      if (snippetLanguage) snippetTranslations[snippetLanguage][r._originalName] = value;
      diagnostics.push({
        code: 'DEPLOYMENT_PROFILE_SNIPPET_NAME_ALIAS',
        recordId: r.id,
        sourceName: r._originalName,
        profileName: r.name,
        message:
          'Profile renames a content snippet; its exported source name remains available for template references',
      });
    }
  }
  const settings = {};
  // Enhanced data model: a site setting can name an environment variable instead of a static value. The binding is
  // recorded here (no environment variable state exists at import time); secret-resolver.mjs bindSiteSettings applies
  // the effective value, or resolves a Secret type through the secrets resolver. The export field names
  // (`environmentvariable` lookup, `source` 1 = Environment variable) are a guess not yet checked against a real export.
  const settingEnvironmentVariables = {};
  for (const r of byKind('sitesetting')) {
    settings[r.name] = String(field(r, 'value', ''));
    const bound = id(field(r, 'environmentvariable'));
    // Assumed native default for adx_sitesetting source: the static value (0).
    if (bound && Number(field(r, 'source', 0)) === 1) settingEnvironmentVariables[r.name] = bound;
  }
  const webFiles = [];
  const webFileRecords = byKind('webfile');
  // Attachment lookups are independent; resolve them concurrently, then keep record order.
  const attachments = await mapLimit(webFileRecords, IO_CONCURRENCY, async (r) => {
    if (enhanced)
      return r._attachment?.name
        ? containedFile(sourceDir, path.join(path.dirname(r._file), 'filecontent', r._attachment.name))
        : null;
    const candidates = [path.basename(r._file).replace(/\.webfile\.ya?ml$/i, ''), r.filename, r.name].filter(Boolean);
    for (const candidate of candidates) {
      const found = await containedFile(sourceDir, path.join(path.dirname(r._file), String(candidate)));
      if (found) return found;
    }
    return null;
  });
  for (const [index, r] of webFileRecords.entries()) {
    const parent = pageUrl(field(r, 'parentpageid'));
    const file = attachments[index];
    // Partial URLs are relative to the parent page; leading slashes are dropped as for pages.
    const partial = field(r, 'partialurl') == null ? null : String(field(r, 'partialurl')).replace(/^\/+/, '');
    if (!file || parent === null || partial == null) {
      diagnostics.push({
        code: 'webfile-missing',
        file: r._file,
        message: 'Attachment or parent missing',
      });
      continue;
    }
    webFiles.push({
      id: r.id,
      name: r.name,
      url: `${parent.replace(/\/$/, '')}/${partial}`,
      file,
      mimeType: field(r, 'mimetype', r._attachment?.mimeType ?? null),
      metadata: r,
    });
  }
  // The served claimant is moved ahead of the others so every lookup by URL finds it first.
  prioritizeUrlClaims(pages, 'webpage', diagnostics);
  prioritizeUrlClaims(webFiles, 'webfile', diagnostics);
  const pageTemplates = byKind('pagetemplate').map((r) => ({
    id: r.id,
    name: r.name,
    webTemplateId: id(field(r, 'webtemplateid')),
    useHeaderFooter: field(r, 'usewebsiteheaderandfooter', true) !== false,
    rewriteUrl: field(r, 'rewriteurl'),
    metadata: r,
  }));
  const links = byKind('weblink')
    .map((r) => ({
      id: r.id,
      name: r.name,
      title: field(r, 'title', r.name),
      url: field(r, 'externalurl', pageUrl(field(r, 'pageid'))),
      pageId: id(field(r, 'pageid')),
      parentId: id(field(r, 'parentweblinkid')),
      setId: id(field(r, 'weblinksetid')),
      displayOrder: Number(field(r, 'displayorder', 0)),
      display_page_child_links: field(r, 'displaypagechildlinks', false),
      open_in_new_window: field(r, 'openinnewwindow', false),
      Open_In_New_Window: field(r, 'openinnewwindow', false),
      disable_page_validation: field(r, 'disablepagevalidation', false),
      description: localized(field(r, 'description', ''), lcid),
      metadata: r,
    }))
    .sort((a, b) => a.displayOrder - b.displayOrder);
  for (const link of links) link.weblinks = links.filter((c) => c.parentId === link.id);
  // Web link sets: every active set stays reachable by ID (weblinkSets, export order); the
  // name map holds the FIRST active set per exact name, as the platform's name lookup
  // (first active set in retrieval order). Shared names are reported.
  const weblinkSets = await mapLimit(byKind('weblinkset'), IO_CONCURRENCY, async (r) => {
    const copy = await source(r, 'copy.html', 'copy');
    return {
      id: r.id,
      name: r.name,
      title: field(r, 'title') == null ? null : localized(field(r, 'title'), lcid),
      copy: copy || (field(r, 'copy') == null ? null : copy),
      metadata: r,
      weblinks: links.filter((c) => c.setId === r.id && !c.parentId),
    };
  });
  const weblinks = {};
  for (const set of weblinkSets) {
    if (!Object.hasOwn(weblinks, set.name)) {
      weblinks[set.name] = set;
      continue;
    }
    diagnostics.push({
      code: 'WEBLINK_SET_NAME_SHARED',
      name: set.name,
      id: set.id,
      usedId: weblinks[set.name].id,
      message: `Another active web link set is also named "${set.name}"; lookups by name use the first set (${weblinks[set.name].id}); this set (${set.id}) is reachable by its ID.`,
    });
  }
  // Site markers resolve to the first active record with the exact name (legacy
  // name lookup is case-sensitive and takes the first match).
  const sitemarkers = {};
  const siteMarkers = [];
  for (const r of byKind('sitemarker')) {
    const pageId = id(field(r, 'pageid'));
    siteMarkers.push({ id: r.id, name: r.name, pageId });
    if (Object.hasOwn(sitemarkers, r.name)) {
      diagnostics.push({
        code: 'SITE_MARKER_DUPLICATE',
        id: r.id,
        name: r.name,
        message: 'Another active site marker has the same name; the first exported marker is used.',
      });
      continue;
    }
    sitemarkers[r.name] = pages.find((p) => p.id === pageId) ?? { url: null };
  }
  const all = (kind) => records.filter((r) => r.kind === kind);
  const flagOf = (value) =>
    value === true || value === 1 || (typeof value === 'string' && value.toLowerCase() === 'true');
  const idList = (value) => {
    let values;
    if (Array.isArray(value)) values = value;
    else if (value == null) values = [];
    else values = [value];
    return values.map(id).filter(Boolean);
  };
  // The special web roles are identified by their Authenticated/Anonymous Users Role
  // flags. An export without an active flagged role falls back to the documented default
  // role name, with a diagnostic (an enhanced export can leave "Authenticated Users"
  // unflagged).
  for (const [flag, defaultName] of [
    ['authenticatedusersrole', 'Authenticated Users'],
    ['anonymoususersrole', 'Anonymous Users'],
  ]) {
    const roles = byKind('webrole');
    applyWebRoleDefaultFlag(flag, defaultName, roles, diagnostics, flagOf);
  }
  // Publishing states are evaluated by their Is Visible flag; the legacy content map
  // loads them without a statecode filter, so inactive state records keep applying.
  const publishingStates = all('publishingstate').map((r) => ({
    id: r.id,
    name: r.name,
    isVisible: flagOf(field(r, 'isvisible', false)),
    isDefault: flagOf(field(r, 'isdefault', false)),
    displayOrder: Number(field(r, 'displayorder', 0)),
    active: active(r),
  }));
  // adx_redirect matching has no statecode filter in the legacy provider.
  const redirects = all('redirect').map((r) => ({
    id: r.id,
    name: r.name,
    inboundUrl: field(r, 'inboundurl'),
    statusCode: field(r, 'statuscode') == null ? null : Number(field(r, 'statuscode')),
    redirectUrl: field(r, 'redirecturl') ?? null,
    webPageId: id(field(r, 'webpageid')) || null,
    siteMarkerId: id(field(r, 'sitemarkerid')) || null,
    active: active(r),
    file: r._file,
  }));
  const urlHistory = byKind('urlhistory').map((r) => ({
    id: r.id,
    path: field(r, 'name', r.name),
    webPageId: id(field(r, 'webpageid')) || null,
    changedDate: field(r, 'changeddate') ?? null,
  }));
  const websiteAccess = byKind('websiteaccess').map((r) => ({
    id: r.id,
    name: r.name,
    roleIds: idList(field(r, 'websiteaccess_webrole', [])),
    manageContentSnippets: flagOf(field(r, 'managecontentsnippets', false)),
    manageSiteMarkers: flagOf(field(r, 'managesitemarkers', false)),
    manageWebLinkSets: flagOf(field(r, 'manageweblinksets', false)),
    previewUnpublishedEntities: flagOf(field(r, 'previewunpublishedentities', false)),
  }));
  // Portal languages of a short-key export (.portalconfig/*.portallanguage.yml): the language
  // code and LCID that its site languages link to through portallanguageid.
  const portalLanguages = [];
  const portalConfig = path.join(sourceDir, '.portalconfig');
  let configEntries = [];
  try {
    configEntries = await fs.readdir(portalConfig, { withFileTypes: true });
  } catch {
    /* Optional metadata remains absent when its source cannot be parsed or read. */
  }
  // One record per file (short-key exports: *.portallanguage.yml) or a list of records (PAC YAML:
  // portallanguage.yml, whose enhanced-data-model website languages share their portal
  // language's ID).
  for (const entry of configEntries
    .filter((item) => item.isFile() && /(?:^|\.)portallanguage\.ya?ml$/i.test(item.name))
    .sort((a, b) => Number(a.name > b.name) - Number(a.name < b.name))) {
    const file = path.join(portalConfig, entry.name);
    try {
      const parsed = YAML.parse(await fs.readFile(file, 'utf8')) ?? {};
      for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!row || typeof row !== 'object') continue;
        portalLanguages.push({
          id: id(field(row, 'portallanguageid') ?? row.id),
          name: String(field(row, 'name', '')),
          code: String(field(row, 'languagecode', '')).trim() || null,
          lcid: Number(field(row, 'lcid', field(row, 'systemlanguage'))) || null,
          displayName: String(field(row, 'displayname', '')).trim() || null,
          file,
        });
      }
    } catch (error) {
      diagnostics.push({ code: 'invalid-yaml', file, message: error.message });
    }
  }
  const portalLanguageById = new Map(portalLanguages.filter((item) => item.id).map((item) => [item.id, item]));
  // URL language codes: the exported code (enhanced site languages, or the linked portal
  // language of a short-key export), else the documented portal-language catalogue by the
  // website language name, else (default language) by the website's base LCID.
  const baseLcid = Number(field(website, 'website_language')) || null;
  const websiteLanguages = byKind('websitelanguage').map((r) => {
    const stateId = id(field(r, 'publishingstate', field(r, 'publishingstateid')));
    const state = publishingStates.find((s) => s.id === stateId);
    const isDefault = Boolean(language) && r.id === language;
    const linked = portalLanguageById.get(id(field(r, 'portallanguageid')));
    const exportedCode = String(field(r, 'languagecode') ?? linked?.code ?? '').trim();
    let known;
    if (exportedCode)
      known = {
        code: exportedCode,
        lcid: Number(field(r, 'lcid')) || linked?.lcid || portalLanguage({ name: exportedCode })?.lcid || null,
      };
    else {
      known = portalLanguage({ name: r.name });
      if (known == null && isDefault) known = portalLanguage({ lcid: baseLcid });
    }
    if (!known)
      diagnostics.push({
        code: 'WEBSITE_LANGUAGE_CODE_UNKNOWN',
        id: r.id,
        name: r.name,
        message: 'The website language name matches no documented portal language; its URL language code is unknown.',
      });
    return {
      id: r.id,
      name: r.name,
      portalLanguageId: id(field(r, 'portallanguageid')) || null,
      publishingStateId: stateId || null,
      published: state ? state.isVisible : true,
      isDefault,
      ...(known ? { code: known.code, lcid: known.lcid } : {}),
      ...(linked?.displayName ? { displayName: linked.displayName } : {}),
    };
  });
  const normalizeComponent = (r) => ({
    id: r.id,
    name: r.name,
    entityName: field(r, 'entitylogicalname', field(r, 'entityname')),
    formName: field(r, 'formname'),
    mode: field(r, 'mode', r.kind === 'basicform' ? 100000000 : undefined),
    js: field(r, 'customjavascript', ''),
    metadata: r,
  });
  const forms = byKind('basicform').map(normalizeComponent);
  for (const f of forms) f.js = await source(f.metadata, 'custom_javascript.js', 'customjavascript');
  const lists = byKind('list').map(normalizeComponent);
  for (const list of lists) list.js = await source(list.metadata, 'custom_javascript.js', 'customjavascript');
  for (const step of byKind('advancedformstep'))
    step.customJavascript = await source(step, 'custom_javascript.js', 'customjavascript');
  const shortcuts = byKind('shortcut').map((record) => {
    // A shortcut has one target: the first set of external URL, web page, survey, web file, event and forum
    // (https://learn.microsoft.com/power-pages/configure/place-child-nodes#manage-shortcuts). Enhanced mspp_shortcut
    // offers only the external URL, web page and web file columns, so a standard export's survey, event or forum
    // target is reported and leaves the shortcut without a URL; a lower-priority web file is not used in its place.
    const selected = SHORTCUT_TARGET_FIELDS.find((name) => field(record, name));
    const unsupported = SHORTCUT_UNSUPPORTED_TARGETS[selected];
    if (unsupported)
      diagnostics.push({
        code: 'SHORTCUT_TARGET_UNSUPPORTED',
        shortcutId: record.id,
        targetId: id(field(record, selected)),
        targetKind: unsupported,
        message: `The shortcut targets a ${unsupported}, which the enhanced shortcut table (mspp_shortcut) does not offer and Mirage does not host; the shortcut has no URL.`,
      });
    const externalUrl = selected === 'externalurl' ? field(record, 'externalurl') : null;
    const targetPageId = selected === 'webpageid' ? id(field(record, 'webpageid')) : null;
    const targetFileId = selected === 'webfileid' ? id(field(record, 'webfileid')) : null;
    const target = pages.find((page) => page.id === targetPageId) ?? webFiles.find((file) => file.id === targetFileId);
    if (!target && (targetPageId || targetFileId))
      diagnostics.push({
        code: 'SHORTCUT_TARGET_UNRESOLVED',
        shortcutId: record.id,
        targetId: targetPageId ?? targetFileId,
        targetKind: targetPageId ? 'webpage' : 'webfile',
        message: 'The selected shortcut target does not resolve to an exported page or web file attachment.',
      });
    return {
      id: record.id,
      name: record.name,
      title: localized(field(record, 'title') || target?.title || target?.name || record.name, lcid),
      description: field(record, 'description'),
      url: externalUrl ?? target?.url ?? null,
      parentId: id(field(record, 'parentpage_webpageid')),
      targetPageId,
      targetFileId,
      displayOrder: Number(field(record, 'displayorder', 0)),
      disableTargetValidation: field(record, 'disabletargetvalidation', false),
      metadata: record,
    };
  });
  // Server logic (component type 35, adx_serverlogic): the record, its web roles and its code
  // file. Execution requires an explicit trusted pack registration; imports alone
  // keep /_api/serverlogics/<name> unsupported (lib/server-logic.mjs).
  const serverLogics = await mapLimit(byKind('serverlogic'), IO_CONCURRENCY, async (record) => {
    const folder = path.dirname(record._file);
    const stem = path.basename(record._file).replace(/\.serverlogic\.ya?ml$/i, '');
    const candidates = enhanced
      ? [record._attachment?.name ? path.join(folder, 'filecontent', record._attachment.name) : null]
      : [
          path.join(folder, `${stem}.js`),
          path.join(folder, `${record.name}.js`),
          `${record._file.replace(/\.ya?ml$/i, '')}.js`,
        ];
    let file = null;
    for (const candidate of candidates.filter(Boolean)) {
      const contained = await containedFile(sourceDir, candidate);
      if (contained) {
        file = contained;
        break;
      }
    }
    if (!file)
      diagnostics.push({
        code: 'SERVER_LOGIC_CODE_MISSING',
        id: record.id,
        name: record.name,
        file: record._file,
        message: `Server logic "${record.name}" has no code file in the export.`,
      });
    return {
      id: record.id,
      name: record.name,
      displayName: field(record, 'display_name', null),
      description: field(record, 'description', null),
      roleIds: idList(field(record, 'serverlogic_adx_webrole', [])),
      file,
    };
  });
  // Cloud flows (component type 33, adx_cloudflowconsumer): the trigger URL path, the flow and
  // its web roles. Local execution requires a trusted pack registration; otherwise a trigger is 501.
  const relationshipOf = (record, name) => {
    const found = Object.keys(record).find((key) => key.toLowerCase() === name);
    return idList(found ? record[found] : []);
  };
  const cloudFlows = byKind('cloudflowconsumer').map((record) => {
    const apiUrl = field(record, 'flowapiurl');
    let triggerPath = null;
    try {
      triggerPath = apiUrl ? new URL(String(apiUrl), 'http://local.invalid').pathname : null; // NOSONAR: reserved or loopback placeholder host, not a real transport
    } catch {
      /* Optional metadata remains absent when its source cannot be parsed or read. */
    }
    return {
      id: record.id,
      name: record.name,
      path: triggerPath,
      processId: id(field(record, 'processid') ?? record._adx_processid_value) || null,
      roleIds: relationshipOf(record, 'adx_cloudflowconsumer_adx_webrole'),
    };
  });
  // Platform changes the runtime reports instead of modelling (lib/platform-changes.mjs).
  diagnostics.push(...platformChangeDiagnostics({ website, lists, forms, records, pages, templates, settings }));
  const codeSiteSetting = Object.keys(settings).find((name) => name.toLowerCase() === 'codesite/enabled');
  const codeSiteEnabled =
    codeSiteSetting !== undefined && flagOf(settings['CodeSite/Enabled'] ?? settings[codeSiteSetting]);
  // A source with zero recognised pages is not a portal (serve, inspect and bootstrap-report
  // refuse it through assertPortalSource, lib/source-dialect.mjs).
  if (!pages.length)
    diagnostics.push({
      code: 'PORTAL_SOURCE_EMPTY',
      dialect: layout.dialect,
      message: unrecognisedSourceMessage(sourceDir, layout, {
        pageRecords: records.filter((record) => record.kind === 'webpage').length,
      }),
    });
  return {
    sourceDir,
    source: layout,
    selectedLanguageId: language,
    selectedLcid: lcid,
    // The site's data model (the runtime's adx_ or powerpagecomponent tables and relationships).
    format: dataModel,
    dataModel,
    dataModelSource,
    codeSite,
    isSpaSite: Boolean(codeSite?.entryFile) || flagOf(field(website, 'isspasite', false)) || codeSiteEnabled,
    website,
    pages,
    templates,
    snippets,
    snippetTranslations,
    settings,
    settingEnvironmentVariables,
    webFiles,
    pageTemplates,
    weblinks,
    weblinkSets,
    sitemarkers,
    siteMarkers,
    shortcuts,
    redirects,
    urlHistory,
    publishingStates,
    websiteAccess,
    websiteLanguages,
    portalLanguages,
    serverLogics,
    cloudFlows,
    language: language
      ? (websiteLanguages.find((entry) => entry.id === language) ?? {
          id: language,
          published: true,
          ...(portalLanguage({ lcid: baseLcid })
            ? { code: portalLanguage({ lcid: baseLcid }).code, lcid: baseLcid }
            : {}),
        })
      : null,
    forms,
    lists,
    advancedForms: byKind('advancedform').map(normalizeComponent),
    records,
    diagnostics,
    deploymentProfile: deploymentProfile ?? null,
    deploymentProfileFile: selectedProfileFile,
    profileChanges,
  };
}

export { field as portalField };

/**
 * Order of preference between content snippets that share a name: a snippet in the selected
 * language, else one without a language (Content Snippet Language left blank), else one in the
 * site's default language, else any other. Higher ranks sort later and win, because the
 * importer keeps the last value per name; equal ranks keep export order. Microsoft Learn
 * ("Customize content by using content snippets", "Enable multiple-language website support")
 * documents the snippet language column but states no fallback order; this order is a
 * deterministic local model, not native evidence.
 */
export function snippetLanguageRank(languageId, defaultLanguageId = null) {
  const selected = id(languageId),
    fallback = id(defaultLanguageId);
  return (record) => {
    const language = id(field(record, 'contentsnippetlanguageid'));
    if (selected && language === selected) return 3;
    if (!language) return 2;
    if (fallback && language === fallback) return 1;
    return 0;
  };
}

/** Shared effective snippet identity, matching last-wins importer language selection. */
export function effectiveSnippetRecords(records, languageId, defaultLanguageId) {
  const website = records.find((record) => record.kind === 'website');
  const rank = snippetLanguageRank(
    languageId,
    defaultLanguageId === undefined ? field(website ?? {}, 'defaultlanguage') : defaultLanguageId,
  );
  const winners = new Map(),
    exact = new Map();
  const rows = records
    .filter((record) => record.kind === 'contentsnippet' && Number(field(record, 'statecode', 0)) !== 1)
    .sort((a, b) => rank(a) - rank(b));
  for (const record of rows) {
    exact.set(String(record.name), record);
    if (record._originalName) exact.set(record._originalName, record);
  }
  for (const [name, record] of exact) if (!winners.has(name.toLowerCase())) winners.set(name.toLowerCase(), record);
  Object.defineProperty(winners, 'resolve', {
    value: (name) => exact.get(String(name)) ?? winners.get(String(name).toLowerCase()),
  });
  Object.defineProperty(winners, 'records', { value: () => [...new Set(exact.values())] });
  return winners;
}

/** Explicit page-template choices select the active source even when both references exist. */
export function pageTemplateKind(template) {
  const value = field(template?.metadata ?? {}, 'type');
  if (Number(value) === 756150000) return 'rewrite';
  if (Number(value) === 756150001) return 'web-template';
  // Older or partial exports omit the choice; infer the source from the references.
  if (template?.webTemplateId) return 'web-template';
  if (template?.rewriteUrl) return 'rewrite';
  return null;
}
