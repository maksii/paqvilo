import test from "node:test";
import assert from "node:assert/strict";
import { datePickerFormat, clientDateControlsRuntime } from "../lib/date-controls.mjs";
import vm from "node:vm";
import { renderComponent } from "../lib/platform.mjs";

test("native date formats preserve exported time tokens and quoted literals", () => {
  assert.equal(datePickerFormat("dd/MM/yyyy"), "DD/MM/YYYY");
  assert.equal(
    datePickerFormat("yyyy-MM-dd 'day' HH:mm tt", false),
    "YYYY-MM-DD [day] HH:mm A",
  );
});

test("readonly native date display remains visible and does not disable its textbox", () => {
  const classes = new Set(), icon = { style: {} }, display = { readOnly: false, classList: { add: value => classes.add(value) } };
  const group = { dataset: { simDateTarget: "date", simDateOnly: "true", dateFormat: "DD/MM/YYYY" }, querySelector: selector => selector === "input" ? display : icon };
  const input = { id: "date", value: "", readOnly: true };
  const picker = { disable: () => assert.fail("Readonly native textboxes must not be disabled"), date: () => {} };
  const jq = () => ({ datetimepicker() {}, data: () => picker, on() {} });
  jq.fn = { datetimepicker() {} };
  vm.runInNewContext(clientDateControlsRuntime(), { window: { jQuery: jq, moment() {} }, document: { readyState: "complete", querySelectorAll: () => [group], getElementById: () => input }, console });
  assert.equal(display.readOnly, true);
  assert.equal(classes.has("readonly"), true);
  assert.equal(icon.style.display, "none");
  assert.equal(group.dataset.simDateReady, "true");
});

test("form dates retain canonical submission fields and native adjacent picker controls", async () => {
  const html = await renderComponent(
    "entityform",
    "Dates",
    {},
    {
      portal: {
        forms: [],
        records: [],
        settings: { "DateTime/DateFormat": "dd/MM/yyyy" },
      },
      schemas: {
        Dates: {
          entity: "item",
          fields: [
            {
              name: "effective",
              label: "Effective date",
              type: "date",
              required: true,
            },
          ],
        },
      },
      store: {
        resolveMapping: () => ({ idColumn: "itemid", relationships: {} }),
      },
      identity: {},
      diagnostics: [],
    },
  );
  // Native markup: the bound input stays a hidden-by-style text box carrying the
  // ISO value; the picker group follows it with the *_datepicker_description box.
  assert.match(
    html,
    /<input name="[^"]*\$effective" type="text" id="effective" class="datetime form-control " data-ui="datetimepicker" data-type="date" data-attribute="effective" data-behavior="DateOnly" value="" style="display: none;" required="" data-sim-date-value>/,
  );
  assert.match(
    html,
    /<div class="input-append input-group datetimepicker" role="none" data-sim-date-target="effective" data-sim-date-only="true"><input type="text" data-date-format="DD\/MM\/YYYY"[^>]* placeholder="DD\/MM\/YYYY"/,
  );
  assert.match(html, /<span class="input-group-addon" tabindex="0" role="button" title="Choose a date" aria-label="Choose a date">/);
  assert.match(
    html,
    /id="effective_datepicker_description"[^>]*aria-labelledby="effective_label"[^>]* required/,
  );
  assert.match(html, /<label for="effective_datepicker_description" id="effective_label" class="field-label">Effective date<\/label>/);
  assert.match(html, /<span id="DateFormatValidatoreffective" style="visibility:hidden;">\*<\/span>/);
  assert.match(html, /<span id="RequiredFieldValidatoreffective" style="display:none;">\*<\/span>/);
  assert.doesNotMatch(html, /name="effective_datepicker_description"/);
});

