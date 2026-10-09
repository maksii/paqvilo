import { decodeXml } from "./importer.mjs";

/**
 * Small non-resolving XML reader for unpacked Dataverse solution files.
 * Declarations and external entities are rejected; nothing is fetched.
 */
export function parseSolutionXml(source, { recover = false } = {}) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error("XML external declarations are not supported");
  const root = { name: "#document", attrs: {}, children: [], text: "" };
  const stack = [root];
  let recovered = 0;
  for (const token of String(source).match(
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<[^>]+>|[^<]+/g,
  ) ?? []) {
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
      const m = /^<([\w:.-]+)([\s\S]*?)\/?\s*>$/.exec(token);
      if (!m) throw new Error("Malformed XML element");
      const attrs = {};
      const rest = m[2].replace(
        /([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/g,
        (_, key, _quote, value) => {
          if (Object.hasOwn(attrs, key))
            throw new Error("Duplicate XML attribute");
          attrs[key] = decodeXml(value);
          return "";
        },
      );
      if (rest.trim()) throw new Error("Malformed XML attributes");
      const node = { name: m[1], attrs, children: [], text: "" };
      stack.at(-1).children.push(node);
      if (!/\/\s*>$/.test(token)) stack.push(node);
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

/** Labels of a node keyed by LCID (label, LocalizedName and displayname rows). */
export function labelsOf(node) {
  const rows = descendants(node, "label").concat(
    descendants(node, "LocalizedName"),
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
