// Used by verification to edit temporary sources in either supported extract layout.
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import { inspectComponentJson, inspectJsonText } from './audit-json.mjs';
import {
  componentIdentity,
  componentContent,
  componentContentSpan,
  isSourceFile,
  sourceText,
} from './portal-model.mjs';

const xmlEscape = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function isExplicitFieldPath(fieldPath) {
  if (!Array.isArray(fieldPath)) return false;
  if (!fieldPath.length) return false;
  return !fieldPath.some((key) => !(typeof key === 'string' && key.length) && !(Number.isSafeInteger(key) && key >= 0));
}

function validateYamlRecordIdentity(source, fieldPath, document, label) {
  if (
    source.recordId != null &&
    (typeof source.recordIdField !== 'string' ||
      !source.recordIdField ||
      document.getIn([...fieldPath.slice(0, -1), source.recordIdField]) !== source.recordId)
  )
    throw new Error(`Cannot edit YAML field with a stale record identity: ${label}`);
  if (
    source.recordLanguageField &&
    document.getIn([...fieldPath.slice(0, -1), source.recordLanguageField]) !== source.recordLanguageId
  )
    throw new Error(`Cannot edit YAML field with a stale language identity: ${label}`);
}

function parseLocalizedJson(serialized, label) {
  try {
    if (typeof serialized !== 'string') throw new Error('not text');
    const inspected = inspectJsonText(serialized);
    if (!inspected.complete) throw new Error('invalid or ambiguous JSON');
    return inspected.value;
  } catch {
    throw new Error(`Cannot edit source field ${label}: invalid or ambiguous serialized JSON`);
  }
}

function validateYamlRoundTrip(roundtrip, fieldPath, localizedParent, jsonPath, after, expected, label) {
  let roundtripValue = roundtrip.getIn(fieldPath);
  if (localizedParent) {
    try {
      roundtripValue = JSON.parse(roundtripValue);
      for (const key of jsonPath) roundtripValue = roundtripValue[key];
    } catch {
      throw new Error(`Cannot round-trip YAML field ${label}`);
    }
  }
  if (roundtrip.errors.length || roundtripValue !== after) throw new Error(`Cannot round-trip YAML field ${label}`);
  if (!isDeepStrictEqual(roundtrip.toJS(), expected))
    throw new Error(`Cannot edit YAML field without changing unrelated values: ${label}`);
}

function editFieldContext(source, raw, yaml, component, label) {
  if (component && source.componentId != null && componentIdentity(raw) !== String(source.componentId).toLowerCase())
    throw new Error(`Cannot edit component field with a stale record identity: ${label}`);
  const fieldPath = yaml ? (source.fieldPath ?? [source.field]) : null;
  if (yaml && !isExplicitFieldPath(fieldPath))
    throw new Error(`Cannot edit YAML without a valid explicit field path: ${label}`);
  const document = yaml ? YAML.parseDocument(raw) : null;
  if (yaml && document.errors.length) throw new Error(`Cannot edit YAML field ${label}: invalid YAML`);
  if (yaml) validateYamlRecordIdentity(source, fieldPath, document, label);
  return { fieldPath, document };
}

function inspectComponentContent(component, raw, label) {
  const inspectedComponent = component ? inspectComponentJson(raw) : null;
  const content = inspectedComponent?.value;
  if (component && (!inspectedComponent.complete || !content))
    throw new Error(`Cannot edit component field ${label}: invalid or ambiguous JSON content`);
  return content;
}

function localizedFieldContext(source, { yaml, component, fieldPath, document, content, label, jsonPath }) {
  let localized = null,
    localizedParent = null,
    localizedKey = null;
  if ((yaml || component) && jsonPath !== undefined) {
    if (!isExplicitFieldPath(jsonPath))
      throw new Error(`Cannot edit source without a valid explicit JSON field path: ${label}`);
    const serialized = yaml ? document.getIn(fieldPath) : content[source.field];
    localized = parseLocalizedJson(serialized, label);
    let value = localized;
    for (const key of jsonPath) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key))
        throw new Error(`Cannot edit missing JSON field ${label}`);
      localizedParent = value;
      localizedKey = key;
      value = value[key];
    }
    if (source.lcid != null && localizedParent.LCID !== source.lcid)
      throw new Error(`Cannot edit localized field with a stale language identity: ${label}`);
  }
  return { localized, localizedParent, localizedKey };
}

function currentSourceValue(
  source,
  { yaml, component, fieldPath, document, content, file, raw, localizedParent, localizedKey },
) {
  if (localizedParent) return localizedParent[localizedKey];
  if (yaml) return document.getIn(fieldPath);
  if (component) return content[source.field];
  return sourceText({ ...source, file }, raw);
}

function validateSourceText(source, yaml, component, current, label) {
  if ((yaml || component) && current !== undefined && current !== null && typeof current !== 'string')
    throw new Error(`${yaml ? 'YAML' : 'Component'} field ${source.field} is not text`);
  const before = yaml || component ? (current ?? '') : current;
  if (before === null) throw new Error(`Cannot read source ${label}`);
  return before;
}

