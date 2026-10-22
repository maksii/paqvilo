// Scaffolding shared by the `/_sim/` view modules (D3): heading with guide, collapsed panels with help, paged tables,
// field help from help-content `fields`, pending buttons and request failures. DOM-free and import-free: the module
// passes its id, label, the UI kit and the HELP map, so every host serves this file by the admin asset pattern.
export function viewCommon({ id, label, kit, help }) {
  const e = kit.escapeHtml;
  const value = item => (typeof item === 'function' ? item() : item);
  const helpEntry = (ctx, key) => (ctx.help ?? help)[key] ?? { intro: '' };
  const docOf = (ctx, entry) => (entry.doc ? kit.docLink(entry.doc, value(ctx.docs) ?? {}) : null);
  const helpBlock = (ctx, key) => kit.help({ id: `help-${key.replace(/\./g, '-')}`, text: helpEntry(ctx, key).intro, doc: docOf(ctx, helpEntry(ctx, key)) });
  const deepLink = name => new URLSearchParams(String(globalThis.location?.hash ?? '').split('?')[1] ?? '').get(name);
  const list = (ctx, key, items, columns, emptyText, caption) => kit.table({ key, columns, result: kit.pageItems(items, ctx.pager(key)), emptyText, caption });
  /** A request failure kept as data: the message plus the HTTP status when the host answered one. */
  const failure = error => ({ error: error?.message ?? String(error), ...(error?.status ? { status: error.status } : {}) });
  const failed = item => `${item.error}${item.status ? ` (HTTP ${item.status})` : ''}`;
  const json = (item, limit = 160) => { const text = JSON.stringify(item ?? null); return e(text.length > limit ? `${text.slice(0, limit)}…` : text); };
  const yes = (flag, on = 'yes', off = 'no') => kit.badge(flag ? on : off, flag ? 'ok' : 'neutral');
  /** Bus totals in one line (services summary and memory-queue depth). */
  const activityCounts = totals => `${totals?.active ?? 0} active · ${totals?.locked ?? 0} locked · ${totals?.scheduled ?? 0} scheduled · ${totals?.deadLettered ?? 0} dead-lettered`;
  /** Visible help for a control from `HELP[key].fields[name]`; give the control `aria-describedby="<controlId>-help"`. */
  const fieldHelp = (ctx, controlId, key, name) => kit.fieldHelp(controlId, helpEntry(ctx, key).fields?.[name] ?? '');
  function heading(ctx, title) {
    const entry = helpEntry(ctx, id);
    return `<div class="page-heading"><div><span class="eyebrow">SIMULATOR WORKSPACE</span><h1>${e(label)}</h1></div></div>`
      + kit.guide({ key: id, title, intro: entry.intro, steps: entry.steps ?? [], example: entry.example, docs: docOf(ctx, entry) ? [docOf(ctx, entry)] : [] });
  }
  // helpKey: the HELP entry for the panel when its own key has none.
  function panel(ctx, key, title, summary, body, open = false, helpKey = `${id}.${key}`) {
    const sectionKey = `${id}:${key}`;
    return kit.section({ key: sectionKey, title, summary, open: open || Boolean(ctx.open?.(sectionKey)) || deepLink('panel') === key, help: helpBlock(ctx, helpKey), body });
  }
  /** Runs `work` with the button pending and answers `true` synchronously, so the app stops the event (handle contract). */
  function pending(ctx, button, work) {
    if (ctx.setButtonPending(button, true) === false) return true;
    Promise.resolve().then(work).then(() => ctx.setButtonPending(button, false), error => { ctx.setButtonPending(button, false, true); ctx.notify(error.message, true); });
    return true;
  }
  return { e, value, helpEntry, docOf, helpBlock, deepLink, list, failure, failed, json, yes, activityCounts, fieldHelp, heading, panel, pending };
}
