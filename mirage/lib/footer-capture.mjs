import { createHash } from "node:crypto";
import { parse, parseFragment, serialize } from "parse5";
import { footerLogoClasses } from "./extensions.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message) =>
  Object.assign(new Error(message), {
    status: 422,
    code: "FOOTER_LOGO_CAPTURE",
  });
const elements = new Set([
  "svg",
  "g",
  "defs",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "title",
  "desc",
  "style",
  "clipPath",
  "linearGradient",
  "radialGradient",
  "stop",
  "use",
  "symbol",
  "mask",
  "pattern",
  "image",
  "img",
]);
const attributes = new Set([
  "id",
  "class",
  "xmlns",
  "xmlns:xlink",
  "viewBox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "fill-rule",
  "clip-rule",
  "clip-path",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "transform",
  "gradientTransform",
  "gradientUnits",
  "offset",
  "stop-color",
  "stop-opacity",
  "fx",
  "fy",
  "font-family",
  "font-size",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
  "preserveAspectRatio",
  "role",
  "aria-label",
  "aria-hidden",
  "focusable",
  "data-name",
  "style",
  "href",
  "xlink:href",
  "src",
  "alt",
  "loading",
]);
function cssSafe(value) {
  if (/[\\]|@|expression\s*\(|javascript\s*:|\/\*/i.test(value)) return false;
  return [...value.matchAll(/url\s*\(([^)]*)\)/gi)].every((match) =>
    /^\s*["']?#[\w.-]+["']?\s*$/.test(match[1]),
  );
}
function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
}
function logoSlot(html) {
  const classNames = footerLogoClasses();
  if (!classNames.length)
    throw fail("No data pack declares a footer logo container class.");
  const document = parse(html, { sourceCodeLocationInfo: true }),
    slots = [];
  walk(document, (node) => {
    if (
      node.attrs?.some(
        (a) =>
          a.name === "class" &&
          a.value.split(/\s+/).some((name) => classNames.includes(name)),
      )
    )
      slots.push(node);
  });
  if (slots.length !== 1 || !slots[0].sourceCodeLocation?.endTag)
    throw fail("Expected one observed footer logo container.");
  return slots[0];
}

/** Accept static graphics only; page scripts, user values and hidden controls never enter a profile. */
export function validateFooterLogoMarkup(markup) {
  if (typeof markup !== "string" || Buffer.byteLength(markup) > 512 * 1024)
    throw fail("Footer graphics exceed the bounded static slot.");
  const fragment = parseFragment(markup);
  const top = (fragment.childNodes ?? []).filter(
    (node) => node.nodeName !== "#text" || node.value.trim(),
  );
  if (!top.length || top.some((node) => !["svg", "img"].includes(node.tagName)))
    throw fail("Footer slot must contain direct SVG or image elements.");
  walk(fragment, (node) => {
    if (node.nodeName === "#comment")
      throw fail("Footer graphics cannot contain comments.");
    if (!node.tagName) return;
    if (!elements.has(node.tagName))
      throw fail("Footer graphics contain a non-static element.");
    for (const attribute of node.attrs ?? []) {
      const name = attribute.prefix
        ? attribute.prefix + ":" + attribute.name
        : attribute.name;
      if (!attributes.has(name) || /^on/i.test(name))
        throw fail(
          `Footer graphics contain an unsupported attribute: ${name}.`,
        );
      if (
        ["href", "xlink:href"].includes(name) &&
        !/^#[\w.-]+$/.test(attribute.value)
      )
        throw fail("SVG references must be internal to their graphic.");
      if (
        name === "src" &&
        (!attribute.value.startsWith("/") ||
          attribute.value.startsWith("//") ||
          /[\\\u0000-\u001f]/.test(attribute.value))
      )
        throw fail("Footer images must use a captured portal-relative asset.");
      if (name === "style" && !cssSafe(attribute.value))
        throw fail("Footer inline styles contain active or external content.");
      if (
        ["fill", "stroke", "clip-path", "mask"].includes(name) &&
        !cssSafe(attribute.value)
      )
        throw fail("Footer graphic references escaped the image.");
    }
    if (
      node.tagName === "style" &&
      !cssSafe((node.childNodes ?? []).map((n) => n.value ?? "").join(""))
    )
      throw fail("Footer styles contain active or external content.");
  });
  return serialize(fragment);
}

