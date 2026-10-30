// D-M-6 readability measurement of the open /_sim/ view, run in the page (`page.evaluate(measureView)`): self-contained,
// no imports. firstY: the top (px from the page top) of the first useful content element after the page heading — a
// data row, tile, fact list, form control, list item, card or empty state; prose: the characters of visible
// explanatory text (paragraphs, help lines, notices, row details outside tables and fact lists) that is not inside an
// (i) popover, tooltip or `[data-help]`; firstRowY: the top of the first data row; scrollX: whether the page scrolls
// sideways; infoPairs: adjacent bare (i) buttons; frames: the shared tables whose frame scrolls sideways (a cut column or row action, DV-N4c-2).
export function measureView() {
  const content = document.querySelector('#content');
  const visible = (node) =>
    node.getClientRects().length > 0 &&
    !node.closest('[hidden], .ui-info-pop, [role="tooltip"], [data-help], details:not([open]) > :not(summary)') &&
    getComputedStyle(node).visibility !== 'hidden';
  const USEFUL = [
    'tbody tr',
    '.ui-tile',
    '.dm-kpi',
    'dl',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    '.row',
    'li',
    '.ui-empty',
    '.empty',
    '[data-node]',
    'details > summary',
    'form',
    '.diagnostic',
    '.panel',
    '.dm-hero',
    '.ui-section',
    '.notice',
    '.ui-notice',
  ].join(', ');
  const first = [...content.querySelectorAll(USEFUL)].find(
    (node) => visible(node) && !node.closest('.page-heading, .ui-guide, .ui-info, nav'),
  );
  const box = first?.getBoundingClientRect();
  // The first data row of the main list (D-M-7 list views: at most 180 px from the top).
  const row = [...content.querySelectorAll('tbody tr')].find(visible)?.getBoundingClientRect();
  // What the eye reads as explanation: paragraphs, list items, help and notice lines, row and step details, the
  // description of an action (DV-N4b-2).
  const PROSE =
    'p, li, small, .ui-help, .muted, .field-help, .ui-field-help, .notice, .ui-notice, .ui-guide, .row-detail, .step-detail, .action-row';
  // Data, not explanation: tables, fact grids, data lines (bindings, source paths), the Health hero's fact chips and
  // component counts, controls, headings, code, badges.
  const NOT_PROSE =
    'table, dl, .detail-list, .data-line, .row-title, .row-fact, nav, .ui-chips, .dm-chips, .dm-hero-stats, button, label, summary, h1, h2, h3, h4, code, strong, .badge, .ui-badge, select, a';
  let prose = 0;
  const parts = [];
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent?.closest(PROSE) || parent.closest(NOT_PROSE) || !visible(parent)) continue;
    const text = node.textContent.replace(/\s+/g, ' ').trim();
    prose += text.length;
    if (text) parts.push(text);
  }
  return {
    firstY: box ? Math.round(box.top + scrollY) : null,
    firstRowY: row ? Math.round(row.top + scrollY) : null,
    first: first ? `${first.localName}${first.className ? `.${String(first.className).split(' ')[0]}` : ''}` : null,
    prose,
    // The prose itself, so a failing view names what to move behind an (i).
    parts,
    scrollX: document.documentElement.scrollWidth > innerWidth,
    // DV-N4e: two bare (i) buttons side by side (same line, under 20 px apart): each (i) belongs beside its own control.
    infoPairs: [...content.querySelectorAll('.ui-info-button')]
      .filter((button) => visible(button))
      .map((button, index, buttons) => [button, buttons[index + 1]])
      .filter(([a, b]) => {
        if (!b) return false;
        const p = a.getBoundingClientRect(),
          q = b.getBoundingClientRect();
        return q.top < p.bottom && q.bottom > p.top && q.left - p.right < 20 && q.left >= p.left;
      })
      .map(([a, b]) => `${a.getAttribute('aria-label')} + ${b.getAttribute('aria-label')}`),
    frames: [...content.querySelectorAll('.ui-data-table')]
      .filter((table) => visible(table))
      .map((table) => [table.dataset.dataTable, table.querySelector('.ui-table-wrap')])
      .filter(([, wrap]) => wrap && wrap.scrollWidth - wrap.clientWidth > 2)
      .map(([id, wrap]) => `${id} (${wrap.scrollWidth - wrap.clientWidth} px)`),
  };
}
