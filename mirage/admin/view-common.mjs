// Scaffolding shared by the `/_sim/` view modules: heading with guide, collapsed panels with help, paged tables,
// field help from help-content `fields`, pending buttons and request failures. DOM-free and import-free: the module
// passes its id, label, the UI kit and the HELP map, so every host serves this file by the admin asset pattern.
export function viewCommon({ id, label, kit, help }) {
  const e = kit.escapeHtml;
  const value = (item) => (typeof item === 'function' ? item() : item);
  const helpEntry = (ctx, key) => (ctx.help ?? help)[key] ?? { intro: '' };
  const docOf = (ctx, entry) => (entry.doc ? kit.docLink(entry.doc, value(ctx.docs) ?? {}) : null);
  // Panel help (D-M-6): one (i) at the top of the section; the text, steps, example and doc link are in its popover.
  const helpBlock = (ctx, key, title) => {
    const entry = helpEntry(ctx, key),
      doc = docOf(ctx, entry);
    const html = kit.info({
      id: `help-${key.replace(/\./g, '-')}`,
      label: `About ${title ?? 'this section'}`,
      text: entry.intro,
      steps: entry.steps ?? [],
      example: entry.example,
      docs: doc ? [doc] : [],
    });
    return html ? `<p class="ui-section-help">${html}</p>` : '';
  };
  const deepLink = (name) => new URLSearchParams(String(globalThis.location?.hash ?? '').split('?')[1] ?? '').get(name);
  // The shared data table (D-M-8): search above once a list has more than one page, count and paging below;
  // every data column sorts (`kit.sortable`; the shell keeps `ctx.pager(key).sort`).
  const list = (ctx, key, items, data, emptyText, caption, extra = {}) => {
    const state = ctx.pager(key),
      rows = Array.isArray(items) ? items : [],
      columns = kit.sortable(data);
    return kit.dataTable({
      id: key,
      columns,
      caption,
      emptyText,
      sort: state.sort,
      // D-M-11: every table has its search box, its column filters and the bottom controls bar.
      search: true,
      filters: state.filters ?? {},
      result: kit.pageItems(kit.sortItems(kit.filterItems(rows, columns, state.filters), columns, state.sort), state),
      ...extra,
    });
  };
  /** A request failure kept as data: the message plus the HTTP status when the host answered one. */
  const failure = (error) => ({
    error: error?.message ?? String(error),
    ...(error?.status ? { status: error.status } : {}),
  });
  const failed = (item) => `${item.error}${item.status ? ` (HTTP ${item.status})` : ''}`;
  const json = (item, limit = 160) => {
    const text = JSON.stringify(item ?? null);
    return e(text.length > limit ? `${text.slice(0, limit)}…` : text);
  };
  const yes = (flag, on = 'yes', off = 'no') => kit.badge(flag ? on : off, flag ? 'ok' : 'neutral');
  /** Bus totals in one line (services summary and memory-queue depth). */
  const activityCounts = (totals) =>
    `${totals?.active ?? 0} active · ${totals?.locked ?? 0} locked · ${totals?.scheduled ?? 0} scheduled · ${totals?.deadLettered ?? 0} dead-lettered`;
  /** Visible help for a control from `HELP[key].fields[name]`; give the control `aria-describedby="<controlId>-help"`. */
  const fieldHelp = (ctx, controlId, key, name) => kit.fieldHelp(controlId, helpEntry(ctx, key).fields?.[name] ?? '');
  // D-M-7 page chrome: the hidden H1, the view's (i) (the shell puts it after the breadcrumb) and one toolbar row.
  // `options`: { actions, filters, summary, chips } as kit.pageChrome takes them.
  function heading(ctx, options = {}) {
    const entry = (ctx.help ?? help)[`${id}.about`] ?? helpEntry(ctx, id),
      doc = docOf(ctx, entry);
    return kit.pageChrome({
      breadcrumb: { section: ctx.group?.() ?? '', page: label },
      help: entry.intro
        ? { text: entry.intro, steps: entry.steps ?? [], example: entry.example, docs: doc ? [doc] : [] }
        : null,
      ...(options && typeof options === 'object' ? options : {}),
    });
  }
  // helpKey: the HELP entry for the panel when its own key has none.
  function panel(ctx, key, title, summary, body, open = false, helpKey = `${id}.${key}`) {
    const sectionKey = `${id}:${key}`;
    return kit.section({
      key: sectionKey,
      title,
      summary,
      open: open || Boolean(ctx.open?.(sectionKey)) || deepLink('panel') === key,
      help: helpBlock(ctx, helpKey, title),
      body,
    });
  }
  /** Runs `work` with the button pending and answers `true` synchronously, so the app stops the event (handle contract). */
  function pending(ctx, button, work) {
    if (ctx.setButtonPending(button, true) === false) return true;
    Promise.resolve()
      .then(work)
      .then(
        () => ctx.setButtonPending(button, false),
        (error) => {
          ctx.setButtonPending(button, false, true);
          ctx.notify(error.message, true);
        },
      );
    return true;
  }
  return {
    e,
    value,
    helpEntry,
    docOf,
    helpBlock,
    deepLink,
    list,
    failure,
    failed,
    json,
    yes,
    activityCounts,
    fieldHelp,
    heading,
    panel,
    pending,
  };
}
