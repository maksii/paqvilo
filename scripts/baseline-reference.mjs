#!/usr/bin/env node
// Generates the offline reference (mirage/docs/baseline/reference.md) from captured live
// evidence: per component, variation, state and persona it records what rendered, which request
// sequence fired, which configuration record drives the page (site manifest + catalog ids) and the
// inventory rows that explain it. Only minimal, redacted excerpts are written; bulk evidence stays
// in the project's ignored evidence folder.
//
// What rendered is judged from what was visible at capture time: the element inventory's `visible`
// flags select the nodes (validation summary, alerts, messages, open dialogs, data grids, watched
// controls) and dom.html supplies their text. Hidden templates and resource strings do not count.
//
//   node scripts/baseline-reference.mjs --evidence <dir> --matrix <matrix.json> [--label live] [--reasons <json>] [--out mirage/docs/baseline/reference.md]
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { parse } from "parse5";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (file, fallback = null) => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
};
const escape = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const QUERY = /\?[^\s"'<>)]*/g;
const clip = (text, max = 160) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// ---------------------------------------------------------------------------
// dom.html lookup by the inventory's selector paths (`tag#id>tag:nth-of-type(n)>…`).
// ---------------------------------------------------------------------------
const children = (node) => (node.childNodes ?? []).filter((child) => child.tagName);
function textOf(node) {
  if (node.nodeName === "#text") return node.value;
  if (["script", "style", "template", "noscript"].includes(node.tagName)) return "";
  return (node.childNodes ?? []).map(textOf).join(" ");
}
function index(document) {
  const byId = new Map();
  const walk = (node) => {
    const id = node.attrs?.find((attribute) => attribute.name === "id")?.value;
    if (id && !byId.has(id)) byId.set(id, node);
    for (const child of children(node)) walk(child);
  };
  walk(document);
  const body = (function find(node) {
    if (node.tagName === "body") return node;
    for (const child of children(node)) {
      const found = find(child);
      if (found) return found;
    }
    return null;
  })(document);
  return { byId, body };
}
function resolve({ byId, body }, selector) {
  const parts = selector.split(">");
  let node = null;
  for (const [position, part] of parts.entries()) {
    const match = /^([a-z0-9-]+)(?:#(.+?))?(?::nth-of-type\((\d+)\))?$/i.exec(part);
    if (!match) return null;
    const [, tag, id, nth] = match;
    if (id) node = byId.get(CSS_unescape(id)) ?? null;
    else if (position === 0 && tag === "body") node = body;
    else if (node) node = children(node).filter((child) => child.tagName === tag.toLowerCase())[Number(nth ?? 1) - 1] ?? null;
    if (!node) return null;
  }
  return node;
}
const CSS_unescape = (text) => text.replace(/\\(.)/g, "$1");

// ---------------------------------------------------------------------------
// Rendered summary from the visible inventory.
// ---------------------------------------------------------------------------
const MESSAGE_CLASSES = ["validation-summary", "alert", "message", "text-danger", "calendar-error"];
function renderSummary(elements, dom, scenario) {
  const visible = elements.filter((e) => e.visible);
  const controls = visible.filter((e) => ["input", "select", "textarea"].includes(e.tag) && !["hidden", "submit", "button"].includes(e.attributes.type ?? ""));
  const buttons = visible.filter((e) => (e.tag === "input" && ["submit", "button"].includes(e.attributes.type ?? "")) || e.tag === "button");
  const tree = index(parse(dom));
  // Visible message nodes in document order (outermost first): a text already quoted by an enclosing node is skipped.
  const messages = [];
  for (const element of visible.filter((e) => e.classes.some((c) => MESSAGE_CLASSES.includes(c)))) {
    const node = resolve(tree, element.selector);
    const text = node ? textOf(node).replace(/\s+/g, " ").trim() : "";
    if (!text || messages.some((listed) => listed.includes(text))) continue;
    messages.push(text);
  }
  // Liquid errors render as page text, outside any message element.
  for (const match of textOf(tree.body ?? parse(dom)).replace(/\s+/g, " ").matchAll(/Liquid error:[^.]*\./g)) if (!messages.includes(match[0])) messages.push(match[0]);
  // Only data grids (Bootstrap tables of an entity list, subgrid or lookup) count; form sections are tables too.
  const grids = visible.filter((e) => e.tag === "table" && e.classes.includes("table")).length;
  const rows = visible.filter((e) => e.tag === "tr" && e.attributes["data-id"]).length;
  const modals = visible.filter((e) => e.classes.includes("modal") && (e.classes.includes("in") || e.classes.includes("show"))).length;
  // Controls the scenario filled or named in `watch`: their visibility and value after the capture.
  const watched = [...new Set([...(scenario.watch ?? []), ...(scenario.steps ?? []).map((step) => /^#([\w-]+)$/.exec(step.fill ?? step.clear ?? "")?.[1]).filter(Boolean)])];
  const values = watched.map((id) => {
    const element = elements.find((e) => e.attributes.id === id);
    if (!element) return `#${id} absent`;
    return `#${id} ${element.visible ? "visible" : "hidden"}${element.value !== undefined ? `="${clip(String(element.value), 60)}"` : ""}`;
  });
  return {
    controls: controls.length,
    required: controls.filter((e) => e.required).length,
    disabled: controls.filter((e) => e.disabled || e.readonly).length,
    buttons: buttons.map((e) => e.attributes.value ?? e.attributes.title ?? e.attributes["aria-label"] ?? "").filter(Boolean).slice(0, 6),
    grids,
    rows,
    modals,
    messages: messages.map((text) => clip(text.replace(GUID, "{guid}").replace(QUERY, "?…"))).slice(0, 5),
    values,
  };
}

function requestSummary(requests) {
  return requests
    .filter((r) => r.resourceType === "document" || r.resourceType === "xhr" || r.resourceType === "fetch")
    .map((r) => `${r.method} ${r.url.replace(GUID, "{guid}").slice(0, 90)} → ${r.response?.status ?? "—"}`);
}

async function main() {
  const { values } = parseArgs({ options: { evidence: { type: "string" }, matrix: { type: "string" }, label: { type: "string" }, out: { type: "string" }, reasons: { type: "string" } } });
  if (!values.evidence || !values.matrix) throw new Error("--evidence and --matrix are required");
  const label = values.label ?? "live";
  const matrix = JSON.parse(await fs.readFile(values.matrix, "utf8"));
  const manifest = await readJson(path.join(root, "examples/project/baseline/site-manifest.json"), { records: [] });
  // A page is described by its component record (basic form, list, multistep form), not by the web page record that hosts it.
  const byPath = new Map();
  for (const record of manifest.records.filter((r) => r.path)) if (!byPath.has(record.path) || ["webpage", "website"].includes(byPath.get(record.path).kind)) byPath.set(record.path, record);
  // Reviewed reasons (`--reasons <json>`: scenario id → text) explain a state the live portal cannot reach or a captured page
  // that does not show the promised state; they are printed whether or not the capture succeeded.
  const reasons = values.reasons ? await readJson(values.reasons, {}) : {};
  const sections = new Map();
  let captured = 0;
  let noted = 0;
  let missing = 0;
  for (const scenario of matrix.scenarios) {
    const folder = path.join(values.evidence, ...scenario.id.split("/"), label);
    const meta = await readJson(path.join(folder, "meta.json"));
    const key = `${scenario.component} · ${scenario.variation}`;
    const list = sections.get(key) ?? [];
    const entry = { scenario, meta };
    if (!meta) missing++;
    else if (meta.status === "captured") {
      captured++;
      if (reasons[scenario.id]) noted++;
      entry.render = renderSummary(await readJson(path.join(folder, "elements.json"), []), await fs.readFile(path.join(folder, "dom.html"), "utf8").catch(() => ""), scenario);
      entry.requests = requestSummary(await readJson(path.join(folder, "requests.json"), []));
    }
    list.push(entry);
    sections.set(key, list);
  }
  const lines = ["# Native component reference (offline)", "", `Generated by \`scripts/baseline-reference.mjs\` from the project's captured live evidence (label \`${label}\`), the scenario matrix and the fixture site manifest. Per component and state: what was visible (controls, buttons, data grids and rows, open dialogs, the text of visible validation summaries, alerts and messages, the values of the controls the scenario filled or watches), which requests fired (documents and XHR, query values redacted), which configuration record drives the page and the catalog items it exercises (the inventories explain each item). Captures whose status is not \`captured\` are listed as not observed; a reviewed note explains a page that does not reach the state its name promises. Do not edit by hand.`, "", `Scenarios in the matrix: ${matrix.scenarios.length}. Observed: ${captured} (${noted} with a reviewed note). Not observed: ${matrix.scenarios.length - captured} (${missing} without evidence).`, ""];
  for (const [key, entries] of [...sections].sort()) {
    lines.push(`## ${key}`, "");
    const page = entries[0].scenario.steps.find((s) => s.goto)?.goto?.split("?")[0];
    const record = page ? byPath.get(page) : null;
    if (record) lines.push(`Configuration: ${record.kind} \`${record.name}\` at \`${record.path}\` (${escape(record.variation ?? "")}); catalog items: ${(record.catalog ?? []).slice(0, 12).map((id) => `\`${id}\``).join(", ")}${(record.catalog ?? []).length > 12 ? ", …" : ""}. See the [Power Pages inventory](power-pages-inventory.md) rows for these ids and the [Dataverse inventory](dataverse-inventory.md) for the form/view/column rows named by the page.`, "");
    lines.push("| State | Persona | Observed | Rendered | Requests (documents and XHR) |", "| --- | --- | --- | --- | --- |");
    for (const { scenario, meta, render, requests } of entries) {
      const reason = reasons[scenario.id] ? escape(reasons[scenario.id]) : "";
      const observed = !meta ? `no evidence${reason ? ` — ${reason}` : ""}` : meta.status === "captured" ? `yes${reason ? ` — note: ${reason}` : ""}` : `no — ${reason || "not reviewed"} (capture ${meta.status}: ${escape((meta.problems?.[0] ?? "").split("\n")[0].slice(0, 120))})`;
      const rendered = render
        ? [
            `title "${escape(meta.title)}"`,
            `${render.controls} controls (${render.required} required, ${render.disabled} read-only)`,
            `buttons ${render.buttons.map((b) => `"${escape(b)}"`).join(", ") || "none"}`,
            `${render.grids} data grids / ${render.rows} rows`,
            `${render.modals} open dialogs`,
            `messages: ${render.messages.map((m) => `"${escape(m)}"`).join("; ") || "none"}`,
            ...(render.values.length ? [`values: ${render.values.map(escape).join(", ")}`] : []),
          ].join("; ")
        : "—";
      const seq = requests ? requests.slice(0, 8).map(escape).join("<br>") + (requests.length > 8 ? `<br>… ${requests.length - 8} more` : "") : "—";
      lines.push(`| ${scenario.state} | ${scenario.persona ?? "anonymous"} | ${observed} | ${rendered} | ${seq} |`);
    }
    lines.push("");
  }
  const out = values.out ?? path.join(root, "mirage/docs/baseline/reference.md");
  await fs.writeFile(out, lines.join("\n"));
  console.log(JSON.stringify({ out, sections: sections.size, scenarios: matrix.scenarios.length, captured, noted, missing }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
