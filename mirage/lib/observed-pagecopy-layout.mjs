import { createHash } from "node:crypto";
import { parse, parseFragment, serialize } from "parse5";
import { normalizePortalPath } from "./importer.mjs";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message) =>
  Object.assign(new Error(message), {
    status: 422,
    code: "PAGE_COPY_LAYOUT_INVALID",
  });
const significant = (n) =>
  (n.childNodes ?? []).filter((c) => c.nodeName !== "#text" || c.value.trim());
const attr = (n, key) => n.attrs?.find((a) => a.name === key)?.value;
const classes = (n) => (attr(n, "class") ?? "").split(/\s+/);
function shape(n) {
  if (n.nodeName === "#text")
    return ["text", n.value.replace(/\s+/g, " ").trim()];
  return [
    n.tagName,
    (n.attrs ?? [])
      .map((a) => [a.name, a.value])
      .sort(([a], [b]) => a.localeCompare(b)),
    significant(n).map(shape),
  ];
}
const allowedClasses = new Set([
  "row",
  "sectionBlockLayout",
  "text-left",
  "container",
  "columnBlockLayout",
  ...Array.from({ length: 12 }, (_, i) => "col-md-" + (i + 1)),
]);
function layoutSpec(node, depth = 0) {
  if (depth > 3 || node.tagName !== "div")
    throw fail("Observed Studio layout must contain only bounded empty divs.");
  const attributes = {};
  for (const a of node.attrs ?? []) {
    if (!["class", "style"].includes(a.name))
      throw fail("Observed Studio layout contains unsupported attributes.");
    if (
      a.name === "class" &&
      a.value.split(/\s+/).some((c) => !allowedClasses.has(c))
    )
      throw fail("Observed Studio layout contains unsupported classes.");
    if (
      a.name === "style" &&
      a.value
        .split(";")
        .filter((v) => v.trim())
        .some(
          (v) =>
            !/^\s*(?:(?:display)\s*:\s*flex|flex-wrap\s*:\s*wrap|flex-direction\s*:\s*column|flex-grow\s*:\s*1|min-height\s*:\s*auto|(?:padding|margin|min-width)\s*:\s*(?:0|\d{1,3}px))\s*$/i.test(
              v,
            ),
        )
    )
      throw fail("Observed Studio layout contains unsupported styles.");
    attributes[a.name] = a.value;
  }
  const children = significant(node).map((n) => layoutSpec(n, depth + 1));
  if (children.length > 2)
    throw fail("Observed Studio layout has too many children.");
  return { tag: "div", attributes, children };
}
function renderSpec(spec, depth = 0) {
  if (
    depth > 3 ||
    spec?.tag !== "div" ||
    !Array.isArray(spec.children) ||
    spec.children.length > 2 ||
    Object.values(spec.attributes ?? {}).some(
      (value) => typeof value !== "string" || value.length > 1024,
    )
  )
    throw fail("Observed layout specification is invalid.");
  const node = {
    nodeName: "div",
    tagName: "div",
    attrs: Object.entries(spec.attributes ?? {}).map(([name, value]) => ({
      name,
      value,
    })),
    childNodes: [],
  };
  for (const child of spec.children) {
    node.childNodes.push(
      parseFragment(renderSpec(child, depth + 1)).childNodes[0],
    );
  }
  layoutSpec(node);
  return serialize({ childNodes: [node] });
}
/** Capture only a source-bound empty Studio layout beyond the exported page copy. */
export function observedPageCopyLayout(html, { portal, path, origin }) {
  const page = portal?.pages?.find(
    (p) => normalizePortalPath(p.url) === normalizePortalPath(path),
  );
  if (!page || !page.html) return undefined;
  const source = page.html.replace(
    /\{%\s*comment\s*%\}[\s\S]*?\{%\s*endcomment\s*%\}/g,
    "",
  );
  if (/\{%|\{\{/.test(source)) return undefined;
  const copies = [];
  function visit(n) {
    if (classes(n).includes("page-copy")) copies.push(n);
    for (const c of n.childNodes ?? []) visit(c);
  }
  visit(parse(html));
  if (copies.length !== 1) return undefined;
  const candidates = [];
  function value(n) {
    if (classes(n).includes("xrm-attribute-value")) candidates.push(n);
    for (const c of n.childNodes ?? []) value(c);
  }
  value(copies[0]);
  if (candidates.length !== 1) return undefined;
  const nodes = significant(candidates[0]),
    last = nodes.at(-1);
  if (!last || !classes(last).includes("sectionBlockLayout")) return undefined;
  const sourceNodes = significant(parseFragment(source));
  if (
    JSON.stringify(sourceNodes.map(shape)) !==
    JSON.stringify(nodes.slice(0, -1).map(shape))
  )
    return undefined;
  const layout = layoutSpec(last);
  if (!classes(last).includes("row") || !layout.children.length)
    throw fail("Observed empty Studio layout has no section root.");
  return {
    version: 1,
    kind: "observed-empty-page-copy-layout",
    pageId: page.id,
    path: normalizePortalPath(page.url),
    origin,
    sourceSha256: digest(page.html),
    layout,
    layoutSha256: digest(JSON.stringify(layout)),
    capturedAt: new Date().toISOString(),
  };
}
export function resolveObservedPageCopy(
  source,
  { pageId, path, origin, profiles = [] },
) {
  const profile = profiles.find(
    (p) => p.pageId === pageId && p.path === normalizePortalPath(path),
  );
  if (!profile) return { source };
  if (profile.origin !== origin)
    return {
      source,
      diagnostic: {
        code: "PAGE_COPY_LAYOUT_ORIGIN_CHANGED",
        message: "Observed empty layout belongs to a different portal origin.",
      },
    };
  if (profile.sourceSha256 !== digest(source))
    return {
      source,
      diagnostic: {
        code: "PAGE_COPY_LAYOUT_SOURCE_CHANGED",
        message:
          "Observed empty layout is stale; edited local page copy takes priority.",
      },
    };
  if (
    profile.version !== 1 ||
    profile.kind !== "observed-empty-page-copy-layout" ||
    digest(JSON.stringify(profile.layout)) !== profile.layoutSha256
  )
    throw fail("Observed empty layout failed integrity validation.");
  const layout = renderSpec(profile.layout);
  return {
    source:
      '<div class="page-copy"><div class="xrm-editable-html xrm-attribute"><div class="xrm-attribute-value">' +
      source +
      layout +
      "</div></div></div>",
  };
}
