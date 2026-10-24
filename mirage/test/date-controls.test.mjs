import test from 'node:test';
import assert from 'node:assert/strict';
import { datePickerFormat, clientDateControlsRuntime } from '../lib/date-controls.mjs';
import { renderComponent } from '../lib/platform.mjs';

test('native date formats preserve exported time tokens and quoted literals', () => {
  assert.equal(datePickerFormat('dd/MM/yyyy'), 'DD/MM/YYYY');
  assert.equal(datePickerFormat("yyyy-MM-dd 'day' HH:mm tt", false), 'YYYY-MM-DD [day] HH:mm A');
});

test('form dates retain canonical submission fields and native adjacent picker controls', async () => {
  const html = await renderComponent(
    'entityform',
    'Dates',
    {},
    {
      portal: {
        forms: [],
        records: [],
        settings: { 'DateTime/DateFormat': 'dd/MM/yyyy' },
      },
      schemas: {
        Dates: {
          entity: 'item',
          fields: [
            {
              name: 'effective',
              label: 'Effective date',
              type: 'date',
              required: true,
            },
          ],
        },
      },
      store: {
        resolveMapping: () => ({ idColumn: 'itemid', relationships: {} }),
      },
      identity: {},
      diagnostics: [],
    },
  );
  // Native response markup: the bound text box alone carries the ISO value and the picker
  // attributes; the browser-side crmentityformview-datetime.js (date-controls runtime) builds
  // the *_datepicker_description group and retargets the label. No local attributes.
  assert.match(
    html,
    /<input name="[^"]*\$effective" type="text" id="effective" class="datetime form-control " data-ui="datetimepicker" data-type="date" data-attribute="effective" data-behavior="DateOnly"><\/div>/,
  );
  assert.doesNotMatch(
    html,
    /data-sim-date|datetimepicker" role="none"|_datepicker_description|style="display: none;" data-ui/,
  );
  assert.match(html, /<label for="effective" id="effective_label" class="field-label">Effective date<\/label>/);
  assert.doesNotMatch(clientDateControlsRuntime(), /data-sim-date/);
  assert.match(html, /<span id="DateFormatValidatoreffective" style="visibility:hidden;">\*<\/span>/);
  assert.match(html, /<span id="RequiredFieldValidatoreffective" style="display:none;">\*<\/span>/);
  assert.doesNotMatch(html, /name="effective_datepicker_description"/);
});
