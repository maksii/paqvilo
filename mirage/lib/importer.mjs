import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { portalLanguage } from "./portal-languages.mjs";
import { detectSourceDialect, unrecognisedSourceMessage } from "./source-dialect.mjs";
import { platformChangeDiagnostics } from "./platform-changes.mjs";

const execFileAsync = promisify(execFile);
const slugOf = (value) =>
  String(value ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
/**
 * Sort key of a GUID in SQL Server uniqueidentifier order (System.Data.SqlTypes.SqlGuid:
 * the last six bytes first, then the fourth group, then the byte-swapped third, second
 * and first groups); null for an ID that is not a GUID.
 */
export function guidOrderKey(value) {
  const hex = String(value ?? "").replace(/[{}]/g, "").toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(hex)) return null;
  const digits = hex.replace(/-/g, "");
  return [10, 11, 12, 13, 14, 15, 8, 9, 7, 6, 5, 4, 3, 2, 1, 0].map((index) => digits.slice(index * 2, index * 2 + 2)).join("");
}
/** Last commit time of a file (ms) when it is tracked by git, else null. Read-only. */
async function committedAt(file) {
  try {
    const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%ct", "--", path.basename(file)], {
      cwd: path.dirname(file),
      timeout: 15000,
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
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir, timeout: 15000, windowsHide: true });
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
  const matching = copies.filter((copy) => copy._file && slugOf(path.basename(copy._file).split(".")[0]) === slugOf(copy.name));
  if (matching.length === 1) return { record: matching[0], reason: "its file name matches the record name" };
  const pool = matching.length > 1 ? matching : copies;
  const newest = (times) => {
    const best = Math.max(...times);
    const winners = times.flatMap((time, index) => (time === best ? [index] : []));
    return winners.length === 1 ? pool[winners[0]] : null;
  };
  const commits = await Promise.all(pool.map((copy) => (copy._file ? commitTime(copy._file) : null)));
  if (commits.every((time) => time !== null)) {
    const record = newest(commits);
    if (record) return { record, reason: "its file was committed most recently" };
  }
  const modified = await Promise.all(pool.map(async (copy) => (await fs.stat(copy._file).catch(() => null))?.mtimeMs ?? 0));
  const record = newest(modified);
  if (record) return { record, reason: "its file was modified most recently" };
  return { record: pool[0], reason: "it is the first copy in export order" };
}

const TYPES = {
  1: "publishingstate",
  2: "webpage",
  3: "webfile",
  4: "weblinkset",
  5: "weblink",
  6: "pagetemplate",
  7: "contentsnippet",
  8: "webtemplate",
  9: "sitesetting",
  10: "webpageaccesscontrolrule",
  11: "webrole",
  12: "websiteaccess",
  13: "sitemarker",
  15: "basicform",
  16: "basicformmetadata",
  17: "list",
  18: "tablepermission",
  19: "advancedform",
  20: "advancedformstep",
  21: "advancedformmetadata",
  24: "pollplacement",
  26: "adplacement",
  27: "botconsumer",
  28: "columnpermissionprofile",
  29: "columnpermission",
  30: "redirect",
  31: "publishingstatetransitionrule",
  32: "shortcut",
  33: "cloudflowconsumer",
  34: "uxcomponent",
  35: "serverlogic",
};
// The documented powerpagecomponenttype choices (learn.microsoft.com/power-apps/developer/
// data-platform/reference/entities/powerpagecomponent#BKMK_powerpagecomponenttype; 14, 22, 23
// and 25 are not choices). Record kinds follow the PAC folder tables (adx_cloudflowconsumer,
// mspp_uxcomponent, adx_serverlogic) and the file suffixes of short-key exports.
const COMPONENT_TYPE_OF_KIND = Object.fromEntries(Object.entries(TYPES).map(([type, kind]) => [kind, Number(type)]));
export const COMPONENT_KINDS = Object.freeze({ ...TYPES });
export const DATA_MODELS = Object.freeze(["standard", "enhanced"]);
export function decodeXml(text = "") {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) =>
      entity[0] === "#"
        ? String.fromCodePoint(
            entity[1].toLowerCase() === "x"
              ? parseInt(entity.slice(2), 16)
              : Number(entity.slice(1)),
          )
        : { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[
            entity.toLowerCase()
          ],
    );
}
const field = (record, name, fallback = null) =>
  record[`adx_${name}`] ?? record[`mspp_${name}`] ?? record[name] ?? fallback;
const id = (value) =>
  value == null
    ? null
    : String(
        typeof value === "object" ? (value.id ?? value.value ?? "") : value,
      )
        .replace(/[{}]/g, "")
        .toLowerCase();
const active = (r) => Number(field(r, "statecode", 0)) !== 1;
export const normalizePortalPath = (value) => {
  // A portal path never names a host: a leading "//" is a doubled slash, not an authority.
  const url = new URL(String(value || "/").replace(/^\/{2,}/, "/"), "http://localhost");
  return (
    decodeURIComponent(url.pathname)
      .replace(/\/{2,}/g, "/")
      .replace(/\/$/, "")
      .toLowerCase() || "/"
  );
};

