// JSON.parse defines the values the mapper sees; a syntax tree independently checks
// for object keys that JSON.parse would silently collapse. Diagnostics contain no bodies.
import YAML from 'yaml';
import { componentContentSpan } from './portal-model.mjs';

export function inspectJsonText(text) {
  let value;
  try { value = JSON.parse(text); }
  catch { return { value: null, complete: false, diagnostics: [{ code: 'INVALID_JSON', reason: 'Cannot parse JSON; fields were not inventoried.' }] }; }
  const document = YAML.parseDocument(text);
  const diagnostics = document.errors.filter((error) => error.code === 'DUPLICATE_KEY').map((error) => ({
    code: 'DUPLICATE_JSON_KEY',
    reason: 'Duplicate JSON object key; collapsed occurrences prevent complete source inventory.',
    offset: error.pos?.[0] ?? null,
  }));
  return { value, complete: diagnostics.length === 0, diagnostics };
}

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const xmlUnescape = (value) => value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(lt|gt|amp|quot|apos));/gi, (_match, dec, hex, name) =>
  dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : XML_ENTITIES[name.toLowerCase()],
);

/** Inspect the enhanced component's serialized content without losing duplicate keys. */
export function inspectComponentJson(xml) {
  const contents = [];
  for (let span = componentContentSpan(xml); span; span = componentContentSpan(xml, span.closeEnd)) contents.push(span);
  const diagnostics = [];
  const elementText = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  if ([...elementText.matchAll(/<content\b/g)].length !== contents.length || [...elementText.matchAll(/<\/content\s*>/g)].length !== contents.length) diagnostics.push({ code: 'INVALID_XML_CONTENT', reason: 'Component content elements are not completely paired; some fields could not be inventoried.' });
  if (contents.length !== 1) {
    diagnostics.push({ code: contents.length ? 'DUPLICATE_XML_CONTENT' : 'INVALID_XML_CONTENT', reason: contents.length ? 'Multiple component content elements; complete source inventory cannot select one safely.' : 'Component has no readable content element.' });
  }
  let value = null;
  for (const content of contents) {
    const raw = xml.slice(content.contentStart, content.contentEnd);
    let decoded;
    try {
      const sections = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>/g;
      decoded = '';
      let from = 0;
      for (let section; (section = sections.exec(raw));) {
        decoded += xmlUnescape(raw.slice(from, section.index));
        if (section[1] !== undefined) decoded += section[1];
        from = sections.lastIndex;
      }
      decoded += xmlUnescape(raw.slice(from));
    }
    catch { diagnostics.push({ code: 'INVALID_XML_CONTENT', reason: 'Component content contains an invalid XML character entity.' }); continue; }
    const inspected = inspectJsonText(decoded);
    diagnostics.push(...inspected.diagnostics);
    if (!inspected.value || typeof inspected.value !== 'object' || Array.isArray(inspected.value)) {
      if (inspected.complete) diagnostics.push({ code: 'INVALID_XML_CONTENT', reason: 'Component JSON content is not an object.' });
      continue;
    }
    value ??= inspected.value;
  }
  return { value, complete: diagnostics.length === 0, diagnostics };
}
