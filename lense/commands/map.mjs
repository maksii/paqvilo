// `paqvilo map`: the full mapping between online resources and local sources.
import fs from 'node:fs';
import path from 'node:path';
import { OverlaySession } from '../session.mjs';
import { sourceText } from '../portal-model.mjs';
import { fetchOnline, mapLimit, describeStatus } from '../online.mjs';

const WHERE = {
  'page-js': 'inline <script> of the page',
  'page-css': 'inline <style> of the page',
  'page-copy': 'HTML of the page (changes vs baseline)',
  'page-summary': 'HTML of the page (changes vs baseline)',
  'basic-form-js': 'inline <script> on every page showing the form',
  'advanced-form-step-js': 'inline <script> on every page showing the step',
  'list-js': 'inline <script> on every page showing the list',
  'web-template': 'HTML of every page using the template (changes vs baseline)',
  'content-snippet': 'HTML of every page using the snippet (changes vs baseline)',
  'metadata-markup': 'literal HTML stored in supported metadata text fields (changes vs baseline)',
};

export function buildMapping(session) {
  const { cfg, model } = session;
  const inlineKinds = new Set(cfg.site.inline.enabled ? cfg.site.inline.kinds : []);
  const markupKinds = new Set(cfg.site.markup.enabled ? cfg.site.markup.kinds : []);
  return {
    site: cfg.siteName,
    environment: cfg.envName,
    origin: cfg.origin,
    source: cfg.sourceDir,
    scope: cfg.site.scope,
    routes: cfg.site.routes,
    webFiles: model.webFiles.map((w) => ({
      url: w.url,
      local: w.file ? session.rel(w.file) : null,
      overridden: Boolean(w.url && w.file && session.resolver.resolve(w.url)?.file === w.file),
      problem: w.problem,
    })),
    inline: model.inlineSources
      .map((s) => ({
        kind: s.kind,
        enabled: s.mode === 'block' ? inlineKinds.has(s.kind) : markupKinds.has(s.kind),
        technique: s.mode === 'block' ? 'replace block' : 'patch changes',
        local: s.rel,
        page: s.pageUrl,
        usedOn: s.usedOn,
        where: WHERE[s.kind],
        empty: !(sourceText(s) ?? '').trim(),
      })),
    needsDeploy: session.rewriter.unsupported,
    warnings: model.warnings,
  };
}

