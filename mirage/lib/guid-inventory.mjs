import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

const guid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const matches = (text) => [...text.matchAll(new RegExp(guid, "gi"))];
const canonical = (value) => String(value).toLowerCase();

/** Classify authored literal GUIDs; configuration components are never assumed to be business rows. */
export function classifyGuidLiterals(
  text,
  {
    source = "inline",
    components = new Set(),
    records = new Map(),
    mappings = {},
  } = {},
) {
  const result = [];
  for (const match of matches(text)) {
    const id = canonical(match[0]),
      start = Math.max(0, match.index - 220),
      context = text.slice(start, match.index + 220);
    const before = text.slice(start, match.index);
    const condition = /<(?:condition|value)\b[^>]*(?:>\s*\{?)?$/i.exec(
      before,
    )?.[0];
    const binding = new RegExp(
      `/([a-z_][a-z0-9_]*)\\(\\{?${match[0]}`,
      "i",
    ).exec(
      text.slice(Math.max(0, match.index - 100), match.index + match[0].length),
    );
    const hintedEntity = binding
      ? (Object.entries(mappings).find(
          ([name, m]) => m.entitySet === binding[1] || name === binding[1],
        )?.[0] ?? binding[1])
      : /\buitype=["']([^"']+)["']/i.exec(condition ?? "")?.[1];
    const metadataContext =
      /(?:formId|formid|entityformid|webformid|viewId|DefaultViewId|LookupViewId|webresourceid|data-selected-view)[\s"':=]+[^<>]*$/i.test(
        before.slice(-100),
      );
    const contextual =
      /\.xml$/i.test(source) &&
      ["contact", "account", "adx_website"].includes(hintedEntity);
    const classification =
      components.has(id) || metadataContext
        ? "component"
        : contextual
          ? "contextual-view-binding"
          : records.has(id)
            ? "present-data"
            : hintedEntity
              ? "missing-data"
              : "unclassified";
    result.push({
      id,
      classification,
      ...(hintedEntity ? { entity: hintedEntity } : {}),
      ...(records.has(id) ? { existingEntities: records.get(id) } : {}),
      source,
      line: text.slice(0, match.index).split("\n").length,
      context: context.replace(/\s+/g, " ").slice(0, 440),
    });
  }
  return result;
}

export async function inventoryLiteralGuids({
  portalRoot,
  solutionRoots = [],
  state,
}) {
  const files = [],
    components = new Set(),
    records = new Map();
  async function walk(root, portal) {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (
        [".git", "node_modules", ".paqvilo", "bin", "obj"].includes(entry.name)
      )
        continue;
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) await walk(file, portal);
      else if (/\.(html|js|xml|ya?ml)$/i.test(file))
        files.push({
          source: file,
          portal,
          text: await fs.readFile(file, "utf8"),
        });
    }
  }
  await walk(portalRoot, true);
  for (const root of solutionRoots) await walk(root, false);
  function metadata(value, key = "") {
    if (
      typeof value === "string" &&
      /^(?:adx_|mspp_).*id$/i.test(key) &&
      new RegExp(`^${guid}$`, "i").test(value)
    )
      components.add(canonical(value));
    else if (Array.isArray(value)) value.forEach((item) => metadata(item, key));
    else if (value && typeof value === "object")
      for (const [name, item] of Object.entries(value)) metadata(item, name);
  }
  for (const file of files) {
    if (file.portal && /\.ya?ml$/i.test(file.source)) {
      metadata(parse(file.text, { uniqueKeys: false }));
      for (const match of file.text.matchAll(
        new RegExp(`^\\s*(?:adx_|mspp_)[\\w]*id:\\s*["']?(${guid})`, "gmi"),
      ))
        components.add(canonical(match[1]));
    }
    if (!file.portal && /\.xml$/i.test(file.source)) {
      for (const match of file.text.matchAll(
        new RegExp(
          `\\b(?:id|objectid|formid|viewid|webresourceid|solutionid|componentid|classid|uniqueid)=["']\\{?(${guid})\\}?["']`,
          "gi",
        ),
      ))
        components.add(canonical(match[1]));
      for (const match of file.text.matchAll(
        /<(?:ViewId|ViewIds|DefaultViewId|LookupViewId|EntityId|MetadataId|ObjectId)\b[^>]*>([^<]*)</gi,
      ))
        for (const value of matches(match[1]))
          components.add(canonical(value[0]));
      for (const match of matches(path.basename(file.source)))
        components.add(canonical(match[0]));
    }
  }
  for (const [entity, rows] of Object.entries(state.tables ?? {})) {
    const primary = state.mappings?.[entity]?.idColumn ?? `${entity}id`;
    for (const row of rows)
      if (new RegExp(`^${guid}$`, "i").test(row[primary] ?? "")) {
        const id = canonical(row[primary]);
        const entities = records.get(id) ?? [];
        if (!entities.includes(entity)) entities.push(entity);
        records.set(id, entities);
      }
  }
  const occurrences = files
    .filter((f) => /\.(html|js|xml)$/i.test(f.source))
    .flatMap((file) =>
      classifyGuidLiterals(file.text, {
        ...file,
        components,
        records,
        mappings: state.mappings,
      }),
    );
  const groups = {};
  for (const row of occurrences) (groups[row.id] ??= []).push(row);
  const counts = {};
  for (const rows of Object.values(groups)) {
    const kinds = [...new Set(rows.map((row) => row.classification))];
    for (const kind of kinds) counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return {
    generatedAt: new Date().toISOString(),
    portalRoot,
    solutionRoots,
    scannedFiles: files.length,
    componentIds: components.size,
    storedDataIds: records.size,
    distinctGuidCount: Object.keys(groups).length,
    counts,
    groups,
    limitations: [
      "Unclassified literals require source-context review; presence alone is not proof of correct relationships or browser coverage.",
      "Solution test contact/account/site conditions are contextual view bindings, never copied live identities.",
      "This inventory covers literal GUIDs; dynamically assembled identifiers remain separate contracts.",
    ],
  };
}
