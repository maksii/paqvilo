import { decodeXml } from './importer.mjs';

/**
 * Small non-resolving XML reader for unpacked Dataverse solution files.
 * Declarations and external entities are rejected; nothing is fetched.
 */
export function parseSolutionXml(source, { recover = false, locations = false } = {}) {
  source = String(source);
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('XML external declarations are not supported');
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let recovered = 0;
  let offset = 0;
  const position = { line: 1, column: 1 };
  for (const token of xmlTokens(source)) {
    const region = { start: offset, end: offset + token.length, line: position.line, column: position.column };
    offset += token.length;
    updateXmlPosition(token, position, locations);
    recovered += consumeXmlToken(token, region, stack, { recover, locations });
  }
  return finishParsedXml(root, stack, recover, recovered);
}

function consumeClosingToken(token, region, stack, recover, locations) {
  const name = token.slice(2, -1).trim();
  if (stack.length > 1 && stack.at(-1).name === name) {
    if (locations) stack.at(-1).region.end = region.end;
    stack.pop();
    return 0;
  }
  // Recovery (metadata reads only): close unclosed children up to the matching
  // element, or ignore a stray closing tag. Callers report the recovery.
  const depth = stack.findLastIndex((node, index) => index > 0 && node.name === name);
  if (!recover) throw new Error('Malformed XML closing element');
  if (depth > 0) stack.length = depth;
  return 1;
}

function consumeXmlToken(token, region, stack, { recover, locations }) {
  if (token.startsWith('<!--') || token.startsWith('<?')) return 0;
  if (token.startsWith('<![CDATA[')) {
    stack.at(-1).text += token.slice(9, -3);
    return 0;
  }
  if (token.startsWith('</')) return consumeClosingToken(token, region, stack, recover, locations);
  if (!token.startsWith('<')) {
    stack.at(-1).text += decodeXml(token);
    return 0;
  }
  const { name, attrs, selfClosing } = readElement(token);
  const node = { name, attrs, children: [], text: '' };
  if (locations) node.region = region;
  stack.at(-1).children.push(node);
  if (!selfClosing) stack.push(node);
  return 0;
}

function updateXmlPosition(token, position, locations) {
  if (!locations) return;
  const last = token.lastIndexOf('\n');
  if (last < 0) position.column += token.length;
  else {
    for (let cursor = token.indexOf('\n'); cursor >= 0; cursor = token.indexOf('\n', cursor + 1)) position.line++;
    position.column = token.length - last;
  }
}

function finishParsedXml(root, stack, recover, recovered) {
  if (recover && stack.length > 1) {
    recovered += stack.length - 1;
    stack.length = 1;
  }
  if (stack.length !== 1 || root.children.length !== 1) throw new Error('One complete XML root is required');
  const element = root.children[0];
  if (recovered) Object.defineProperty(element, 'recovered', { value: recovered });
  return element;
}

function findXmlTerminator(source, cursor, terminator) {
  let terminatorOffset = 2;
  if (terminator === ']]>') terminatorOffset = 9;
  else if (terminator === '-->') terminatorOffset = 4;
  const end = source.indexOf(terminator, cursor + terminatorOffset);
  if (end < 0) throw new Error('Malformed XML: unterminated declaration or CDATA');
  return end + terminator.length;
}

function scanXmlElementEnd(source, cursor) {
  let quote = null;
  for (cursor++; cursor < source.length; cursor++) {
    const character = source[cursor];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') break;
    else if (character === '<') throw new Error('Malformed XML element');
  }
  if (cursor === source.length) throw new Error('Malformed XML: unterminated element');
  return cursor + 1;
}

/** Scan once, without retrying a missing delimiter at every '<' in malformed input. */
/* NOSONAR: single-pass routine, splitting it would change shared state */ function* xmlTokens(source) {
  for (let cursor = 0; cursor < source.length;) {
    const start = cursor;
    if (source[cursor] !== '<') {
      const next = source.indexOf('<', cursor);
      cursor = next < 0 ? source.length : next;
    } else {
      let terminator = null;
      if (source.startsWith('<!--', cursor)) terminator = '-->';
      else if (source.startsWith('<![CDATA[', cursor)) terminator = ']]>';
      else if (source.startsWith('<?', cursor)) terminator = '?>';
      if (terminator) {
        cursor = findXmlTerminator(source, cursor, terminator);
      } else {
        cursor = scanXmlElementEnd(source, cursor);
      }
    }
    yield source.slice(start, cursor);
  }
}