function writeYamlEdit({ raw, document, fieldPath, localizedParent, jsonPath, after, fieldValue, label, save }) {
  // Snapshot values independently: updating an anchored scalar can also change another
  // record through an alias. Such an edit must fail instead of changing sibling fields.
  const expected = JSON.parse(JSON.stringify(document.toJS())); // NOSONAR: JSON round trip semantics differ from structuredClone
  let expectedParent = expected;
  for (const key of fieldPath.slice(0, -1)) {
    if (!expectedParent || typeof expectedParent !== 'object' || !Object.hasOwn(expectedParent, key))
      throw new Error(`Cannot edit missing YAML parent field ${label}`);
    expectedParent = expectedParent[key];
  }
  if (!expectedParent || typeof expectedParent !== 'object')
    throw new Error(`Cannot edit missing YAML parent field ${label}`);
  Object.defineProperty(expectedParent, fieldPath.at(-1), {
    value: fieldValue,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  document.setIn(fieldPath, fieldValue);
  let updated = String(document);
  if (raw.startsWith('\uFEFF')) updated = '\uFEFF' + updated;
  if (raw.includes('\r\n') && !raw.replaceAll('\r\n', '').includes('\n'))
    updated = updated.replaceAll(/\r?\n/g, '\r\n');
  const roundtrip = YAML.parseDocument(updated);
  validateYamlRoundTrip(roundtrip, fieldPath, localizedParent, jsonPath, after, expected, label);
  save(updated);
}

function writeComponentEdit(source, content, fieldValue, raw, label, save) {
  Object.defineProperty(content, source.field, {
    value: fieldValue,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  const span = componentContentSpan(raw);
  const updated =
    raw.slice(0, span.contentStart) + xmlEscape(JSON.stringify(content, null, 2)) + raw.slice(span.contentEnd);
  if (componentContent(updated)?.[source.field] !== fieldValue)
    throw new Error(`Cannot round-trip component field ${label}`);
  save(updated);
}

function writeUpdatedSource(context) {
  const { yaml, component, raw, fieldPath, document, localizedParent, jsonPath, after, fieldValue, label, save } =
    context;
  if (yaml) {
    writeYamlEdit({ raw, document, fieldPath, localizedParent, jsonPath, after, fieldValue, label, save });
    return;
  }
  if (!component) {
    save(raw.startsWith('\uFEFF') ? '\uFEFF' + after : after);
    return;
  }
  writeComponentEdit(context.source, context.content, fieldValue, raw, label, save);
}

export function editSource(source, transform) {
  const file = source.file ?? source.path;
  if (typeof file !== 'string' || !file) throw new Error('A source edit requires its physical file path');
  const label = source.rel ?? source.relativePath ?? file;
  const validateFile = () => {
    if (source.sourceDir && !isSourceFile(source.sourceDir, file))
      throw new Error(`Cannot edit source missing or outside the extract: ${label}`);
  };
  validateFile();
  const yaml = source.format === 'yaml';
  const component =
    !yaml && Boolean(source.field || source.extract || path.basename(file).toLowerCase() === 'powerpagecomponent.xml');
  if ((yaml || component) && (typeof source.field !== 'string' || !source.field))
    throw new Error(`Cannot edit ${yaml ? 'YAML' : 'component XML'} without an explicit field: ${label}`);
  const raw = fs.readFileSync(file, 'utf8');
  const { fieldPath, document } = editFieldContext(source, raw, yaml, component, label);
  const content = inspectComponentContent(component, raw, label);
  const jsonPath = source.jsonPath ?? undefined;
  const { localized, localizedParent, localizedKey } = localizedFieldContext(source, {
    yaml,
    component,
    fieldPath,
    document,
    content,
    label,
    jsonPath,
  });
  const current = currentSourceValue(source, {
    yaml,
    component,
    fieldPath,
    document,
    content,
    file,
    raw,
    localizedParent,
    localizedKey,
  });
  const before = validateSourceText(source, yaml, component, current, label);
  const after = transform(before);
  if (typeof after !== 'string') throw new Error('A source edit must return text');
  // An exact/no-op edit must not reformat XML, strip a BOM, update timestamps or reload a tab.
  if (after === before) return;
  // Check immediately before writing: another editor may save the component while
  // the edit is being prepared, or an ancestor may be replaced with a junction.
  const save = (updated) => {
    validateFile();
    if (fs.readFileSync(file, 'utf8') !== raw)
      throw new Error(`Cannot edit source changed while preparing the edit: ${label}`);
    fs.writeFileSync(file, updated);
  };
  if (localizedParent)
    Object.defineProperty(localizedParent, localizedKey, {
      value: after,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  const fieldValue = localizedParent ? JSON.stringify(localized, null, 2) : after;
  writeUpdatedSource({
    source,
    yaml,
    component,
    raw,
    fieldPath,
    document,
    content,
    localizedParent,
    jsonPath,
    after,
    fieldValue,
    label,
    save,
  });
}
