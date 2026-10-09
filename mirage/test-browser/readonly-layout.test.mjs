import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { renderComponent } from "../lib/platform.mjs";

test("source-filled spacer and readonly controls preserve native two-column form layout", async t => {
  const html = await renderComponent("entityform", "Readonly", { request: { params: { id: "record" } } }, {
    portal: { forms: [{ id: "Readonly", mode: 100000002 }], records: [] },
    schemas: { Readonly: {
      entity: "item", fields: [
        { name: "date", type: "date", label: "Date" },
        { name: "owner", type: "lookup", label: "Owner" },
      ],
      layout: [{ name: "General", columns: [{ width: "100%", sections: [{ name: "General", columnWidths: [50, 50], rows: [[{ spacer: true }, { name: "date", type: "date" }], [{ name: "owner", type: "lookup", colspan: 2 }]] }] }] }],
      // Native custom JavaScript is the first child of the form control, so DOM access waits for ready.
      js: `document.addEventListener('DOMContentLoaded',()=>{document.querySelector('table.section tr td').innerHTML='<label>Regulatory type</label><input id="source-regulatory" value="Marketing authorisation">';});`,
    } },
    store: { resolveMapping: () => ({ idColumn: "itemid", relationships: {} }), get: async () => ({ owner: { id: "account", name: "Example account", logical_name: "account" } }) },
  });
  const server = http.createServer((_req, res) => res.end(`<!doctype html><style>.zero-cell{display:none}table{width:800px}td{vertical-align:top}input{width:90%}</style>${html}`));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    // A preconnected socket that never sent a request would hold server.close open.
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await assert.doesNotReject(() => page.locator("#source-regulatory").waitFor({ state: "visible" }));
  assert.equal(await page.locator("#date_datepicker_description").isVisible(), true);
  assert.equal(await page.locator("#date_datepicker_description").isDisabled(), false);
  assert.equal(await page.locator("#owner_name").inputValue(), "Example account");
  assert.equal(await page.locator(".launchentitylookup,.clearlookupfield,.modal-lookup").count(), 0);
  assert.equal(await page.locator(".datetimepicker .input-group-addon").isVisible(), false);
  const left = await page.locator("#source-regulatory").boundingBox(), right = await page.locator("#date_datepicker_description").boundingBox();
  assert.ok(right.x > left.x + left.width, "The source-filled spacer must occupy the first native column.");
  assert.equal(await page.locator("table.section tr").first().locator("td").count(), 3);
});
