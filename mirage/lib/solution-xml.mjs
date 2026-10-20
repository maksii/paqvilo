import { decodeXml } from "./importer.mjs";

/**
 * Small non-resolving XML reader for unpacked Dataverse solution files.
 * Declarations and external entities are rejected; nothing is fetched.
 */
export function parseSolutionXml(source, { recover = false } = {}) {
  source = String(source);
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error("XML external declarations are not supported");
  const root = { name: "#document", attrs: {}, children: [], text: "" };
  const stack = [root];
  let recovered = 0;
  for (const token of xmlTokens(source)) {
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (token.startsWith("<![CDATA[")) {
      stack.at(-1).text += token.slice(9, -3);
      continue;
    }
    if (token.startsWith("</")) {
      const name = token.slice(2, -1).trim();
      if (stack.length > 1 && stack.at(-1).name === name) {
        stack.pop();
        continue;
      }
      // Recovery (metadata reads only): close unclosed children up to the matching
      // element, or ignore a stray closing tag. Callers report the recovery.
      const depth = stack.findLastIndex((node, index) => index > 0 && node.name === name);
      if (!recover) throw new Error("Malformed XML closing element");
      recovered++;
      if (depth > 0) stack.length = depth;
      continue;
    }
    if (token.startsWith("<")) {
      const { name, attrs, selfClosing } = readElement(token);
      const node = { name, attrs, children: [], text: "" };
      stack.at(-1).children.push(node);
      if (!selfClosing) stack.push(node);
    } else stack.at(-1).text += decodeXml(token);
  }
  if (recover && stack.length > 1) {
    recovered += stack.length - 1;
    stack.length = 1;
  }
  if (stack.length !== 1 || root.children.length !== 1)
    throw new Error("One complete XML root is required");
  const element = root.children[0];
  if (recovered) Object.defineProperty(element, "recovered", { value: recovered });
  return element;
}

/** Scan once, without retrying a missing delimiter at every '<' in malformed input. */
function* xmlTokens(source) {
  for (let cursor = 0; cursor < source.length;) {
    const start = cursor;
    if (source[cursor] !== '<') {
      const next = source.indexOf('<', cursor);
      cursor = next < 0 ? source.length : next;
    } else {
      const terminator = source.startsWith('<!--', cursor) ? '-->'
        : source.startsWith('<![CDATA[', cursor) ? ']]>'
          : source.startsWith('<?', cursor) ? '?>' : null;
      if (terminator) {
        const end = source.indexOf(terminator, cursor + (terminator === ']]>' ? 9 : terminator === '-->' ? 4 : 2));
        if (end < 0) throw new Error('Malformed XML: unterminated declaration or CDATA');
        cursor = end + terminator.length;
      } else {
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
        cursor++;
      }
    }
    yield source.slice(start, cursor);
  }
}

/** Attribute names and quoted values are consumed in order, including long invalid names. */
function readElement(token) {
  let cursor = 1;
  const nameCharacter = character => character !== undefined && /[\w:.-]/.test(character);
  const skipWhitespace = () => { while (cursor < token.length && /\s/.test(token[cursor])) cursor++; };
  const readName = () => {
    const start = cursor;
    while (nameCharacter(token[cursor])) cursor++;
    return token.slice(start, cursor);
  };
  const name = readName();
  if (!name) throw new Error('Malformed XML element');
  const attrs = {};
  while (cursor < token.length - 1) {
    skipWhitespace();
    if (token[cursor] === '>') break;
    if (token[cursor] === '/') {
      cursor++;
      skipWhitespace();
      if (token[cursor] !== '>') throw new Error('Malformed XML attributes');
      return { name, attrs, selfClosing: true };
    }
    const key = readName();
    skipWhitespace();
    if (!key || token[cursor++] !== '=') throw new Error('Malformed XML attributes');
    skipWhitespace();
    const quote = token[cursor++];
    if (quote !== '"' && quote !== "'") throw new Error('Malformed XML attributes');
    const end = token.indexOf(quote, cursor);
    if (end < 0) throw new Error('Malformed XML attributes');
    if (Object.hasOwn(attrs, key)) throw new Error('Duplicate XML attribute');
    Object.defineProperty(attrs, key, { value: decodeXml(token.slice(cursor, end)), enumerable: true, configurable: true, writable: true });
    cursor = end + 1;
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
  const rows = descendants(node, "label").concat(
    descendants(node, "LocalizedName"),
    descendants(node, "LocalizedCollectionName"),
    descendants(node, "displayname"),
  );
  const labels = {};
  for (const row of rows) {
    const lcid = String(row.attrs.languagecode ?? "");
    if (row.attrs.description != null && !Object.hasOwn(labels, lcid))
      labels[lcid] = row.attrs.description;
  }
  return labels;
}

/** Select the requested LCID, otherwise the first exported label. */
export function label(node, lcid = 1033) {
  const rows = descendants(node, "label").concat(
    descendants(node, "LocalizedName"),
    descendants(node, "LocalizedCollectionName"),
    descendants(node, "displayname"),
  );
  return (
    rows.find((r) => Number(r.attrs.languagecode) === Number(lcid)) ?? rows[0]
  )?.attrs.description;
}

export const pickLabel = (labels, lcid = 1033) =>
  labels?.[String(lcid)] ?? Object.values(labels ?? {})[0];

export const serializeXml = (node) =>
  `<${node.name}${Object.entries(node.attrs)
    .map(
      ([k, v]) =>
        ` ${k}="${String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}"`,
    )
    .join(
      "",
    )}>${node.text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}${node.children.map(serializeXml).join("")}</${node.name}>`;