const xmlNameCharacter = (character) => character !== undefined && /[\w:.-]/.test(character);

function skipXmlWhitespace(scanner) {
  while (scanner.cursor < scanner.token.length && /\s/.test(scanner.token[scanner.cursor])) scanner.cursor++;
}

function readXmlName(scanner) {
  const start = scanner.cursor;
  while (xmlNameCharacter(scanner.token[scanner.cursor])) scanner.cursor++;
  return scanner.token.slice(start, scanner.cursor);
}

function readXmlAttribute(scanner, attrs) {
  const key = readXmlName(scanner);
  skipXmlWhitespace(scanner);
  if (!key || scanner.token[scanner.cursor++] !== '=') throw new Error('Malformed XML attributes');
  skipXmlWhitespace(scanner);
  const quote = scanner.token[scanner.cursor++];
  if (quote !== '"' && quote !== "'") throw new Error('Malformed XML attributes');
  const end = scanner.token.indexOf(quote, scanner.cursor);
  if (end < 0) throw new Error('Malformed XML attributes');
  if (Object.hasOwn(attrs, key)) throw new Error('Duplicate XML attribute');
  Object.defineProperty(attrs, key, {
    value: decodeXml(scanner.token.slice(scanner.cursor, end)),
    enumerable: true,
    configurable: true,
    writable: true,
  });
  scanner.cursor = end + 1;
}

function readXmlSelfClosing(scanner) {
  if (scanner.token[scanner.cursor] !== '/') return false;
  scanner.cursor++;
  skipXmlWhitespace(scanner);
  if (scanner.token[scanner.cursor] !== '>') throw new Error('Malformed XML attributes');
  return true;
}

/** Attribute names and quoted values are consumed in order, including long invalid names. */
function readElement(token) {
  const scanner = { token, cursor: 1 },
    name = readXmlName(scanner);
  if (!name) throw new Error('Malformed XML element');
  const attrs = {};
  while (scanner.cursor < token.length - 1) {
    skipXmlWhitespace(scanner);
    if (token[scanner.cursor] === '>') break;
    if (readXmlSelfClosing(scanner)) return { name, attrs, selfClosing: true };
    readXmlAttribute(scanner, attrs);
  }
  return { name, attrs, selfClosing: false };
}

export const descendants = (node, name) => {
  const result = [];
  for (const item of node?.children ?? []) {
    if (item.name === name) result.push(item);
    result.push(...descendants(item, name));
  }
  return result;
};
export const child = (node, name) => node?.children.find((c) => c.name === name);
export const childText = (node, name) => child(node, name)?.text.trim();

/** Labels of a node keyed by LCID, including exported collection names. */
export function labelsOf(node) {
  const rows = descendants(node, 'label').concat(
    descendants(node, 'LocalizedName'),
    descendants(node, 'LocalizedCollectionName'),
    descendants(node, 'displayname'),
  );
  const labels = {};
  for (const row of rows) {
    const lcid = String(row.attrs.languagecode ?? '');
    if (row.attrs.description != null && !Object.hasOwn(labels, lcid)) labels[lcid] = row.attrs.description;
  }
  return labels;
}

/** Select the requested LCID, otherwise the first exported label. */
export function label(node, lcid = 1033) {
  const rows = descendants(node, 'label').concat(
    descendants(node, 'LocalizedName'),
    descendants(node, 'LocalizedCollectionName'),
    descendants(node, 'displayname'),
  );
  return (rows.find((r) => Number(r.attrs.languagecode) === Number(lcid)) ?? rows[0])?.attrs.description;
}

export const pickLabel = (labels, lcid = 1033) => labels?.[String(lcid)] ?? Object.values(labels ?? {})[0];

export const serializeXml = (node) =>
  `<${node.name}${Object.entries(node.attrs)
    .map(
      ([k, v]) =>
        ` ${k}="${String(v).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}"`,
    )
    .join(
      '',
    )}>${node.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}${node.children.map(serializeXml).join('')}</${node.name}>`;
