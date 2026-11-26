// Offline code component (PCF) checks of `lense audit`: every codecomponent tag of the portal export against the
// Solution and pcf.sources catalogue the overlay and Mirage read (mirage/lib/code-components.mjs importCodeComponents).
// A tag whose control is not in the sources, a control the Power Pages host refuses, and the import diagnostics of a
// referenced control (a declared resource that is missing, unreadable or too large, an unresolved identity) are
// findings. Dynamic names are counted and never guessed. Nothing is written and no portal is contacted.
import fs from 'node:fs/promises';
import path from 'node:path';
import { codeComponentGuid, importCodeComponents, portalPcfRefusals } from '../mirage/lib/code-components.mjs';
import { pcfPlatformLibraries } from '../mirage/lib/pcf-sources.mjs';
import { scanSolutionSources } from '../mirage/lib/solution-schema.mjs';
import { codeComponentReferences, inspectionSources } from './source-inspection.mjs';

const TEXT = /\.(?:html?|ya?ml|liquid|json|txt)$/i;
const SKIP = new Set(['.git', '.portalconfig', 'node_modules', '.paqvilo']);
const MAX_FILES = 20000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const IMPORT_CODES = new Set([
  'PCF_IMPORT_FAILED',
  'PCF_IDENTITY_UNRESOLVED',
  'PCF_IDENTITY_SHADOWED',
  'PCF_ARCHIVE_UNREADABLE',
  'PCF_RESOURCE_KIND_UNSUPPORTED',
]);
const norm = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();

const relativeExportPath = (walk, file) => path.relative(walk.sourceDir, file).replaceAll('\\', '/') || '.';

// A folder or file the walk cannot read is a finding of its own; the rest of the export is still checked.
function noteUnreadable(walk, file, error) {
  walk.findings.push({
    code: 'PCF_AUDIT_EXPORT_UNREADABLE',
    relativePath: relativeExportPath(walk, file),
    reason: error.message,
  });
}

async function readExportDirectory(walk, directory) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    noteUnreadable(walk, directory, error);
    return [];
  }
}

// The text of one export file, or null when it is larger than the read limit or unreadable. The size is checked on the
// open handle that is read, so a file replaced after the check is never read past the limit.
async function readExportText(walk, file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    if ((await handle.stat()).size > MAX_FILE_BYTES) return null;
    return await handle.readFile('utf8');
  } catch (error) {
    noteUnreadable(walk, file, error);
    return null;
  } finally {
    await handle?.close();
  }
}

async function scanExportFile(walk, file) {
  const text = await readExportText(walk, file);
  if (text === null || !/codecomponent/i.test(text)) return;
  for (const reference of codeComponentReferences(text))
    walk.references.push({ ...reference, relativePath: relativeExportPath(walk, file) });
}

