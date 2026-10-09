import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { createSimulator } from "../server.mjs";

test("clean source-only forms use local date and rich-text compatibility assets with explicit mode", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-compatibility-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    "website.yml": "adx_websiteid: site\nadx_name: Test",
    "web-pages/home/Home.webpage.yml":
      "adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_pagetemplateid: template",
    "page-templates/Main.pagetemplate.yml":
      "adx_pagetemplateid: template\nadx_name: Main\nadx_webtemplateid: main",
    "web-templates/main/Main.webtemplate.yml":
      "adx_webtemplateid: main\nadx_name: Main",
    // The page renders a basic form, so its content sits inside the platform's WebForms form: a button
    // without type="button" would post the page back (as on the platform), so the fixture's buttons declare it.
    // The authored script runs when the document is ready: the platform's Bootstrap and postpreform
    // bundles (and their local equivalents) load after the footer, as on the platform.
    "web-templates/main/Main.webtemplate.source.html":
      `<style>html,body{height:100%}body{position:relative;min-height:100%;margin:0}#overlapAction{position:relative;margin-top:660px;left:0}.sample-footer{position:absolute;bottom:0;left:0;right:0;height:100px;background:#ddd;z-index:9999}</style><button type="button" id="overlapAction">Last form action</button><footer class="sample-footer">Footer</footer><div id="sourceDate"><input id="sourceDateValue" type="text" value=""></div><button type="button" id="sourceTip" title="Helpful hint">Hint</button><button type="button" id="sourcePopover" data-content="More details">Details</button><div class="dropdown"><button type="button" id="sourceDropdown" data-toggle="dropdown">Menu</button></div><button type="button" id="sourceTab" data-toggle="tab" data-target="#sourcePanel">Tab</button><div id="sourcePanel" hidden>Tab content</div><button type="button" id="sourceCollapseToggle" data-toggle="collapse" data-target="#sourceCollapse">Expand</button><div id="sourceCollapse" hidden>Collapsed content</div><button type="button" id="sourceModalToggle" data-toggle="modal" data-target="#sourceModal">Open modal</button><div id="sourceModal" class="modal" hidden><button type="button" data-dismiss="modal">Close</button></div><div id="sourceDialog" hidden>Dialog body</div><script>document.addEventListener("DOMContentLoaded",()=>{window.sourceGlobals={jquery:!!window.jQuery,moment:!!window.moment,plugin:typeof window.jQuery?.fn?.datetimepicker,tooltip:typeof window.jQuery?.fn?.tooltip,popover:typeof window.jQuery?.fn?.popover,modal:typeof window.jQuery?.fn?.modal,dropdown:typeof window.jQuery?.fn?.dropdown,tab:typeof window.jQuery?.fn?.tab,collapse:typeof window.jQuery?.fn?.collapse,dialog:typeof window.jQuery?.fn?.dialog,dateFormat:typeof Date.prototype.format};window.sourceMoment=moment.utc('2025-02-03').format('YYYY-MM-DD');window.sourceDateFormat=new Date(2025,1,3).format('dd/M/yyyy');$('#sourceDate').datetimepicker({format:'DD/MM/YYYY'});$('#sourceTip').tooltip();$('#sourcePopover').popover();$('#sourceDialog').dialog({autoOpen:false});});</script>{% entityform name: "Narrative" %}`,
    "basic-forms/Narrative.basicform.yml":
      "adx_entityformid: narrative-form\nadx_name: Narrative\nadx_entityname: example\nadx_mode: 100000000",
  };
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
  }
  const stateFile = path.join(root, "state.json");
  const app = await createSimulator({
    sourceDir: root,
    stateFile,
    watch: false,
    initial: {
      tables: { example: [] },
      mappings: { example: { entitySet: "examples", idColumn: "exampleid" } },
      permissions: [],
      settings: { permissionMode: "permissive" },
      simulator: {
        identity: { id: "editor" },
        componentSchemas: {
          "narrative-form": {
            entity: "example",
            fields: [
              { name: "effective", type: "date", label: "Effective date" },
              {
                name: "narrative",
                type: "textarea",
                label: "Narrative",
                richText: { name: "MscrmControls.RichTextEditor.RichTextEditorControl" },
              },
            ],
          },
        },
      },
    },
  });
  t.after(() => app.close());
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage(), errors = [], assets = [];
  page.on("requestfailed", (request) => errors.push(`FAILED ${request.url()} ${request.failure()?.errorText}`));
  const probe = await page.request.get(`${app.url}/__sim-static/vendor/jquery.min.js`);
  assert.equal(probe.status(), 200, await probe.text());
  page.on("console", (message) => {
    if (message.type() === "error" && !message.location().url.endsWith("/favicon.ico")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/__sim-static/vendor/") && response.status() >= 400)
      errors.push(`HTTP ${response.status()} ${response.url()}`);
    if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`);
    if (response.url().includes("/__sim-static/vendor/"))
      assets.push({ path: new URL(response.url()).pathname, status: response.status() });
  });
  await page.goto(app.url);
  try {
    await page.waitForFunction(() => window.sourceGlobals?.plugin === "function", null, { timeout: 5000 });
  } catch {
    throw new Error(JSON.stringify({ title: await page.title(), body: await page.locator("body").innerText(), sourceGlobals: await page.evaluate(() => window.sourceGlobals ?? null), assets, errors }));
  }
  assert.deepEqual(await page.evaluate(() => window.sourceGlobals), {
    jquery: true,
    moment: true,
    plugin: "function",
    tooltip: "function",
    popover: "function",
    modal: "function",
    dropdown: "function",
    tab: "function",
    collapse: "function",
    dialog: "function",
    dateFormat: "function",
  });
  assert.equal(await page.evaluate(() => window.sourceMoment), "2025-02-03");
  assert.equal(await page.evaluate(() => window.sourceDateFormat), "03/2/2025");
  assert.equal(await page.evaluate(() => window.__portalSimulation?.compatibility?.footerSpacingMode), "local-overlap-repair");
  assert.equal(await page.locator("#overlapAction").evaluate((button) => button.getBoundingClientRect().bottom <= document.querySelector(".sample-footer").getBoundingClientRect().top), true, JSON.stringify(await page.evaluate(() => ({ action: document.querySelector("#overlapAction").getBoundingClientRect().toJSON(), footer: document.querySelector(".sample-footer").getBoundingClientRect().toJSON(), style: { position: getComputedStyle(document.querySelector(".sample-footer")).position, marginTop: getComputedStyle(document.querySelector(".sample-footer")).marginTop }, body: document.body.getBoundingClientRect().toJSON() }))));
  assert.equal(await page.locator("#sourceDate").evaluate((node) => !!window.jQuery(node).data("DateTimePicker")), true);
  await page.locator("#sourceTip").hover();
  assert.equal(await page.getByRole("tooltip").innerText(), "Helpful hint");
  await page.evaluate(() => {
    window.popoverHookCalls = [];
    const prototype = window.jQuery.fn.popover.Constructor.prototype;
    prototype.getPosition = function () { window.popoverHookCalls.push("getPosition"); return { width: 40, height: 20, top: 120, left: 220, scroll: 0 }; };
    prototype.replaceArrow = function () { window.popoverHookCalls.push("replaceArrow"); this.arrow().css("left", "13%"); };
  });
  await page.locator("#sourcePopover").click();
  assert.equal(await page.getByRole("dialog").innerText(), "More details");
  assert.deepEqual(await page.evaluate(() => ({ calls: window.popoverHookCalls, top: document.querySelector(".paqvilo-mirage-popover").style.top, left: document.querySelector(".paqvilo-mirage-popover .arrow").style.left })), { calls: ["getPosition", "replaceArrow"], top: "144px", left: "13%" });
  // Portal templates can load jQuery again later in the document. Reapply the
  // local adapters and verify their delegated click handler remains singular.
  await page.addScriptTag({ url: `${app.url}/__sim-static/vendor/jquery.min.js` });
  for (const name of ["datetimepicker-compat.js", "bootstrap-plugins-compat.js", "jqueryui-dialog-compat.js"])
    await page.addScriptTag({ url: `${app.url}/__sim-static/vendor/${name}` });
  assert.deepEqual(await page.evaluate(() => [typeof $.fn.datetimepicker, typeof $.fn.tooltip, typeof $.fn.popover, typeof $.fn.modal, typeof $.fn.dialog]), ["function", "function", "function", "function", "function"]);
  await page.evaluate(() => $("#sourceDialog").dialog({ autoOpen: false }));
  await page.locator("#sourceDropdown").click();
  assert.equal(await page.locator(".dropdown").evaluate((node) => node.classList.contains("open")), true);
  await page.locator("#sourceTab").click();
  assert.equal(await page.locator("#sourcePanel").isVisible(), true);
  await page.locator("#sourceCollapseToggle").click();
  assert.equal(await page.locator("#sourceCollapse").isVisible(), true);
  assert.equal(await page.locator("#sourceCollapseToggle").getAttribute("aria-expanded"), "true");
  await page.evaluate(() => {
    window.modalEvents = [];
    window.jQuery("#sourceModal").on("show.bs.modal", (event) => { window.modalEvents.push("show"); event.preventDefault(); });
  });
  await page.locator("#sourceModalToggle").click();
  assert.equal(await page.locator("#sourceModal").isVisible(), false, "a namespaced show handler can cancel a modal");
  assert.deepEqual(await page.evaluate(() => window.modalEvents), ["show"]);
  await page.evaluate(() => {
    window.jQuery("#sourceModal").off("show.bs.modal");
    window.jQuery("#sourceModal").on("hidden.bs.modal", () => window.modalEvents.push("hidden"));
  });
  await page.locator("#sourceModalToggle").click();
  assert.equal(await page.locator("#sourceModal").isVisible(), true);
  await page.locator("#sourceModal [data-dismiss=modal]").click();
  assert.equal(await page.locator("#sourceModal").isVisible(), false);
  assert.deepEqual(await page.evaluate(() => window.modalEvents), ["show", "hidden"]);
  assert.equal(await page.locator("#sourceDialog").isVisible(), false);
  await page.evaluate(() => window.jQuery("#sourceDialog").dialog("open"));
  assert.equal(await page.locator("#sourceDialog").isVisible(), true);
  assert.equal(await page.evaluate(() => window.jQuery("#sourceDialog").dialog("isOpen")), true);
  await page.evaluate(() => window.jQuery("#sourceDialog").dialog("close"));
  assert.equal(await page.locator("#sourceDialog").isVisible(), false);
  // The page loads the platform bundles; only the scripts this test adds itself load from
  // /__sim-static/vendor/.
  assert.deepEqual(assets.sort((left, right) => left.path.localeCompare(right.path)), [
    { path: "/__sim-static/vendor/bootstrap-plugins-compat.js", status: 200 },
    { path: "/__sim-static/vendor/datetimepicker-compat.js", status: 200 },
    { path: "/__sim-static/vendor/jquery.min.js", status: 200 },
    { path: "/__sim-static/vendor/jqueryui-dialog-compat.js", status: 200 },
  ]);
  await page.locator("#effective_datepicker_description").waitFor();
  await page.locator("#effective_datepicker_description").evaluate((display) => {
    const chooser = display.closest("[data-sim-date-target]").querySelector(".paqvilo-mirage-date-chooser");
    chooser.value = "2025-02-03";
    chooser.dispatchEvent(new Event("change", { bubbles: true }));
  });
  assert.equal(await page.locator("#effective").inputValue(), "2025-02-03");
  assert.equal(await page.locator("#effective_datepicker_description").inputValue(), "03/02/2025");
  await page.locator("[data-sim-editor-mode=compatibility]").waitFor();
  assert.equal(await page.locator(".sim-compatibility-badge").innerText(), "Compatibility editor");
  assert.equal(
    await page.evaluate(() => ["getData", "setData", "on", "fire", "updateElement", "destroy"].every((name) => typeof window.CKEDITOR.instances.narrative_editor[name] === "function")),
    true,
  );
  await page.locator("iframe.cke_wysiwyg_frame").contentFrame().locator("body").fill("Compatibility formatted text");
  assert.match(await page.evaluate(() => window.CKEDITOR.instances.narrative_editor.getData()), /^<p>Compatibility formatted text<\/p>$/);
  await page.locator("button[aria-label=Bold]").click();
  assert.equal(
    await page.evaluate(() => new DOMParser().parseFromString(JSON.parse(document.getElementById("narrative").value), "text/html").body.textContent),
    "Compatibility formatted text",
  );
  assert.ok(errors.length === 0, errors.join("\n") + `\n${JSON.stringify({ assets })}`);
});

