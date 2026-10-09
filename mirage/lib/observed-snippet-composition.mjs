import { createHash } from "node:crypto";
import { parse, parseFragment } from "parse5";
import { validateLivePath } from "./live.mjs";
import { validateFooterLogoMarkup } from "./footer-capture.mjs";
import { serialize } from "parse5";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const failure = (message) =>
  Object.assign(new Error(message), {
    code: "SNIPPET_COMPOSITION_INVALID",
    status: 422,
  });
const significant = (node) =>
  (node.childNodes ?? []).filter(
    (child) => child.nodeName !== "#text" || child.value.trim(),
  );
function root(markup) {
  const nodes = significant(
    parseFragment(markup, { sourceCodeLocationInfo: true }),
  );
  if (nodes.length !== 1 || !nodes[0].tagName)
    throw failure("Observed composition requires one static root.");
  return nodes[0];
}
function shape(node, { hideStyle = false } = {}) {
  if (node.nodeName === "#text")
    return ["text", node.value.replace(/\s+/g, " ").trim()];
  return [
    node.tagName,
    (node.attrs ?? [])
      .filter((a) => !hideStyle || a.name !== "style")
      .map((a) => [a.name, a.value])
      .sort(([a], [b]) => a.localeCompare(b)),
    significant(node).map((child) => shape(child)),
  ];
}
function childSource(markup) {
  const node = root(markup);
  if (node.tagName !== "button" || !node.attrs.some((a) => a.name === "id"))
    throw failure("Observed action must be an existing exported button.");
  function visit(n) {
    if (n.tagName === "svg") {
      validateFooterLogoMarkup(serialize({ childNodes: [n] }));
      return;
    }
    if (n.tagName && !["button", "span"].includes(n.tagName))
      throw failure("Observed action contains unsupported elements.");
    for (const a of n.attrs ?? [])
      if (
        ![
          "class",
          "title",
          "style",
          "id",
          "type",
          "aria-label",
          "aria-hidden",
        ].includes(a.name) ||
        (a.name === "style" &&
          !/^\s*display\s*:\s*none\s*;?\s*$/i.test(a.value))
      )
        throw failure("Observed action contains unsupported attributes.");
    for (const c of n.childNodes ?? []) visit(c);
  }
  visit(node);
  return node;
}
/** Record only a verified composition of two existing local snippets, never native HTML. */
export function observedSnippetComposition({
  snippets,
  parentName,
  childName,
  observedMarkup,
  origin,
  pagePath,
}) {
  const parent = snippets[parentName],
    child = snippets[childName];
  if (
    typeof parent !== "string" ||
    typeof child !== "string" ||
    /\{%|\{\{/.test(parent + child)
  )
    throw failure("Observed composition requires static exported snippets.");
  const sourceParent = root(parent),
    sourceChild = childSource(child),
    observed = root(observedMarkup),
    parts = significant(observed),
    last = parts.at(-1);
  const observedStyle = last?.attrs?.find((a) => a.name === "style")?.value;
  if (
    observedStyle?.trim() &&
    !/^\s*display\s*:\s*none\s*;?\s*$/i.test(observedStyle)
  )
    throw failure("Observed action has an unexpected style change.");
  if (
    !last ||
    JSON.stringify(shape(last, { hideStyle: true })) !==
      JSON.stringify(shape(sourceChild, { hideStyle: true }))
  )
    throw failure(
      "Observed final action does not match the existing exported snippet.",
    );
  observed.childNodes = observed.childNodes.filter((n) => n !== last);
  if (JSON.stringify(shape(observed)) !== JSON.stringify(shape(sourceParent)))
    throw failure(
      "Observed empty-state markup differs beyond the existing exported action.",
    );
  return {
    version: 1,
    kind: "observed-snippet-composition",
    parentName,
    childName,
    sourceSha256: digest(parent),
    childSourceSha256: digest(child),
    observedShapeSha256: digest(
      JSON.stringify([
        shape(sourceParent),
        shape(sourceChild, { hideStyle: true }),
      ]),
    ),
    origin,
    pagePath,
    capturedAt: new Date().toISOString(),
  };
}
export function resolveSnippetComposition(
  snippets,
  key,
  profiles = [],
  { origin } = {},
) {
  const value = snippets[key],
    profile = profiles.find((p) => p.parentName === key);
  if (!profile) return { source: value };
  if (
    profile.version !== 1 ||
    profile.kind !== "observed-snippet-composition" ||
    typeof snippets[profile.childName] !== "string"
  )
    throw failure("Observed snippet composition profile is invalid.");
  if (origin !== profile.origin)
    return {
      source: value,
      diagnostic: {
        code: "SNIPPET_COMPOSITION_ORIGIN_CHANGED",
        message:
          "Observed snippet composition is bound to a different portal origin.",
      },
    };
  const child = snippets[profile.childName];
  if (
    digest(value ?? "") !== profile.sourceSha256 ||
    digest(child) !== profile.childSourceSha256
  )
    return {
      source: value,
      diagnostic: {
        code: "SNIPPET_COMPOSITION_SOURCE_CHANGED",
        message: `Observed composition for ${key} is stale; edited local snippets take priority.`,
      },
    };
  const parentRoot = root(value),
    childRoot = childSource(child);
  if (
    digest(
      JSON.stringify([
        shape(parentRoot),
        shape(childRoot, { hideStyle: true }),
      ]),
    ) !== profile.observedShapeSha256
  )
    throw failure(
      "Observed snippet composition failed its source-shape integrity check.",
    );
  const offset = parentRoot.sourceCodeLocation?.endTag?.startOffset;
  if (offset === undefined)
    throw failure("Observed composition requires a closing root tag.");
  return { source: value.slice(0, offset) + child + value.slice(offset) };
}
/** Explicit read-only native page observation; page HTML never enters the returned profile. */
export async function captureObservedSnippetComposition(
  live,
  { portal, path, parentName, childName },
) {
  validateLivePath(path);
  if (!live?.context || !live.origin)
    throw failure("A connected intended portal browser is required.");
  if (/^\/(?:_api|__sim)(?:\/|$)/i.test(path))
    throw failure("Composition observation requires a portal page.");
  const response = await live.request(path, { method: "GET" });
  if (
    response.status !== 200 ||
    !/^text\/html(?:;|$)/i.test(response.headers?.["content-type"] ?? "")
  )
    throw failure("Composition observation requires an HTTP 200 HTML page.");
  const html = Buffer.from(
    response.body,
    response.bodyEncoding === "base64" ? "base64" : "utf8",
  ).toString("utf8");
  if (
    html.length > 5 * 1024 * 1024 ||
    /\/(?:account\/login|signin)(?:[/?]|$)/i.test(response.url ?? "")
  )
    throw failure(
      "Composition observation is too large or redirected to sign-in.",
    );
  const candidates = [];
  function visit(n) {
    if (n.tagName) candidates.push(n);
    for (const child of n.childNodes ?? []) visit(child);
  }
  visit(parse(html));
  const parent = root(portal.snippets[parentName] ?? ""),
    observed = [],
    reasons = new Set();
  for (const node of candidates) {
    if (
      node.tagName !== parent.tagName ||
      JSON.stringify(
        (node.attrs ?? []).map((a) => [a.name, a.value]).sort(),
      ) !==
        JSON.stringify(
          (parent.attrs ?? []).map((a) => [a.name, a.value]).sort(),
        )
    )
      continue;
    try {
      observed.push(
        observedSnippetComposition({
          snippets: portal.snippets,
          parentName,
          childName,
          observedMarkup: serialize({ childNodes: [node] }),
          origin: live.origin,
          pagePath: path,
        }),
      );
    } catch (error) {
      if (error.code !== "SNIPPET_COMPOSITION_INVALID") throw error;
      reasons.add(error.message);
    }
  }
  let observation = { provider: "native-page-html", blockedRequests: [] };
  if (observed.length === 0 && typeof live.context.newPage === "function") {
    if (
      live.context
        .serviceWorkers?.()
        .some((worker) => new URL(worker.url()).origin === live.origin)
    )
      throw failure(
        "Dynamic observation cannot guarantee read-only requests while a portal service worker is active.",
      );
    const id = childSource(portal.snippets[childName]).attrs.find(
      (a) => a.name === "id",
    ).value;
    if (!/^[\w:-]{1,160}$/.test(id))
      throw failure("Observed action identifier cannot be safely selected.");
    const selector =
      parent.tagName +
      parent.attrs
        .filter((a) => ["class", "id"].includes(a.name))
        .map((a) => "[" + a.name + "=" + JSON.stringify(a.value) + "]")
        .join("") +
      ' > [id="' +
      id +
      '"]';
    let page;
    const blockedRequests = [];
    try {
      page = await live.context.newPage();
      await page.route("**/*", (route) =>
        ["GET", "HEAD"].includes(route.request().method())
          ? route.continue()
          : (blockedRequests.push({
              method: route.request().method(),
              path: new URL(route.request().url()).pathname,
            }),
            route.abort()),
      );
      await page.goto(live.origin + path, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page
        .locator(selector)
        .waitFor({ state: "attached", timeout: 10000 });
      const final = new URL(page.url()),
        expected = new URL(path, live.origin);
      if (final.origin !== live.origin || final.pathname !== expected.pathname)
        throw failure(
          "Native composition page redirected away from the requested portal page.",
        );
      const markup = await page
        .locator(selector)
        .evaluate((node) => node.parentElement.outerHTML);
      observed.push(
        observedSnippetComposition({
          snippets: portal.snippets,
          parentName,
          childName,
          observedMarkup: markup,
          origin: live.origin,
          pagePath: path,
        }),
      );
      observation = { provider: "native-browser-dom", blockedRequests };
    } finally {
      await page?.close();
    }
  }
  if (observed.length !== 1)
    throw failure(
      "Expected exactly one native composition matching both exported snippets." +
        (reasons.size ? " " + [...reasons].join(" ") : ""),
    );
  return {
    profile: observed[0],
    observation,
    diagnostics: [
      {
        code: "OBSERVED_SNIPPET_COMPOSITION",
        message:
          "Observed native static composition uses existing exported snippets; no native HTML is stored.",
      },
    ],
  };
}
