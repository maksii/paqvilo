// Code components (PCF) and Solution web resources a portal page loads, mapped to the developer's Solution files.
//
// A live page declares each code component itself: `<span id="PcfControlConfig_<id>" data-pcf-control="{JSON}">`,
// HTML-entity encoded. The JSON names the Solution control (`Name`) and its resources in order; a resource of
// `Type` 0 is the code bundle and `Type` 1 a style sheet, each with `Path` the GUID the page requests as
// `/_pcfwebresource/<guid>`. Type 2 can name a localization GUID. When exactly one local RESX matches it, the mapping
// can answer an explicit XML request without changing the portal's inline configuration (Type 3).
// The declared code and style resources are joined, in order, to the resources of that kind the control's
// ControlManifest.xml declares (the catalogue mirage/lib/code-components.mjs importCodeComponents reads, which admits
// only manifest-declared files inside the control folder). Each kind joins on its own: a kind is refused, and no file
// is served for its addresses, when its counts differ, when its manifest resources declare different load orders (the
// order the page lists them in is then not established) or when an entry names no admitted file; the other kinds still
// map, and the difference (with any change of the declared parameter names) is a manifest change to deploy
// (`deployments`, Lense needsDeploy). The whole control is refused when no kind maps or it is not in the sources.
import fs from 'node:fs';
import path from 'node:path';
import { annotateRuntimeSources } from './runtime-sources.mjs';

const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** The address of a code component resource on the portal origin; [1] is its GUID. */
export const PCF_RESOURCE_PATH = new RegExp(String.raw`^\/_pcfwebresource\/(${GUID})\/?$`, 'i');
/** The address of a Solution web resource on the portal origin (a form's web resource control); [1] is its name. */
export const WEB_RESOURCE_PATH = /^\/_webresource\/(\w[\w./-]{0,255})$/;
/** The address Mirage serves a Solution code component resource at (mirage/lib/code-components.mjs). */
const MIRAGE_PCF_PREFIX = '/__sim-static/pcf/';
/** Declared resource types that the page requests, and the manifest resource kind each one is. */
const PCF_RESOURCE_TYPES = Object.freeze({ 0: 'code', 1: 'css' });
const PCF_RESX_TYPE = 2;

export function acceptsPcfResx(value) {
  return (
    typeof value === 'string' &&
    value
      .split(',')
      .some(
        (item) =>
          /^\s*(?:application|text)\/xml\s*(?:;|$)/i.test(item) && !/;\s*q\s*=\s*0(?:\.0+)?\s*(?:;|$)/i.test(item),
      )
  );
}

/** Why a declared code component resource is not mapped to a file. */
export const PCF_REFUSALS = Object.freeze({
  'pcf-control-not-in-sources': 'The code component is not in your Solution sources.',
  'pcf-manifest-mismatch':
    "The resources the page declares do not match the control's ControlManifest.xml (count or load order per kind), so no local file is served for them.",
});

const MAX_DECLARATIONS = 200;
const MAX_ATTRIBUTE_CHARS = 4 * 1024 * 1024;
const MAX_RESOURCES = 500;
const MAX_ENTRIES = 4096;
const MAX_JOINS = 256;

