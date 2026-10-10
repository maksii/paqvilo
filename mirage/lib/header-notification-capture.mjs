import { createHash } from "node:crypto";
import { parse, parseFragment, serialize } from "parse5";
import { validateFooterLogoMarkup } from "./footer-capture.mjs";
const digest = (v) => createHash("sha256").update(v).digest("hex");
const fail = (message) =>
  Object.assign(new Error(message), {
    status: 422,
    code: "HEADER_NOTIFICATION_CAPTURE",
  });
const escape = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function walk(n, visit) {
  visit(n);
  for (const c of n.childNodes ?? []) walk(c, visit);
}
function hasClass(n, name) {
  return n.attrs
    ?.find((a) => a.name === "class")
    ?.value.split(/\s+/)
    .includes(name);
}
function find(html, predicate) {
  const root = parse(html, { sourceCodeLocationInfo: true }),
    found = [];
  walk(root, (n) => {
    if (predicate(n)) found.push(n);
  });
  return found;
}
const SEVERITIES = new Set(["success", "danger", "warning", "info"]);
function safeMenuStyle(value) {
  if (!value) return "";
  if (
    value.length > 256 ||
    value
      .split(";")
      .filter((v) => v.trim())
      .some(
        (v) =>
          !/^\s*(?:left|width|padding)\s*:\s*(?:-?\d+(?:\.\d+)?(?:px|rem|%)|auto)(?:\s*!important)?\s*$/i.test(
            v,
          ),
      )
  )
    throw fail("Notification dropdown layout contains unsupported CSS.");
  return value;
}
function validateItem(markup) {
  const fragment = parseFragment(markup),
    roots = fragment.childNodes.filter((n) => n.tagName);
  if (roots.length !== 1 || roots[0].tagName !== "li" || markup.length > 16384)
    throw fail("Notification item must be one bounded static list item.");
  const allowed = new Set(["li", "div", "p", "button", "span", "svg"]);
  let descriptions = 0;
  function visit(node, inSvg = false) {
    if (node.tagName === "svg") {
      validateFooterLogoMarkup(serialize({ childNodes: [node] }));
      return;
    }
    if (node.tagName) {
      if (!allowed.has(node.tagName))
        throw fail("Notification item contains a non-static element.");
      for (const a of node.attrs ?? []) {
        if (
          ![
            "class",
            "style",
            "type",
            "data-dismiss",
            "aria-label",
            "aria-hidden",
          ].includes(a.name)
        )
          throw fail("Notification item contains an unsupported attribute.");
        if (
          a.name === "style" &&
          /[\\@<>]|url\s*\(|expression\s*\(|javascript:/i.test(a.value)
        )
          throw fail("Notification item contains active styles.");
        if (a.name === "data-dismiss" && a.value !== "alert")
          throw fail("Notification item contains an unsupported action.");
        if (a.name === "aria-label" && a.value !== "Close")
          throw fail("Notification item contains an unexpected label.");
      }
      if (node.tagName === "p" && hasClass(node, "description")) {
        descriptions++;
        if (
          node.childNodes.some((n) => n.nodeName !== "#text" || n.value.trim())
        )
          throw fail("Observed item descriptions must be empty.");
      }
    } else if (
      node.nodeName !== "#text" ||
      (node.value.trim() && node.value.trim() !== "×")
    )
      throw fail("Notification item contains unexpected text.");
    for (const child of node.childNodes ?? []) visit(child);
  }
  visit(roots[0]);
  if (descriptions !== 1)
    throw fail("Notification item requires one empty description.");
  return serialize(fragment);
}
function captureItems(menu) {
  const templates = new Map();
  for (const row of menu?.childNodes ?? []) {
    if (row.tagName !== "li") continue;
    let description, alert;
    walk(row, (n) => {
      if (hasClass(n, "description")) description = n;
      if (
        n.attrs?.some(
          (a) =>
            a.name === "class" &&
            a.value
              .split(/\s+/)
              .some((c) => /^alert-(?:success|danger|warning|info)$/.test(c)),
        )
      )
        alert = n;
    });
    if (!description || !alert) continue;
    const type = [...SEVERITIES].find((name) =>
      hasClass(alert, "alert-" + name),
    );
    description.childNodes = [];
    const markup = validateItem(serialize({ childNodes: [row] }));
    if (!templates.has(type))
      templates.set(type, {
        severity: type,
        markup,
        sha256: digest(markup),
      });
  }
  return [...templates.values()];
}
function plainDescription(value) {
  return String(value ?? "").slice(0, 4096);
}
/** Capture only the observed bell/count presentation. Native dropdown contents are discarded. */
export function observedHeaderNotifications(
  html,
  { headerSource, origin, path = "/" },
) {
  const counts = find(html, (n) => hasClass(n, "notificationsCount"));
  if (counts.length === 0) return undefined;
  if (counts.length !== 1)
    throw fail("Expected one native notification count.");
  let li = counts[0];
  while (li && li.tagName !== "li") li = li.parentNode;
  if (!li || !hasClass(li, "userProfileHolder"))
    throw fail("Notification presentation is outside the observed header.");
  const anchor = li.childNodes?.find((n) => n.tagName === "a"),
    svg = anchor?.childNodes?.find((n) => n.tagName === "svg");
  if (
    !anchor ||
    !svg ||
    anchor.attrs?.find((a) => a.name === "href")?.value !== "#"
  )
    throw fail("Notification presentation has an unsupported action.");
  const menu = li.childNodes?.find(
    (n) => n.tagName === "ul" && hasClass(n, "alerts-dropdown"),
  );
  let menuStyle = menu?.attrs?.find((a) => a.name === "style")?.value ?? "";
  if (!menuStyle) {
    const styles = find(html, (n) => n.tagName === "style");
    for (const node of styles) {
      const css = (node.childNodes ?? []).map((n) => n.value ?? "").join("");
      const matches = [
        ...css.matchAll(/(?:^|})\s*\.alerts-dropdown\s*\{([^{}]*)\}/g),
      ];
      if (matches.length) {
        if (menuStyle)
          throw fail("Multiple observed notification dropdown layouts.");
        menuStyle = safeMenuStyle(matches[0][1]);
      }
    }
  }
  menuStyle = safeMenuStyle(menuStyle);
  const itemTemplates = captureItems(menu);
  const graphic = validateFooterLogoMarkup(serialize({ childNodes: [svg] }));
  const style = counts[0].attrs.find((a) => a.name === "style")?.value ?? "";
  if (
    style.length > 1024 ||
    /[\\@]|url\s*\(|expression\s*\(|javascript:/i.test(style) ||
    /[<>]/.test(style)
  )
    throw fail("Notification count styles contain active content.");
  // No live values, contact IDs, links, descriptions, handlers or inline scripts survive.
  const markup =
    '<li class="dropdown userProfileHolder" data-sim-observed-notifications><a href="#" class="dropdown-toggle userProfile" data-toggle="dropdown" role="button" aria-expanded="false">' +
    graphic +
    '\n                    <span class="notificationsCount" style="' +
    escape(style) +
    '"></span></a><ul class="dropdown-menu alerts-dropdown" role="menu"' +
    (menuStyle ? ' style="' + escape(menuStyle) + '"' : "") +
    "></ul></li>";
  return {
    markup,
    sourceSha256: digest(headerSource),
    sha256: digest(markup),
    origin,
    pagePath: path,
    capturedAt: new Date().toISOString(),
    ...(itemTemplates.length ? { itemTemplates } : {}),
  };
}
export function reconcileHeaderNotifications(
  rendered,
  source,
  profile,
  { notifications = [], origin } = {},
) {
  if (!profile) return { html: rendered };
  if (origin !== undefined && profile.origin !== origin)
    return {
      html: rendered,
      diagnostic: {
        code: "HEADER_NOTIFICATION_ORIGIN_CHANGED",
        message:
          "Observed notification presentation belongs to a different portal origin.",
      },
    };
  if (profile.sourceSha256 !== digest(source))
    return {
      html: rendered,
      diagnostic: {
        code: "HEADER_NOTIFICATION_SOURCE_CHANGED",
        message:
          "Observed notification presentation is stale after a header source edit.",
      },
    };
  if (profile.sha256 !== digest(profile.markup ?? ""))
    throw fail(
      "Observed notification presentation failed its integrity check.",
    );
  // Re-extract the exact static contract so edited profiles cannot inject executable markup.
  const validated = observedHeaderNotifications(profile.markup, {
    headerSource: source,
    origin: profile.origin,
    path: profile.pagePath,
  });
  if (!validated || validated.markup !== profile.markup)
    throw fail(
      "Observed notification presentation has an invalid static shape.",
    );
  if (!Array.isArray(notifications) || notifications.length > 100)
    throw fail("Local notifications exceed the bounded header limit.");
  const slots = find(
    rendered,
    (n) => n.tagName === "li" && hasClass(n, "userProfileHolder"),
  );
  if (
    slots.some((n) => {
      let found = false;
      walk(n, (c) => {
        if (hasClass(c, "notificationsCount")) found = true;
      });
      return found;
    })
  )
    return { html: rendered };
  const slot = slots.at(-1);
  if (!slot?.sourceCodeLocation) return { html: rendered };
  const fragment = parseFragment(profile.markup);
  const widget = fragment.childNodes.find((n) => n.tagName === "li");
  let count, menu;
  walk(widget, (n) => {
    if (hasClass(n, "notificationsCount")) count = n;
    if (hasClass(n, "alerts-dropdown")) menu = n;
  });
  const visibleNotifications = notifications.filter((row) => row.visible !== false);
  count.childNodes = [
    {
      nodeName: "#text",
      value: String(visibleNotifications.length),
      parentNode: count,
    },
  ];
  const templates = new Map();
  for (const template of profile.itemTemplates ?? []) {
    if (
      !SEVERITIES.has(template.severity) ||
      template.sha256 !== digest(template.markup) ||
      templates.has(template.severity)
    )
      throw fail("Observed notification item failed its integrity check.");
    templates.set(template.severity, validateItem(template.markup));
  }
  const items = visibleNotifications
    .map((n) => {
      const markup =
        templates.get(String(n.severity)) ??
        '<li><div class="alert alert-' +
          (SEVERITIES.has(n.severity) ? n.severity : "info") +
          '"><p class="description"></p></div></li>';
      const fragment = parseFragment(markup);
      walk(fragment, (node) => {
        if (hasClass(node, "description"))
          node.childNodes = [
            {
              nodeName: "#text",
              value: plainDescription(n.notificationText),
              parentNode: node,
            },
          ];
        if (node.tagName === "button") {
          let style = node.attrs.find((a) => a.name === "style");
          if (n.showCloseButton === false) {
            if (style) style.value += ";display:none";
            else node.attrs.push({ name: "style", value: "display:none" });
          } else if (style)
            style.value = style.value.replace(
              /(?:^|;)\s*display\s*:\s*none\s*;?/gi,
              "",
            );
        }
      });
      return serialize(fragment);
    })
    .join("");
  menu.childNodes = parseFragment(items).childNodes;
  for (const n of menu.childNodes) n.parentNode = menu;
  const offset = slot.sourceCodeLocation.startOffset;
  return {
    html:
      rendered.slice(0, offset) + serialize(fragment) + rendered.slice(offset),
  };
}