async function scanExportDirectory(walk, directory) {
  for (const entry of await readExportDirectory(walk, directory)) {
    if (entry.isSymbolicLink() || SKIP.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk.next.push(file);
    else if (entry.isFile() && TEXT.test(entry.name) && ++walk.files <= MAX_FILES) await scanExportFile(walk, file);
  }
}

async function portalReferences(sourceDir, findings) {
  const walk = { sourceDir, findings, references: [], files: 0, next: [] };
  let directories = [sourceDir];
  while (directories.length && walk.files < MAX_FILES) {
    walk.next = [];
    for (const directory of directories) await scanExportDirectory(walk, directory);
    directories = walk.next.sort(/* NOSONAR: preserve default string coercion */);
  }
  return walk.references;
}

const folderOf = (file) =>
  String(file ?? '')
    .split(/[\\/#]/)
    .at(-2);

// Power Pages renders nothing for these tags and ends the rest of the template.
function tagRefusalFindings(reference, at, findings) {
  if (reference.quoted)
    findings.push({
      code: 'PCF_AUDIT_NAME_QUOTED',
      ...at,
      reason:
        'A quoted control name renders nothing and ends the rest of the template on Power Pages: write it unquoted.',
    });
  if (reference.braced)
    findings.push({
      code: 'PCF_AUDIT_NAME_BRACED',
      ...at,
      reason:
        'A control id in braces renders nothing and halts rendering there on Power Pages: the rest of the page content is cut off. Write the id without braces.',
    });
  if (reference.duplicate)
    findings.push({
      code: 'PCF_AUDIT_DUPLICATE_CONTROL',
      ...at,
      reason: 'A second tag of the same control renders no host and ends the rest of the template on Power Pages.',
    });
}

// The import diagnostics of the referenced control, each reported once across the export.
function importCauseFindings(name, at, { catalogue, findings, reported }) {
  const causes = catalogue.diagnostics.filter(
    (entry) =>
      IMPORT_CODES.has(entry.code) &&
      [entry.name, folderOf(entry.file)].some((value) => value && norm(value) === norm(name)),
  );
  for (const cause of causes) {
    const key = JSON.stringify([cause.code, cause.file, cause.message]);
    if (reported.has(key)) continue;
    reported.add(key);
    findings.push({ code: cause.code, ...at, reason: cause.message });
  }
}

function auditReference(reference, context) {
  const { catalogue, observed, findings } = context;
  const direct = [...catalogue.controls.keys()].find((key) => norm(key) === norm(reference.name));
  const schema = direct ?? observed?.codeComponents?.[codeComponentGuid(reference.name) ?? norm(reference.name)];
  const control = schema && catalogue.controls.get(schema);
  const at = { relativePath: reference.relativePath, name: reference.name };
  tagRefusalFindings(reference, at, findings);
  importCauseFindings(schema ?? reference.name, at, context);
  if (!control) {
    findings.push({
      code: 'PCF_AUDIT_CONTROL_MISSING',
      ...at,
      reason: codeComponentGuid(reference.name)
        ? 'The tag names a component GUID without an observed codeComponents mapping to a control in the sources.'
        : 'No code component in the Solution or pcf.sources catalogue has this name.',
    });
    return;
  }
  const refusals = portalPcfRefusals(control, schema, { platformLibraries: context.platformLibraries });
  if (refusals.length)
    findings.push({
      code: 'PCF_AUDIT_CONTROL_REFUSED',
      ...at,
      schema,
      reasons: refusals.map((refusal) => refusal.code),
      reason: refusals[0].message,
    });
}

/**
 * `{ references, dynamic, controls, findings: [{ code, relativePath, name, reason, ... }] }` of one site configuration
 * (`cfg` from loadConfig). The catalogue is read only when the export references a code component.
 */
export async function auditCodeComponents(cfg) {
  const findings = [];
  const references = await portalReferences(cfg.sourceDir, findings);
  const result = { references: references.length, dynamic: 0, controls: 0, findings };
  const named = references.filter((reference) => !reference.dynamic && reference.name);
  result.dynamic = references.length - named.length;
  if (!named.length) return result;
  const sources = await inspectionSources(cfg);
  for (const diagnostic of sources.diagnostics)
    if (/^PCF_/.test(diagnostic.code)) result.findings.push({ code: diagnostic.code, reason: diagnostic.reason });
  // The pcf.platformLibraries the Power Pages host serves admit React and virtual controls, as Mirage renders them
  // (mirage/lib/pcf-sources.mjs pcfPlatformLibraries): a listed file that cannot be served is its own finding; the
  // notice that the list differs from the live set is not.
  const { libraries: platformLibraries } = await pcfPlatformLibraries(sources.pcf, {
    diagnostic: (entry) => {
      if (entry.severity !== 'info') result.findings.push({ code: entry.code, reason: entry.message });
    },
  });
  const scan = await scanSolutionSources(sources.roots, { order: sources.order });
  const catalogue = await importCodeComponents([...scan.layers, ...sources.pcfLayers], sources.pcfImport);
  result.controls = catalogue.controls.size;
  const context = {
    catalogue,
    observed: sources.observed,
    platformLibraries,
    findings: result.findings,
    reported: new Set(),
  };
  for (const reference of named) auditReference(reference, context);
  return result;
}