const NAMED = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ' };
/** Decodes the character references of an HTML attribute value (named ones the platform writes, and numeric). */
export function decodeHtmlAttribute(text) {
  return String(text).replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]+);/gi, (whole, name) => {
    if (name[0] !== '#') return NAMED[name.toLowerCase()] ?? whole;
    const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** One declaration attribute as `{ name, resources }`, or null when it is unreadable. */
function readDeclaration(raw) {
  let config;
  try {
    config = JSON.parse(decodeHtmlAttribute(raw));
  } catch {
    return null;
  }
  if (!config || typeof config.Name !== 'string' || !/^[\w.]{1,256}$/.test(config.Name)) return null;
  if (!Array.isArray(config.Resources) || config.Resources.length > MAX_RESOURCES) return null;
  const resources = [];
  for (const resource of config.Resources) {
    if (!resource || (!Object.hasOwn(PCF_RESOURCE_TYPES, resource.Type) && resource.Type !== PCF_RESX_TYPE)) continue;
    const guid =
      typeof resource.Path === 'string' && new RegExp(`^${GUID}$`, 'i').test(resource.Path)
        ? resource.Path.toLowerCase()
        : null;
    if (resource.Type !== PCF_RESX_TYPE || guid) resources.push({ type: resource.Type, guid });
  }
  // The parameter names the page configures (`Properties[].Name`), compared with the local manifest.
  const properties =
    Array.isArray(config.Properties) &&
    config.Properties.length <= MAX_RESOURCES &&
    config.Properties.every((property) => typeof property?.Name === 'string')
      ? config.Properties.map((property) => property.Name)
      : null;
  return { name: config.Name, resources, ...(properties ? { properties } : {}) };
}

/**
 * Every code component the HTML declares: `{ name, resources: [{ type, guid }] }`, resources of the requested types
 * only, in the order the page lists them. A requestable RESX declaration has a GUID. Code and CSS entries without
 * their GUID are kept for the manifest check. An unreadable declaration is skipped.
 */
export function pcfDeclarations(html, { limit = MAX_DECLARATIONS } = {}) {
  const found = [];
  if (typeof html !== 'string' || !html.includes('data-pcf-control')) return found;
  for (const match of html.matchAll(/\bdata-pcf-control\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    if (found.length >= limit) break;
    const raw = match[1] ?? match[2];
    if (raw.length > MAX_ATTRIBUTE_CHARS) continue;
    const declaration = readDeclaration(raw);
    if (declaration) found.push(declaration);
  }
  return found;
}

/**
 * Joins one declaration to its Solution control in `catalogue` (importCodeComponents). Returns
 * `{ control, componentKey, manifestFile, resources: [{ guid, kind, order, path, file, controlRoot }] }`, or
 * `{ refused, control, componentKey?, manifestFile?, detail? }`. Only files the catalogue admitted are named.
 */
// One kind of a declaration joined to the manifest resources of that kind: `{ resources }`, or `{ mismatch }` when the
// counts differ, the manifest's load orders of that kind differ, or an entry names no GUID or no admitted file.
function joinKind(declaration, control, catalogue, type, kind) {
  const declared = declaration.resources.filter((resource) => resource.type === Number(type));
  const manifest = (control.resources ?? []).filter((resource) => resource.kind === kind);
  if (declared.length !== manifest.length)
    return { declared, mismatch: { kind, declared: declared.length, manifest: manifest.length } };
  if (new Set(manifest.map((resource) => resource.order)).size > 1)
    return { declared, mismatch: { kind, order: 'differs' } };
  const resources = [];
  for (const [order, item] of declared.entries()) {
    const resource = manifest[order];
    const asset = catalogue.assets?.get(resource.url);
    if (!item.guid || !asset?.file || !asset.root) return { declared, mismatch: { kind, order } };
    resources.push({ guid: item.guid, kind, order, path: resource.path, file: asset.file, controlRoot: asset.root });
  }
  return { declared, resources };
}

// The declared parameter names against the manifest's: a difference is a manifest change the portal has not deployed.
// Not yet established from live evidence: whether `Properties[]` lists every manifest property (outputs, unbound inputs) is
// not established, so a shorter live list is never a mismatch. Only a name the page declares and the local manifest no
// longer has is (a removed or renamed parameter). The `Type` numbers are not mapped to manifest types yet.
function propertyMismatch(declaration, control) {
  if (!declaration.properties) return null;
  const local = (control.properties ?? []).map((property) => String(property.name));
  const known = new Set(local.map((name) => name.toLowerCase()));
  const removed = declaration.properties.filter((name) => !known.has(name.toLowerCase()));
  return removed.length ? { kind: 'property', declared: removed, manifest: local } : null;
}

export function joinPcfDeclaration(declaration, catalogue) {
  const wanted = declaration.name.toLowerCase();
  const schema = [...(catalogue?.controls?.keys() ?? [])].find((name) => name.toLowerCase() === wanted);
  if (!schema) return { refused: 'pcf-control-not-in-sources', control: declaration.name };
  const control = catalogue.controls.get(schema);
  const identity = { control: schema, componentKey: 'pcf:' + wanted, manifestFile: control.file };
  // Each kind joins on its own: a kind whose resources differ from the page's (a local style added, a bundle split)
  // refuses only its own addresses and is a manifest change to deploy; the other kinds still map.
  const resources = [],
    mismatches = [],
    refusedGuids = [];
  for (const [type, kind] of Object.entries(PCF_RESOURCE_TYPES)) {
    const joined = joinKind(declaration, control, catalogue, type, kind);
    if (joined.resources) resources.push(...joined.resources);
    else {
      mismatches.push(joined.mismatch);
      refusedGuids.push(...joined.declared.map((item) => item.guid).filter(Boolean));
    }
  }
  if (!resources.length && mismatches.length)
    return { refused: 'pcf-manifest-mismatch', ...identity, detail: mismatches[0], mismatches };
  const properties = propertyMismatch(declaration, control);
  if (properties) mismatches.push(properties);
  if (mismatches.length) Object.assign(identity, { mismatches, refusedGuids });
  const declaredResx = declaration.resources.filter((resource) => resource.type === PCF_RESX_TYPE);
  const manifestResx = (control.resources ?? []).filter((resource) => resource.kind === 'resx');
  if (!declaredResx.length) return { ...identity, resources };
  const resource = manifestResx.length === 1 ? manifestResx[0] : null;
  const asset = resource && catalogue.assets?.get(resource.url);
  if (declaredResx.length !== 1 || !asset?.file || !asset.root)
    return { ...identity, resources, unresolvedResx: declaredResx.map((item) => item.guid) };
  resources.push({
    guid: declaredResx[0].guid,
    kind: 'resx',
    order: 0,
    path: resource.path,
    file: asset.file,
    controlRoot: asset.root,
  });
  return { ...identity, resources };
}

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/**
 * How a Solution file is named outside the portal export, as the inspection report names it
 * (runtime-sources.mjs annotateRuntimeSources: `@<root folder>/<path>`), and the Solution root that holds it.
 */
function solutionReference(file, { sourceDir, roots }) {
  const row = { sourceFile: file };
  annotateRuntimeSources(row, { sourceDir, roots: [sourceDir, ...roots] });
  if (!row.ref || !row.path) return null;
  const root = roots.find((candidate) => inside(candidate, row.path));
  return root ? { ref: row.ref, file: row.path, root } : null;
}

// What one manifest mismatch changes, as the deployment note words it.
function describeDeploymentMismatch(item) {
  if (item.kind === 'property') return 'its parameters';
  const counts = item.declared === undefined ? '' : ` (${item.declared} on the page, ${item.manifest} in the manifest)`;
  return `its ${item.kind} resources${counts}`;
}

/**
 * The Solution files of one session that answer portal addresses: code component resources joined from the pages'
 * declarations, Solution web resources by name. Entries by address (lower-case path), by display reference and by file.
 */
export class SolutionResourceIndex {
  constructor({ limit = MAX_ENTRIES } = {}) {
    this.limit = limit;
    this.byUrl = new Map();
    this.byRef = new Map();
    this.joins = new Map();
    /** control folders and web resource folders of mapped files (watched for saves) */
    this.folders = new Set();
    /** manifest changes the portal has not deployed, by control: { rel, control, reason } (needsDeploy rows) */
    this.deployments = new Map();
  }

  /** The entry for a portal address, or undefined. */
  lookup(pathname) {
    return this.byUrl.get(String(pathname).toLowerCase().replace(/\/$/, ''));
  }

  /** The served entry a display reference names, or undefined. */
  source(ref) {
    return this.byRef.get(ref);
  }

  /** The display reference of a mapped file, or undefined. */
  refOf(file) {
    const resolved = path.resolve(file);
    for (const entry of this.byRef.values()) if (entry.file === resolved) return entry.rel;
    return undefined;
  }

  /** Whether a saved path belongs to a mapped file or a folder that holds them. */
  covers(file) {
    const resolved = path.resolve(file);
    return [...this.folders].some((folder) => resolved === folder || inside(folder, resolved));
  }

  #set(url, entry) {
    const key = url.toLowerCase();
    const previous = this.byUrl.get(key);
    if (!previous && this.byUrl.size >= this.limit) return null;
    this.byUrl.set(key, entry);
    if (entry.rel && entry.file) this.byRef.set(entry.rel, entry);
    return entry;
  }

  /** Names a file of the Solution roots; null when it is not inside one (never served then). */
  #named(file, sources) {
    let real;
    try {
      real = fs.realpathSync.native(file);
    } catch {
      return null;
    }
    return solutionReference(real, sources);
  }

  /**
   * Records what the declarations of one document map to, with `sources` = `{ catalogue, roots, sourceDir }` (the
   * inspector's code component catalogue and Solution roots). Returns the entries of this document's resources.
   */
  notePcf(declarations, sources) {
    const entries = [];
    for (const declaration of declarations) this.#noteDeclaration(declaration, sources, entries);
    return entries;
  }

  #join(declaration, sources) {
    const control = sources?.catalogue?.controls
      ? [...sources.catalogue.controls.values()].find(
          (item) => item.schemaName?.toLowerCase() === declaration.name.toLowerCase(),
        )
      : null;
    const key = JSON.stringify([
      declaration.name.toLowerCase(),
      control?.sourceContentRevision ?? null,
      control?.file ?? null,
      declaration.resources,
      declaration.properties ?? null,
    ]);
    let joined = this.joins.get(key);
    if (!joined) {
      joined = joinPcfDeclaration(declaration, sources?.catalogue);
      if (this.joins.size >= MAX_JOINS) this.joins.delete(this.joins.keys().next().value);
      this.joins.set(key, joined);
    }
    return joined;
  }

  #noteDeclaration(declaration, sources, entries) {
    const joined = this.#join(declaration, sources);
    const manifest = joined.manifestFile && sources ? this.#named(joined.manifestFile, sources) : null;
    const refusal = (reason, guid) => ({
      url: `/_pcfwebresource/${guid}`,
      kind: 'pcf-resource',
      control: joined.control,
      ...(joined.componentKey ? { componentKey: joined.componentKey } : {}),
      ...(manifest ? { manifestRel: manifest.ref } : {}),
      refused: reason,
    });
    this.#noteDeployment(joined, manifest);
    if (joined.refused) {
      for (const resource of declaration.resources)
        if (resource.guid) entries.push(this.#refuse(refusal(joined.refused, resource.guid)));
      return;
    }
    for (const resource of joined.resources)
      this.#noteResource(resource, { joined, manifest, refusal, sources }, entries);
    for (const guid of [...(joined.refusedGuids ?? []), ...(joined.unresolvedResx ?? [])])
      entries.push(this.#refuse(refusal('pcf-manifest-mismatch', guid)));
  }

  // A control whose local manifest declares other resources or parameters than the page: a change that needs a deploy
  // (the overlay keeps mapping the kinds that still match). Keyed by control; a later matching page clears it.
  #noteDeployment(joined, manifest) {
    const key = String(joined.control).toLowerCase();
    if (!joined.mismatches?.length || !manifest) {
      if (joined.componentKey) this.deployments.delete(key);
      return;
    }
    const changes = joined.mismatches.map(describeDeploymentMismatch);
    this.deployments.set(key, {
      pcfDeployment: true,
      rel: manifest.ref,
      control: joined.control,
      reason: `code component ${joined.control} changed ${changes.join(' and ')} in ControlManifest.xml; deploy the control before those changes can be previewed`,
    });
  }

  #noteResource(resource, { joined, manifest, refusal, sources }, entries) {
    const named = this.#named(resource.file, sources);
    if (!named) {
      entries.push(this.#refuse(refusal('pcf-manifest-mismatch', resource.guid)));
      return;
    }
    const entry = {
      url: `/_pcfwebresource/${resource.guid}`,
      kind: 'pcf-resource',
      control: joined.control,
      componentKey: joined.componentKey,
      resourceKind: resource.kind,
      order: resource.order,
      path: resource.path,
      file: named.file,
      rel: named.ref,
      solutionRoot: named.root,
      folder: path.resolve(resource.controlRoot),
      ...(manifest ? { manifestRel: manifest.ref } : {}),
    };
    const previous = this.lookup(entry.url);
    // One address names one file: a GUID two declarations join to different files is served by neither.
    if (previous?.file && previous.file !== entry.file) {
      entries.push(this.#refuse(refusal('pcf-manifest-mismatch', resource.guid)));
      return;
    }
    if (this.#set(entry.url, entry)) {
      this.folders.add(entry.folder);
      entries.push(entry);
    }
  }

  #refuse(entry) {
    const previous = this.lookup(entry.url);
    if (previous?.file) this.byRef.delete(previous.rel);
    return this.#set(entry.url, entry) ?? entry;
  }

  /**
   * The Solution web resource `/_webresource/<name>` names: `<root>/WebResources/<name>` of the first Solution root
   * that declares it (its PAC `.data.xml` beside it), as Mirage serves it (mirage/lib/native-services.mjs). Null when
   * no root holds it.
   */
  noteWebResource(pathname, sources) {
    const match = WEB_RESOURCE_PATH.exec(pathname);
    if (!match || match[1].split('/').some((part) => part === '..' || part === '.' || part === '') || !sources)
      return null;
    const known = this.lookup(pathname);
    if (known) return known;
    for (const root of sources.roots ?? []) {
      const folder = path.join(root, 'WebResources');
      const file = path.join(folder, ...match[1].split('/'));
      try {
        if (!fs.statSync(file).isFile() || !fs.statSync(file + '.data.xml').isFile()) continue;
        const real = fs.realpathSync.native(file);
        if (!inside(fs.realpathSync.native(folder), real)) continue;
        const named = solutionReference(real, sources);
        if (!named) continue;
        const entry = {
          url: pathname,
          kind: 'web-resource',
          name: match[1],
          file: named.file,
          rel: named.ref,
          solutionRoot: named.root,
          folder: fs.realpathSync.native(folder),
        };
        if (!this.#set(pathname, entry)) return null;
        this.folders.add(entry.folder);
        return entry;
      } catch {
        /* not in this root */
      }
    }
    return null;
  }

  /** The entry of a Mirage code component address (`/__sim-static/pcf/...`) from the catalogue, or null. */
  mirageAsset(pathname, sources) {
    if (!String(pathname).startsWith(MIRAGE_PCF_PREFIX) || !sources?.catalogue?.assets) return null;
    const asset = sources.catalogue.assets.get(pathname);
    if (!asset?.file) return null;
    const control = [...sources.catalogue.controls.values()].find((item) =>
      item.resources?.some((resource) => resource.url === pathname),
    );
    const named = this.#named(asset.file, sources);
    if (!control || !named) return null;
    return {
      url: pathname,
      kind: 'pcf-resource',
      control: control.schemaName,
      componentKey: 'pcf:' + control.schemaName.toLowerCase(),
      resourceKind: asset.kind,
      file: named.file,
      rel: named.ref,
    };
  }
}