const IO_CONCURRENCY = 32;
async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await mapper(items[index], index);
      }
    }),
  );
  return results;
}
/** Directory listing in depth-first readdir order; directories are read concurrently. */
async function walk(dir) {
  const children = new Map();
  let level = [dir];
  while (level.length) {
    const next = [];
    await mapLimit(level, IO_CONCURRENCY, async (current) => {
      const entries = (await fs.readdir(current, { withFileTypes: true })).filter(
        (entry) =>
          !entry.isSymbolicLink() &&
          entry.name !== ".git" &&
          entry.name !== ".portalconfig",
      );
      children.set(current, entries);
      for (const entry of entries)
        if (entry.isDirectory()) next.push(path.join(current, entry.name));
    });
    level = next;
  }
  const files = [];
  const flatten = (current) => {
    for (const entry of children.get(current) ?? []) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) flatten(file);
      else if (entry.isFile()) files.push(file);
    }
  };
  flatten(dir);
  return files;
}
// Text sources are prefetched concurrently; reads fall back to disk for other files.
async function read(file, contents) {
  if (contents?.has(file)) return contents.get(file);
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}
const TEXT_SOURCE =
  /(?:\.ya?ml|\.(?:copy|summary|source|value)\.html|\.custom_(?:css\.css|javascript\.js)|powerpagecomponent\.xml|powerpagesites\.xml)$/i;
async function prefetch(files) {
  const selected = files.filter((file) => TEXT_SOURCE.test(file));
  const contents = await mapLimit(selected, IO_CONCURRENCY, async (file) => {
    try {
      return await fs.readFile(file, "utf8");
    } catch {
      return "";
    }
  });
  return new Map(selected.map((file, index) => [file, contents[index]]));
}
async function containedFile(root, file) {
  try {
    const [realRoot, realFile] = await Promise.all([
      fs.realpath(root),
      fs.realpath(file),
    ]);
    const rel = path.relative(realRoot, realFile);
    return !rel.startsWith("..") &&
      !path.isAbsolute(rel) &&
      (await fs.stat(realFile)).isFile()
      ? realFile
      : null;
  } catch {
    return null;
  }
}
const localized = (value, lcid = 1033) => {
  if (typeof value !== "string") return value ?? "";
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.some((x) => x && "LCID" in x))
      return (
        (parsed.find((x) => Number(x.LCID) === Number(lcid)) ?? parsed[0])
          ?.Value ?? ""
      );
  } catch {}
  return value;
};

/**
 * Read a portal source; no source mutation. Layouts: PAC YAML with adx_ keys, the short-key
 * .powerpages-site YAML (unprefixed keys, record IDs in id:, language folders under
 * content-pages/ and content-snippets/, one folder per web file, language codes in
 * .portalconfig/*.portallanguage.yml), and an unpacked Solution with powerpagecomponents/.
 * A code-site project folder is read through its .powerpages-site/ folder.
 *
 * `dataModel` ("standard" or "enhanced") selects the site's data model for a YAML layout. The
 * enhanced layout is always the enhanced data model; standard YAML defaults to the standard data
 * model, and short-key YAML, which does not record it, defaults to the enhanced data model with
 * a DATA_MODEL_ASSUMED diagnostic (code sites require it).
 */