/** A single observed, intrinsic SVG sizing rule; never a general stylesheet override. */
export function observedFooterLayout({ path, sourceCss, observedCss }) {
  if (
    typeof path !== "string" ||
    !/^\/(?!\/)[^?#\\]+\.css$/i.test(path) ||
    typeof sourceCss !== "string" ||
    typeof observedCss !== "string"
  )
    throw fail("Footer layout requires a mapped stylesheet and its source.");
  const classNames = footerLogoClasses();
  if (!classNames.length)
    throw fail("No data pack declares a footer logo container class.");
  const clean = observedCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [
    ...clean.matchAll(
      new RegExp(
        String.raw`(?:^|})\s*\.(?:${classNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\s+svg\s*\{([^{}]*)\}`,
        "g",
      ),
    ),
  ];
  const topLevel = (offset) => {
    let depth = 0,
      quote;
    for (let index = 0; index < offset; index++) {
      const character = clean[index];
      if (quote) {
        if (character === "\\") index++;
        else if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === "{") depth++;
      else if (character === "}") depth--;
    }
    return depth === 0;
  };
  if (
    !rules.some(
      (rule) =>
        topLevel(rule.index + (rule[0].startsWith("}") ? 1 : 0)) &&
        /(?:^|;)\s*width\s*:\s*auto\s*(?:;|$)/i.test(rule[1]),
    )
  )
    return undefined;
  const layout = {
    path,
    sourceCssSha256: digest(sourceCss),
    observedCssSha256: digest(observedCss),
    svgWidth: "auto",
  };
  return { ...layout, sha256: digest(JSON.stringify(layout)) };
}

export function observedFooterLogos(
  html,
  { footerSource, origin, path = "/", layout },
) {
  const slot = logoSlot(html),
    location = slot.sourceCodeLocation;
  const markup = validateFooterLogoMarkup(
    html.slice(location.startTag.endOffset, location.endTag.startOffset),
  );
  return {
    markup,
    sourceSha256: digest(footerSource),
    sha256: digest(markup),
    origin,
    pagePath: path,
    capturedAt: new Date().toISOString(),
    ...(layout ? { layout } : {}),
  };
}

/** Preserve editable source links/Liquid and invalidate the reconciliation after a footer source edit. */
export function reconcileFooterLogos(
  rendered,
  source,
  profile,
  { styleSources = {}, origin } = {},
) {
  if (!profile) return { html: rendered };
  // Without a data pack declaring the logo container class the step is
  // skipped: the exported footer renders unchanged with a diagnostic.
  if (!footerLogoClasses().length)
    return {
      html: rendered,
      diagnostic: {
        code: "FOOTER_LOGO_CLASS_UNDECLARED",
        message:
          "No data pack declares the footer logo container class; observed footer graphics are not applied.",
      },
    };
  if (origin !== undefined && profile.origin !== origin)
    return {
      html: rendered,
      diagnostic: {
        code: "FOOTER_ORIGIN_CHANGED",
        message:
          "Observed footer graphics belong to a different portal origin.",
      },
    };
  if (profile.sourceSha256 !== digest(source))
    return {
      html: rendered,
      diagnostic: {
        code: "FOOTER_SOURCE_CHANGED",
        message:
          "Observed footer graphics are stale after an exported footer edit.",
      },
    };
  if (profile.sha256 !== digest(profile.markup ?? ""))
    throw fail("Observed footer graphics failed their integrity check.");
  let markup = validateFooterLogoMarkup(profile.markup),
    diagnostic;
  if (profile.layout) {
    const { sha256, ...layout } = profile.layout;
    if (
      layout.svgWidth !== "auto" ||
      !/^\/(?!\/)[^?#\\]+\.css$/i.test(layout.path) ||
      !/^[a-f\d]{64}$/.test(layout.observedCssSha256 ?? "") ||
      sha256 !== digest(JSON.stringify(layout))
    )
      throw fail("Observed footer layout failed its integrity check.");
    const css = styleSources[layout.path];
    if (typeof css !== "string" || digest(css) !== layout.sourceCssSha256)
      diagnostic = {
        code: "FOOTER_LAYOUT_SOURCE_CHANGED",
        message:
          "Observed intrinsic footer SVG sizing is stale after a stylesheet source edit.",
        path: layout.path,
      };
    else {
      const fragment = parseFragment(markup);
      for (const graphic of fragment.childNodes ?? [])
        if (graphic.tagName === "svg") {
          const style = graphic.attrs.find(
            (attribute) => attribute.name === "style",
          );
          if (style) style.value += ";width:auto";
          else graphic.attrs.push({ name: "style", value: "width:auto" });
        }
      markup = serialize(fragment);
    }
  }
  const slot = logoSlot(rendered),
    location = slot.sourceCodeLocation;
  return {
    html:
      rendered.slice(0, location.startTag.endOffset) +
      markup +
      rendered.slice(location.endTag.startOffset),
    ...(diagnostic ? { diagnostic } : {}),
  };
}
