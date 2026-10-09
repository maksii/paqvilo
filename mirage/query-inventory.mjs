#!/usr/bin/env node
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { importPortal } from "./lib/importer.mjs";

function inventoryBlock(source) {
  const roots = new Set();
  let queryBlocks = 0, unresolvedBlocks = 0, maxLinks = 0, maxLinkDepth = 0;
  const fetchTag = /\{%-?\s*fetchxml\b[^%]*%\}([\s\S]*?)\{%-?\s*endfetchxml\s*-?%\}/gi;
  for (const match of source.matchAll(fetchTag)) {
    queryBlocks++;
    const body = match[1]
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/gi, "");
    const rootMatch = /<entity\b[^>]*\bname\s*=\s*(["'])([\w.]+)\1/i.exec(body);
    if (rootMatch) roots.add(rootMatch[2].toLowerCase());
    let unresolved = !rootMatch;

    // Count only literal XML links. Liquid-generated markup is separately
    // reported as unresolved and is never presented as a complete inventory.
    let depth = 0, linkCount = 0, linkDepth = 0;
    const tag = /<\/?(?:entity|link-entity)\b[^>]*>/gi;
    for (const token of body.matchAll(tag)) {
      if (/^<\//.test(token[0])) {
        depth = Math.max(0, depth - 1);
      } else if (/^<link-entity\b/i.test(token[0])) {
        linkCount++;
        if (!/\/\s*>$/.test(token[0])) {
          depth++;
          linkDepth = Math.max(linkDepth, depth - 1);
        }
      } else if (!/\/\s*>$/.test(token[0])) depth++;
    }
    maxLinks = Math.max(maxLinks, linkCount);
    maxLinkDepth = Math.max(maxLinkDepth, linkDepth);
    if (
      /(?:\{\{[\s\S]{0,300}(?:<\s*(?:entity|link-entity)\b)|<(?:entity|link-entity)\b[^>]*\b(?:name|from|to)\s*=\s*["']\s*\{\{|\{%\s*(?:include|render)\b)/i.test(body)
    ) unresolved = true;
    if (unresolved) unresolvedBlocks++;
  }
  return { queryBlocks, roots, unresolvedBlocks, maxLinks, maxLinkDepth };
}

export async function inventoryPortalQueries(portalRoot) {
  const root = await realpath(path.resolve(portalRoot));
  const portal = await importPortal(root);
  const templates = [...new Map(
    Object.values(portal.templates).map((template) => [
      `${template.id ?? ""}\0${template.name}\0${template.metadata?._file ?? ""}`,
      template,
    ]),
  ).values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  let queryBlocks = 0, unresolvedBlocks = 0, maxLinks = 0, maxLinkDepth = 0;
  const roots = new Set();
  const sources = [];
  for (const template of templates) {
    const source = String(template.source ?? "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/gi, "");
    sources.push({
      id: template.id ?? null,
      name: template.name ?? "",
      file: template.metadata?._file ?? null,
      relativePath: template.metadata?._file
        ? path.relative(root, template.metadata._file).replaceAll(path.sep, "/")
        : null,
      sourceHash: createHash("sha256").update(String(template.source ?? "")).digest("hex"),
    });
    const result = inventoryBlock(source);
    queryBlocks += result.queryBlocks;
    unresolvedBlocks += result.unresolvedBlocks;
    maxLinks = Math.max(maxLinks, result.maxLinks);
    maxLinkDepth = Math.max(maxLinkDepth, result.maxLinkDepth);
    for (const name of result.roots) roots.add(name);
  }
  return {
    portalRoot: root,
    format: portal.format,
    sourceFiles: templates.length,
    sourceFingerprint: createHash("sha256").update(JSON.stringify(sources)).digest("hex"),
    sources,
    literalFetchXmlBlocks: queryBlocks,
    literalRootEntities: roots.size,
    maxLiteralLinkEntitiesPerBlock: maxLinks,
    maxLiteralNestedLinkDepth: maxLinkDepth,
    unresolvedOrDynamicBlocks: unresolvedBlocks,
    staticInventoryComplete: unresolvedBlocks === 0,
    note: "Static web-template FetchXML only. Liquid-generated XML, included templates, forms, lists, and runtime calls are outside this inventory. Source records and file paths come from the standard/enhanced portal importer.",
  };
}

async function main(args) {
  let portal, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--portal") portal = args[++i];
    else if (args[i] === "--json") json = true;
    else throw new Error(`Unknown argument ${args[i]}`);
  }
  if (!portal) throw new Error("Usage: node mirage/query-inventory.mjs --portal <portal-source-dir> [--json]");
  const result = await inventoryPortalQueries(portal);
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Portal source: ${result.portalRoot}`);
    console.log(`Imported web templates (${result.format}): ${result.sourceFiles}`);
    console.log(`Source fingerprint: ${result.sourceFingerprint}`);
    console.log(`Literal FetchXML blocks: ${result.literalFetchXmlBlocks}`);
    console.log(`Distinct literal root entities: ${result.literalRootEntities}`);
    console.log(`Maximum literal links per block: ${result.maxLiteralLinkEntitiesPerBlock}`);
    console.log(`Maximum nested literal link depth: ${result.maxLiteralNestedLinkDepth}`);
    console.log(`Unresolved or dynamic blocks: ${result.unresolvedOrDynamicBlocks}`);
    console.log(result.note);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
