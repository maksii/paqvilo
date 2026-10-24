/*
 * Local equivalent of the platform's /xrm-adx/js/jquery.stackranking.js (loaded by form pages
 * with stack rank controls, adx_controlstyle 100000008): $.fn.stackRanking turns a form section
 * table into a stack ranking question. Each row's controls are hidden, each legacy "div.info"
 * label block is followed by one numbered rank cell per row of the table, a click assigns the
 * rank to the row's box (removing it from any other row after confirmation), and the boxes'
 * values preselect their cells. Bootstrap 5 label blocks (div.table-info) get no rank cells,
 * as on the platform.
 */
(function ($) {
  'use strict';
  if (!$ || $.fn.stackRanking) return;
  const PROMPT =
    'That ranking has already been assigned to another item. \nAre you sure you want to reassign it to this item?';
  $.fn.stackRanking = function (options) {
    const settings = $.extend({ withPrompt: true }, options);
    const select = (cell) => $(cell).addClass('selected-cell');
    const box = (cell) => $(cell).parent().find('div.control input');
    function click() {
      const cell = this;
      let confirmed = true;
      $(cell)
        .parents('table')
        .first()
        .find(`.sr-cell[col=${$(cell).attr('col')}]`)
        .filter('.selected-cell')
        .each(function () {
          if (settings.withPrompt && !window.confirm(PROMPT)) {
            confirmed = false;
            return;
          }
          $(this).removeClass('selected-cell');
          box(this).val('');
        });
      if (!confirmed) return false;
      $(cell).parent().find('.sr-cell').removeClass('selected-cell');
      select(cell);
      box(cell).val($(cell).html());
      return false;
    }
    return this.each(function () {
      const table = this;
      const count = $(table).find('tr').length;
      table.itemNumber = count;
      $(table)
        .find('tr')
        .each(function () {
          $(this).find('div.control').hide();
          let cells = '';
          for (let rank = 1; rank <= count; rank++) cells += `<div class='sr-cell' col='${rank}'>${rank}</div>`;
          $(this).find('div.info').after(cells);
        });
      $(table).find('.sr-cell').on('click', click);
      $(table).addClass('stack-ranking-question');
      $(table)
        .find('div.control input')
        .each(function () {
          const value = $(this).val();
          if (value !== '')
            select(
              $(this)
                .parents('td')
                .first()
                .find('.sr-cell')
                .get(parseInt(value, 10) - 1),
            );
        });
    });
  };
})(window.jQuery);