const markdownText = (value) => String(value ?? '').replace(/[&<>|`\\\[\]*_]/g, (c) => `&#${c.charCodeAt(0)};`).replace(/\r\n?|\n/g, '<br>');

export function toMarkdown(m) {
  const lines = [
    `# Mapping: ${markdownText(m.site)} @ ${markdownText(m.environment)}`,
    '',
    `- online: ${markdownText(m.origin)}`,
    `- local: ${markdownText(m.source)}`,
    `- scope: ${markdownText(m.scope)}`,
    '',
    `## Web files (${m.webFiles.length})`,
    '',
    `| Online URL | Local file | Overridden |${m.checked ? ' Online |' : ''}`,
    `|---|---|---|${m.checked ? '---|' : ''}`,
    ...m.webFiles.map(
      (w) => `| ${markdownText(w.url ?? '(none)')} | ${markdownText(w.local ?? '(none)')} | ${w.overridden ? 'yes' : `no${w.problem ? `: ${markdownText(w.problem)}` : ''}`} |${m.checked ? ` ${markdownText([w.online, w.onlineError].filter(Boolean).join(': '))} |` : ''}`,
    ),
    '',
  ];
  const byKind = Map.groupBy(m.inline, (i) => i.kind);
  for (const [kind, items] of byKind) {
    const filled = items.filter((i) => !i.empty);
    lines.push(`## ${markdownText(kind)} (${filled.length} with content, ${items.length} files)`, '', `Appears as: ${markdownText(WHERE[kind])}. Technique: ${markdownText(items[0].technique)}.`, '');
    lines.push('| Local file | Page(s) | Enabled |', '|---|---|---|', ...filled.map((i) => `| ${markdownText(i.local)} | ${i.page ? markdownText(i.page) : (i.usedOn ?? []).map(markdownText).join('<br>')} | ${i.enabled === false ? 'no' : 'yes'} |`), '');
  }
  if (m.routes?.length) lines.push('## Explicit routes', '', '| URL pattern | Local source |', '|---|---|', ...m.routes.map((r) => `| ${markdownText(r.url)} | ${markdownText(r.passthrough ? '(online)' : r.file ?? r.dir)} |`), '');
  if (m.needsDeploy.length) {
    lines.push('## Local changes that need a deployment to be visible', '', ...m.needsDeploy.map((u) => `- ${markdownText(u.rel)}: ${markdownText(u.reason)}`), '');
  }
  if (m.warnings.length) lines.push('## Notes', '', ...m.warnings.map((w) => `- ${markdownText(w)}`), '');
  return lines.join('\n');
}

export default async function map(cfg, args) {
  const session = await OverlaySession.create(cfg);
  const mapping = buildMapping(session);

  if (args.check) {
    const targets = mapping.webFiles.filter((w) => w.url);
    const results = await mapLimit(targets, 8, async (w) => {
      try { return await fetchOnline(cfg.origin, w.url, 3, { readBody: false }); }
      catch (err) { return { status: 0, error: err.message }; }
    });
    targets.forEach((w, i) => {
      w.onlineStatus = results[i].status;
      w.online = describeStatus(results[i].status);
      if (results[i].error) w.onlineError = results[i].error;
    });
    mapping.checked = true;
  }

  fs.mkdirSync(cfg.stateDir, { recursive: true });
  const base = path.join(cfg.stateDir, `mapping-${cfg.siteName}-${cfg.envName}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(mapping, null, 2));
  fs.writeFileSync(`${base}.md`, toMarkdown(mapping));
  const exitCode = mapping.checked && mapping.webFiles.some((w) => w.url && ![200, 404].includes(w.onlineStatus)) ? 1 : 0;

  if (args.json) {
    console.log(JSON.stringify(mapping, null, 2));
    return exitCode;
  }

  const width = Math.min(60, Math.max(...mapping.webFiles.map((w) => (w.url ?? '').length)));
  console.log(`${cfg.siteName} @ ${cfg.envName}  ${cfg.origin}\n`);
  console.log(`WEB FILES  online URL -> local file (under ${cfg.sourceDir})`);
  for (const w of mapping.webFiles) {
    const state = w.overridden ? '' : `   [not overridden${w.problem ? `: ${w.problem}` : ''}]`;
    console.log(`  ${(w.url ?? '(no url)').padEnd(width)}  ${w.local ?? '(no file)'}${w.online && w.online !== 'online' ? `   [${w.online}${w.onlineError ? `: ${w.onlineError}` : ''}]` : ''}${state}`);
  }
  console.log('\nINLINE SOURCES (no URL of their own; laid over the page HTML)');
  for (const [kind, items] of Map.groupBy(mapping.inline, (i) => i.kind)) {
    console.log(`  ${kind.padEnd(22)} ${String(items.filter((i) => !i.empty).length).padStart(4)} with content / ${String(items.length).padStart(4)} files   ${WHERE[kind]}`);
  }
  if (mapping.routes.length) {
    console.log('\nEXPLICIT ROUTES');
    for (const r of mapping.routes) console.log(`  ${r.url}  ->  ${r.passthrough ? '(online)' : (r.file ?? r.dir)}`);
  }
  const overridden = mapping.webFiles.filter((w) => w.overridden).length;
  console.log(`\n${overridden} of ${mapping.webFiles.length} web files overridden locally.`);
  if (mapping.checked) {
    const counts = Map.groupBy(mapping.webFiles.filter((w) => w.online), (w) => w.online);
    console.log(`online check: ${[...counts].map(([k, v]) => `${v.length} ${k}`).join(', ')}`);
  }
  for (const w of mapping.warnings) console.log(`note: ${w}`);
  for (const u of mapping.needsDeploy) console.log(`needs deploy: ${u.rel} - ${u.reason}`);
  console.log(`\nfull mapping written to ${base}.md and .json`);
  if (exitCode) console.log('Online check incomplete: some mapped resources could not be inspected.');
  return exitCode;
}
