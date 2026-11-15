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
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import { emailMatches, replaceEmails } from '../mirage/lib/text-scanning.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (file, fallback = null) => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const escape = (text) =>
  String(text ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll('|', String.raw`\|`)
    .replace(/\s+/g, ' ')
    .trim();
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const QUERY = /\?[^\s"'<>)]*/g;
// The document is shared: ids, hosts (absolute URLs, e.g. a sign-in button naming the tenant's authority) and e-mail
// addresses are reduced in everything printed, and the written text is scanned for any that remain.
const URL_HOST = /\b(https?:\/\/)[^/\s"'<>)|\\]+/gi;
const HOST = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|ms|cloud|windows|microsoft|azure|dynamics|invalid)\b/gi;
export const redact = (text) =>
  replaceEmails(String(text).replace(GUID, '{guid}'), '{email}').replace(URL_HOST, '$1{host}');
export const leaks = (text) => [
  ...new Set(
    [GUID, null, HOST].flatMap((pattern) =>
      [...(pattern ? String(text).matchAll(pattern) : emailMatches(String(text)))].map((match) => match[0]),
    ),
  ),
];
const clip = (text, max = 160) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// ---- dom.html lookup by the inventory's selector paths (`tag#id>tag:nth-of-type(n)>…`).
const children = (node) => (node.childNodes ?? []).filter((child) => child.tagName);
function textOf(node) {
  if (node.nodeName === '#text') return node.value;
  if (['script', 'style', 'template', 'noscript'].includes(node.tagName)) return '';
  return (node.childNodes ?? []).map(textOf).join(' ');
}
function index(document) {
  const byId = new Map();
  const walk = (node) => {
    const id = node.attrs?.find((attribute) => attribute.name === 'id')?.value;
    if (id && !byId.has(id)) byId.set(id, node);
    for (const child of children(node)) walk(child);
  };
  walk(document);
  const body = (function find(node) {
    if (node.tagName === 'body') return node;
    for (const child of children(node)) {
      const found = find(child);
      if (found) return found;
    }
    return null;
  })(document);
  return { byId, body };
}
function resolve({ byId, body }, selector) {
  const parts = selector.split('>');
  let node = null;
  for (const [position, part] of parts.entries()) {
    const match = /^([a-z0-9-]+)(?:#(.+?))?(?::nth-of-type\((\d+)\))?$/i.exec(part);
    if (!match) return null;
    const [, tag, id, nth] = match;
    if (id) node = byId.get(CSS_unescape(id)) ?? null;
    else if (position === 0 && tag === 'body') node = body;
    else if (node)
      node = children(node).filter((child) => child.tagName === tag.toLowerCase())[Number(nth ?? 1) - 1] ?? null;
    if (!node) return null;
  }
  return node;
}
const CSS_unescape = (text) => text.replace(/\\(.)/g, '$1');

// ---- Rendered summary from the visible inventory.
const MESSAGE_CLASSES = new Set(['validation-summary', 'alert', 'message', 'text-danger', 'calendar-error']);
function visibleMessages(visible, tree, dom) {
  const messages = [];
  for (const element of visible.filter((e) => e.classes.some((c) => MESSAGE_CLASSES.has(c)))) {
    const node = resolve(tree, element.selector);
    const text = node ? textOf(node).replace(/\s+/g, ' ').trim() : '';
    if (!text || messages.some((listed) => listed.includes(text))) continue;
    messages.push(text);
  }
  // Liquid errors render as page text, outside any message element.
  for (const match of textOf(tree.body ?? parse(dom))
    .replace(/\s+/g, ' ')
    .matchAll(/Liquid error:[^.]*\./g))
    if (!messages.includes(match[0])) messages.push(match[0]);
  return messages;
}

function formActionsBar(elements) {
  const tabs = elements.flatMap((e, position) =>
    e.visible && e.tag === 'div' && e.classes.includes('tab') ? [position] : [],
  );
  const bars = elements.flatMap((e, position) =>
    e.visible && e.classes.includes('form-custom-actions') ? [position] : [],
  );
  return bars.length && tabs.length
    ? [
        ...new Set(
          bars.map((position) => {
            if (position < tabs[0]) return 'above';
            return position > tabs.at(-1) ? 'below' : 'between the tabs of';
          }),
        ),
      ].join(' and ')
    : null;
}

function skipPageContentNode(node) {
  return (
    ['script', 'style', 'template', 'noscript', 'header', 'footer', 'nav'].includes(node.tagName) ||
    /\b(?:navbar|modal)\b/.test(node.attrs?.find((a) => a.name === 'class')?.value ?? '')
  );
}

function pageContentText(node) {
  if (node.nodeName === '#text') return node.value;
  if (skipPageContentNode(node)) return '';
  return (node.childNodes ?? []).map(pageContentText).join(' ');
}

function renderedPageContent(scenario, bodyText, tree) {
  if (scenario.component !== 'page' || bodyText !== null || !tree.body) return null;
  const main = tree.byId.get('mainContent');
  const rendered = pageContentText(main ?? tree.body)
    .replace(/\s+/g, ' ')
    .trim();
  return rendered ? `${rendered.length} chars "${clip(rendered.replace(QUERY, '?…'), 200)}"` : null;
}

function dialogSummaries(elements, visible, tree) {
  const textAt = (element) => {
    const node = resolve(tree, element.selector);
    return node ? textOf(node).replace(/\s+/g, ' ').trim() : '';
  };
  return visible
    .filter((e) => e.classes.includes('modal') && (e.classes.includes('in') || e.classes.includes('show')))
    .map((modal) => {
      const inside = elements.filter((e) => e.selector.startsWith(`${modal.selector}>`));
      const size =
        inside
          .find((e) => e.classes.includes('modal-dialog'))
          ?.classes.find((c) => c === 'modal-lg' || c === 'modal-sm') ?? 'default';
      const title = inside.find((e) => e.classes.includes('modal-title'));
      const titleText = title ? ` "${clip(textAt(title), 60)}"` : '';
      return `${size}${titleText}`;
    });
}

function bodySummary(tree) {
  const pre = tree.body ? children(tree.body).filter((child) => child.tagName === 'pre') : [];
  const bodyText = pre.length === 1 ? textOf(pre[0]).trim() : null;
  let body = null;
  if (bodyText !== null) {
    let valid = true;
    try {
      JSON.parse(bodyText);
    } catch {
      valid = false;
    }
    body = `"${clip(bodyText.replace(GUID, '{guid}'), 100)}" (${valid ? 'valid JSON' : 'not valid JSON'})`;
  }
  return { bodyText, body };
}

function noteSummaries(visible) {
  return visible
    .filter((e) => e.tag === 'div' && e.classes.includes('note') && e.attributes['data-id'])
    .map((e) => {
      const text = clip(
        String(e.attributes['data-unformattedtext'] ?? '')
          .replace(/s+/g, ' ')
          .trim(),
        60,
      );
      const file = e.attributes['data-attachmentfilename'];
      const fileSize = e.attributes['data-attachmentfilesize'];
      const sizeText = fileSize ? ` (${fileSize})` : '';
      const attachment = file ? ` with ${file}${sizeText}` : '';
      return `"${text}"${attachment}`;
    });
}

function watchedValues(elements, scenario) {
  const watched = [
    ...new Set([
      ...(scenario.watch ?? []),
      ...(scenario.steps ?? []).map((step) => /^#([\w-]+)$/.exec(step.fill ?? step.clear ?? '')?.[1]).filter(Boolean),
    ]),
  ];
  return watched.map((id) => {
    const element = elements.find((e) => e.attributes.id === id);
    if (!element) return `#${id} absent`;
    const valueText = element.value !== undefined ? `="${clip(String(element.value), 60)}"` : '';
    return `#${id} ${element.visible ? 'visible' : 'hidden'}${valueText}`;
  });
}

function renderSummary(elements, dom, scenario) {
  const visible = elements.filter((e) => e.visible);
  const controls = visible.filter(
    (e) =>
      ['input', 'select', 'textarea'].includes(e.tag) &&
      !['hidden', 'submit', 'button'].includes(e.attributes.type ?? ''),
  );
  const buttons = visible.filter(
    (e) => (e.tag === 'input' && ['submit', 'button'].includes(e.attributes.type ?? '')) || e.tag === 'button',
  );
  const tree = index(parse(dom));
  // Visible message nodes in document order (outermost first): a text already quoted by an enclosing node is skipped.
  const messages = visibleMessages(visible, tree, dom);
  // Only data grids (Bootstrap tables of an entity list, subgrid or lookup) count; form sections are tables too.
  const grids = visible.filter((e) => e.tag === 'table' && e.classes.includes('table')).length;
  const rows = visible.filter((e) => e.tag === 'tr' && e.attributes['data-id']).length;
  // Open dialogs with their size class (modal-lg, modal-sm or default) and title; the inventory is in document order, so a
  // dialog's descendants carry its selector as prefix.
  const dialogs = dialogSummaries(elements, visible, tree);
  // Form action bar (basic form settings) placement relative to the form's tabs.
  const actionsBar = formActionsBar(elements);
  // A document the browser shows as plain text (JSON or text templates): the body is one <pre>.
  const { bodyText, body } = bodySummary(tree);
  // Page rows (Liquid, template and page-rule pages): the text the page content renders, from #mainContent or, for a
  // template that replaces the layout, the body without header, footer, navigation and dialog templates.
  const content = renderedPageContent(scenario, bodyText, tree);
  // Visible notes (the notes control's rendered entries): text and attached file name, newest first as rendered.
  const notes = noteSummaries(visible);
  // Controls the scenario filled or named in `watch`: their visibility and value after the capture.
  const values = watchedValues(elements, scenario);
  return {
    controls: controls.length,
    required: controls.filter((e) => e.required).length,
    disabled: controls.filter((e) => e.disabled || e.readonly).length,
    buttons: buttons
      .map((e) => e.attributes.value ?? e.attributes.title ?? e.attributes['aria-label'] ?? '')
      .filter(Boolean)
      .slice(0, 6),
    grids,
    rows,
    dialogs,
    actionsBar,
    body,
    content,
    notes,
    messages: messages.map((text) => clip(text.replace(GUID, '{guid}').replace(QUERY, '?…'))).slice(0, 5),
    values,
  };
}

function requestSummary(requests) {
  return requests
    .filter((r) => r.resourceType === 'document' || r.resourceType === 'xhr' || r.resourceType === 'fetch')
    .map((r) => `${r.method} ${r.url.replace(GUID, '{guid}').slice(0, 90)} → ${r.response?.status ?? '—'}`);
}

const reviewedReason = (reasons, id) => {
  if (typeof reasons[id] === 'string') return { note: reasons[id] };
  if (reasons[id]?.notObserved) return { notObserved: reasons[id].notObserved };
  return {};
};

async function collectScenarioEntries(matrix, evidence, label, reasons, sections, counts) {
  for (const scenario of matrix.scenarios) {
    const folder = path.join(evidence, ...scenario.id.split('/'), label);
    const meta = await readJson(path.join(folder, 'meta.json'));
    const key = `${scenario.component} · ${scenario.variation}`;
    const list = sections.get(key) ?? [];
    const entry = { scenario, meta };
    if (!meta) counts.missing++;
    else if (meta.status === 'captured') {
      // A write the capture's guard aborted means the page never reached the promised state.
      entry.blocked = (meta.blockedWrites ?? []).map(
        (write) => `${write.method} ${write.path.replace(GUID, '{guid}')}`,
      );
      if (!entry.blocked.length && !reviewedReason(reasons, scenario.id).notObserved) {
        counts.captured++;
        if (reviewedReason(reasons, scenario.id).note) counts.noted++;
      }
      entry.render = renderSummary(
        await readJson(path.join(folder, 'elements.json'), []),
        await fs.readFile(path.join(folder, 'dom.html'), 'utf8').catch(() => ''),
        scenario,
      );
      entry.requests = requestSummary(await readJson(path.join(folder, 'requests.json'), []));
    }
    list.push(entry);
    sections.set(key, list);
  }
}

function observedStatus(meta, blocked, note, notObserved, reason) {
  const problem = escape((meta?.problems?.[0] ?? '').split('\n')[0].slice(0, 120));
  const reasonNote = reason ? ` — ${reason}` : '';
  const blockedNote = reason ? `; ${reason}` : '';
  const observedNote = reason ? ` — note: ${reason}` : '';
  let observed = `yes${observedNote}`;
  if (!meta) observed = `no evidence${reasonNote}`;
  else if (meta.status !== 'captured')
    observed = `no — ${reason || 'not reviewed'} (capture ${meta.status}: ${problem})`;
  else if (blocked.length)
    observed = `no — not observed: the harness blocked ${escape(blocked.join(', '))}${blockedNote}`;
  else if (notObserved) observed = `no — ${reason} (captured page summarised)`;
  return observed;
}

function renderedSummary(render, meta) {
  if (!render) return '—';
  const buttons = render.buttons.map((b) => `"${escape(b)}"`).join(', ') || 'none';
  const dialogs = render.dialogs.length ? ` (${render.dialogs.map(escape).join(', ')})` : '';
  const messages = render.messages.map((m) => `"${escape(m)}"`).join('; ') || 'none';
  return [
    `title "${escape(meta.title)}"`,
    `${render.controls} controls (${render.required} required, ${render.disabled} read-only)`,
    `buttons ${buttons}`,
    `${render.grids} data grids / ${render.rows} rows`,
    `${render.dialogs.length} open dialogs${dialogs}`,
    ...(render.actionsBar ? [`actions bar ${render.actionsBar} the form`] : []),
    ...(render.body ? [`body ${escape(render.body)}`] : []),
    ...(render.content ? [`content ${escape(render.content)}`] : []),
    ...(render.notes.length ? [`notes: ${render.notes.map(escape).join('; ')}`] : []),
    `messages: ${messages}`,
    ...(render.values.length ? [`values: ${render.values.map(escape).join(', ')}`] : []),
  ].join('; ');
}

function requestSequence(requests) {
  if (!requests) return '—';
  const more = requests.length > 8 ? `<br>… ${requests.length - 8} more` : '';
  return requests.slice(0, 8).map(escape).join('<br>') + more;
}

function renderScenarioRow({ scenario, meta, render, requests, blocked }, reasons) {
  const { note, notObserved } = reviewedReason(reasons, scenario.id);
  const reason = escape(note ?? notObserved ?? '');
  const observed = observedStatus(meta, blocked, note, notObserved, reason);
  const rendered = renderedSummary(render, meta);
  const sequence = requestSequence(requests);
  return `| ${scenario.state} | ${scenario.persona ?? 'anonymous'} | ${observed} | ${rendered} | ${sequence} |`;
}

function appendReferenceSection(lines, key, entries, byPath, reasons) {
  lines.push(`## ${key}`, '');
  const page = entries[0].scenario.steps.find((s) => s.goto)?.goto?.split('?')[0];
  const record = page ? byPath.get(page) : null;
  if (record)
    lines.push(
      `Configuration: ${record.kind} \`${record.name}\` at \`${record.path}\` (${escape(record.variation ?? '')}); catalog items: ${(
        record.catalog ?? []
      )
        .slice(0, 12)
        .map((id) => `\`${id}\``)
        .join(
          ', ',
        )}${(record.catalog ?? []).length > 12 ? ', …' : ''}. See the [Power Pages inventory](power-pages-inventory.md) rows for these ids and the [Dataverse inventory](dataverse-inventory.md) for the form/view/column rows named by the page.`,
      '',
    );
  lines.push(
    '| State | Persona | Observed | Rendered | Requests (documents and XHR) |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const entry of entries) lines.push(renderScenarioRow(entry, reasons));
  lines.push('');
}

async function main() {
  const { values } = parseArgs({
    options: {
      evidence: { type: 'string' },
      matrix: { type: 'string' },
      label: { type: 'string' },
      out: { type: 'string' },
      reasons: { type: 'string' },
    },
  });
  if (!values.evidence || !values.matrix) throw new Error('--evidence and --matrix are required');
  const label = values.label ?? 'live';
  const matrix = JSON.parse(await fs.readFile(values.matrix, 'utf8'));
  const manifest = await readJson(path.join(root, 'examples/project/baseline/site-manifest.json'), { records: [] });
  // A page is described by its component record (basic form, list, multistep form), not by the web page record that hosts it.
  const byPath = new Map();
  for (const record of manifest.records.filter((r) => r.path))
    if (!byPath.has(record.path) || ['webpage', 'website'].includes(byPath.get(record.path).kind))
      byPath.set(record.path, record);
  // Reviewed reasons (`--reasons <json>`: scenario id → text, or → { "notObserved": text }) explain a state the live portal
  // cannot reach or a captured page that does not show the promised state. A text is a note printed whether or not the
  // capture succeeded; `notObserved` lists a captured page as not observed (its rendered summary stays printed).
  const reasons = values.reasons ? await readJson(values.reasons, {}) : {};
  const sections = new Map();
  const counts = { captured: 0, noted: 0, missing: 0 };
  await collectScenarioEntries(matrix, values.evidence, label, reasons, sections, counts);
  const lines = [
    '# Native component reference (offline)',
    '',
    `Generated by \`scripts/baseline-reference.mjs\` from the project's captured live evidence (label \`${label}\`), the scenario matrix and the fixture site manifest. Per component and state: what was visible (controls, buttons, data grids and rows, open dialogs, the text of visible validation summaries, alerts and messages, the values of the controls the scenario filled or watches), which requests fired (documents and XHR, query values redacted), which configuration record drives the page and the catalog items it exercises (the inventories explain each item). Captures whose status is not \`captured\`, whose write the capture harness blocked, or whose reviewed reason says the state is not reachable are listed as not observed; a reviewed note explains a page that does not reach the state its name promises. Do not edit by hand.`,
    '',
    `Scenarios in the matrix: ${matrix.scenarios.length}. Observed: ${counts.captured} (${counts.noted} with a reviewed note). Not observed: ${matrix.scenarios.length - counts.captured} (${counts.missing} without evidence).`,
    '',
  ];
  for (const [key, entries] of [...sections].sort((a, b) => {
    const x = String(a);
    const y = String(b);
    return Number(x > y) - Number(x < y);
  })) {
    appendReferenceSection(lines, key, entries, byPath, reasons);
  }
  const out = values.out ?? path.join(root, 'mirage/docs/baseline/reference.md');
  const document = redact(lines.join('\n'));
  const left = leaks(document);
  if (left.length)
    throw new Error(
      `The reference still names ${left.length} id(s), host(s) or e-mail address(es) after redaction (first starts "${left[0].slice(0, 6)}"); extend redact().`,
    );
  await fs.writeFile(out, document);
  console.log(
    JSON.stringify({
      out,
      sections: sections.size,
      scenarios: matrix.scenarios.length,
      captured: counts.captured,
      noted: counts.noted,
      missing: counts.missing,
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  /* NOSONAR: module-level promise chain must not block evaluation */ main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
