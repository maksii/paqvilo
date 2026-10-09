// Used by verification to edit temporary sources in either supported extract layout.
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import { inspectComponentJson, inspectJsonText } from './audit-json.mjs';
import { componentContent, componentContentSpan, isSourceFile, sourceText } from './portal-model.mjs';

const xmlEscape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function editSource(source, transform) {
  const file = source.file ?? source.path;
  if (typeof file !== 'string' || !file) throw new Error('A source edit requires its physical file path');
  const label = source.rel ?? source.relativePath ?? file;
  const validateFile = () => {
    if (source.sourceDir && !isSourceFile(source.sourceDir, file)) throw new Error(`Cannot edit source missing or outside the extract: ${label}`);
  };
  validateFile();
  const yaml = source.format === 'yaml';
  const component = !yaml && Boolean(source.field || source.extract || path.basename(file).toLowerCase() === 'powerpagecomponent.xml');
  if ((yaml || component) && (typeof source.field !== 'string' || !source.field)) throw new Error(`Cannot edit ${yaml ? 'YAML' : 'component XML'} without an explicit field: ${label}`);
  const raw = fs.readFileSync(file, 'utf8');
  const fieldPath = yaml ? source.fieldPath ?? [source.field] : null;
  if (yaml && (!Array.isArray(fieldPath) || !fieldPath.length || fieldPath.some((key) => !(typeof key === 'string' && key.length) && !(Number.isSafeInteger(key) && key >= 0)))) throw new Error(`Cannot edit YAML without a valid explicit field path: ${label}`);
  const document = yaml ? YAML.parseDocument(raw) : null;
  if (yaml && document.errors.length) throw new Error(`Cannot edit YAML field ${label}: invalid YAML`);
  if (yaml && source.recordId != null && (typeof source.recordIdField !== 'string' || !source.recordIdField || document.getIn([...fieldPath.slice(0, -1), source.recordIdField]) !== source.recordId)) throw new Error(`Cannot edit YAML field with a stale record identity: ${label}`);
  const inspectedComponent = component ? inspectComponentJson(raw) : null;
  const content = inspectedComponent?.value;
  if (component && (!inspectedComponent.complete || !content)) throw new Error(`Cannot edit component field ${label}: invalid or ambiguous JSON content`);
  const jsonPath = source.jsonPath ?? undefined;
  let localized = null;
  let localizedParent = null;
  let localizedKey = null;
  if ((yaml || component) && jsonPath !== undefined) {
    if (!Array.isArray(jsonPath) || !jsonPath.length || jsonPath.some((key) => !(typeof key === 'string' && key.length) && !(Number.isSafeInteger(key) && key >= 0))) throw new Error(`Cannot edit source without a valid explicit JSON field path: ${label}`);
    const serialized = yaml ? document.getIn(fieldPath) : content[source.field];
    try {
      if (typeof serialized !== 'string') throw new Error('not text');
      const inspected = inspectJsonText(serialized);
      if (!inspected.complete) throw new Error('invalid or ambiguous JSON');
      localized = inspected.value;
    }
    catch { throw new Error(`Cannot edit source field ${label}: invalid or ambiguous serialized JSON`); }
    let value = localized;
    for (const key of jsonPath) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error(`Cannot edit missing JSON field ${label}`);
      localizedParent = value;
      localizedKey = key;
      value = value[key];
    }
    if (source.lcid != null && localizedParent.LCID !== source.lcid) throw new Error(`Cannot edit localized field with a stale language identity: ${label}`);
  }
  const current = localizedParent ? localizedParent[localizedKey] : yaml ? document.getIn(fieldPath) : component ? content[source.field] : sourceText({ ...source, file }, raw);
  if ((yaml || component) && current !== undefined && current !== null && typeof current !== 'string') throw new Error(`${yaml ? 'YAML' : 'Component'} field ${source.field} is not text`);
  const before = yaml || component ? current ?? '' : current;
  if (before === null) throw new Error(`Cannot read source ${label}`);
  const after = transform(before);
  if (typeof after !== 'string') throw new Error('A source edit must return text');
  // An exact/no-op edit must not reformat XML, strip a BOM, update timestamps or reload a tab.
  if (after === before) return;
  // Check immediately before writing: another editor may save the component while
  // the edit is being prepared, or an ancestor may be replaced with a junction.
  const save = (updated) => {
    validateFile();
    if (fs.readFileSync(file, 'utf8') !== raw) throw new Error(`Cannot edit source changed while preparing the edit: ${label}`);
    fs.writeFileSync(file, updated);
  };
  if (localizedParent) Object.defineProperty(localizedParent, localizedKey, { value: after, writable: true, enumerable: true, configurable: true });
  const fieldValue = localizedParent ? JSON.stringify(localized, null, 2) : after;
  if (yaml) {
    // Snapshot values independently: updating an anchored scalar can also change another
    // record through an alias. Such an edit must fail instead of changing sibling fields.
    const expected = JSON.parse(JSON.stringify(document.toJS()));
    let expectedParent = expected;
    for (const key of fieldPath.slice(0, -1)) {
      if (!expectedParent || typeof expectedParent !== 'object' || !Object.hasOwn(expectedParent, key)) throw new Error(`Cannot edit missing YAML parent field ${label}`);
      expectedParent = expectedParent[key];
    }
    if (!expectedParent || typeof expectedParent !== 'object') throw new Error(`Cannot edit missing YAML parent field ${label}`);
    Object.defineProperty(expectedParent, fieldPath.at(-1), { value: fieldValue, writable: true, enumerable: true, configurable: true });
    document.setIn(fieldPath, fieldValue);
    let updated = String(document);
    if (raw.startsWith('\uFEFF')) updated = '\uFEFF' + updated;
    if (raw.includes('\r\n') && !raw.replace(/\r\n/g, '').includes('\n')) updated = updated.replace(/\r?\n/g, '\r\n');
    const roundtrip = YAML.parseDocument(updated);
    let roundtripValue = roundtrip.getIn(fieldPath);
    if (localizedParent) {
      try { roundtripValue = JSON.parse(roundtripValue); for (const key of jsonPath) roundtripValue = roundtripValue[key]; }
      catch { throw new Error(`Cannot round-trip YAML field ${label}`); }
    }
    if (roundtrip.errors.length || roundtripValue !== after) throw new Error(`Cannot round-trip YAML field ${label}`);
    if (!isDeepStrictEqual(roundtrip.toJS(), expected)) throw new Error(`Cannot edit YAML field without changing unrelated values: ${label}`);
    save(updated);
    return;
  }
  if (!component) {
    save(raw.startsWith('\uFEFF') ? '\uFEFF' + after : after);
    return;
  }
  Object.defineProperty(content, source.field, { value: fieldValue, writable: true, enumerable: true, configurable: true });
  const span = componentContentSpan(raw);
  const updated = raw.slice(0, span.contentStart) + xmlEscape(JSON.stringify(content, null, 2)) + raw.slice(span.contentEnd);
  if (componentContent(updated)?.[source.field] !== fieldValue) throw new Error(`Cannot round-trip component field ${label}`);
  save(updated);
}