export async function importPortal(
  sourceDir,
  { languageId, lcid = 1033, deploymentProfile, dataModel: requestedDataModel, cache = null, git = gitQueries } = {},
) {
  if (requestedDataModel != null && !DATA_MODELS.includes(requestedDataModel))
    throw new Error(`dataModel must be standard or enhanced, not ${JSON.stringify(requestedDataModel)}`);
  sourceDir = await fs.realpath(path.resolve(sourceDir));
  let layout = detectSourceDialect(sourceDir);
  const layoutNotes = [];
  if (layout.dialect === "code-site-project") {
    // A code-site project keeps its site records in .powerpages-site/ beside the app sources.
    const siteDir = await fs.realpath(path.join(sourceDir, ".powerpages-site"));
    layoutNotes.push({
      code: "CODE_SITE_PROJECT_SOURCE",
      projectDir: sourceDir,
      sourceDir: siteDir,
      message: `${sourceDir} is a code-site project; its site records are read from ${siteDir}.`,
    });
    sourceDir = siteDir;
    layout = detectSourceDialect(sourceDir);
  }
  const shortKey = layout.dialect === "short-key-yaml";
  // Commit times for differing duplicate copies: one HEAD lookup per import, then each
  // file's last commit time, kept in `cache` (a SolutionFileCache: by file path and
  // content, re-validated when the file's stamp changes, and only for the same HEAD).
  let headLookup = null;
  const commitTime = async (file) => {
    headLookup ??= git.head(sourceDir);
    const head = await headLookup;
    if (!head) return null;
    return cache ? cache.remember(file, "git-commit@1", head, () => git.commitTime(file)) : git.commitTime(file);
  };
  const files = await walk(sourceDir);
  const contents = await prefetch(files);
  const enhanced = files.some(
    (f) => path.basename(f) === "powerpagecomponent.xml",
  );
  const records = [];
  const diagnostics = [...layoutNotes];
  let website = {};
  // The data model: the enhanced layout is the enhanced data model; a YAML layout uses the
  // requested model, else standard (adx_ keys) or enhanced (short keys, assumed).
  const dataModel = enhanced ? "enhanced" : (requestedDataModel ?? (shortKey ? "enhanced" : "standard"));
  const dataModelSource = enhanced ? "export" : requestedDataModel ? "configured" : shortKey ? "assumed" : "export";
  if (enhanced && requestedDataModel === "standard")
    diagnostics.push({
      code: "DATA_MODEL_OVERRIDE_IGNORED",
      requested: requestedDataModel,
      message: "An unpacked Solution with powerpagecomponents/ is the enhanced data model; the requested standard data model is ignored.",
    });
  if (dataModelSource === "assumed")
    diagnostics.push({
      code: "DATA_MODEL_ASSUMED",
      dataModel,
      message:
        "The .powerpages-site layout does not record the site's data model; the enhanced data model is assumed (code sites require it). For a standard data model site set dataModel: standard (serve and inspect --data-model standard, the project portal's dataModel, or the catalogue site's mirage.dataModel).",
    });
  if (enhanced) {
    for (const file of files.filter(
      (f) => path.basename(f) === "powerpagecomponent.xml",
    )) {
      const xml = await read(file, contents);
      const type = Number(
        /<powerpagecomponenttype>\s*(\d+)\s*</.exec(xml)?.[1],
      );
      try {
        const content = JSON.parse(
          decodeXml(/<content>([\s\S]*?)<\/content>/.exec(xml)?.[1] ?? "{}"),
        );
        const attachment =
          /<filecontent\b([^>]*)>([\s\S]*?)<\/filecontent>/.exec(xml);
        // The component's site language is the <powerpagesitelanguageid> element outside
        // <content>; it selects language copies as adx_webpagelanguageid and
        // adx_contentsnippetlanguageid do in standard exports.
        const siteLanguageId = id(
          /<powerpagesitelanguageid>\s*(?:<powerpagesitelanguageid>)?\s*([^<\s][^<]*?)\s*<\/powerpagesitelanguageid>/.exec(xml)?.[1],
        );
        const languageFields = siteLanguageId
          ? {
              powerpagesitelanguageid: siteLanguageId,
              ...(type === 2 && content.webpagelanguageid == null ? { webpagelanguageid: siteLanguageId } : {}),
              ...(type === 7 && content.contentsnippetlanguageid == null ? { contentsnippetlanguageid: siteLanguageId } : {}),
            }
          : {};
        records.push({
          kind: TYPES[type] ?? `component:${type}`,
          powerpagecomponenttype: type,
          id: id(
            /powerpagecomponentid="([^"]+)"/.exec(xml)?.[1] ??
              path.basename(path.dirname(file)),
          ),
          name: decodeXml(/<name>([\s\S]*?)<\/name>/.exec(xml)?.[1] ?? ""),
          ...content,
          ...languageFields,
          statecode: Number(/<statecode>\s*(\d+)\s*</.exec(xml)?.[1] ?? 0),
          _file: file,
          _attachment: attachment
            ? {
                name: decodeXml(attachment[2]).trim(),
                mimeType: /mimetype="([^"]*)"/.exec(attachment[1])?.[1],
              }
            : null,
        });
      } catch (error) {
        diagnostics.push({
          code: "invalid-enhanced-content",
          file,
          message: error.message,
        });
      }
    }
    const sites = files.find(
      (f) => path.basename(f).toLowerCase() === "powerpagesites.xml",
    );
    if (sites) {
      const xml = await read(sites, contents);
      try {
        website = {
          ...JSON.parse(
            decodeXml(/<content>([\s\S]*?)<\/content>/.exec(xml)?.[1] ?? "{}"),
          ),
          id: id(/powerpagesiteid="([^"]+)"/.exec(xml)?.[1]),
          name: decodeXml(/<name>([\s\S]*?)<\/name>/.exec(xml)?.[1] ?? ""),
          // powerpagesite.enhancedauthorization (0-3), read by lib/platform-changes.mjs.
          ...(/<enhancedauthorization>\s*(\d+)\s*<\/enhancedauthorization>/.test(xml)
            ? { enhancedauthorization: Number(/<enhancedauthorization>\s*(\d+)\s*<\/enhancedauthorization>/.exec(xml)[1]) }
            : {}),
        };
      } catch (error) {
        diagnostics.push({ code: "invalid-website", message: error.message });
      }
    }
    // Site languages (powerpagesitelanguages.xml, the enhanced counterpart of
    // adx_websitelanguage) carry their language code and LCID directly.
    for (const file of files.filter((f) => path.basename(f).toLowerCase() === "powerpagesitelanguages.xml")) {
      const xml = await read(file, contents);
      for (const match of xml.matchAll(/<powerpagesitelanguage\b([^>]*)>([\s\S]*?)<\/powerpagesitelanguage>/g)) {
        const element = (name) => {
          const value = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(match[2])?.[1];
          return value === undefined ? undefined : decodeXml(value).trim();
        };
        let content = {};
        try {
          content = JSON.parse(element("content") || "{}");
        } catch (error) {
          diagnostics.push({ code: "invalid-enhanced-content", file, message: error.message });
        }
        records.push({
          kind: "websitelanguage",
          id: id(/powerpagesitelanguageid="([^"]+)"/.exec(match[1])?.[1]),
          name: element("name") ?? element("displayname") ?? "",
          ...content,
          ...(element("languagecode") ? { languagecode: element("languagecode") } : {}),
          ...(element("lcid") ? { lcid: Number(element("lcid")) } : {}),
          ...(element("displayname") ? { displayname: element("displayname") } : {}),
          statecode: Number(element("statecode") ?? 0),
          _file: file,
        });
      }
    }
  } else {
    for (const file of files.filter(
      (f) => /\.ya?ml$/i.test(f) && !/[\\/]deployment-profiles[\\/]/i.test(f),
    )) {
      const originalKind = path
        .basename(file)
        .replace(/\.ya?ml$/i, "")
        .split(".")
        .at(-1)
        .toLowerCase();
      const kind =
        originalKind === "webpagerule"
          ? "webpageaccesscontrolrule"
          : originalKind;
      try {
        const text = await read(file, contents);
        let rows;
        try {
          rows = YAML.parse(text);
        } catch (error) {
          if (!/Map keys must be unique/.test(error.message)) throw error;
          diagnostics.push({
            code: "duplicate-yaml-key",
            file,
            message: error.message,
            recovered: true,
          });
          rows = YAML.parse(text, { uniqueKeys: false });
        }
        if (!Array.isArray(rows)) rows = [rows];
        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          const record = {
            ...row,
            kind,
            id: id(
              field(
                row,
                `${kind === "basicform" ? "entityform" : kind === "advancedform" ? "webform" : kind === "list" ? "entitylist" : kind === "tablepermission" ? "entitypermission" : kind === "advancedformstep" ? "webformstep" : kind === "basicformmetadata" ? "entityformmetadata" : kind === "advancedformmetadata" ? "webformmetadata" : kind}id`,
              ) ?? (shortKey ? row.id : undefined),
            ),
            name: field(row, "name", ""),
            // Short-key records of an enhanced data model site are powerpagecomponent rows.
            ...(shortKey && dataModel === "enhanced" && COMPONENT_TYPE_OF_KIND[kind] ? { powerpagecomponenttype: COMPONENT_TYPE_OF_KIND[kind] } : {}),
            _file: file,
          };
          records.push(record);
          if (kind === "website") website = record;
        }
      } catch (error) {
        diagnostics.push({
          code: "invalid-yaml",
          file,
          message: error.message,
        });
      }
    }
  }
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
        code: "DUPLICATE_RECORD_IDENTICAL",
        kind: copy.kind,
        id: copy.id,
        file: copy._file,
        firstFile: same.record._file,
        message: "The export contains the same record twice with identical content; the first copy is used.",
      });
    }
    if (distinct.length < 2) continue;
    const { record: used, reason } = await chooseRecordCopy(distinct.map((item) => item.record), { commitTime });
    for (const { record: copy } of distinct) {
      if (copy === used) continue;
      for (const twin of copies) if (signatureOf(twin) === signatureOf(copy)) dropped.add(twin);
      diagnostics.push({
        code: "DUPLICATE_RECORD_RESOLVED",
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
  if (deploymentProfile) {
    if (!/^[\w.-]+$/.test(deploymentProfile))
      throw new Error("Select a deployment profile by its exported name");
    const profileName = deploymentProfile.replace(/\.deployment\.ya?ml$/i, "");
    const profile = files.find(
      (f) =>
        /[\\/]deployment-profiles[\\/]/i.test(f) &&
        path
          .basename(f)
          .replace(/\.deployment\.ya?ml$/i, "")
          .toLowerCase() === profileName.toLowerCase(),
    );
    if (!profile)
      throw new Error(
        `Deployment profile '${deploymentProfile}' is absent in the export`,
      );
    const values = YAML.parse(await read(profile, contents));
    for (const [entity, rows] of Object.entries(values ?? {})) {
      const raw = entity.replace(/^(?:adx|mspp)_/, "");
      const kind =
        {
          entityform: "basicform",
          webform: "advancedform",
          entitylist: "list",
          entitypermission: "tablepermission",
        }[raw] ?? raw;
      for (const patch of Array.isArray(rows) ? rows : [rows]) {
        const targetId = id(
          patch?.[`${entity}id`] ??
            Object.entries(patch ?? {}).find(
              ([k]) => k === `adx_${raw}id` || k === `mspp_${raw}id`,
            )?.[1],
        );
        const record = records.find(
          (r) =>
            r.kind === kind &&
            (targetId ? r.id === targetId : r.name === field(patch, "name")),
        );
        if (!record) {
          diagnostics.push({
            code: "DEPLOYMENT_PROFILE_TARGET_UNRESOLVED",
            profile: profileName,
            entity,
            id: targetId,
            message: "Profile override has no matching exported record",
          });
          continue;
        }
        const fields = Object.keys(patch).filter((k) => !k.endsWith("id"));
        record._originalName ??= record.name;
        Object.assign(record, patch);
        record.name = field(record, "name", record.name);
        record._profileFields = {
          ...record._profileFields,
          ...Object.fromEntries(
            fields.map((k) => [k.replace(/^(?:adx|mspp)_/, ""), patch[k]]),
          ),
        };
        record._deploymentProfile = profileName;
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
  const live = records.filter(active);
  const byKind = (kind) => live.filter((r) => r.kind === kind);
  const language = id(languageId ?? field(website, "defaultlanguage"));
  // A page record without an ID (adx_webpageid, or id: in a .powerpages-site export) cannot be
  // placed in the page tree: it is skipped and reported.
  const rawPages = byKind("webpage").filter((r) => r.id);
  const unidentifiedPages = byKind("webpage").filter((r) => !r.id);
  if (unidentifiedPages.length)
    diagnostics.push({
      code: "RECORD_ID_MISSING",
      kind: "webpage",
      count: unidentifiedPages.length,
      files: unidentifiedPages.slice(0, 5).map((r) => r._file),
      message: `${unidentifiedPages.length} web page record${unidentifiedPages.length === 1 ? " has" : "s have"} no ID (adx_webpageid, or id: in a .powerpages-site export) and cannot be placed in the page tree.`,
    });
  const roots = rawPages.filter((r) => field(r, "isroot", true) !== false);
  const aliases = new Map();
  for (const r of rawPages) {
    const root = id(field(r, "rootwebpageid"));
    if (root) aliases.set(r.id, root);
  }
  const rootMap = new Map(roots.map((r) => [r.id, r]));
  const urls = new Map();
  const pageUrl = (pageId, seen = new Set()) => {
    pageId = aliases.get(id(pageId)) ?? id(pageId);
    if (!pageId) return "/";
    if (urls.has(pageId)) return urls.get(pageId);
    const r = rootMap.get(pageId);
    if (!r || seen.has(pageId)) return null;
    seen.add(pageId);
    const parent = id(field(r, "parentpageid"));
    const base = parent ? pageUrl(parent, seen) : "/";
    if (base === null) return null;
    const partial = String(field(r, "partialurl", "")).replace(
      /^\/+|\/+$/g,
      "",
    );
    const url = partial ? `${base.replace(/\/$/, "")}/${partial}/` : base;
    urls.set(pageId, url);
    return url;
  };
  async function source(record, suffix, fallbackField) {
    if (Object.hasOwn(record._profileFields ?? {}, fallbackField))
      return String(localized(record._profileFields[fallbackField], lcid));
    if (enhanced)
      return String(localized(field(record, fallbackField, ""), lcid));
    const stem = record._file.replace(/\.ya?ml$/i, "");
    return (
      (await read(`${stem}.${suffix}`, contents)) ||
      String(localized(field(record, fallbackField, ""), lcid))
    );
  }
  const pages = [];
  for (const r of roots) {
    const copies = rawPages.filter(
      (c) => id(field(c, "rootwebpageid")) === r.id,
    );
    const copy =
      copies.find((c) => id(field(c, "webpagelanguageid")) === language) ??
      copies.find((c) => /en-US/i.test(c._file)) ??
      copies[0] ??
      r;
    const merged = { ...r, ...copy };
    // Every language content page by its website language; the renderer selects one per
    // request (website.selected_language).
    const translations = {};
    for (const variant of copies) {
      const variantLanguage = id(field(variant, "webpagelanguageid"));
      if (!variantLanguage || Object.hasOwn(translations, variantLanguage)) continue;
      translations[variantLanguage] = {
        title: [field(variant, "title"), field(variant, "name"), field(r, "title"), field(r, "name")].map((value) => String(localized(value, lcid) ?? "").trim()).find(Boolean) ?? "",
        html: await source(variant, "copy.html", "copy"),
        css: await source(variant, "custom_css.css", "customcss"),
        js: await source(variant, "custom_javascript.js", "customjavascript"),
        summary: await source(variant, "summary.html", "summary"),
        metadata: { ...r, ...variant },
      };
    }
    const url = pageUrl(r.id);
    if (url === null) {
      diagnostics.push({
        code: "page-hierarchy",
        pageId: r.id,
        message: "Missing parent or cycle",
      });
      continue;
    }
    pages.push({
      id: r.id,
      name: field(r, "name", ""),
      // The node title is adx_title, else adx_name, of the language content page.
      title: [field(copy, "title"), field(copy, "name"), field(r, "title"), field(r, "name")].map((value) => String(localized(value, lcid) ?? "").trim()).find(Boolean) ?? "",
      url,
      parentId: id(field(r, "parentpageid")),
      pageTemplateId: id(field(merged, "pagetemplateid")),
      html: await source(copy, "copy.html", "copy"),
      css: await source(copy, "custom_css.css", "customcss"),
      js: await source(copy, "custom_javascript.js", "customjavascript"),
      summary: await source(copy, "summary.html", "summary"),
      formId: id(field(merged, "entityformid", field(merged, "entityform"))),
      advancedFormId: id(field(merged, "webformid", field(merged, "webform"))),
      listId: id(field(merged, "entitylistid", field(merged, "entitylist"))),
      metadata: merged,
      translations,
    });
  }
  const templates = {};
  for (const r of byKind("webtemplate")) {
    const t = {
      id: r.id,
      name: r.name,
      source: await source(r, "source.html", "source"),
      metadata: r,
    };
    templates[t.id] = t;
    templates[t.name] = t;
  }
  const snippets = {};
  const snippetRows = byKind("contentsnippet").sort(
    (a, b) =>
      Number(id(field(a, "contentsnippetlanguageid")) === language) -
      Number(id(field(b, "contentsnippetlanguageid")) === language),
  );
  const snippetTranslations = {};
  for (const r of snippetRows) {
    const value = await source(r, "value.html", "value");
    snippets[r.name] = value;
    const snippetLanguage = id(field(r, "contentsnippetlanguageid"));
    if (snippetLanguage) (snippetTranslations[snippetLanguage] ??= {})[r.name] = value;
    if (r._originalName && r._originalName !== r.name) {
      snippets[r._originalName] = value;
      if (snippetLanguage) snippetTranslations[snippetLanguage][r._originalName] = value;
      diagnostics.push({
        code: "DEPLOYMENT_PROFILE_SNIPPET_NAME_ALIAS",
        recordId: r.id,
        sourceName: r._originalName,
        profileName: r.name,
        message:
          "Profile renames a content snippet; its exported source name remains available for template references",
      });
    }
  }
  const settings = {};
  for (const r of byKind("sitesetting"))
    settings[r.name] = String(field(r, "value", ""));
  const webFiles = [];
  const webFileRecords = byKind("webfile");
  // Attachment lookups are independent; resolve them concurrently, then keep record order.
  const attachments = await mapLimit(webFileRecords, IO_CONCURRENCY, async (r) => {
    if (enhanced)
      return r._attachment?.name
        ? containedFile(
            sourceDir,
            path.join(path.dirname(r._file), "filecontent", r._attachment.name),
          )
        : null;
    const candidates = [
      path.basename(r._file).replace(/\.webfile\.ya?ml$/i, ""),
      r.filename,
      r.name,
    ].filter(Boolean);
    for (const candidate of candidates) {
      const found = await containedFile(
        sourceDir,
        path.join(path.dirname(r._file), String(candidate)),
      );
      if (found) return found;
    }
    return null;
  });
  for (const [index, r] of webFileRecords.entries()) {
    const parent = pageUrl(field(r, "parentpageid"));
    const file = attachments[index];
    // Partial URLs are relative to the parent page; leading slashes are dropped as for pages.
    const partial = field(r, "partialurl") == null ? null : String(field(r, "partialurl")).replace(/^\/+/, "");
    if (!file || parent === null || partial == null) {
      diagnostics.push({
        code: "webfile-missing",
        file: r._file,
        message: "Attachment or parent missing",
      });
      continue;
    }
    webFiles.push({
      id: r.id,
      name: r.name,
      url: `${parent.replace(/\/$/, "")}/${partial}`,
      file,
      mimeType: r.mimetype ?? r._attachment?.mimeType ?? null,
      metadata: r,
    });
  }
  // One URL claimed by several pages, or by several web files. Dataverse returns rows in
  // primary-key order when a query sets no order; ordered by SQL Server uniqueidentifier,
  // the default routing model selects the FIRST claiming page and LAST claiming web file,
  // as a lookup that takes the first match for pages and keeps the last entry per URL for files
  // (docs/bootstrap-and-sources.md). Claimants without GUID IDs keep export order. The
  // served claimant moves ahead of the others, so every lookup by URL finds it first;
  // pages answer paths ending with "/", web files others.
  for (const [kind, entries] of [["webpage", pages], ["webfile", webFiles]]) {
    const claims = new Map();
    for (const entry of entries) {
      const key = normalizePortalPath(entry.url);
      if (!claims.has(key)) claims.set(key, []);
      claims.get(key).push(entry);
    }
    for (const [key, claimants] of claims) {
      if (claimants.length < 2) continue;
      const keys = new Map(claimants.map((entry) => [entry, guidOrderKey(entry.id)]));
      const ordered = claimants.every((entry) => keys.get(entry));
      const rule = ordered ? (kind === "webpage" ? "id-order" : "id-order-last") : "export-order";
      const sorted = ordered ? [...claimants].sort((a, b) => (keys.get(a) < keys.get(b) ? -1 : keys.get(a) > keys.get(b) ? 1 : 0)) : claimants;
      const used = rule === "id-order-last" ? sorted.at(-1) : sorted[0];
      if (used !== claimants[0]) {
        entries.splice(entries.indexOf(used), 1);
        entries.splice(entries.indexOf(claimants[0]), 0, used);
      }
      diagnostics.push({
        code: "URL_CLAIMED_TWICE",
        kind,
        path: key,
        usedId: used.id,
        rule,
        claimants: claimants.map((entry) => ({ id: entry.id, name: entry.name, url: entry.url, file: entry.metadata?._file ?? null })),
        message: `${claimants.length} ${kind === "webpage" ? "pages" : "web files"} claim ${claimants[0].url}: ${claimants.map((entry) => `'${entry.name}'`).join(", ")}; '${used.name}' is served (${rule === "id-order" ? "first in Dataverse ID" : rule === "id-order-last" ? "last in Dataverse ID" : "first in export"} order).`,
      });
    }
  }
  const pageTemplates = byKind("pagetemplate").map((r) => ({
    id: r.id,
    name: r.name,
    webTemplateId: id(field(r, "webtemplateid")),
    useHeaderFooter: field(r, "usewebsiteheaderandfooter", true) !== false,
    rewriteUrl: field(r, "rewriteurl"),
    metadata: r,
  }));
  const links = byKind("weblink")
    .map((r) => ({
      id: r.id,
      name: r.name,
      title: field(r, "title", r.name),
      url: field(r, "externalurl", pageUrl(field(r, "pageid"))),
      pageId: id(field(r, "pageid")),
      parentId: id(field(r, "parentweblinkid")),
      setId: id(field(r, "weblinksetid")),
      displayOrder: Number(field(r, "displayorder", 0)),
      display_page_child_links: field(r, "displaypagechildlinks", false),
      open_in_new_window: field(r, "openinnewwindow", false),
      Open_In_New_Window: field(r, "openinnewwindow", false),
      disable_page_validation: field(r, "disablepagevalidation", false),
      description: localized(field(r, "description", ""), lcid),
      metadata: r,
    }))
    .sort((a, b) => a.displayOrder - b.displayOrder);
  for (const link of links)
    link.weblinks = links.filter((c) => c.parentId === link.id);
  // Web link sets: every active set stays reachable by ID (weblinkSets, export order); the
  // name map holds the FIRST active set per exact name, as the platform's name lookup
  // (first active set in retrieval order). Shared names are reported.
  const weblinkSets = byKind("weblinkset").map((r) => ({
    id: r.id,
    name: r.name,
    weblinks: links.filter((c) => c.setId === r.id && !c.parentId),
  }));
  const weblinks = {};
  for (const set of weblinkSets) {
    if (!Object.hasOwn(weblinks, set.name)) {
      weblinks[set.name] = set;
      continue;
    }
    diagnostics.push({
      code: "WEBLINK_SET_NAME_SHARED",
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
  for (const r of byKind("sitemarker")) {
    const pageId = id(field(r, "pageid"));
    siteMarkers.push({ id: r.id, name: r.name, pageId });
    if (Object.hasOwn(sitemarkers, r.name)) {
      diagnostics.push({
        code: "SITE_MARKER_DUPLICATE",
        id: r.id,
        name: r.name,
        message: "Another active site marker has the same name; the first exported marker is used.",
      });
      continue;
    }
    sitemarkers[r.name] = pages.find((p) => p.id === pageId) ?? { url: null };
  }
  const all = (kind) => records.filter((r) => r.kind === kind);
  const flagOf = (value) =>
    value === true || value === 1 || (typeof value === "string" && value.toLowerCase() === "true");
  const idList = (value) =>
    (Array.isArray(value) ? value : value == null ? [] : [value]).map(id).filter(Boolean);
  // The special web roles are identified by their Authenticated/Anonymous Users Role
  // flags. An export without an active flagged role falls back to the documented default
  // role name, with a diagnostic (an enhanced export can leave "Authenticated Users"
  // unflagged).
  for (const [flag, defaultName] of [["authenticatedusersrole", "Authenticated Users"], ["anonymoususersrole", "Anonymous Users"]]) {
    const roles = byKind("webrole");
    const flagged = roles.filter((role) => flagOf(field(role, flag, false)));
    const named = roles.filter((role) => String(role.name ?? "").trim().toLowerCase() === defaultName.toLowerCase());
    if (flagged.length) {
      // Flags are used as exported. An unusual assignment (several flagged roles, or the
      // role with the default name left unflagged) is reported, never corrected.
      const unflagged = named.filter((role) => !flagged.includes(role));
      if (flagged.length > 1 || unflagged.length)
        diagnostics.push({
          code: "WEB_ROLE_FLAG_AS_EXPORTED",
          flag,
          roles: flagged.map((role) => role.name),
          ...(unflagged.length ? { unflagged: unflagged.map((role) => role.name) } : {}),
          message: `The export flags ${flagged.map((role) => `"${role.name}"`).join(", ")} as the ${defaultName} role${unflagged.length ? `; ${unflagged.map((role) => `"${role.name}"`).join(", ")} is not flagged` : ""}. The flags are used as exported.`,
        });
      continue;
    }
    if (named.length === 1) {
      named[0][`adx_${flag}`] = true;
      diagnostics.push({
        code: "WEB_ROLE_FLAG_INFERRED",
        id: named[0].id,
        name: named[0].name,
        flag,
        message: `No active web role is flagged as the ${defaultName} role; the role named "${defaultName}" is used as the documented default.`,
      });
    } else if (named.length > 1)
      diagnostics.push({
        code: "WEB_ROLE_FLAG_AMBIGUOUS",
        ids: named.map((role) => role.id),
        flag,
        message: `No active web role is flagged as the ${defaultName} role and ${named.length} roles are named "${defaultName}"; none is used.`,
      });
  }
  // Publishing states are evaluated by their Is Visible flag; the legacy content map
  // loads them without a statecode filter, so inactive state records keep applying.
  const publishingStates = all("publishingstate").map((r) => ({
    id: r.id,
    name: r.name,
    isVisible: flagOf(field(r, "isvisible", false)),
    isDefault: flagOf(field(r, "isdefault", false)),
    displayOrder: Number(field(r, "displayorder", 0)),
    active: active(r),
  }));
  // adx_redirect matching has no statecode filter in the legacy provider.
  const redirects = all("redirect").map((r) => ({
    id: r.id,
    name: r.name,
    inboundUrl: field(r, "inboundurl"),
    statusCode: field(r, "statuscode") == null ? null : Number(field(r, "statuscode")),
    redirectUrl: field(r, "redirecturl") ?? null,
    webPageId: id(field(r, "webpageid")) || null,
    siteMarkerId: id(field(r, "sitemarkerid")) || null,
    active: active(r),
    file: r._file,
  }));
  const urlHistory = byKind("urlhistory").map((r) => ({
    id: r.id,
    path: field(r, "name", r.name),
    webPageId: id(field(r, "webpageid")) || null,
    changedDate: field(r, "changeddate") ?? null,
  }));
  const websiteAccess = byKind("websiteaccess").map((r) => ({
    id: r.id,
    name: r.name,
    roleIds: idList(field(r, "websiteaccess_webrole", [])),
    manageContentSnippets: flagOf(field(r, "managecontentsnippets", false)),
    manageSiteMarkers: flagOf(field(r, "managesitemarkers", false)),
    manageWebLinkSets: flagOf(field(r, "manageweblinksets", false)),
    previewUnpublishedEntities: flagOf(field(r, "previewunpublishedentities", false)),
  }));
  // Portal languages of a short-key export (.portalconfig/*.portallanguage.yml): the language
  // code and LCID that its site languages link to through portallanguageid.
  const portalLanguages = [];
  const portalConfig = path.join(sourceDir, ".portalconfig");
  let configEntries = [];
  try {
    configEntries = await fs.readdir(portalConfig, { withFileTypes: true });
  } catch {}
  // One record per file (short-key exports: *.portallanguage.yml) or a list of records (PAC YAML:
  // portallanguage.yml, whose enhanced-data-model website languages share their portal
  // language's ID).
  for (const entry of configEntries.filter((item) => item.isFile() && /(?:^|\.)portallanguage\.ya?ml$/i.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(portalConfig, entry.name);
    try {
      const parsed = YAML.parse(await fs.readFile(file, "utf8")) ?? {};
      for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!row || typeof row !== "object") continue;
        portalLanguages.push({
          id: id(field(row, "portallanguageid") ?? row.id),
          name: String(field(row, "name", "")),
          code: String(field(row, "languagecode", "")).trim() || null,
          lcid: Number(field(row, "lcid", field(row, "systemlanguage"))) || null,
          displayName: String(field(row, "displayname", "")).trim() || null,
          file,
        });
      }
    } catch (error) {
      diagnostics.push({ code: "invalid-yaml", file, message: error.message });
    }
  }
  const portalLanguageById = new Map(portalLanguages.filter((item) => item.id).map((item) => [item.id, item]));
  // URL language codes: the exported code (enhanced site languages, or the linked portal
  // language of a short-key export), else the documented portal-language catalogue by the
  // website language name, else (default language) by the website's base LCID.
  const baseLcid = Number(field(website, "website_language")) || null;
  const websiteLanguages = byKind("websitelanguage").map((r) => {
    const stateId = id(field(r, "publishingstate", field(r, "publishingstateid")));
    const state = publishingStates.find((s) => s.id === stateId);
    const isDefault = Boolean(language) && r.id === language;
    const linked = portalLanguageById.get(id(field(r, "portallanguageid")));
    const exportedCode = String(field(r, "languagecode") ?? linked?.code ?? "").trim();
    const known = exportedCode
      ? { code: exportedCode, lcid: Number(field(r, "lcid")) || linked?.lcid || portalLanguage({ name: exportedCode })?.lcid || null }
      : (portalLanguage({ name: r.name }) ?? (isDefault ? portalLanguage({ lcid: baseLcid }) : null));
    if (!known)
      diagnostics.push({
        code: "WEBSITE_LANGUAGE_CODE_UNKNOWN",
        id: r.id,
        name: r.name,
        message: "The website language name matches no documented portal language; its URL language code is unknown.",
      });
    return {
      id: r.id,
      name: r.name,
      portalLanguageId: id(field(r, "portallanguageid")) || null,
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
    entityName: field(r, "entitylogicalname", field(r, "entityname")),
    formName: field(r, "formname"),
    mode: field(r, "mode", r.kind === "basicform" ? 100000000 : undefined),
    js: field(r, "customjavascript", ""),
    metadata: r,
  });
  const forms = byKind("basicform").map(normalizeComponent);
  for (const f of forms)
    f.js = await source(f.metadata, "custom_javascript.js", "customjavascript");
  const lists = byKind("list").map(normalizeComponent);
  for (const list of lists)
    list.js = await source(
      list.metadata,
      "custom_javascript.js",
      "customjavascript",
    );
  for (const step of byKind("advancedformstep"))
    step.customJavascript = await source(
      step,
      "custom_javascript.js",
      "customjavascript",
    );
  const shortcuts = byKind("shortcut").map((record) => {
    const targetPageId = id(field(record, "webpageid"));
    const targetFileId = id(field(record, "webfileid"));
    const target =
      pages.find((page) => page.id === targetPageId) ??
      webFiles.find((file) => file.id === targetFileId);
    return {
      id: record.id,
      name: record.name,
      title: localized(
        field(record, "title") || target?.title || target?.name || record.name,
        lcid,
      ),
      url: field(record, "externalurl", target?.url),
      parentId: id(field(record, "parentpage_webpageid")),
      targetPageId,
      targetFileId,
      displayOrder: Number(field(record, "displayorder", 0)),
      disableTargetValidation: field(record, "disabletargetvalidation", false),
      metadata: record,
    };
  });
  // Server logic (component type 35, adx_serverlogic): the record, its web roles and its code
  // file. Execution requires an explicit trusted pack registration; imports alone
  // keep /_api/serverlogics/<name> unsupported (lib/server-logic.mjs).
  const serverLogics = await mapLimit(byKind("serverlogic"), IO_CONCURRENCY, async (record) => {
    const folder = path.dirname(record._file);
    const stem = path.basename(record._file).replace(/\.serverlogic\.ya?ml$/i, "");
    const candidates = enhanced
      ? [record._attachment?.name ? path.join(folder, "filecontent", record._attachment.name) : null]
      : [path.join(folder, `${stem}.js`), path.join(folder, `${record.name}.js`), `${record._file.replace(/\.ya?ml$/i, "")}.js`];
    let file = null;
    for (const candidate of candidates.filter(Boolean)) if ((file = await containedFile(sourceDir, candidate))) break;
    if (!file)
      diagnostics.push({
        code: "SERVER_LOGIC_CODE_MISSING",
        id: record.id,
        name: record.name,
        file: record._file,
        message: `Server logic "${record.name}" has no code file in the export.`,
      });
    return {
      id: record.id,
      name: record.name,
      displayName: field(record, "display_name", null),
      description: field(record, "description", null),
      roleIds: idList(field(record, "serverlogic_adx_webrole", [])),
      file,
    };
  });
  // Cloud flows (component type 33, adx_cloudflowconsumer): the trigger URL path, the flow and
  // its web roles. Local execution requires a trusted pack registration; otherwise a trigger is 501.
  const relationshipOf = (record, name) => {
    const found = Object.keys(record).find((key) => key.toLowerCase() === name);
    return idList(found ? record[found] : []);
  };
  const cloudFlows = byKind("cloudflowconsumer").map((record) => {
    const apiUrl = field(record, "flowapiurl");
    let triggerPath = null;
    try {
      triggerPath = apiUrl ? new URL(String(apiUrl), "http://local.invalid").pathname : null;
    } catch {}
    return {
      id: record.id,
      name: record.name,
      path: triggerPath,
      processId: id(field(record, "processid") ?? record._adx_processid_value) || null,
      roleIds: relationshipOf(record, "adx_cloudflowconsumer_adx_webrole"),
    };
  });
  // Platform changes the runtime reports instead of modelling (lib/platform-changes.mjs).
  diagnostics.push(...platformChangeDiagnostics({ website, lists, forms, records, pages, templates }));
  // A source with zero recognised pages is not a portal (serve, inspect and bootstrap-report
  // refuse it through assertPortalSource, lib/source-dialect.mjs).
  if (!pages.length)
    diagnostics.push({
      code: "PORTAL_SOURCE_EMPTY",
      dialect: layout.dialect,
      message: unrecognisedSourceMessage(sourceDir, layout, { pageRecords: records.filter((record) => record.kind === "webpage").length }),
    });
  return {
    sourceDir,
    source: layout,
    // The site's data model (the runtime's adx_ or powerpagecomponent tables and relationships).
    format: dataModel,
    dataModel,
    dataModelSource,
    website,
    pages,
    templates,
    snippets,
    snippetTranslations,
    settings,
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
          ...(portalLanguage({ lcid: baseLcid }) ? { code: portalLanguage({ lcid: baseLcid }).code, lcid: baseLcid } : {}),
        })
      : null,
    forms,
    lists,
    advancedForms: byKind("advancedform").map(normalizeComponent),
    records,
    diagnostics,
    deploymentProfile: deploymentProfile ?? null,
    profileChanges,
  };
}

export { field as portalField };
